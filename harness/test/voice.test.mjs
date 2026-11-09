/**
 * Voice input tests.
 *
 * The interesting part is that the speech-to-text half is tested for real on
 * any machine, microphone or not: the Windows synthesizer speaks a known
 * sentence into a WAV file and each engine has to transcribe it. Only the
 * microphone capture needs a human in the room.
 *
 * The slower engine tests skip themselves when their backend is not installed,
 * so a fresh checkout still passes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BACKEND_ORDER,
  VENV_PYTHON,
  VOICE_DIR,
  describeBackends,
  detectBackends,
  ffmpegPath,
  parseMicList,
  pickBackend,
  transcribeWhisper,
  transcribeWindows,
} from "../src/voice.mjs";

const PHRASE = "add a json flag to the export command";

function words(text) {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function overlap(heard, expected) {
  const heardWords = new Set(words(heard));
  return words(expected).filter((word) => heardWords.has(word)).length;
}

// Verbatim shape of `ffmpeg -list_devices` on this machine, video device and all.
const DEVICE_LIST = [
  '[dshow @ 000001] "E\u01d6gato Virtual Camera" (video)',
  '[dshow @ 000001]   Alternative name "@device_pnp_\\\\?\\root#media#0000"',
  '[dshow @ 000001] "OBS Virtual Camera" (video)',
  '[dshow @ 000001] "Analogue 1 + 2 (Focusrite USB Audio)" (audio)',
  '[dshow @ 000001]   Alternative name "@device_cm_{33D9A762}"',
].join("\n");

test("parseMicList keeps audio devices and ignores video ones", () => {
  assert.deepEqual(parseMicList(DEVICE_LIST), ["Analogue 1 + 2 (Focusrite USB Audio)"]);
});

test("parseMicList survives empty and malformed input", () => {
  assert.deepEqual(parseMicList(""), []);
  assert.deepEqual(parseMicList(null), []);
  assert.deepEqual(parseMicList(undefined), []);
  // A trailing suffix means it is not the plain device line ffmpeg prints.
  assert.deepEqual(parseMicList('[dshow @ 0] "Mic" (audio) trailing'), []);
});

test("every backend is described, ready or not", () => {
  const { backends } = detectBackends({ env: {} });
  assert.deepEqual(Object.keys(backends).sort(), [...BACKEND_ORDER].sort());
  for (const name of BACKEND_ORDER) {
    assert.equal(typeof backends[name].available, "boolean", name);
    assert.ok(backends[name].detail.length > 0, name);
  }
  // Without a key the cloud backend must not claim to be ready.
  assert.equal(backends.openai.available, false);
});

test("pickBackend refuses the unknown and the unready", () => {
  assert.throws(() => pickBackend("nonsense"), /unknown voice backend/);
  assert.throws(() => pickBackend("openai", { env: {} }), /not ready/);
  // Capture is Windows-only, so which answer is correct depends on the host: on Windows
  // the built-in backend is always ready, everywhere else there is nothing to pick.
  if (process.platform === "win32") assert.ok(BACKEND_ORDER.includes(pickBackend(null, { env: {} })));
  else assert.throws(() => pickBackend(null, { env: {} }), /no speech-to-text backend is available/);
});

test("off Windows every backend reports unavailable, with the reason", () => {
  // The macOS requirement, checked on any host: voice input must be ABSENT rather than
  // advertised and then broken. Nothing may claim to be ready on a platform whose recorder
  // (ffmpeg DirectShow) and built-in engine (System.Speech) do not exist.
  for (const platform of ["darwin", "linux"]) {
    const { backends } = detectBackends({ env: { OPENAI_API_KEY: "sk-not-really" }, platform });
    assert.deepEqual(Object.keys(backends).sort(), [...BACKEND_ORDER].sort(), platform);
    for (const name of BACKEND_ORDER) {
      assert.equal(backends[name].available, false, `${platform}/${name}`);
      assert.match(backends[name].detail, /Windows-only/, `${platform}/${name}`);
    }
    assert.throws(() => pickBackend("whisper", { env: { OPENAI_API_KEY: "x" }, platform }), /not ready/);
    assert.throws(() => pickBackend(null, { env: {}, platform }), /no speech-to-text backend/);
  }
  // ... and the same call on Windows keeps the answer it always had.
  const windows = detectBackends({ env: {}, platform: "win32" }).backends;
  assert.equal(windows.windows.available, true);
});

test("describeBackends names every backend and reports microphones", () => {
  const text = describeBackends({ env: {} });
  for (const name of BACKEND_ORDER) assert.match(text, new RegExp(name));
  assert.match(text, /mics/);
});

/** Speak the test phrase to a WAV file - a stand-in for a person talking. */
function synthesize() {
  const res = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(VOICE_DIR, "selftest.ps1"), "-SynthOnly"],
    { encoding: "utf8", timeout: 120_000 },
  );
  const path = String(res.stdout ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .pop();
  return path && existsSync(path) ? path : null;
}

test("the Windows recognizer transcribes a recording", (t) => {
  const wav = synthesize();
  if (!wav) return t.skip("could not synthesize a test recording");
  // No output file: the transcript comes back on stdout, so the test needs no
  // writable temp directory at all.
  const { text } = transcribeWindows(wav);
  const need = Math.ceil(words(PHRASE).length / 2);
  assert.ok(overlap(text, PHRASE) >= need, `expected at least ${need} words, heard "${text}"`);
});

test("faster-whisper transcribes the same recording accurately", (t) => {
  if (!existsSync(VENV_PYTHON)) return t.skip("run src/voice/setup.ps1 to install the accurate backend");
  const wav = synthesize();
  if (!wav) return t.skip("could not synthesize a test recording");
  const { text, meta } = transcribeWhisper(wav);
  // The accurate engine is held to a much higher bar than the Windows one: the
  // whole point of installing 500 MB is that "json" does not become "Owen".
  const need = words(PHRASE).length - 2;
  assert.ok(overlap(text, PHRASE) >= need, `expected at least ${need} words, heard "${text}"`);
  assert.ok(meta?.totalMs > 0, "the transcriber should report its own timing");
});

test("silence transcribes to nothing rather than to invented words", (t) => {
  if (!existsSync(VENV_PYTHON)) return t.skip("run src/voice/setup.ps1 to install the accurate backend");
  const ffmpeg = ffmpegPath();
  if (!ffmpeg) return t.skip("ffmpeg is not on PATH");

  // Found the hard way: with VAD off, whisper answers a recording of pure room
  // tone with confident nonsense - "Earring Earring Earring Earring..." - and
  // that lands in the prompt line looking like something the user said.
  const wav = join(mkdtempSync(join(tmpdir(), "harness-voice-silence-")), "silence.wav");
  spawnSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono",
    "-t", "3", "-y", wav,
  ]);
  if (!existsSync(wav)) return t.skip("ffmpeg could not generate a silent recording");

  const { text, meta } = transcribeWhisper(wav);
  assert.equal(text, "", `silence produced "${text}" - whisper is inventing words again`);
  assert.equal(meta.peakDb, null, "digital silence has no peak level");
});

test("a quiet microphone is still transcribed", (t) => {
  if (!existsSync(VENV_PYTHON)) return t.skip("run src/voice/setup.ps1 to install the accurate backend");
  const ffmpeg = ffmpegPath();
  if (!ffmpeg) return t.skip("ffmpeg is not on PATH");
  const loud = synthesize();
  if (!loud) return t.skip("could not synthesize a test recording");

  // Attenuating by 15 dB puts this fixture at peak -15.4 / RMS -36.0 dBFS, which
  // is where the real microphone on this machine sits (-16.0 / -35.9). At the
  // VAD threshold Silero ships with, audio at that level is discarded as
  // non-speech and the transcript comes back EMPTY with no error at all - the
  // feature appears to work and simply never hears you.
  const quiet = join(mkdtempSync(join(tmpdir(), "harness-voice-quiet-")), "quiet.wav");
  spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", loud, "-af", "volume=-15dB", "-y", quiet]);
  if (!existsSync(quiet)) return t.skip("ffmpeg could not attenuate the recording");

  const { text, meta } = transcribeWhisper(quiet);
  const need = words(PHRASE).length - 2;
  assert.ok(overlap(text, PHRASE) >= need, `expected at least ${need} words, heard "${text}"`);
  // Pin the fixture at the level it is supposed to test, so it cannot drift
  // quietly and weaken this test into passing for the wrong reason.
  assert.ok(
    meta?.peakDb < -14 && meta?.peakDb > -17,
    `fixture should sit near -15 dBFS, got ${meta?.peakDb}`,
  );
});
