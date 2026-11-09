// The Terminal tab: a shell the person drives from the window, the way Claude's desktop app
// has one. It is the person's own console, not a model tool: nothing the agent does reaches
// it, and every write needs the page token, like every other mutating route.
//
// No pseudo-terminal: node-pty is a native module this build does not ship, so the shell
// runs on pipes. Line-oriented commands (dir, git, npm, node, python) work as in any
// console; full-screen programs (vim, htop) need a real TTY and will not draw.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";

const MAX_BUFFER = 256 * 1024; // what a reconnecting tab gets replayed
const MAX_SESSIONS = 16;

export const SHELLS = process.platform === "win32" ? ["cmd", "powershell"] : ["sh", "bash"];

function shellCommand(shell) {
  if (process.platform === "win32") {
    // PowerShell reading commands from stdin prints no prompt, so the page shows its own.
    if (shell === "powershell") return { file: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NoExit", "-Command", "-"] };
    return { file: process.env.ComSpec || "cmd.exe", args: ["/Q", "/K"] };
  }
  if (shell === "bash" && existsSync("/bin/bash")) return { file: "/bin/bash", args: ["-i"] };
  return { file: "/bin/sh", args: ["-i"] };
}

/** Kill a shell and everything it started: a hung `npm run dev` must not outlive the tab. */
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

export function createTerminals({ workspace = process.cwd() } = {}) {
  const sessions = new Map();

  function emit(session, event) {
    if (event.type === "out") {
      session.buffer += event.data;
      if (session.buffer.length > MAX_BUFFER) session.buffer = session.buffer.slice(-MAX_BUFFER);
    }
    for (const send of session.subscribers) send(event);
  }

  function open({ shell, cwd, tag = null } = {}) {
    if (sessions.size >= MAX_SESSIONS) {
      // The oldest finished one goes first; failing that, refuse rather than pile up shells.
      const done = [...sessions.values()].find((s) => s.exited);
      if (done) sessions.delete(done.id);
      else throw new Error(`at most ${MAX_SESSIONS} terminals at once; close one first`);
    }
    const name = SHELLS.includes(shell) ? shell : SHELLS[0];
    let dir = String(cwd ?? "").trim() || workspace;
    try {
      if (!statSync(dir).isDirectory()) dir = workspace;
    } catch {
      dir = workspace;
    }
    const { file, args } = shellCommand(name);
    const child = spawn(file, args, {
      cwd: dir,
      env: { ...process.env, TERM: "dumb", PYTHONUNBUFFERED: "1", FORCE_COLOR: "0" },
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const session = { id: randomBytes(6).toString("hex"), tag: tag ? String(tag) : null, shell: name, cwd: dir, child, buffer: "", subscribers: new Set(), exited: null, at: Date.now() };
    sessions.set(session.id, session);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data) => emit(session, { type: "out", data }));
    child.stderr.on("data", (data) => emit(session, { type: "out", data }));
    child.on("error", (err) => emit(session, { type: "out", data: `\r\n[could not start ${file}: ${err.message}]\r\n` }));
    child.on("exit", (code, signal) => {
      session.exited = { code, signal };
      emit(session, { type: "exit", code, signal });
    });
    child.stdin.on("error", () => {}); // writing to a shell that just exited is not a crash
    return describe(session);
  }

  function describe(s) {
    return { id: s.id, tag: s.tag ?? null, shell: s.shell, cwd: s.cwd, at: s.at, exited: s.exited };
  }

  function get(id) {
    return sessions.get(String(id ?? "")) ?? null;
  }

  function write(id, data) {
    const s = get(id);
    if (!s) throw new Error(`no terminal "${id}"`);
    if (s.exited) throw new Error("this terminal has exited; open a new one");
    const text = String(data ?? "");
    if (text.length > 64 * 1024) throw new Error("input over 64 KB");
    s.child.stdin.write(text);
    return true;
  }

  /** Stop what is running: the whole tree goes, and the tab can open a fresh shell. */
  function close(id) {
    const s = get(id);
    if (!s) return false;
    killTree(s.child);
    sessions.delete(s.id);
    return true;
  }

  /** Which chat a shell belongs to: a new chat's shells move to its thread on the first send. */
  function retag(id, tag) {
    const s = get(id);
    if (!s) return false;
    s.tag = tag ? String(tag) : null;
    return true;
  }

  function subscribe(id, send) {
    const s = get(id);
    if (!s) return null;
    if (s.buffer) send({ type: "out", data: s.buffer, replay: true });
    if (s.exited) send({ type: "exit", ...s.exited });
    s.subscribers.add(send);
    return () => s.subscribers.delete(send);
  }

  function list() {
    return [...sessions.values()].map(describe);
  }

  function closeAll() {
    for (const s of sessions.values()) killTree(s.child);
    sessions.clear();
  }

  return { open, write, close, retag, subscribe, list, closeAll, get };
}
