// The runtime half of plugin verification, inside Electron's main process.
//
// Used two ways: in-process by the desktop app (the harness already runs in Electron's
// main process there), and by plugin-verify-runner.mjs when the CLI or the tests start
// the checkout's Electron. Both call captureVerify with the electron module.
//
// The window gets its own in-memory session, so a plugin under test can never see the
// person's real storage, and every request that leaves the local verify server is
// cancelled and recorded: the CSP already forbids it, and this is the second lock.

import { writeFileSync } from "node:fs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A screenshot that is one flat colour means the page drew nothing. Every 3rd pixel is
 * sampled, and the page counts as drawn when more than 0.1% of the samples differ from
 * the most common colour: one line of heading text on a plain background clears that,
 * an empty page does not.
 */
function looksBlank(image) {
  const { width, height } = image.getSize();
  if (!width || !height) return true;
  const bitmap = image.toBitmap();
  const counts = new Map();
  let samples = 0;
  for (let y = 0; y < height; y += 3) {
    for (let x = 0; x < width; x += 3) {
      const i = (y * width + x) * 4;
      // Quantised, so a gradient's dithering on an empty page does not count as content.
      const key = ((bitmap[i] >> 3) << 10) | ((bitmap[i + 1] >> 3) << 5) | (bitmap[i + 2] >> 3);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      samples += 1;
    }
  }
  const dominant = Math.max(...counts.values());
  return (samples - dominant) / samples < 0.001;
}

export async function captureVerify(electron, { url, timeoutMs = 120_000, readyMs = 20_000, screenshot = null } = {}) {
  const { BrowserWindow, session } = electron;
  const origin = new URL(url).origin;
  const part = session.fromPartition(`rosalena-verify-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const blocked = [];
  part.webRequest.onBeforeRequest((details, callback) => {
    const target = details.url;
    if (target.startsWith(origin + "/") || target.startsWith("data:") || target.startsWith("blob:") || target.startsWith("devtools:")) {
      return callback({});
    }
    blocked.push(target.slice(0, 200));
    callback({ cancel: true });
  });
  part.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  // Offscreen rendering: a hidden normal window stops producing frames for the plugin's
  // frame partway through a run (animation stalls, and the screenshot is a stale frame).
  // An offscreen window paints at a fixed rate whatever its visibility, and every paint
  // hands over the whole frame, so the screenshot is what the page shows at the end.
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: { session: part, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
  });
  win.webContents.setFrameRate(30);
  let lastFrame = null;
  win.webContents.on("paint", (_event, _dirty, image) => {
    lastFrame = image;
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("will-frame-navigate", (details) => {
    if (!details.url.startsWith(origin + "/")) {
      blocked.push(`navigation to ${details.url.slice(0, 200)}`);
      details.preventDefault?.();
    }
  });

  try {
    await win.loadURL(`${url}?ready=${readyMs}`);
    const deadline = Date.now() + timeoutMs;
    let result = null;
    while (Date.now() < deadline) {
      result = await win.webContents.executeJavaScript("window.__verifyResult ?? null", true).catch(() => null);
      if (result) break;
      await sleep(250);
    }
    if (!result) return { error: `the page did not finish verifying within ${timeoutMs / 1000} s`, blocked };

    let shot = null;
    let blank = null;
    try {
      win.webContents.invalidate();
      await sleep(400);
      const image = lastFrame && !lastFrame.isEmpty() ? lastFrame : await win.webContents.capturePage();
      blank = looksBlank(image);
      if (screenshot) {
        writeFileSync(screenshot, image.toPNG());
        shot = screenshot;
      }
    } catch (err) {
      blank = null;
      result.reports = [...(result.reports ?? []), { level: "error", message: `screenshot failed: ${err?.message ?? err}` }];
    }
    if (blocked.length) {
      result.reports = [...(result.reports ?? []), ...blocked.map((b) => ({ level: "csp", message: `request outside the plugin was cancelled: ${b}` }))];
    }
    return { result, screenshot: shot, blank, blocked };
  } finally {
    win.destroy();
  }
}
