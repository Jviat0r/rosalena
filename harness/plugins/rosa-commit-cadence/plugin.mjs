// commit-cadence - commit small finished pieces on its own, save the big ones for one
// question at the end.
//
// The failure it exists for: on a long run the model stops every few changes to ask
// "shall I commit this?". The person says yes every time, but each question parks
// the run until they come back, which defeats "set it and leave it". Asking about
// nothing is just as bad: a large or risky change slips into history unreviewed.
//
// So the harness, not the model, decides how big a change is. The model calls
// `checkpoint` when a piece of work is finished and verified. The plugin reads the
// real diff from git and sorts it into one of three tiers:
//
//   small    committed straight away, scoped to this piece's files
//   large    parked: left in the working tree, uncommitted, and queued. The model is
//            told to carry on with the remaining work and ask ONCE, at the end, about
//            everything that was parked
//   blocked  never committed by the harness (a secret, a key file, a huge binary).
//            The model has to stop and tell the person
//
// Small models are bad at judging their own diffs, which is why the size check is a
// pure function of the diff (`classify`) and not a question to the model.
//
// Modes (per workspace, `/plugin rosa-commit-cadence:mode <mode>`):
//   off         the plugin never commits and tells the model not to ask either
//   ask         nothing is committed without the person; every checkpoint is parked,
//               so a long run still asks only once, at the end
//   loose       small: commit. large: park until the end. blocked: stop and ask
//   autonomous  small and large: commit. blocked: stop and ask. Pushes still ask
//
// What it never does, in any mode: push, amend, rebase, reset, or touch a file the
// person had uncommitted changes in when the run started without asking first.
// Commits carry a trailer so they are easy to find and squash later.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const MODES = ["off", "ask", "loose", "autonomous"];
export const DEFAULT_MODE = "ask";

export const DEFAULTS = Object.freeze({
  maxLines: 300, // added + deleted, across the checkpoint
  maxFiles: 12,
  maxDeletedFiles: 0, // deleting a file that existed before the run always waits for a person
  maxRunLines: 1000, // across every automatic commit in one run, so small commits cannot add up to an unreviewed rewrite
  maxRunFiles: 30,
  maxFileBytes: 5 * 1024 * 1024,
  trailer: "Rosalena-Checkpoint: auto",
});

// --------------------------------------------------------------------------- signals

/** Files whose contents are secrets: never committed by the harness. */
const SECRET_FILE = [
  /(^|\/)\.env(\.[^/]*)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|\/)credentials(\.json)?$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.envrc$/i,
  /(^|\/)service[-_]?account.*\.json$/i,
];
// `.env.example` and friends are templates, not secrets.
const SECRET_TEMPLATE = /(^|\/)\.env\.(example|sample|template|dist)$/i;

/** Secrets pasted into ordinary files. Deliberately narrow: a false alarm costs a question. */
const SECRET_TEXT = [
  { name: "private key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: "AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "GitHub token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/ },
  { name: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "Stripe secret key", re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/ },
  { name: "OpenAI/Anthropic-style API key", re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
];

/** Changes that deserve a human look even when they are small. Each has a reason. */
const SENSITIVE_PATHS = [
  { re: /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Gemfile\.lock|go\.sum|composer\.lock)$/i, why: "changes a dependency lockfile" },
  { re: /(^|\/)(migrations?|migrate)\//i, why: "adds or changes a database migration" },
  { re: /\.sql$|(^|\/)schema\.prisma$|(^|\/)drizzle\//i, why: "changes a database schema" },
  { re: /(^|\/)\.github\/workflows\/|(^|\/)\.gitlab-ci\.yml$|(^|\/)\.circleci\/|(^|\/)azure-pipelines\.yml$/i, why: "changes CI" },
  { re: /(^|\/)(Dockerfile|docker-compose[^/]*\.ya?ml|wrangler\.(toml|jsonc?)|vercel\.json|netlify\.toml|fly\.toml|render\.yaml|Procfile)$/i, why: "changes deploy or infrastructure config" },
  { re: /\.(tf|tfvars)$|(^|\/)(k8s|kubernetes|helm)\//i, why: "changes infrastructure" },
  { re: /(^|\/)(auth|security|permissions?|crypto)(\/|\.[a-z]+$)/i, why: "touches auth or security code" },
  { re: /(^|\/)\.gitignore$|(^|\/)\.gitattributes$|(^|\/)\.gitmodules$/i, why: "changes what git tracks" },
  // The paths Claude Code's auto mode never approves on its own: they run code or change tools.
  { re: /(^|\/)(\.husky|\.devcontainer|\.vscode|\.idea)\/|(^|\/)(\.pre-commit-config\.yaml|lefthook\.ya?ml|\.mcp\.json)$/i, why: "changes git hooks, editor or agent tooling that runs code" },
];

/** A manifest change is only "sensitive" when it touches dependencies, not a script line. */
const DEPENDENCY_LINE = /^[+-]\s*"(?:dependencies|devDependencies|peerDependencies|optionalDependencies|overrides|resolutions)"\s*:|^[+-]\s*"[@a-z0-9][^"]*"\s*:\s*"[~^<>=*]?\d/i;
const MANIFEST = /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|Cargo\.toml|go\.mod|Gemfile|composer\.json)$/i;

// --------------------------------------------------------------------------- pure functions

/**
 * Sort one checkpoint's changes into a tier. Pure, so every threshold is testable.
 *
 * `changes`: [{ path, status: "A"|"M"|"D"|"?", added, deleted, binary, bytes, mixed, diff }]
 *   mixed  the file had the person's own uncommitted edits when the run started
 *   diff   the added/removed lines ("+..."/"-..."), for the secret and dependency scans
 */
export function classify(changes, limits = {}) {
  const lim = { ...DEFAULTS, ...limits };
  const blocked = [];
  const large = [];
  const list = Array.isArray(changes) ? changes : [];

  let lines = 0;
  let deletedFiles = 0;
  for (const c of list) {
    const path = String(c.path ?? "").replace(/\\/g, "/");
    lines += (Number(c.added) || 0) + (Number(c.deleted) || 0);
    if (c.status === "D") deletedFiles += 1;

    if (c.status !== "D" && SECRET_FILE.some((re) => re.test(path)) && !SECRET_TEMPLATE.test(path)) {
      blocked.push(`${path} looks like a secrets or key file`);
    }
    const addedText = String(c.diff ?? "")
      .split("\n")
      .filter((l) => l.startsWith("+"))
      .join("\n");
    for (const s of SECRET_TEXT) {
      if (s.re.test(addedText)) blocked.push(`${path} adds what looks like a ${s.name}`);
    }
    if ((Number(c.bytes) || 0) > lim.maxFileBytes) {
      blocked.push(`${path} is ${(c.bytes / 1024 / 1024).toFixed(1)} MB`);
    }

    if (c.mixed) large.push(`${path} also has your own uncommitted edits from before the run`);
    for (const s of SENSITIVE_PATHS) if (s.re.test(path)) large.push(`${path} ${s.why}`);
    if (MANIFEST.test(path) && String(c.diff ?? "").split("\n").some((l) => DEPENDENCY_LINE.test(l))) {
      large.push(`${path} adds, removes or bumps a dependency`);
    }
    if (c.symlink) large.push(`${path} is a symbolic link`);
    if (c.executable) large.push(`${path} is being made executable`);
    if (c.binary && c.status !== "D" && !/\.(png|jpe?g|gif|webp|svg|ico|avif)$/i.test(path)) {
      large.push(`${path} is a binary file`);
    }
  }

  if (lines > lim.maxLines) large.push(`${lines} lines changed (the limit for an automatic commit is ${lim.maxLines})`);
  if (list.length > lim.maxFiles) large.push(`${list.length} files changed (the limit is ${lim.maxFiles})`);
  if (deletedFiles > lim.maxDeletedFiles) large.push(`deletes ${deletedFiles} file(s) that existed before the run`);
  // The run's running total: many small commits are still one big change.
  const runLines = (Number(limits.runLinesSoFar) || 0) + lines;
  const runFiles = (Number(limits.runFilesSoFar) || 0) + list.length;
  if (runLines > lim.maxRunLines) large.push(`this run has now changed ${runLines} lines in automatic commits (the limit per run is ${lim.maxRunLines})`);
  if (runFiles > lim.maxRunFiles) large.push(`this run has now committed ${runFiles} file changes automatically (the limit per run is ${lim.maxRunFiles})`);

  const uniq = (xs) => [...new Set(xs)];
  if (blocked.length) return { tier: "blocked", reasons: uniq(blocked), lines, files: list.length };
  if (large.length) return { tier: "large", reasons: uniq(large), lines, files: list.length };
  return { tier: "small", reasons: [], lines, files: list.length };
}

/** Package names a manifest change adds or bumps: `+ "left-pad": "1.3.0"`, `+requests==2.32`. */
export function addedDependencies(changes) {
  const names = new Set();
  for (const c of Array.isArray(changes) ? changes : []) {
    if (!MANIFEST.test(String(c.path ?? "").replace(/\\/g, "/"))) continue;
    for (const line of String(c.diff ?? "").split("\n")) {
      const js = /^\+\s*"([@a-z0-9][^"]*)"\s*:\s*"[~^<>=*]?\d/i.exec(line);
      if (js && !/^(version|node|npm)$/i.test(js[1])) names.add(js[1]);
      const py = /^\+\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(?:==|>=|~=|<=|>|<)/.exec(line);
      if (py && /requirements[^/]*\.txt$/i.test(c.path)) names.add(py[1]);
    }
  }
  return [...names];
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function importsAny(diff, names) {
  const added = String(diff ?? "").split("\n").filter((l) => l.startsWith("+")).join("\n");
  return names.find((name) => {
    const n = escapeRe(name);
    return new RegExp(`(?:from\\s+|require\\(\\s*|import\\s+|import\\(\\s*)['"]${n}(?:['"/])`).test(added) ||
      new RegExp(`^\\+\\s*(?:import|from)\\s+${escapeRe(name.replace(/-/g, "_"))}\\b`, "m").test(added);
  });
}

/**
 * Split a checkpoint that mixes a big change with small ones. Pure. A file is risky when it
 * would be held on its own for a reason other than size (a dependency, a migration, CI,
 * auth, a deletion...). A file that imports a dependency this checkpoint adds goes with the
 * manifest: committing pad.js without the package.json line for left-pad breaks the commit.
 * Returns { risky, rest, reasons } (paths).
 */
export function splitRisky(changes, limits = {}) {
  const list = Array.isArray(changes) ? changes : [];
  const alone = { ...limits, maxLines: Infinity, maxFiles: Infinity, maxRunLines: Infinity, maxRunFiles: Infinity, runLinesSoFar: 0, runFilesSoFar: 0 };
  const risky = new Set();
  const reasons = [];
  for (const c of list) {
    const v = classify([c], alone);
    if (v.tier !== "small") {
      risky.add(c.path);
      reasons.push(...v.reasons);
    }
  }
  const deps = addedDependencies(list);
  for (const c of list) {
    if (risky.has(c.path) || !deps.length) continue;
    const name = importsAny(c.diff, deps);
    if (name) {
      risky.add(c.path);
      reasons.push(`${c.path} uses ${name}, which this change adds`);
    }
  }
  return { risky: list.filter((c) => risky.has(c.path)).map((c) => c.path), rest: list.filter((c) => !risky.has(c.path)).map((c) => c.path), reasons: [...new Set(reasons)] };
}

/** A command that checks the work: its passing is the moment a piece is finished. */
export const CHECK_COMMAND = /\b(test|tests|build|lint|typecheck|type-check|tsc|check|pytest|vitest|jest|mocha|playwright|ruff|mypy|eslint|clippy|go (?:test|vet|build)|cargo (?:test|build|check)|mvn|gradle)\b/i;

/** What happens to a classified checkpoint in each mode. */
export function decideAction(mode, tier) {
  if (mode === "off") return "skip";
  if (tier === "blocked") return "stop";
  if (mode === "ask") return "park";
  if (mode === "loose") return tier === "small" ? "commit" : "park";
  if (mode === "autonomous") return "commit";
  return "park";
}

/**
 * Was the person's reply a clear yes to the parked commits? Anything unclear is a no:
 * committing by mistake is worse than asking again.
 */
export function isAffirmative(text) {
  const t = String(text ?? "").trim().toLowerCase();
  if (!t || t.length > 200) return false;
  if (/\b(no|nope|not|don'?t|do not|wait|hold|stop|later|cancel|never)\b/.test(t)) return false;
  // "ok skip for now", "sure, leave them": a yes-word in front of a put-off is a no.
  if (isDeferral(t)) return false;
  return /^(y|ya|yes|yep|yeah|yup|sure|ok|okay|k|go|go ahead|do it|approved?|lgtm|ship it|commit( them| it| all| everything)?|please do|sounds good)\b/.test(t);
}

/**
 * Did the person put the held-back commits off ("skip for now", "not now", "don't commit",
 * "stop asking")? Measured 2026-11-08: after "skip for now just use the mcp like i asked"
 * every later run asked about the same two commits again instead of doing the request.
 */
export function isDeferral(text) {
  const t = String(text ?? "").trim().toLowerCase();
  // Said about the commits: "don't commit", "no commits", "stop asking", "skip the commits".
  if (/\b(don'?t commit|do not commit|no commits?|stop asking|hold off|forget (about )?(the )?commits?|ignore (the )?commits?|(skip|leave) (the |those |these )?(commits?|changes)|commit (them )?later)\b/.test(t)) return true;
  // Or a reply that opens with a put-off ("skip for now, just use the mcp", "not now",
  // "later"). A bare "later" mid-sentence ("tests later") is about something else.
  return /^(ok,?\s+|okay,?\s+|sure,?\s+|yes,?\s+|no,?\s+)?(skip|not now|later|leave (them|it|those)|nah|no thanks)\b/.test(t);
}

/** Which held-back set a "not now" was about: a new one is worth one question again. */
export const parkedSignature = (parked) => (parked ?? []).map((p) => p.id ?? p.message).join("|");

/** True while the person's "not now" still covers everything that is held back. */
export const deferredNow = (state) => Boolean(state?.parked?.length) && state.deferred === parkedSignature(state.parked);

/** `git status --porcelain=v1 -z --no-renames` -> [{ path, status }]. */
export function parsePorcelain(text) {
  const out = [];
  for (const entry of String(text ?? "").split("\0")) {
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    const status = xy === "??" ? "?" : xy.includes("D") ? "D" : xy.includes("A") ? "A" : "M";
    out.push({ path, status });
  }
  return out;
}

/** `git diff --numstat -z --no-renames` -> Map(path -> { added, deleted, binary }). */
export function parseNumstat(text) {
  const map = new Map();
  for (const entry of String(text ?? "").split("\0")) {
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(entry.replace(/^\n/, ""));
    if (!m) continue;
    const binary = m[1] === "-";
    map.set(m[3], { added: binary ? 0 : Number(m[1]), deleted: binary ? 0 : Number(m[2]), binary });
  }
  return map;
}

export function renderParked(parked) {
  if (!parked.length) return "nothing is parked";
  return parked
    .map((p, i) => `${i + 1}. "${p.message}" - ${p.paths.length} file(s), ${p.lines} line(s)\n   why it waited: ${p.reasons.join("; ")}\n   files: ${p.paths.slice(0, 12).join(", ")}${p.paths.length > 12 ? ", ..." : ""}`)
    .join("\n");
}

// --------------------------------------------------------------------------- git

function git(root, args, { input } = {}) {
  const res = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 * 1024, input });
  return { ok: res.status === 0, out: res.stdout ?? "", err: (res.stderr ?? "").trim() || (res.error ? String(res.error.message) : "") };
}

function repoInfo(root) {
  // One git process for both paths: each spawn costs a few hundred ms on Windows.
  const paths = git(root, ["rev-parse", "--show-toplevel", "--absolute-git-dir"]);
  if (!paths.ok) return null;
  const [top = "", gitDir = ""] = paths.out.split(/\r?\n/).map((line) => line.trim());
  const head = git(root, ["rev-parse", "--verify", "-q", "HEAD"]);
  return { top, gitDir, hasHead: head.ok };
}

// The hooks ask "which repo is this?" at run start and again before step 1; the answer
// (top and git dir) does not change inside a run, so they share it for a few seconds
// instead of spawning git again. The checkpoint tool keeps calling repoInfo fresh:
// hasHead flips when it makes the first commit.
const repoCache = new Map();
function repoInfoForHooks(root) {
  const key = String(root ?? "");
  const hit = repoCache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.info;
  const info = repoInfo(root);
  repoCache.set(key, { info, at: Date.now() });
  return info;
}

function dirty(top) {
  const res = git(top, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
  return res.ok ? parsePorcelain(res.out) : [];
}

function hashFile(top, path) {
  const abs = join(top, path);
  if (!existsSync(abs)) return "deleted";
  try {
    return createHash("sha1").update(readFileSync(abs)).digest("hex");
  } catch {
    return "unreadable";
  }
}

function isBinaryBuffer(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true;
  return false;
}

/** Everything `classify` needs to know about these paths, read from git and the disk. */
function describe(top, entries, { hasHead, mixed }) {
  const tracked = entries.filter((e) => e.status !== "?").map((e) => e.path);
  const stats = tracked.length && hasHead ? parseNumstat(git(top, ["diff", "--numstat", "-z", "--no-renames", "HEAD", "--", ...tracked]).out) : new Map();
  const patch = tracked.length && hasHead ? git(top, ["diff", "-U0", "--no-renames", "--no-color", "HEAD", "--", ...tracked]).out : "";
  // "mode change 100644 => 100755 path": a file that becomes executable.
  const summary = tracked.length && hasHead ? git(top, ["diff", "--summary", "--no-renames", "HEAD", "--", ...tracked]).out : "";
  const madeExecutable = new Set([...summary.matchAll(/mode change 100644 => 100755 (.+)$/gm)].map((m) => m[1].trim()));
  const patchByFile = new Map();
  let current = null;
  for (const line of patch.split("\n")) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) {
      current = header[2];
      patchByFile.set(current, []);
    } else if (current && /^[+-]/.test(line) && !/^(\+\+\+|---) /.test(line)) {
      patchByFile.get(current).push(line);
    }
  }

  return entries.map((e) => {
    const abs = join(top, e.path);
    let bytes = 0;
    let added = 0;
    let deleted = 0;
    let binary = false;
    let diff = (patchByFile.get(e.path) ?? []).join("\n");
    if (e.status === "?" || (e.status === "A" && !stats.has(e.path)) || !hasHead) {
      try {
        const buf = readFileSync(abs);
        bytes = buf.length;
        binary = isBinaryBuffer(buf);
        if (!binary) {
          const text = buf.subarray(0, 1024 * 1024).toString("utf8");
          const lines = text.split("\n");
          if (lines.at(-1) === "") lines.pop(); // a final newline ends a line, it does not start one
          added = lines.length;
          diff = lines.map((l) => `+${l}`).join("\n");
        }
      } catch {
        /* vanished between status and read: counted as zero */
      }
    } else {
      const s = stats.get(e.path) ?? { added: 0, deleted: 0, binary: false };
      ({ added, deleted, binary } = s);
      try {
        bytes = e.status === "D" ? 0 : statSync(abs).size;
      } catch {
        bytes = 0;
      }
    }
    let symlink = false;
    try {
      symlink = e.status !== "D" && lstatSync(abs).isSymbolicLink();
    } catch {
      /* gone */
    }
    return { ...e, added, deleted, binary, bytes, diff, symlink, executable: madeExecutable.has(e.path), mixed: mixed.has(e.path) };
  });
}

function commit(top, paths, message, trailer) {
  const add = git(top, ["add", "-A", "--", ...paths]);
  if (!add.ok) return { ok: false, err: `git add failed: ${add.err}` };
  const body = trailer ? `${message.trim()}\n\n${trailer}` : message.trim();
  // --only (the default with paths) commits exactly these paths and leaves anything
  // else the person staged where it was. Hooks run: their repo, their rules.
  const res = git(top, ["commit", "--only", "-F", "-", "--", ...paths], { input: body });
  if (!res.ok) return { ok: false, err: res.err || res.out.trim() };
  const sha = git(top, ["rev-parse", "--short", "HEAD"]).out.trim();
  return { ok: true, sha };
}

// --------------------------------------------------------------------------- state

/** Per repository, inside .git so it can never be committed. */
function statePath(gitDir) {
  return join(gitDir, "rosalena", "commit-cadence.json");
}
function readState(gitDir) {
  try {
    const parsed = JSON.parse(readFileSync(statePath(gitDir), "utf8"));
    return { baseline: {}, parked: [], awaiting: false, ...parsed };
  } catch {
    return { baseline: {}, parked: [], awaiting: false };
  }
}
function writeState(gitDir, state) {
  const file = statePath(gitDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2));
}

/** The mode per workspace, in ~/.rosalena so it follows the person, not the repo. */
function modesFile() {
  return join(process.env.ROSALENA_HOME || join(homedir(), ".rosalena"), "commit-cadence.json");
}
export function readMode(root, fallback = DEFAULT_MODE) {
  try {
    const parsed = JSON.parse(readFileSync(modesFile(), "utf8"));
    const mode = parsed?.workspaces?.[resolve(root)] ?? parsed?.default;
    return MODES.includes(mode) ? mode : fallback;
  } catch {
    return fallback;
  }
}
export function writeMode(root, mode, { asDefault = false } = {}) {
  const file = modesFile();
  let parsed = {};
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    /* first write */
  }
  if (asDefault) parsed.default = mode;
  else parsed.workspaces = { ...(parsed.workspaces ?? {}), [resolve(root)]: mode };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(parsed, null, 2));
}

/**
 * Files this run changed that no checkpoint has dealt with: uncommitted, not held back, and
 * not the person's own work from before the run (unless the run changed it on top).
 */
function unsaved(top, state) {
  const parked = new Set(state.parked.flatMap((p) => p.paths));
  return dirty(top)
    .filter((e) => !parked.has(e.path))
    .filter((e) => state.baseline?.[e.path] === undefined || state.baseline[e.path] !== hashFile(top, e.path))
    .map((e) => e.path);
}
const listFiles = (paths) => `${paths.slice(0, 12).join(", ")}${paths.length > 12 ? `, and ${paths.length - 12} more` : ""}`;

/** What the composer's Commits menu shows: the mode here, whether it is a repo, what waits. */
export function commitStatus(root, fallback = DEFAULT_MODE) {
  const info = repoInfo(root);
  return { mode: readMode(root, fallback), git: Boolean(info), held: info ? readState(info.gitDir).parked.length : 0 };
}

const lastUserText = (messages) => {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) return m.content.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join(" ");
  }
  return "";
};

// --------------------------------------------------------------------------- the plugin

/**
 * Plugins load once per server, but each chat can work in its own folder and a tool's
 * run() is not told which. The top-level run's root is recorded at onRunStart.
 */
let activeRoot = null;

/** Does the running engine call a hook by this name? Older builds refuse unknown hooks. */
async function engineHasHook(name) {
  try {
    const mod = await import(new URL("../../src/plugins.mjs", import.meta.url).href);
    return Array.isArray(mod.HOOK_NAMES) && mod.HOOK_NAMES.includes(name);
  } catch {
    return false;
  }
}

const plugin = {
  id: "rosa-commit-cadence",
  description: "Commits small finished pieces itself and saves big changes for one question at the end",

  async setup(ctx) {
    ctx.hasBeforeFinish = await engineHasHook("beforeFinish");
    // `checkpoint` only runs git inside the workspace repo. Without this, workspace mode
    // (the default) asks before every call, which is the interruption this plugin removes.
    try {
      const permissions = await import(new URL("../../src/permissions.mjs", import.meta.url).href);
      if (typeof permissions.registerWorkspaceTool === "function") permissions.registerWorkspaceTool("checkpoint");
    } catch {
      /* older engine: checkpoint asks once per chat in workspace mode until "Always allow" */
    }
  },

  tools(ctx) {
    const limits = { ...DEFAULTS, ...ctx.config };
    const workspace = () => activeRoot ?? ctx.harness?.workspace ?? ctx.root;

    const approveParked = (top, gitDir, state) => {
      const done = [];
      const failed = [];
      for (const p of state.parked) {
        const still = p.paths.filter((path) => dirty(top).some((d) => d.path === path));
        if (!still.length) {
          done.push(`"${p.message}": nothing left to commit (already committed or reverted)`);
          continue;
        }
        const res = commit(top, still, p.message, limits.trailer);
        if (res.ok) done.push(`${res.sha} "${p.message}"`);
        else failed.push({ ...p, error: res.err });
      }
      state.parked = failed.map(({ error, ...p }) => p);
      state.awaiting = false;
      state.approved = false;
      writeState(gitDir, state);
      return [
        done.length ? `committed:\n${done.join("\n")}` : "",
        failed.length ? `could not commit:\n${failed.map((f) => `"${f.message}": ${f.error}`).join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    };

    return [
      {
        name: "checkpoint",
        description:
          "Save finished, verified work as a git commit. Call it after each finished piece of work (tests or build passed), " +
          "with a conventional commit message. The harness checks the size of the change: small changes are committed now, " +
          "big or risky ones are held back until the end of the task. Never run `git commit` yourself and never ask the user " +
          "whether to commit; this tool decides. action 'review' (once, at the end) lists everything held back.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["commit", "review", "approve", "status"], description: "Default commit." },
            message: { type: "string", description: "Conventional commit message, e.g. 'fix(nav): close the menu on route change'." },
            files: { type: "array", items: { type: "string" }, description: "Optional: only these paths. Default: every file this run changed." },
          },
        },
        async run(args = {}) {
          const root = workspace();
          const mode = readMode(root, MODES.includes(ctx.config.mode) ? ctx.config.mode : DEFAULT_MODE);
          const info = repoInfo(root);
          if (!info) return "not a git repository: nothing to checkpoint. Do not run git init unless the user asked for it.";
          const { top, gitDir, hasHead } = info;
          const state = readState(gitDir);
          const action = args.action ?? "commit";

          if (action === "status") {
            return `mode: ${mode}\nparked:\n${renderParked(state.parked)}`;
          }

          if (action === "review") {
            // A model that never called checkpoint reaches review with all its work loose;
            // "nothing is waiting" would end the run with none of it committed.
            const loose = mode === "off" ? [] : unsaved(top, state);
            if (loose.length) {
              return [
                `${loose.length} file(s) changed in this run are not checkpointed yet: ${listFiles(loose)}.`,
                "Call checkpoint for each finished piece first (pass `files` to keep unrelated work apart), then call review again.",
                "If some of them should stay uncommitted, say which and why in your final answer.",
              ].join("\n");
            }
            if (!state.parked.length) return "nothing is waiting for approval. Give your final answer.";
            if (deferredNow(state)) {
              return "The user already said not now to these held-back changes. Do not ask about them again and do not mention them: answer the user's latest message.";
            }
            state.awaiting = true;
            writeState(gitDir, state);
            return [
              `${state.parked.length} change(s) were held back for the user's approval:`,
              renderParked(state.parked),
              "",
              "Now call ask_user ONCE with a short summary of the list above and the options " +
                '["Commit them", "Not now"]. Do not commit anything yourself.',
            ].join("\n");
          }

          if (action === "approve") {
            if (!state.parked.length) return "nothing is parked.";
            if (!state.approved) {
              return "the user has not approved these yet. Call checkpoint with action 'review', then ask_user, and wait for their answer.";
            }
            return approveParked(top, gitDir, state);
          }

          // action: commit
          if (mode === "off") return "commits are turned off for this workspace. Do not commit and do not ask about committing.";
          const message = String(args.message ?? "").trim();
          if (!message) throw new Error("message is required: a conventional commit message for this piece of work");

          const parkedPaths = new Set(state.parked.flatMap((p) => p.paths));
          const wanted = Array.isArray(args.files) && args.files.length
            ? new Set(args.files.map((f) => relative(top, isAbsolute(f) ? f : resolve(root, f)).replace(/\\/g, "/")))
            : null;

          const changedNow = dirty(top);
          const mixed = new Set();
          const absorbed = [];
          const candidates = [];
          for (const entry of changedNow) {
            if (wanted && !wanted.has(entry.path)) continue;
            if (parkedPaths.has(entry.path)) {
              if (wanted) absorbed.push(entry.path);
              continue;
            }
            const before = state.baseline[entry.path];
            if (before !== undefined) {
              // The person's own work from before the run: leave it alone unless the
              // run changed it on top, and even then only with their approval.
              if (before === hashFile(top, entry.path)) continue;
              mixed.add(entry.path);
            }
            candidates.push(entry);
          }

          if (absorbed.length) {
            const target = state.parked.find((p) => p.paths.some((path) => absorbed.includes(path)));
            if (target) target.message = `${target.message}; ${message}`;
            writeState(gitDir, state);
          }
          if (!candidates.length) {
            return absorbed.length
              ? `these files belong to a change that is already held back, so this work joins it: ${absorbed.join(", ")}. Continue with the next task.`
              : "nothing new to commit since the last checkpoint.";
          }

          const described = describe(top, candidates, { hasHead, mixed });
          const verdict = classify(described, { ...limits, runLinesSoFar: state.runLines ?? 0, runFilesSoFar: state.runFiles ?? 0 });
          const act = decideAction(mode, verdict.tier);
          const paths = candidates.map((c) => c.path);

          if (act === "stop") {
            return [
              "NOT COMMITTED - this needs the user:",
              ...verdict.reasons.map((r) => `- ${r}`),
              "Stop and tell the user exactly which file and why. Do not commit it, do not delete it, and do not put the value anywhere else.",
            ].join("\n");
          }

          // Loose mode, one checkpoint holding a big change and small ones: holding it all
          // would hold the small work too. Ask for two calls so each commit's message fits
          // its files. Asked once per set: the same set again is held whole, as before.
          if (act === "park" && mode === "loose") {
            const split = splitRisky(described, limits);
            const restChanges = described.filter((c) => split.rest.includes(c.path));
            const restVerdict = classify(restChanges, { ...limits, runLinesSoFar: state.runLines ?? 0, runFilesSoFar: state.runFiles ?? 0 });
            const signature = [...paths].sort().join("\n");
            if (split.risky.length && split.rest.length && restVerdict.tier === "small" && state.splitAsked !== signature) {
              state.splitAsked = signature;
              writeState(gitDir, state);
              return [
                "NOT COMMITTED YET - this checkpoint mixes a big change with small ones. Split it into two calls:",
                `1. checkpoint { "files": ${JSON.stringify(split.rest)}, "message": "<what these files change>" } - small: committed now`,
                `2. checkpoint { "files": ${JSON.stringify(split.risky)}, "message": "<what these files change>" } - big: held for the user's approval at the end`,
                "Why the second group is big:",
                ...split.reasons.map((r) => `- ${r}`),
              ].join("\n");
            }
          }

          if (act === "park") {
            state.parked.push({ id: Date.now().toString(36), message, paths, reasons: verdict.reasons.length ? verdict.reasons : ["this workspace asks before every commit"], lines: verdict.lines, at: new Date().toISOString() });
            writeState(gitDir, state);
            return [
              `HELD BACK for approval at the end (${verdict.files} file(s), ${verdict.lines} line(s)).`,
              ...(verdict.reasons.length ? verdict.reasons.map((r) => `- ${r}`) : [`- the commit mode here is "${mode}"`]),
              "Leave these files as they are and carry on with the remaining tasks: do the smaller, independent work first.",
              "When everything else is finished, call checkpoint with action 'review' and ask the user once.",
            ].join("\n");
          }

          const res = commit(top, paths, message, limits.trailer);
          if (res.ok) {
            state.runLines = (state.runLines ?? 0) + verdict.lines;
            state.runFiles = (state.runFiles ?? 0) + verdict.files;
            writeState(gitDir, state);
          }
          if (!res.ok) return `commit failed, nothing was committed: ${res.err}\nFix the cause (often a pre-commit hook) or report it. Do not bypass hooks.`;
          const big = verdict.tier === "large" ? `\nnote for the final summary: this was a large change (${verdict.reasons.join("; ")})` : "";
          return `committed ${res.sha}: ${message} (${verdict.files} file(s), ${verdict.lines} line(s)). Continue with the next task.${big}`;
        },
      },
    ];
  },

  commands(ctx) {
    const root = () => activeRoot ?? ctx.harness?.workspace ?? ctx.root;
    return {
      mode: async (argv = []) => {
        const [mode, scope] = argv;
        if (!mode) return `commit mode here: ${readMode(root())}. Choose one of: ${MODES.join(", ")} (add "default" to set it for every workspace)`;
        if (!MODES.includes(mode)) return `unknown mode "${mode}". Choose one of: ${MODES.join(", ")}`;
        writeMode(root(), mode, { asDefault: scope === "default" });
        return `commit mode ${scope === "default" ? "default" : "for this workspace"}: ${mode}`;
      },
      status: async () => {
        const info = repoInfo(root());
        if (!info) return "not a git repository";
        return `mode: ${readMode(root())}\nparked:\n${renderParked(readState(info.gitDir).parked)}`;
      },
      // The person typing this IS the approval: no model in between.
      approve: async () => {
        const info = repoInfo(root());
        if (!info) return "not a git repository";
        const state = readState(info.gitDir);
        state.approved = true;
        writeState(info.gitDir, state);
        // `plugin`, not `this`: the loader may call commands() detached from the object.
        const tool = plugin.tools(ctx)[0];
        return tool.run({ action: "approve" });
      },
    };
  },

  hooks(ctx) {
    const hooks = {
      async onRunStart({ root, messages, depth }) {
        if (depth > 0) return; // delegated workers share the parent's tree and state
        if (root) activeRoot = root;
        const info = repoInfoForHooks(root ?? ctx.root);
        if (!info) return;
        const state = readState(info.gitDir);

        // The person answered the end-of-run question: read their words here, in the
        // harness, so the model cannot approve on their behalf.
        const reply = lastUserText(messages);
        if (state.awaiting) {
          state.approved = isAffirmative(reply);
          state.awaiting = false;
          // Anything but a clear yes is a "not now" for this set: it is not asked about
          // again until something new is held back.
          if (!state.approved) state.deferred = parkedSignature(state.parked);
        } else if (state.parked.length && isDeferral(reply) && !isAffirmative(reply)) {
          state.approved = false;
          state.deferred = parkedSignature(state.parked);
        } else if (state.parked.length && isAffirmative(reply) && /\bcommit\b/.test(String(reply).toLowerCase())) {
          // "commit them now" after an earlier "not now": the person's own words approve
          // the held-back set; before, review kept answering "already said not now".
          state.approved = true;
          state.deferred = null;
        }

        // Baseline: whatever is uncommitted now and not ours is the person's work.
        const parked = new Set(state.parked.flatMap((p) => p.paths));
        const baseline = {};
        for (const entry of dirty(info.top).slice(0, 2000)) {
          if (!parked.has(entry.path)) baseline[entry.path] = hashFile(info.top, entry.path);
        }
        state.baseline = baseline;
        state.runLines = 0;
        state.runFiles = 0;
        writeState(info.gitDir, state);
      },

      async beforeStep({ run, step, root }) {
        const nudge = run.state.get("nudge");
        if (nudge?.length) {
          run.state.set("nudge", null);
          return `Checks just passed, and ${nudge.length} file(s) changed since the last checkpoint: ${listFiles(nudge)}. ` +
            "If they make up a finished piece, call checkpoint now with a message for that piece (pass `files` to leave out unfinished work), then carry on with the next task. Do not ask the user.";
        }
        if (step !== 1 || run.state.get("told")) return;
        const info = repoInfoForHooks(root ?? ctx.root);
        if (!info) return;
        const state = readState(info.gitDir);
        if (!state.parked.length) return;
        run.state.set("told", true);
        if (state.approved) {
          return "The user approved the held-back commits. Call checkpoint with action 'approve' now, then continue with their message.";
        }
        if (deferredNow(state)) {
          return "The user said not now to the held-back commits. Do not mention them, do not ask about committing, and do not call checkpoint review: do what the user's latest message asks.";
        }
        return `${state.parked.length} change(s) are still held back for approval (checkpoint action 'status' lists them). Follow the user's latest message; do not commit them unless they clearly said to.`;
      },

      // Commit as you go, driven by the harness rather than the model's memory: a check
      // command that passes with uncheckpointed work around is when a piece is finished.
      // A local model told this by the skill still did all the work and never committed
      // (2026-11-03); told at the moment, in the step after its tests pass, it acts on it.
      async afterStep({ run, root, depth, toolCallKeys = [], toolResults = [] }) {
        if (depth > 0) return;
        if (toolCallKeys.some((k) => String(k).startsWith("checkpoint("))) {
          run.state.set("nudge", null);
          return;
        }
        const passed = toolResults.some((r, i) => r?.name === "run_command" && r.exit === 0 && CHECK_COMMAND.test(String(toolCallKeys[i] ?? "")));
        if (!passed) return;
        if (readMode(root ?? ctx.root, ctx.config.mode) === "off") return;
        const info = repoInfo(root ?? ctx.root);
        if (!info) return;
        const files = unsaved(info.top, readState(info.gitDir));
        if (!files.length) return;
        const signature = [...files].sort().join("\n");
        if (run.state.get("nudgedFor") === signature) return; // the same files: it already heard
        run.state.set("nudgedFor", signature);
        run.state.set("nudge", files);
      },
    };

    if (ctx.hasBeforeFinish) {
      // Needs the engine's beforeFinish hook (proposals/engine-patches/before-finish.md).
      hooks.beforeFinish = async ({ run, root, depth }) => {
        if (depth > 0 || run.state.get("reviewNudged")) return;
        const mode = readMode(root ?? ctx.root, ctx.config.mode);
        if (mode === "off") return;
        const info = repoInfo(root ?? ctx.root);
        if (!info) return;
        const state = readState(info.gitDir);
        const loose = unsaved(info.top, state);
        if (loose.length) {
          run.state.set("reviewNudged", true);
          return `Before you finish: ${loose.length} file(s) changed in this run are not checkpointed: ${listFiles(loose)}. ` +
            "Call checkpoint for each finished piece (pass `files` to keep unrelated work apart), then call checkpoint with action 'review' and, if anything is held back, ask_user once.";
        }
        if (!state.parked.length || state.awaiting || deferredNow(state)) return;
        run.state.set("reviewNudged", true);
        return `Before you finish: ${state.parked.length} change(s) are held back for approval. Call checkpoint with action 'review', then ask_user once.`;
      };
    }
    return hooks;
  },

  status(ctx) {
    return `mode ${readMode(activeRoot ?? ctx.harness?.workspace ?? ctx.root, ctx.config.mode)}`;
  },
};

export default plugin;
