/**
 * The stable-hostname relay, from the app's side.
 *
 * A quick tunnel's hostname changes every time cloudflared starts. The relay (a small
 * Cloudflare Worker, site/relay/) gives this install one hostname that never changes,
 * `https://<id>.rosalena.dev`, and forwards it to whichever tunnel URL this install
 * registered last. So the phone's bookmark, and the device cookie that lives on that
 * hostname, keep working across restarts.
 *
 * Registration: POST <relay>/api/register { id, secret, target }. The first registration
 * of an id claims it (the relay stores a SHA-256 of the secret); every later one must
 * carry the same secret. `target` must be an https://*.trycloudflare.com/ origin - the
 * relay refuses anything else, so it can never be pointed at an arbitrary site.
 *
 * Failure is never fatal: the page falls back to the raw tunnel link and says why, and
 * the registration is retried with capped exponential backoff (5 s, 10 s, ... 60 s)
 * until it lands or the tunnel goes away.
 */

export const DEFAULT_RELAY = "https://relay.rosalena.dev";
export const RELAY_ENV = "ROSALENA_RELAY";

export function relayBase(env = process.env) {
  const raw = String(env[RELAY_ENV] ?? "").trim();
  return (raw || DEFAULT_RELAY).replace(/\/+$/, "");
}

export function createRelayClient({
  base = relayBase(),
  fetchImpl = (url, init) => fetch(url, init),
  log = () => {},
  now = () => Date.now(),
  baseDelayMs = 5_000,
  maxDelayMs = 60_000,
  timeoutMs = 10_000,
} = {}) {
  const state = { state: "off", url: null, error: null, at: null, target: null, attempts: 0, nextTryAt: null };
  let timer = null;
  let generation = 0;

  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
    state.nextTryAt = null;
  }

  function status() {
    return { state: state.state, url: state.url, error: state.error, at: state.at, nextTryAt: state.nextTryAt, base };
  }

  async function post(path, body) {
    const res = await fetchImpl(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { status: res.status, ok: res.ok, data };
  }

  /**
   * Point the relay at `target`. Resolves the stable URL once accepted, or null (the
   * retry is already scheduled). A newer announce or a stop() cancels an older one.
   */
  async function announce({ id, secret, target }) {
    clearTimer();
    const mine = ++generation;
    state.target = target;
    state.state = "registering";
    state.error = null;
    state.at = now();
    try {
      const out = await post("/api/register", { id, secret, target });
      if (mine !== generation) return null;
      const url = out.data?.url;
      if (!out.ok || typeof url !== "string" || !/^https:\/\/[a-z0-9.-]+\/?$/.test(url)) {
        throw new Error(out.data?.error ? `${out.data.error} (HTTP ${out.status})` : `the relay answered HTTP ${out.status}`);
      }
      state.state = "linked";
      state.url = url.endsWith("/") ? url : `${url}/`;
      state.attempts = 0;
      state.at = now();
      log(`remote: relay linked, ${state.url} now forwards to this tunnel`);
      return state.url;
    } catch (err) {
      if (mine !== generation) return null;
      state.state = "failed";
      state.error = err?.name === "TimeoutError" ? `the relay did not answer within ${Math.round(timeoutMs / 1000)} s` : String(err?.message ?? err);
      state.at = now();
      const delay = Math.min(baseDelayMs * 2 ** state.attempts, maxDelayMs);
      state.attempts += 1;
      state.nextTryAt = now() + delay;
      log(`remote: relay not linked (${state.error}); trying again in ${Math.round(delay / 1000)} s`);
      timer = setTimeout(() => {
        timer = null;
        if (mine === generation) void announce({ id, secret, target });
      }, delay);
      timer.unref?.();
      return null;
    }
  }

  /** Forget the target: the relay shows its "offline" page until the next announce. */
  async function unregister({ id, secret }) {
    try {
      const out = await post("/api/unregister", { id, secret });
      return out.ok;
    } catch {
      return false;
    }
  }

  /** Stop retrying. `keepUrl` keeps the last stable URL known (the tunnel only paused). */
  function stop({ keepUrl = true } = {}) {
    generation += 1;
    clearTimer();
    state.state = "off";
    state.error = null;
    state.attempts = 0;
    state.target = null;
    if (!keepUrl) state.url = null;
  }

  return { announce, unregister, stop, status, get base() { return base; } };
}
