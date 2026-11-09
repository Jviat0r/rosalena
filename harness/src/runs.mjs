// Persistent run store — what makes a task inspectable by ANOTHER process.
//
// A run used to exist only as stdout: when the process ended, everything it did was
// gone unless a human had copied it. Any interop story ("Claude Code can start a task
// and read what happened") needs a record that outlives the process, so every run now
// writes three things under `<ROSALENA_HOME>/runs`:
//
//   <runId>.jsonl  one JSON line per event, appended as the run happens — this is what
//                  a poller watches, and it exists DURING the run
//   <runId>.json   the final record (task, outcome, steps, answer, timings)
//   index.jsonl    one summary line per finished run, so listing does not have to open
//                  every file
//
// Deliberate properties:
//   - the id is chosen by the CALLER when it needs to (a parent that spawns a run must
//     know the id before the child finishes, or it cannot poll it) — see `newRunId`.
//   - nothing here may fail a run. A read-only or missing data directory turns the
//     store into a no-op that reports why, rather than throwing into the agent loop.
//   - readers are tolerant: a half-written line (the process died mid-append) is
//     skipped, not fatal, because that is exactly the run whose record matters.

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rosalenaHome } from "./memory.mjs";

export const DEFAULT_RUNS_DIR = join(rosalenaHome(), "runs");

/**
 * How long a run with events but no record stays "running" before it is reported as
 * `stale`. A run that is really going appends events; a run whose process was killed
 * stops appending and can never write its record, so its log would otherwise claim
 * "running" forever (there is one such orphan in `data\runs` from a killed process).
 * 30 minutes is longer than any single step the agent allows itself, so a live run
 * cannot be mistaken for a dead one.
 */
export function staleMs() {
  const raw = Number(process.env.ROSALENA_RUN_STALE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30 * 60 * 1000;
}

/**
 * Explicit dir > `ROSALENA_RUNS` > `<ROSALENA_HOME>/runs`. Read per call, not per import.
 *
 * Inside the node test runner (it sets NODE_TEST_CONTEXT in every test process) with no
 * ROSALENA_RUNS, the default is a throwaway folder, not the real store. test/isolate.mjs
 * did this only for `npm test`; a plain `node --test`, run by a person or by the agent
 * from inside the app (which hands its own ROSALENA_HOME down), wrote 212 fake chats
 * ("x", "do it", "write a big file") into the app's Recent list on 2026-11-06.
 */
let testRunsDir = null;
export function runsDir(dir) {
  if (dir) return dir;
  if (process.env.ROSALENA_RUNS) return process.env.ROSALENA_RUNS;
  if (process.env.NODE_TEST_CONTEXT) {
    testRunsDir ??= mkdtempSync(join(tmpdir(), "rosalena-test-runs-"));
    return testRunsDir;
  }
  return DEFAULT_RUNS_DIR;
}

const pad = (n, w = 2) => String(n).padStart(w, "0");

/**
 * `r-<yyyymmdd-hhmmss>-<4 hex>` — sortable by name, readable by a human, and with
 * enough entropy that two runs in the same second do not collide. The counter is
 * mixed in because a parent that fans out sub-agents can start several runs inside
 * one millisecond, and a collision would merge two logs that must stay separate.
 */
let seq = 0;
export function newRunId(now = new Date(), rand = Math.random) {
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  seq = (seq + 1) % 0x10000;
  const hex = ((Math.floor(rand() * 0x10000) ^ seq) & 0xffff).toString(16).padStart(4, "0");
  return `r-${stamp}-${hex}`;
}

const readLines = (file) => {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null; // a torn last line from a killed process is expected
      }
    })
    .filter(Boolean);
};

const short = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/**
 * Open a run for writing. Returns a handle whose `event`/`finish` never throw:
 * if the store is unusable, `handle.error` says so and the run continues.
 */
export function openRun({ dir, id = newRunId(), meta = {}, onError = () => {} } = {}) {
  const base = runsDir(dir);
  const handle = {
    id,
    dir: base,
    eventsFile: join(base, `${id}.jsonl`),
    recordFile: join(base, `${id}.json`),
    indexFile: join(base, "index.jsonl"),
    error: null,
    events: 0,
    bytes: 0,
    startedAt: new Date().toISOString(),
  };
  try {
    mkdirSync(base, { recursive: true });
  } catch (err) {
    // The store is unusable. The handle stays usable anyway: `event` drops the event
    // and `finish` returns the record it would have written, marked `stored: false`.
    // A caller must never have to know whether the disk worked.
    handle.error = `cannot create ${base}: ${err?.message ?? err}`;
    onError(handle.error);
    handle.event = () => null;
    handle.finish = (result = {}) => {
      const status = result.error ? "failed" : result.stopped ? "stopped" : "ok";
      return {
        id,
        status,
        ok: status === "ok",
        stored: false,
        storeError: handle.error,
        answer: result.answer ?? "",
        steps: result.steps ?? 0,
        error: result.error ?? null,
        ms: result.ms ?? null,
      };
    };
    return handle;
  }

  const guard = (fn) => {
    try {
      return fn();
    } catch (err) {
      handle.error = err?.message ?? String(err);
      onError(handle.error);
      return null;
    }
  };

  handle.event = (e) => {
    if (handle.error && !handle.events) return null; // store already dead: stay quiet
    const line = JSON.stringify({ at: new Date().toISOString(), ...e });
    const wrote = guard(() => appendFileSync(handle.eventsFile, `${line}\n`));
    if (wrote === null) return null;
    handle.events += 1;
    handle.bytes += line.length + 1;
    return null;
  };

  /**
   * Write the final record and its index line. Idempotent: the second call is ignored,
   * so a double-finished run (an error after a clean exit) cannot write two records.
   */
  handle.finish = (result = {}) => {
    if (handle.finished) return handle.record;
    const endedAt = new Date().toISOString();
    const status = result.error ? "failed" : result.stopped ? "stopped" : "ok";
    const record = {
      id,
      status,
      ok: status === "ok",
      task: short(meta.task, 2000),
      root: meta.root ?? null,
      cls: meta.cls ?? null,
      depth: meta.depth ?? 0,
      parent: meta.parent ?? null,
      model: result.target ?? null,
      startedAt: handle.startedAt,
      endedAt,
      ms: result.ms ?? null,
      steps: result.steps ?? 0,
      fixes: result.fixes ?? 0,
      stopped: result.stopped ?? null,
      error: result.error ? short(result.error, 500) : null,
      answer: result.answer ?? "",
      goal: result.goal ?? null,
      context: result.context ?? null,
      // The last context reading of the run: window, used, percent and the three-part
      // split. Stored so `/api/context` can answer for a chat whose process is gone,
      // and so a run's own record says what it cost without replaying its events.
      contextMeter: result.contextMeter ?? null,
      // Tokens and dollars of this run's own model calls, workers included (usage.mjs).
      usage: result.usage ?? null,
      // Which loop ran it: null is Rosalena's own; "claude-code" and "codex" keep that tool's
      // session (thread) id, which the chat's next message resumes, even after a restart.
      // Codex also keeps the thread's running usage total, which the next run subtracts.
      ...(result.engine ? { engine: result.engine, session: result.session ?? null, ...(result.engineTotals ? { engineTotals: result.engineTotals } : {}) } : {}),
      events: handle.events,
      eventBytes: handle.bytes,
    };
    handle.finished = true;
    handle.record = record;
    const had = guard(() => writeFileSync(handle.recordFile, `${JSON.stringify(record, null, 2)}\n`));
    if (had === null) return record;
    guard(() =>
      appendFileSync(
        handle.indexFile,
        `${JSON.stringify({
          id,
          at: endedAt,
          status,
          ok: record.ok,
          ms: record.ms,
          steps: record.steps,
          cls: record.cls,
          depth: record.depth,
          parent: record.parent,
          task: short(meta.task, 160),
          ...(record.usage?.total
            ? { tokens: record.usage.total.prompt + record.usage.total.completion, usd: record.usage.total.priced ? record.usage.total.usd : null }
            : {}),
        })}\n`,
      ),
    );
    return record;
  };
  return handle;
}

/**
 * Ask a running run to stop. A run can be owned by another process — the UI starts one,
 * a shell starts another — so cancellation cannot be a function call; it is a file that
 * the run's own loop checks between steps. The run then closes its record as
 * `stopped: "cancelled"`, which is why this is a request rather than a kill.
 *
 * Returns `{ok, reason}` instead of throwing: "already finished" is an answer, not a bug.
 */
export function requestCancel({ dir, id } = {}) {
  const base = runsDir(dir);
  let resolved = null;
  try {
    resolved = resolveRunId({ dir: base, id });
  } catch (err) {
    return { ok: false, reason: String(err?.message ?? err) };
  }
  if (!resolved) return { ok: false, reason: `no such run: ${id}` };
  if (existsSync(join(base, `${resolved}.json`))) {
    return { ok: false, reason: `${resolved} already finished; nothing to cancel` };
  }
  // A log with no record is only "running" while it is still growing. Once it is stale
  // there is no process left to notice the flag, so promising a stop would be a lie.
  const st = runStatus({ dir: base, id: resolved });
  if (st && !st.running) {
    return { ok: false, reason: `${resolved} is ${st.status} (no process is working on it); nothing to cancel` };
  }
  try {
    writeFileSync(join(base, `${resolved}.cancel`), `${new Date().toISOString()}\n`);
  } catch (err) {
    return { ok: false, reason: `cannot write the cancel flag: ${err?.message ?? err}` };
  }
  return { ok: true, reason: `${resolved} will stop at its next step` };
}

/** Has anyone asked this run to stop? Read by the agent loop between steps. */
export function cancelRequested({ dir, id } = {}) {
  return existsSync(join(runsDir(dir), `${id}.cancel`));
}

/** Resolve an exact id, or a unique prefix of one. Throws when a prefix is ambiguous. */
export function resolveRunId({ dir, id } = {}) {
  const base = runsDir(dir);
  if (!id) throw new Error("a run id is required");
  if (!existsSync(base)) return null;
  const ids = new Set();
  for (const f of readdirSync(base)) {
    const m = /^(r-.+)\.(json|jsonl)$/.exec(f);
    if (m) ids.add(m[1]);
  }
  if (ids.has(id)) return id;
  const hits = [...ids].filter((x) => x.startsWith(id)).sort();
  if (!hits.length) return null;
  if (hits.length > 1) throw new Error(`run id "${id}" is ambiguous: ${hits.slice(0, 5).join(", ")}`);
  return hits[0];
}

const liveRun = (base, id) => {
  const eventsFile = join(base, `${id}.jsonl`);
  const events = readLines(eventsFile);
  const steps = new Set();
  let tools = 0;
  let last = null;
  for (const e of events) {
    if (typeof e.step === "number") steps.add(e.step);
    if (e.type === "tool") tools += 1;
    last = e;
  }
  // No record + a log that stopped growing = a run whose process is gone. Say so
  // instead of reporting "running" forever; the events are still all there to read.
  let idleMs = 0;
  try {
    idleMs = Date.now() - statSync(eventsFile).mtimeMs;
  } catch {
    idleMs = 0;
  }
  const stale = idleMs > staleMs();
  return {
    id,
    status: stale ? "stale" : "running",
    ok: false,
    stale,
    idleMs: stale ? idleMs : null,
    steps: steps.size,
    tools,
    events: events.length,
    lastEvent: last ? short(last.type, 60) : null,
    lastTool: [...events].reverse().find((e) => e.type === "tool")?.name ?? null,
    startedAt: events[0]?.at ?? null,
    task: null,
    answer: null,
  };
};

/**
 * Newest first. Finished runs come from `index.jsonl`; a run with events but no record
 * is reported as `running` (its log is still growing) or `stale` (it stopped growing —
 * see `staleMs`) — without that, a task started five seconds ago would be invisible to
 * `run_status`, which is the whole point of the store.
 */
export function listRuns({ dir, limit = 50, status = null } = {}) {
  const base = runsDir(dir);
  if (!existsSync(base)) return [];
  const byId = new Map();
  for (const rec of readLines(join(base, "index.jsonl"))) {
    if (rec?.id) byId.set(rec.id, { ...rec, tools: rec.tools ?? null, lastEvent: null });
  }
  for (const f of readdirSync(base)) {
    const m = /^(r-.+)\.jsonl$/.exec(f);
    if (m && !byId.has(m[1])) byId.set(m[1], liveRun(base, m[1]));
  }
  let out = [...byId.values()];
  if (status) out = out.filter((r) => r.status === status);
  out.sort((a, b) => String(b.at ?? b.startedAt ?? b.id).localeCompare(String(a.at ?? a.startedAt ?? a.id)));
  return out.slice(0, limit);
}

/** `{ record, events }` for one run; `record` is null while it is still running. */
export function readRun({ dir, id, maxEvents = 500 } = {}) {
  const base = runsDir(dir);
  const resolved = resolveRunId({ dir: base, id });
  if (!resolved) return null;
  let record = null;
  const recordFile = join(base, `${resolved}.json`);
  if (existsSync(recordFile)) {
    try {
      record = JSON.parse(readFileSync(recordFile, "utf8"));
    } catch {
      record = null;
    }
  }
  const all = readLines(join(base, `${resolved}.jsonl`));
  const events = all.slice(-maxEvents);
  if (!record) record = liveRun(base, resolved);
  return { record, events, truncated: all.length > events.length };
}

/** What a poller needs in one call: is it done, how far did it get, what did it last do. */
export function runStatus({ dir, id } = {}) {
  const found = readRun({ dir, id, maxEvents: 2000 });
  if (!found) return null;
  const { record, events } = found;
  const running = record.status === "running";
  return {
    id: record.id,
    status: record.status,
    ok: record.ok === true,
    running,
    stale: record.stale === true,
    idleMs: record.idleMs ?? null,
    steps: record.steps ?? 0,
    tools: record.tools ?? events.filter((e) => e.type === "tool").length,
    ms: record.ms ?? null,
    task: record.task ?? null,
    answer: running ? null : (record.answer ?? ""),
    error: record.error ?? null,
    usage: record.usage ?? null,
    lastEvent: events.length ? short(events[events.length - 1].type, 60) : null,
    lastTool: [...events].reverse().find((e) => e.type === "tool")?.name ?? null,
    events: events.length,
  };
}
