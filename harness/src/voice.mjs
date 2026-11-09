/**
 * Voice input for the prompt bar.
 *
 * The point is that a prompt can be spoken instead of typed. Speech is turned
 * into text and placed in the prompt line, never sent on its own: the user still
 * reads it, fixes what the recognizer got wrong, and presses Enter. A recognizer
 * that guesses "Adage as Owen flag" for "add a json flag" is still useful that
 * way, and useless if it fires the agent directly.
 *
 * Backends, best first:
 *   whisper  local and accurate (faster-whisper on the CPU). Needs setup.ps1.
 *   openai   cloud and accurate. Needs OPENAI_API_KEY.
 *   windows  the recognizer built into Windows. No install, no network, and
 *            rough accuracy - it is the fallback that always works.
 *
 * The first two record with ffmpeg and transcribe a file; the Windows one
 * listens live. Everything is a plain child process, so there is no dependency
 * to install in the harness itself.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const VOICE_DIR = join(HERE, "voice");
export const WIN_SPEECH = join(VOICE_DIR, "win-speech.ps1");
export const TRANSCRIBE_PY = join(VOICE_DIR, "transcribe.py");
export const VENV_PYTHON = join(VOICE_DIR, ".venv", "Scripts", "python.exe");
export const SETUP_PS1 = join(VOICE_DIR, "setup.ps1");

const POWERSHELL = "powershell.exe";
const DEFAULT_SECONDS = 60;
// A live microphone always has a noise floor near -50 dBFS, so a recording that
// peaks below this is muted, at zero gain, or the wrong device entirely.
const QUIET_DB = -40;

export const BACKEND_ORDER = ["whisper", "openai", "windows"];

function run(cmd, args, { timeoutMs = 120_000 } = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 8 << 20,
  });
  return {
    code: res.status ?? -1,
    out: res.stdout ?? "",
    err: res.stderr ?? "",
    error: res.error ?? null,
  };
}

function which(name) {
  const finder = process.platform === "win32" ? "where.exe" : "which";
  const res = run(finder, [name], { timeoutMs: 15_000 });
  if (res.code !== 0) return null;
  const first = res.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  return first ?? null;
}

export function ffmpegPath() {
  return which("ffmpeg");
}

/**
 * Pull microphone names out of `ffmpeg -list_devices`. Exported because the
 * parsing is the fragile part and deserves a test that does not need ffmpeg.
 */
export function parseMicList(text) {
  const mics = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const match = line.match(/^\[[^\]]*\]\s+"(.+?)"\s+\(audio\)\s*$/);
    if (match) mics.push(match[1]);
  }
  return mics;
}

export function listMics() {
  const ffmpeg = ffmpegPath();
  if (!ffmpeg) return [];
  const res = run(ffmpeg, ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"], {
    timeoutMs: 25_000,
  });
  return parseMicList(`${res.out}\n${res.err}`);
}

export function detectBackends({ env = process.env, withMics = false, platform = process.platform } = {}) {
  const hasVenv = existsSync(VENV_PYTHON);
  const hasFfmpeg = Boolean(ffmpegPath());
  // What decides this is capture, not transcription: record() and listMics() ask ffmpeg
  // for a DirectShow device (`-f dshow`), which only exists on Windows, and the Windows
  // backend shells out to System.Speech. A Mac with faster-whisper installed and ffmpeg on
  // PATH would otherwise be told voice input is ready and then fail the moment the
  // microphone opens - so every backend reports unavailable off Windows, with the reason.
  // `platform` is an argument so this can be tested from any host.
  const canCapture = platform === "win32";
  const elsewhere =
    `voice input is Windows-only in this build: capture uses ffmpeg's DirectShow input and PowerShell's ` +
    `System.Speech, neither of which exists on ${platform}`;
  const backends = {
    whisper: {
      available: canCapture && hasVenv && hasFfmpeg,
      detail: !canCapture
        ? elsewhere
        : !hasVenv
          ? `not installed yet - run: powershell -NoProfile -ExecutionPolicy Bypass -File "${SETUP_PS1}"`
          : !hasFfmpeg
            ? "faster-whisper is installed but ffmpeg is missing, so audio cannot be captured"
            : "local, accurate (faster-whisper on the CPU)",
    },
    openai: {
      available: canCapture && Boolean(env.OPENAI_API_KEY) && hasFfmpeg,
      detail: !canCapture
        ? elsewhere
        : env.OPENAI_API_KEY
          ? "cloud, accurate (whisper-1)"
          : "set OPENAI_API_KEY to enable (and ffmpeg must be present)",
    },
    windows: {
      available: canCapture,
      detail: canCapture ? "built into Windows, offline, rough accuracy" : elsewhere,
    },
  };
  const mics = withMics ? listMics() : null;
  return { backends, mics };
}

export function pickBackend(preferred, options = {}) {
  const { backends } = detectBackends(options);
  if (preferred) {
    if (!backends[preferred]) throw new Error(`unknown voice backend "${preferred}" (${BACKEND_ORDER.join(", ")})`);
    if (!backends[preferred].available) throw new Error(`voice backend "${preferred}" is not ready: ${backends[preferred].detail}`);
    return preferred;
  }
  const ready = BACKEND_ORDER.find((name) => backends[name].available);
  if (!ready) throw new Error("no speech-to-text backend is available");
  return ready;
}

/**
 * Record one utterance to a 16 kHz mono WAV with ffmpeg.
 *
 * `stopSignal` is an optional promise that ends the recording early - the CLI
 * resolves it when the user presses Enter. ffmpeg is asked to quit with "q"
 * rather than killed, so the WAV header is finalised and the file stays
 * playable. `seconds` is only a backstop: if the stop signal never arrives the
 * recording still ends on its own.
 */
export function record(wavPath, { device, seconds = 15, stopSignal = null } = {}) {
  const ffmpeg = ffmpegPath();
  if (!ffmpeg) throw new Error("ffmpeg is not on PATH, so audio cannot be captured");
  const mic = device || listMics()[0];
  if (!mic) {
    throw new Error(
      'no microphone found. Plug one in, or pass --mic "<name>"; /voice mics lists what Windows can see.',
    );
  }
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "dshow",
    "-i",
    `audio=${mic}`,
    "-t",
    String(seconds),
    "-ac",
    "1",
    "-ar",
    "16000",
    "-y",
    wavPath,
  ];
  const started = Date.now();

  return new Promise((resolve, reject) => {
    let stderr = "";
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });

    const stop = () => {
      if (child.exitCode !== null || child.killed) return;
      try {
        child.stdin.write("q");
      } catch {
        child.kill();
      }
      const hard = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }, 3000);
      hard.unref?.();
    };

    if (stopSignal) stopSignal.then(stop, () => {});
    child.on("error", (err) => reject(new Error(`could not start ffmpeg: ${err.message}`)));
    child.on("close", () => {
      if (!existsSync(wavPath)) {
        const tail = stderr.trim().split(/\r?\n/).filter(Boolean).pop();
        reject(new Error(`ffmpeg captured no audio from "${mic}"${tail ? `: ${tail}` : ""}`));
        return;
      }
      resolve({ wavPath, device: mic, ms: Date.now() - started });
    });
  });
}

function lastJsonLine(text) {
  const lines = String(text ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].startsWith("{")) {
      try {
        return JSON.parse(lines[i]);
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

export function transcribeWhisper(wavPath, { model = "base.en", out = null } = {}) {
  if (!existsSync(VENV_PYTHON)) {
    throw new Error(
      `the accurate backend is not installed yet. Run:\n  powershell -NoProfile -ExecutionPolicy Bypass -File "${SETUP_PS1}"`,
    );
  }
  // The transcript comes back on stdout unless a caller explicitly wants a file:
  // one less path that can be denied write access.
  const args = [TRANSCRIBE_PY, "--wav", wavPath, "--model", model];
  if (out) args.push("--out", out);
  const res = run(VENV_PYTHON, args, { timeoutMs: 10 * 60 * 1000 });
  if (res.code === 3) throw new Error("faster-whisper is missing from the voice environment - re-run setup.ps1");
  if (res.code !== 0) {
    const tail = String(res.err).trim().split(/\r?\n/).filter(Boolean).pop() ?? "unknown error";
    throw new Error(`transcription failed: ${tail}`);
  }
  const text = out && existsSync(out) ? readFileSync(out, "utf8").trim() : String(res.out).trim();
  return { text, meta: lastJsonLine(res.err) };
}

export async function transcribeOpenAI(wavPath, { apiKey, model = "whisper-1", env = process.env } = {}) {
  const key = apiKey ?? env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  const form = new FormData();
  form.append("file", new Blob([readFileSync(wavPath)], { type: "audio/wav" }), "audio.wav");
  form.append("model", model);
  form.append("language", "en");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) throw new Error(`OpenAI transcription failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const payload = await res.json();
  return { text: String(payload.text ?? "").trim(), meta: { model } };
}

/** Live recognition by the recognizer built into Windows - no file, no ffmpeg. */
export function listenWindows({ out, seconds = DEFAULT_SECONDS, silence = 1.6, initialSilence = 8 } = {}) {
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    WIN_SPEECH,
    "-Out",
    out,
    "-MaxSeconds",
    String(seconds),
    "-SilenceSeconds",
    String(silence),
    "-InitialSilenceSeconds",
    String(initialSilence),
  ];
  const res = run(POWERSHELL, args, { timeoutMs: (seconds + 45) * 1000 });
  if (res.code === 2) throw new Error(`Windows speech input failed: ${String(res.err).trim().split(/\r?\n/).pop()}`);
  if (res.code === 3) throw new Error("Windows has no speech recognizer installed (add a language pack)");
  return existsSync(out) ? readFileSync(out, "utf8").trim() : "";
}

/**
 * Recognise an existing recording with the Windows recognizer. Used by the
 * self-test, and useful on its own for replaying a saved clip.
 */
export function transcribeWindows(wavPath, { out = null } = {}) {
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", WIN_SPEECH, "-Wav", wavPath];
  if (out) args.push("-Out", out);
  const res = run(POWERSHELL, args, { timeoutMs: 5 * 60 * 1000 });
  if (res.code === 2) throw new Error(`Windows speech input failed: ${String(res.err).trim().split(/\r?\n/).pop()}`);
  if (res.code === 3) throw new Error("Windows has no speech recognizer installed (add a language pack)");
  const text = out && existsSync(out) ? readFileSync(out, "utf8").trim() : String(res.out).trim();
  return { text, meta: { backend: "windows" } };
}

/**
 * Listen once and return the transcript.
 *
 * `onStatus` is called with a short human-readable line before the microphone
 * opens, so the caller can tell the user to start talking.
 */
export async function listen(options = {}) {
  const {
    backend: preferred,
    model = "base.en",
    device,
    seconds = 15,
    stopSignal = null,
    onStatus = () => {},
    keepAudio = false,
    env = process.env,
  } = options;

  const backend = pickBackend(preferred, { env });
  const started = Date.now();
  const dir = mkdtempSync(join(tmpdir(), "harness-voice-"));

  try {
    if (backend === "windows") {
      onStatus("listening - speak now and then pause (Windows speech, offline)");
      const text = listenWindows({ seconds: Math.max(seconds, 20) });
      return { text, backend, ms: Date.now() - started };
    }

    onStatus(`recording - speak now, then press Enter to transcribe with ${backend} (stops by itself after ${seconds}s)`);
    const wav = join(dir, "speech.wav");
    const recorded = await record(wav, { device, seconds, stopSignal });
    let result;
    if (backend === "whisper") {
      result = transcribeWhisper(wav, { model });
      // A live microphone always has a noise floor near -50 dB; well below that
      // means the input is muted, at zero gain, or the wrong device entirely,
      // and no amount of transcription quality will save the recording.
      if (typeof result.meta?.peakDb === "number" && result.meta.peakDb < QUIET_DB) {
        onStatus(
          `the input is very quiet (peak ${result.meta.peakDb} dBFS) - raise the gain on your interface, or check "/voice mics" picked the right input`,
        );
      }
    } else {
      result = await transcribeOpenAI(wav, { env });
    }
    return {
      text: result.text,
      backend,
      ms: Date.now() - started,
      meta: result.meta ?? null,
      device: recorded.device,
      ...(keepAudio ? { wav } : {}),
    };
  } finally {
    if (!keepAudio) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* the temp dir is not worth failing the turn over */
      }
    }
  }
}

export function describeBackends({ env = process.env } = {}) {
  const { backends } = detectBackends({ env });
  const mics = listMics();
  const lines = [];
  for (const name of BACKEND_ORDER) {
    const info = backends[name];
    lines.push(`  ${info.available ? "ready  " : "absent "} ${name.padEnd(8)} ${info.detail}`);
  }
  lines.push(
    mics.length
      ? `  mics   ${mics.join(" | ")}`
      : "  mics   none detected - plug in a microphone, or set --mic if Windows sees one ffmpeg does not",
  );
  return lines.join("\n");
}
