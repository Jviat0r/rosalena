// Electron entry point for verifying a plugin from Node (the CLI and the tests).
//
//   ROSALENA_VERIFY_ARGS='{"url":...,"timeoutMs":...,"readyMs":...,"screenshot":...}' electron src/plugin-verify-runner.mjs
//
// The options travel in the environment, not as flags: Chromium reads every --switch on
// the command line itself, and some of them (--timeout is one) crash it on startup.
//
// It opens one hidden window, runs captureVerify, prints one line that starts with
// "ROSALENA_VERIFY " followed by the JSON result, and exits. plugin-verify.mjs starts it
// and reads that line; everything else Electron prints is ignored.

import electron from "electron";

import { captureVerify } from "./plugin-verify-electron.mjs";

const { app } = electron;
let options = {};
try {
  options = JSON.parse(process.env.ROSALENA_VERIFY_ARGS ?? "{}");
} catch {
  options = {};
}

// WebGL plugins (the 3D ones) still render on a machine whose GPU is unavailable to a
// hidden window: Chromium falls back to SwiftShader instead of failing the context.
app.commandLine.appendSwitch("enable-unsafe-swiftshader");
app.on("window-all-closed", () => {
  /* stay alive until the result is printed */
});

app.whenReady().then(async () => {
  let out;
  try {
    out = await captureVerify(electron, {
      url: String(options.url ?? ""),
      timeoutMs: Number(options.timeoutMs) || 120_000,
      readyMs: Number(options.readyMs) || 20_000,
      screenshot: options.screenshot || null,
    });
  } catch (err) {
    out = { error: String(err?.stack ?? err) };
  }
  process.stdout.write(`ROSALENA_VERIFY ${JSON.stringify(out)}\n`);
  app.exit(0);
});
