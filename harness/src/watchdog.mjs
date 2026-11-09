/**
 * The watchdog: three ways a long-horizon run goes wrong without ever failing.
 *
 *   1. A step that never returns. The model call is given a deadline and aborted
 *      through its AbortSignal, so a provider that accepts the request and then
 *      goes quiet costs one step, not the whole run.
 *   2. A tool that never returns. `run_command` already kills its own child after
 *      `commandTimeoutMs`; this is the backstop for every OTHER tool (a delegated
 *      worker, a plugin's HTTP tool), and it answers the tool call rather than
 *      leaving a `tool_call_id` without a result - an unanswered call is a
 *      malformed history and the next request would be rejected outright.
 *   3. A run that keeps working and never gets anywhere. This is the one a timeout
 *      cannot see: the calls are fast, they succeed, and they are the same calls.
 *      The detector is deliberately narrow - the same call AND the same result
 *      `limit` times in a row - so polling a build that gets further each time is
 *      not a stall, while re-reading an unchanged file forever is.
 *
 * The watchdog notifies; the loop decides. Nothing here throws on its own except
 * `withTimeout`, which the loop catches and turns into a tool result.
 */

export const DEFAULT_STEP_TIMEOUT_MS = 300_000;
// A tool gets five minutes, not the two it used to. Measured 2026-11-06: a `findstr` sweep
// over a whole project was killed at 120s while it was still working, the model was told to
// "choose a different approach", and the run ended with the search it needed never done.
// Five minutes is long enough for a build, a test suite or a full-tree search on this
// machine, and short enough that a genuinely wedged tool does not hold a run for an hour.
export const DEFAULT_TOOL_TIMEOUT_MS = 300_000;
// The ceiling a tool is allowed to reach once it has proved it needs it (see
// `escalatedToolTimeout`): ten minutes. Nothing is given this up front, because a tool that
// hangs should still cost five minutes and not ten.
export const TOOL_TIMEOUT_CEILING_MS = 600_000;
// Off by default. Loop detection is a policy decision - "what counts as stuck" -
// and it is already owned, more thoughtfully, by the bundled `rosa-finish-loop-guard`
// plugin (three signals, a nudge before it stops, per-model filters), which the CLI
// loads by default. Enabling this core detector while that plugin is loaded would be
// two owners of one decision, and this coarse version would stop the run before the
// plugin had a chance to nudge the model. So: opt in with `--repeat-limit N` when no
// loop plugin is loaded, and the watchdog keeps what only the loop can own - killing
// a step or a tool that never returns.
export const DEFAULT_REPEAT_LIMIT = 0;

export class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "TimeoutError";
    this.code = "timeout";
  }
}

/** Non-negative milliseconds, where an explicit 0 means "off" rather than "unset". */
function ms(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.trunc(n));
}

export function deadlines({ stepTimeoutMs, toolTimeoutMs, repeatLimit } = {}) {
  return {
    stepTimeoutMs: ms(stepTimeoutMs, DEFAULT_STEP_TIMEOUT_MS),
    toolTimeoutMs: ms(toolTimeoutMs, DEFAULT_TOOL_TIMEOUT_MS),
    repeatLimit: ms(repeatLimit, DEFAULT_REPEAT_LIMIT),
  };
}

/**
 * How long THIS call to THIS tool gets. The deadline is not one number for every tool in
 * the run: the same `run_command` is a `git status` on one step and a full test suite on the
 * next, and a fixed clock either kills the suite or gives a hung `read_file` ten minutes.
 *
 * The rule, in order:
 *   - a tool that already ran long in this run (`slow` - it was killed at the base, or
 *     finished within 20% of it) gets the ceiling, so the retry is not killed at the same
 *     place it was killed before;
 *   - `known` tools whose honest work is minutes rather than milliseconds (a delegated
 *     worker, a build-ish plugin tool) start at the ceiling's midpoint;
 *   - everything else gets the base.
 *
 * A base of 0 (the person turned the watchdog off) stays off. A ceiling below the base is
 * ignored rather than shortening the base.
 */
export function escalatedToolTimeout(base, { slow = false, known = false, requested = 0, ceiling = TOOL_TIMEOUT_CEILING_MS } = {}) {
  const limit = ms(base, DEFAULT_TOOL_TIMEOUT_MS);
  if (limit === 0) return 0;
  const top = Math.max(limit, ms(ceiling, TOOL_TIMEOUT_CEILING_MS));
  // A tool that was told how long it needs (run_command's own `timeoutMs`) gets that plus a
  // little grace, so the tool's own kill message wins the race and reaches the model.
  const want = ms(requested, 0);
  if (want > 0) return Math.min(top, Math.max(limit, want)) + 30_000;
  if (slow) return top;
  if (known) return Math.min(top, Math.round(limit * 1.5));
  return limit;
}

/**
 * Tools whose own work is measured in minutes. Everything else (read a file, list a
 * directory, ask a plugin for a value) is expected to answer in seconds, and if it does not,
 * the base deadline is the right answer.
 */
export const LONG_TOOLS = Object.freeze(["run_command", "delegate", "shell", "exec"]);

/**
 * Abort a request after `ms` and hand the caller the signal to pass to fetch.
 * `timedOut()` is what separates "the watchdog fired" from "something else
 * aborted this" - the abort surfaces as a plain AbortError either way.
 */
export function abortAfter(ms, options = {}) {
  // A bare function is accepted as `onFire` on purpose. Passing the callback
  // directly is the easy mistake to make, and silently ignoring it means the
  // watchdog fires with nothing in the event log to say that it did.
  const onFire = typeof options === "function" ? options : (options?.onFire ?? null);
  const controller = new AbortController();
  const wait = Number(ms);
  if (!Number.isFinite(wait) || wait <= 0) {
    return { signal: undefined, timedOut: () => false, cancel() {}, abort: () => controller.abort() };
  }
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    try {
      onFire?.();
    } finally {
      controller.abort();
    }
  }, wait);
  // Ref'd on purpose. An unref'd watchdog is a promise that something else will still be
  // holding the event loop when the deadline arrives; where nothing does (a test process,
  // a one-shot CLI run whose tool has hung) node drops the timer, the process exits, and
  // the deadline that was supposed to fire never does. The timer is cleared by cancel()
  // or when the awaited work settles, so it can only outlive the work it guards.
  return {
    signal: controller.signal,
    timedOut: () => fired,
    cancel: () => clearTimeout(timer),
    abort: () => controller.abort(),
  };
}

/**
 * Await a promise, but fail it with a labelled timeout instead of hanging. The
 * underlying work is NOT cancelled (a plugin's tool may not be cancellable), which
 * is why the loop answers the tool call with this failure and moves on: the model
 * gets told the tool timed out, and the alternative - a run that sits forever - is
 * worse than a leaked tool.
 */
export async function withTimeout(promise, { ms: wait, label = "call", onTimeout = null } = {}) {
  const limit = Number(wait);
  if (!Number.isFinite(limit) || limit <= 0) return promise;
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          try {
            onTimeout?.();
          } finally {
            reject(new TimeoutError(`${label} did not finish within ${limit}ms`));
          }
        }, limit);
        // Ref'd for the same reason as abortAfter above: this timer is the only handle
        // left while a cancelled-by-nobody promise hangs, and an unref'd timer there means
        // the timeout never arrives. The finally block clears it, so it is not a leak.
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The identity of one tool call, as the model wrote it. */
export function callKey(call) {
  const name = call?.function?.name ?? call?.name ?? "?";
  const args = call?.function?.arguments ?? call?.args ?? "";
  return `${name}(${typeof args === "string" ? args : JSON.stringify(args)})`;
}

/** A signature for a step: which calls it made, and what came back. */
export function stepSignature(calls, results) {
  const asked = (calls ?? []).map(callKey).join(" | ");
  const got = (results ?? []).map((r) => String(r ?? "")).join(" | ");
  let hash = 5381;
  for (let i = 0; i < got.length; i += 1) hash = ((hash * 33) ^ got.charCodeAt(i)) >>> 0;
  return `${asked} => ${hash.toString(36)}:${got.length}`;
}

/**
 * Counts consecutive identical steps. A step that made no calls is progress (the
 * model answered), and a step whose results changed is progress even if the calls
 * repeat - so both reset the counter.
 */
export function makeStallDetector({ limit = DEFAULT_REPEAT_LIMIT } = {}) {
  const cap = ms(limit, DEFAULT_REPEAT_LIMIT);
  let last = null;
  let count = 0;
  return {
    note(calls, results) {
      if (cap === 0 || !(calls ?? []).length) {
        last = null;
        count = 0;
        return { key: null, repeat: 0, stalled: false };
      }
      const key = stepSignature(calls, results);
      count = key === last ? count + 1 : 1;
      last = key;
      return { key, repeat: count, stalled: count >= cap };
    },
    reset() {
      last = null;
      count = 0;
    },
    get repeat() {
      return count;
    },
  };
}
