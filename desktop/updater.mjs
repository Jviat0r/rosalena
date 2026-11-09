// Rosalena Harness - the self-updater.
//
// Checks the published feed (harness/src/update.mjs decides), asks the person, and when they
// say yes: downloads this platform's file, refuses it unless its SHA-256 matches the feed,
// installs it over this copy and reopens the app. Nothing is installed without a yes.
//
//   Windows, installed with Setup  run the new NSIS installer silently (/S --updated
//                                  --force-run). It closes this app, installs over it in
//                                  the same folder and starts the new version.
//   Windows, portable exe          a small cmd script waits for the old exe to be released,
//                                  moves the new one over it and starts it.
//   macOS                          the release .zip is unpacked with ditto, and a small sh
//                                  script waits for this process to exit, swaps the .app
//                                  bundle and opens it.
//   Linux, AppImage                a small sh script waits for this process to exit, copies
//                                  the new AppImage over the one in $APPIMAGE (same folder,
//                                  same name, so launchers keep working) and starts it.
//   Linux, .deb                    not replaced from inside the app: /opt is root's and
//                                  dpkg's. The dialog opens the download page and names the
//                                  apt command instead.
//
// Why the in-app update never shows "Windows protected your PC" or a Gatekeeper prompt: those
// warnings key off the mark a *browser* puts on a downloaded file (Mark of the Web on
// Windows, com.apple.quarantine on macOS). A file this process downloads carries neither, so
// only the very first download from the website ever sees the warning. The SHA-256 check
// against the feed is what stands in for that trust.
//
// A checkout run (`npm start`, not packaged) only checks: there is no installed copy to
// replace, so it offers the release page instead.

import { app, dialog, net, shell } from "electron";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { basename, dirname, join } from "node:path";
import {
  DOWNLOAD_PAGE_URL,
  appImageSwapScript,
  decideUpdate,
  fetchUpdateManifest,
  manualUpdateReason,
  pickUpdateAsset,
  selfInstallable,
  shouldCheck,
} from "../harness/src/update.mjs";
// The dialogs speak the window's language: main.mjs hands in its current translator.
import { translator } from "../harness/ui/i18n.mjs";

/** First automatic check, a little after the window is up so startup is not slowed. */
const FIRST_CHECK_DELAY_MS = 15 * 1000;
/** Background checks after that. The module's own floor is the same six hours. */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** An installer is ~110 MB today; anything past this is not ours. */
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
/** A stalled download gives up rather than hanging the app forever. */
const DOWNLOAD_IDLE_MS = 60 * 1000;
const NOTES_IN_DIALOG = 700;

const statePath = () => join(app.getPath("userData"), "update-state.json");
const downloadDir = () => join(app.getPath("temp"), "rosalena-update");

async function readUpdateState() {
  try {
    const body = JSON.parse(await readFile(statePath(), "utf8"));
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

async function writeUpdateState(patch) {
  const next = { ...(await readUpdateState()), ...patch };
  try {
    await mkdir(app.getPath("userData"), { recursive: true });
    await writeFile(statePath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  } catch (err) {
    console.error(`[rosalena] could not save ${statePath()}: ${err.message}`);
  }
}

const formatMb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(0)} MB`;

/** Run a command and resolve with its exit code; stderr is kept for the error message. */
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${basename(command)} exited ${code}: ${stderr.trim()}`))));
  });
}

/**
 * The environment the updated copy starts with: this one's, minus the router address this
 * copy wrote for its OWN router (main.mjs marks it ROSALENA_ROUTER_SELF). That router ends
 * with this copy, and the next one read the inherited address as the person's explicit
 * choice, so it started no router and no model could answer (0.1.10, measured).
 */
export function handoverEnv(env = process.env) {
  const out = { ...env };
  if (out.ROSALENA_ROUTER_SELF) {
    delete out.ROUTER_URL;
    delete out.ROSALENA_ROUTER_URL;
    delete out.ROSALENA_ROUTER_SELF;
  }
  return out;
}

/**
 * @param {{ getWindow: () => import("electron").BrowserWindow | null, getT?: () => (key: string, vars?: Record<string, unknown>) => string }} options
 */
export function createUpdater({ getWindow, getT = () => translator("en") }) {
  let busy = false;
  let timer = null;
  // Asked on every string, so a language change in Settings reaches the next dialog.
  const t = (key, vars) => getT()(key, vars);

  const parent = () => {
    const win = getWindow();
    return win && !win.isDestroyed() ? win : null;
  };
  const box = (options) => {
    const win = parent();
    return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
  };
  const progress = (value) => parent()?.setProgressBar(value);

  // How this copy was installed decides which file replaces it.
  const portableExe = (process.env.PORTABLE_EXECUTABLE_FILE ?? "").trim();
  // Set by the AppImage runtime to the .AppImage file this copy was started from; absent
  // for a .deb install (and everywhere else).
  const appImageFile = process.platform === "linux" ? (process.env.APPIMAGE ?? "").trim() : "";
  const target = { platform: process.platform, arch: process.arch, portable: Boolean(portableExe), appImage: Boolean(appImageFile) };

  /** Download to the temp folder, hashing as it goes. Resolves with the file path. */
  async function download(asset) {
    await rm(downloadDir(), { recursive: true, force: true });
    await mkdir(downloadDir(), { recursive: true });
    const file = join(downloadDir(), asset.fileName);

    const controller = new AbortController();
    let idle = setTimeout(() => controller.abort(), DOWNLOAD_IDLE_MS);
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => controller.abort(), DOWNLOAD_IDLE_MS);
    };

    try {
      const response = await net.fetch(asset.url, { signal: controller.signal });
      if (!response.ok) throw new Error(t("the download answered HTTP {status}", { status: response.status }));
      const total = Number(response.headers.get("content-length") ?? 0);
      if (total > MAX_DOWNLOAD_BYTES) throw new Error(t("the download is {size}, larger than any release", { size: formatMb(total) }));

      const hash = createHash("sha256");
      const out = createWriteStream(file);
      let received = 0;
      try {
        for await (const chunk of response.body) {
          touch();
          received += chunk.length;
          if (received > MAX_DOWNLOAD_BYTES) throw new Error(t("the download is larger than any release"));
          hash.update(chunk);
          if (!out.write(chunk)) await once(out, "drain");
          if (total > 0) progress(Math.min(received / total, 1));
        }
      } finally {
        out.end();
        await once(out, "close");
      }

      const actual = hash.digest("hex");
      if (actual !== asset.sha256) {
        await rm(file, { force: true });
        throw new Error(t("the downloaded file's SHA-256 ({actual}) does not match the published one ({expected}), so it was deleted", { actual, expected: asset.sha256 }));
      }
      return file;
    } catch (err) {
      if (controller.signal.aborted) throw new Error(t("the download stalled for a minute and was stopped"));
      throw err;
    } finally {
      clearTimeout(idle);
      progress(-1);
    }
  }

  /** Hand over to the installer or swap script, then quit so it can replace us. */
  async function install(asset, file) {
    if (asset.kind === "nsis") {
      // electron-builder's NSIS installer: /S silent, --updated keeps the existing install
      // folder and shortcuts. Its own --force-run relaunch was measured not to start the app
      // (it goes through a Start menu shortcut via the shell and nothing appeared), so this
      // script waits for the installer and starts the updated exe itself, with the same
      // arguments this copy was started with. Values travel as environment variables.
      const script = join(downloadDir(), "install.cmd");
      await writeFile(
        script,
        ['@echo off', 'start "" /wait "%RU_SETUP%" --updated /S', 'start "" "%RU_TARGET%" %RU_ARGS%', ""].join("\r\n"),
        "utf8",
      );
      const args = process.argv
        .slice(1)
        .filter((arg) => arg.startsWith("--") && !/["%^&|<>]/.test(arg))
        .map((arg) => `"${arg}"`)
        .join(" ");
      const child = spawn("cmd.exe", ["/d", "/c", script], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: { ...handoverEnv(), RU_SETUP: file, RU_TARGET: process.execPath, RU_ARGS: args },
      });
      child.unref();
      app.quit();
      return;
    }

    if (asset.kind === "portable") {
      // The portable launcher holds its exe open until it exits, so the move is retried for
      // up to two minutes. Paths travel as environment variables, never pasted into the
      // script, so a folder name cannot change what the script does.
      const script = join(downloadDir(), "swap.cmd");
      await writeFile(
        script,
        [
          "@echo off",
          "set /a tries=0",
          ":again",
          'move /y "%RU_SOURCE%" "%RU_TARGET%" >nul 2>&1 && goto started',
          "set /a tries+=1",
          "if %tries% geq 240 goto end",
          "ping -n 2 127.0.0.1 >nul",
          "goto again",
          ":started",
          'start "" "%RU_TARGET%"',
          ":end",
          "",
        ].join("\r\n"),
        "utf8",
      );
      const child = spawn("cmd.exe", ["/d", "/c", script], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: { ...handoverEnv(), RU_SOURCE: file, RU_TARGET: portableExe },
      });
      child.unref();
      app.quit();
      return;
    }

    if (asset.kind === "mac-zip") {
      // <bundle>/Contents/MacOS/<exe>  ->  <bundle>
      const bundle = dirname(dirname(dirname(process.execPath)));
      if (!bundle.endsWith(".app")) throw new Error(t("this copy is not running from an .app bundle ({path})", { path: process.execPath }));
      if (bundle.includes("/AppTranslocation/")) {
        throw new Error(t("macOS is running this copy from a temporary location. Move Rosalena Harness to Applications, open it from there, then update."));
      }
      await access(dirname(bundle), constants.W_OK).catch(() => {
        throw new Error(t("this account cannot write to {folder}, so the app cannot replace itself there", { folder: dirname(bundle) }));
      });

      const unpacked = join(downloadDir(), "unpacked");
      await mkdir(unpacked, { recursive: true });
      await run("/usr/bin/ditto", ["-x", "-k", file, unpacked]);
      const fresh = join(unpacked, basename(bundle));
      if (!(await stat(fresh).catch(() => null))?.isDirectory()) {
        throw new Error(t("the update did not contain {name}", { name: basename(bundle) }));
      }

      const script = join(downloadDir(), "swap.sh");
      await writeFile(
        script,
        [
          "#!/bin/sh",
          'while kill -0 "$RU_PID" 2>/dev/null; do sleep 0.5; done',
          'rm -rf "$RU_TARGET.old"',
          'if mv "$RU_TARGET" "$RU_TARGET.old"; then',
          '  if mv "$RU_SOURCE" "$RU_TARGET"; then rm -rf "$RU_TARGET.old"; else mv "$RU_TARGET.old" "$RU_TARGET"; fi',
          "fi",
          'xattr -dr com.apple.quarantine "$RU_TARGET" 2>/dev/null',
          'open "$RU_TARGET"',
          "",
        ].join("\n"),
        "utf8",
      );
      const child = spawn("/bin/sh", [script], {
        detached: true,
        stdio: "ignore",
        env: { ...handoverEnv(), RU_PID: String(process.pid), RU_SOURCE: fresh, RU_TARGET: bundle },
      });
      child.unref();
      app.quit();
      return;
    }

    if (asset.kind === "appimage") {
      if (!appImageFile) throw new Error(t("this copy is not running from an AppImage, so it cannot replace itself"));
      await access(dirname(appImageFile), constants.W_OK).catch(() => {
        throw new Error(t("this account cannot write to {folder}, so the app cannot replace itself there", { folder: dirname(appImageFile) }));
      });
      const script = join(downloadDir(), "swap.sh");
      await writeFile(script, appImageSwapScript(), "utf8");
      const child = spawn("/bin/sh", [script], {
        detached: true,
        stdio: "ignore",
        env: { ...handoverEnv(), RU_PID: String(process.pid), RU_SOURCE: file, RU_TARGET: appImageFile },
      });
      child.unref();
      app.quit();
      return;
    }

    throw new Error(t("no installer for {kind}", { kind: asset.kind }));
  }

  /**
   * One check. `interactive` is the person pressing "Check for updates": they always get an
   * answer, and a version they skipped before is offered again. A background check stays
   * silent unless there is something to install.
   *
   * @returns {Promise<{ state: string, current: string | null, latest: string | null, reason: string }>}
   */
  async function check({ interactive = false } = {}) {
    if (busy) return { state: "busy", current: app.getVersion(), latest: null, reason: t("an update check is already running") };
    busy = true;
    try {
      const current = app.getVersion();
      const feedUrl = process.env.ROSALENA_UPDATE_FEED?.trim();
      const fetched = await fetchUpdateManifest({ ...(feedUrl ? { url: feedUrl } : {}), fetchImpl: net.fetch });
      await writeUpdateState({ lastCheckedAt: Date.now() });
      const verdict = fetched.ok
        ? decideUpdate({ current, manifest: fetched.manifest })
        : { state: "unknown", current, latest: null, url: "", notes: "", releasedAt: null, reason: fetched.reason };

      if (verdict.state === "current") {
        if (interactive) await box({ type: "info", title: t("Check for updates"), message: t("You're up to date."), detail: t("Rosalena Harness {version} is the newest version.", { version: current }), buttons: [t("OK")] });
        return verdict;
      }
      if (verdict.state !== "available") {
        if (interactive) await box({ type: "warning", title: t("Check for updates"), message: t("Couldn't check for updates."), detail: verdict.reason, buttons: [t("OK")] });
        return verdict;
      }

      const saved = await readUpdateState();
      if (!interactive && saved.skippedVersion === verdict.latest) return verdict;

      const asset = pickUpdateAsset({ manifest: fetched.manifest, ...target });
      // ROSALENA_UPDATE_FILES is the companion of ROSALENA_UPDATE_FEED: a folder URL to read
      // the update file from instead of the GitHub release, so the whole flow can be run
      // against a locally served build. The SHA-256 from the feed is still enforced.
      const filesBase = process.env.ROSALENA_UPDATE_FILES?.trim();
      if (asset.ok && filesBase) asset.url = new URL(encodeURIComponent(asset.fileName), filesBase.endsWith("/") ? filesBase : `${filesBase}/`).href;
      const notes = verdict.notes.trim();
      const shortNotes = notes.length > NOTES_IN_DIALOG ? `${notes.slice(0, NOTES_IN_DIALOG)}…` : notes;

      // A checkout, a platform with no published file, or an install the app must not
      // replace itself (a .deb): point at the release page, or for a .deb the download page.
      // A .deb copy is sent to the download page even when the feed lists no .deb for this
      // version: it never installs the file itself, so a missing checksum changes nothing.
      const debCopy = target.platform === "linux" && !target.appImage;
      const manual = debCopy || (asset.ok && !selfInstallable(asset.kind));
      if (!app.isPackaged || !asset.ok || manual) {
        const why = !app.isPackaged
          ? t("This copy runs from source, so it can't replace itself.")
          : manual
            ? manualUpdateReason(debCopy ? "deb" : asset.kind, asset.ok ? asset.fileName : "")
            : t("This copy can't update itself: {reason}.", { reason: asset.reason });
        const pageUrl = app.isPackaged && manual ? DOWNLOAD_PAGE_URL : verdict.url;
        const { response } = await box({
          type: "info",
          title: t("Update available"),
          message: t("Rosalena Harness {version} is available.", { version: verdict.latest }),
          detail: `${t("You have {current}.", { current })} ${why}${shortNotes ? `\n\n${shortNotes}` : ""}`,
          buttons: [pageUrl === DOWNLOAD_PAGE_URL ? t("Open download page") : t("Open release page"), t("Later")],
          defaultId: 0,
          cancelId: 1,
        });
        if (response === 0) await shell.openExternal(pageUrl);
        return verdict;
      }

      const { response } = await box({
        type: "info",
        title: t("Update available"),
        message: t("Rosalena Harness {version} is available.", { version: verdict.latest }),
        detail: [
          t("You have {current}.", { current }),
          shortNotes,
          t("{button} downloads it, checks it against the published SHA-256, installs it and reopens Rosalena Harness. Anything still running in a chat stops when the app restarts.", {
            button: `"${t("Update and restart")}"`,
          }),
        ]
          .filter(Boolean)
          .join("\n\n"),
        buttons: [t("Update and restart"), t("Later"), t("Skip this version")],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 2) {
        await writeUpdateState({ skippedVersion: verdict.latest });
        return verdict;
      }
      if (response !== 0) return verdict;

      try {
        const file = await download(asset);
        await install(asset, file);
        return { ...verdict, state: "installing" };
      } catch (err) {
        console.error(`[rosalena] update failed: ${err?.stack ?? err}`);
        const { response: next } = await box({
          type: "error",
          title: t("Update failed"),
          message: t("Rosalena Harness {version} could not be installed.", { version: verdict.latest }),
          detail: `${err.message}\n\n${t("Nothing was changed. You can download it from the release page instead.")}`,
          buttons: [t("Open release page"), t("Close")],
          defaultId: 0,
          cancelId: 1,
        });
        if (next === 0) await shell.openExternal(verdict.url);
        return { ...verdict, state: "unknown", reason: err.message };
      }
    } finally {
      busy = false;
    }
  }

  /** Background checks: once shortly after launch, then every six hours, both skippable by the floor. */
  async function start() {
    // Leftovers from an earlier update (the installer, an unpacked .app) are not needed now.
    await rm(downloadDir(), { recursive: true, force: true }).catch(() => {});
    if ((process.env.ROSALENA_NO_UPDATE_CHECK ?? "").trim() === "1") return;
    const tick = async () => {
      const { lastCheckedAt } = await readUpdateState();
      if (!shouldCheck({ lastCheckedAt, now: Date.now() })) return;
      await check({ interactive: false }).catch((err) => console.error(`[rosalena] update check failed: ${err?.message ?? err}`));
    };
    const first = setTimeout(() => void tick(), FIRST_CHECK_DELAY_MS);
    first.unref?.();
    timer = setInterval(() => void tick(), CHECK_EVERY_MS);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { check, start, stop };
}
