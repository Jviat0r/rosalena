/**
 * Speech-to-text with the Whisper models from the Models page, through whisper.cpp.
 *
 * Load on use, gone when done: every transcription is one whisper-cli process that
 * loads the model, writes the text and exits, so a Whisper model never sits in memory
 * between two dictations and there is nothing to unload when idle.
 *
 *   models   ~/.rosalena/models/voice/whisper/ggml-*.bin   (downloaded by the Models page)
 *   runner   ~/.rosalena/whisper.cpp/whisper-cli(.exe)     (data/whisper-runtime.json, verified)
 *
 * The audio is a 16 kHz mono 16-bit WAV, which is what the page records and what
 * whisper.cpp reads without ffmpeg.
 */

import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { downloadVerified, extractArchive, findFile, starterHome } from "./starter-model.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const WHISPER_RUNTIME_PATH = resolve(HERE, "..", "data", "whisper-runtime.json");
const EXE = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";

export const whisperRuntimeKey = ({ platform = process.platform, arch = process.arch } = {}) =>
  platform === "win32" && arch === "x64" ? "win32-x64" : platform === "linux" && arch === "x64" ? "linux-x64" : null;

export const whisperDir = (home = starterHome()) => join(home, "whisper.cpp");
export const whisperModelsDir = (home = starterHome()) => join(home, "models", "voice", "whisper");

/** The installed whisper-cli, or null. */
export function whisperBinary(home = starterHome()) {
  const path = join(whisperDir(home), EXE);
  return existsSync(path) ? path : null;
}

// Best first: turbo is near large-v3 accuracy at several times its speed.
const PREFERENCE = [/large-v3-turbo/i, /large-v3/i, /medium/i, /small/i, /base/i, /tiny/i];

/** The Whisper models on disk, best first. */
export function whisperModels(home = starterHome()) {
  let names = [];
  try {
    names = readdirSync(whisperModelsDir(home)).filter((name) => /^ggml-.*\.bin$/i.test(name));
  } catch {
    return [];
  }
  const rank = (name) => {
    const at = PREFERENCE.findIndex((re) => re.test(name));
    return at < 0 ? PREFERENCE.length : at;
  };
  return names
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    // ".en" before any quantization suffix: ggml-base.en.bin and ggml-base.en-q5_1.bin are
    // both English-only, and asking one to detect the language costs accuracy.
    .map((name) => ({ name, path: join(whisperModelsDir(home), name), bytes: statSync(join(whisperModelsDir(home), name)).size, english: /\.en(-q\w+)?\.bin$/i.test(name) }));
}

/** Can the app transcribe right now, and if not, what is missing. */
export function voiceStatus(home = starterHome()) {
  const models = whisperModels(home);
  const binary = whisperBinary(home);
  const key = whisperRuntimeKey();
  if (!models.length) return { ok: false, code: "no-model", why: "Voice typing is not set up yet: click the mic to download the speech model (about 180 MB, runs on this PC).", models };
  if (!binary) {
    return key
      ? { ok: false, code: "no-runner", why: "The Whisper runner (whisper.cpp) is not installed yet; it is downloaded with the next Whisper model, or press Install runner on the Models page.", models }
      : { ok: false, code: "unsupported", why: `There is no whisper.cpp build for ${process.platform}-${process.arch} in this release.`, models };
  }
  return { ok: true, model: models[0], binary, models };
}

/** Download, check and unpack whisper.cpp into <home>/whisper.cpp. */
export async function installWhisperRuntime({ home = starterHome(), key = whisperRuntimeKey(), runtimePath = WHISPER_RUNTIME_PATH, fetchImpl = fetch, extract = extractArchive, signal, onProgress = () => {}, log = () => {} } = {}) {
  const spec = JSON.parse(readFileSync(runtimePath, "utf8")).assets?.[key];
  if (!spec) throw new Error(`there is no whisper.cpp build for this platform (${key ?? `${process.platform}-${process.arch}`})`);
  const archive = join(home, "downloads", spec.name);
  await downloadVerified({ url: spec.url, dest: archive, bytes: spec.bytes, sha256: spec.sha256, fetchImpl, signal, onProgress });
  const staging = join(home, "whisper.cpp.new");
  rmSync(staging, { recursive: true, force: true });
  await extract(archive, staging);
  const binary = findFile(staging, EXE);
  if (!binary) throw new Error(`${spec.name} did not contain ${EXE}`);
  const target = whisperDir(home);
  rmSync(target, { recursive: true, force: true });
  renameSync(dirname(binary), target);
  rmSync(staging, { recursive: true, force: true });
  rmSync(archive, { force: true });
  if (process.platform !== "win32") {
    for (const name of readdirSync(target)) if (name.startsWith("whisper-")) chmodSync(join(target, name), 0o755);
  }
  log(`whisper.cpp ${key} installed in ${target}`);
  return { target };
}

/** The argv for one transcription. English-only models are not asked to detect the language. */
export function whisperArgs({ model, wavPath, threads = Math.max(1, Math.min(8, (cpus()?.length ?? 4) - 1)), prompt = "" }) {
  // `--prompt`: text whisper treats as what was said just before - the project's own
  // words (voice-hints.mjs), so `slugify` is not heard as "sludgeify".
  return ["-m", model.path, "-f", wavPath, "-t", String(threads), "-l", model.english ? "en" : "auto", "-nt", "-np", ...(prompt ? ["--prompt", prompt] : [])];
}

/**
 * Turn a WAV into text. One process: it loads the model, transcribes and exits.
 * Resolves `{ text, model, ms }`; rejects with the runner's last error line.
 */
export function transcribeFile({ wavPath, home = starterHome(), model = null, prompt = "", spawnImpl = spawn, timeoutMs = 10 * 60 * 1000 } = {}) {
  const status = voiceStatus(home);
  if (!status.ok) return Promise.reject(Object.assign(new Error(status.why), { code: status.code }));
  const chosen = model ? status.models.find((m) => m.name === model) ?? status.model : status.model;
  const started = Date.now();
  return new Promise((ok, fail) => {
    const child = spawnImpl(status.binary, whisperArgs({ model: chosen, wavPath, prompt }), { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill?.(), timeoutMs);
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      fail(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const last = String(err).trim().split(/\r?\n/).filter(Boolean).pop() ?? `exit ${code}`;
        return fail(new Error(`whisper.cpp failed: ${last}`));
      }
      const text = String(out)
        .split(/\r?\n/)
        .map((line) => line.replace(/^\s*\[[^\]]*\]\s*/, "").trim())
        .filter((line) => line && !/^\[(BLANK_AUDIO|MUSIC|NOISE)\]$/i.test(line))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      ok({ text, model: chosen.name, ms: Date.now() - started });
    });
  });
}
