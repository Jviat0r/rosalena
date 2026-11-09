// Rosalena's own error explainer. Rosalena calls explain() where a model call fails for good
// (agent.mjs, the router_error exit). It began on 2026-10-21 from the same rule table as a
// DeepSeek Harness plugin; the two are separate projects now and are not kept in step.
/**
 * The error key (pure, no imports).
 *
 * Every rule was written from a real failure in the session logs (2026-10-18..21
 * census of 77 sessions). The provider's own code is often misleading on its own:
 * OpenCode reports an upstream OUTAGE as HTTP 429 (pi-ai code RATE_LIMIT), so a
 * code-only reading calls it a rate limit. Rules therefore match the message
 * body first and fall back to the code last.
 *
 * explain(failure, provider) -> { key, title, meaning, action, retryHelps }
 */

/** Providers served by your own llama-server (default: the openai-completions route on :8080). */
export const DEFAULT_LOCAL_PROVIDERS = ['openai-completions'];

/** Pull the provider's own message out of "429: {json}" style bodies. */
export function innerMessage(message) {
  const m = String(message ?? '').match(/^\s*(\d{3})\s*:?\s*(\{[\s\S]*\})\s*$/);
  if (!m) return null;
  try {
    const body = JSON.parse(m[2]);
    const msg = body?.message ?? body?.error?.message;
    return { status: Number(m[1]), type: body?.type ?? body?.error?.type ?? null, message: typeof msg === 'string' ? msg : null, body };
  } catch {
    return { status: Number(m[1]), type: null, message: null, body: null };
  }
}

function statusOf(message) {
  const m = String(message ?? '').match(/^\s*(\d{3})\b/);
  return m ? Number(m[1]) : null;
}

/**
 * The rules, first match wins. `when` gets { msg, code, status, inner, local, provider }.
 * Titles stay short: they are what you read first in "This turn failed".
 */
export const RULES = [
  {
    key: 'LOCAL-CTX-TOO-SMALL',
    when: ({ msg }) => {
      const m = msg.match(/exceeds the available context size \((\d+) tokens\)/);
      return m && Number(m[1]) < 131072;
    },
    title: 'The local model server was started with a small context window',
    meaning: (x) => {
      const m = x.msg.match(/request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)/);
      return m
        ? `The request was ${Number(m[1]).toLocaleString()} tokens but the llama-server on :8080 only has ${Number(m[2]).toLocaleString()} (its -c setting). The harness was told the window was larger, so it never compacted in time and the server refused the request.`
        : 'The llama-server on :8080 was started with a smaller -c than the harness expects, so requests no longer fit.';
    },
    action: 'Rosalena now adopts the server\'s own number, summarises the oldest turns and retries the step instead of ending the turn. To get the long history back, restart qwen with D:\\llama.cpp\\start-qwen.ps1 (-c 131072): whatever started this server (often another app\'s launcher) used a smaller context.',
    retryHelps: false,
  },
  {
    key: 'CONTEXT-FULL',
    when: ({ msg, code }) => /Context size has been exceeded|exceeds the available context size|context[_ ]length[_ ]exceeded|maximum context length/i.test(msg) || code === 'CONTEXT_WINDOW_EXCEEDED',
    title: 'The conversation no longer fits the model\'s context window',
    meaning: (x) => x.local
      ? 'The prompt plus the reply ran past qwen\'s window. Usually compaction didn\'t run in time, or another request was sharing the same server.'
      : 'The prompt plus the reply ran past this model\'s context window.',
    action: 'Run /compact (or start a new session), then continue. If it keeps happening on qwen, check the Local Models tab for a second job sharing the server.',
    retryHelps: false,
  },
  {
    // The router's own reason for a 503 when the free window is spent (router.mjs quotaHint).
    // Before this rule the 503 fell through to SERVER-ERROR, which said "retry later": the
    // one thing that never helps with a spent daily quota.
    key: 'FREE-LIMIT',
    when: ({ msg }) => /free tier's daily limit is used up/.test(msg),
    title: 'The free tier\'s daily limit is used up',
    meaning: (x) => /OmniRoute, the free fallback, is not running/.test(x.msg)
      ? 'The free models share one daily allowance per internet connection, and it has run out. OmniRoute, the free fallback that would answer now, is not running on this PC.'
      : 'The free models share one daily allowance per internet connection, and it has run out. This is a real quota, not a glitch.',
    action: (x) => /OmniRoute, the free fallback, is not running/.test(x.msg)
      ? 'Open the OmniRoute tab (sidebar, under Plugins) to install or start it, then send again. Or pick a local model, or add your own API key in Settings > API keys.'
      : 'Retrying won\'t help until it comes back (about a day after it started refusing). Pick a local model, or add your own API key in Settings > API keys.',
    retryHelps: false,
  },
  {
    key: 'OC-FREE-QUOTA',
    when: ({ msg }) => /FreeUsageLimitError/.test(msg),
    title: 'OpenCode free-tier usage limit reached',
    meaning: () => 'You have used up the free allowance for OpenCode\'s free models. This is a real quota, not a glitch.',
    action: 'Retrying won\'t help until it resets (OpenCode doesn\'t say when; rate_limit_status shows the estimate). Use a local model or your own API key for now.',
    retryHelps: false,
  },
  {
    key: 'OC-GO-QUOTA',
    when: ({ msg }) => /GoUsageLimitError/.test(msg),
    title: 'OpenCode Go plan usage limit reached',
    meaning: () => 'The OpenCode Go subscription\'s usage allowance is used up.',
    action: 'Wait for the plan\'s reset, or switch to a local model.',
    retryHelps: false,
  },
  {
    key: 'OC-FREE-BLOCKED',
    when: ({ msg }) => /FreeTierError/.test(msg),
    title: 'OpenCode blocked its free models for your network',
    meaning: () => 'OpenCode refused the request because it detected abusive traffic from your IP address. It says this is not about your account.',
    action: 'Retrying won\'t clear it. Turn off any VPN, proxy or IP rotation that these requests go through, and use a local model or your own API key.',
    retryHelps: false,
  },
  {
    key: 'PAID-NO-BALANCE',
    when: ({ msg }) => /Insufficient account funds|insufficient_quota|out of budget|billing/i.test(msg),
    title: 'The paid account has no balance left',
    meaning: () => 'The provider rejected the request because the account balance or budget is empty.',
    action: 'Top up the account on the provider\'s billing page, or switch to a local model.',
    retryHelps: false,
  },
  {
    // The router's own hint when a provider's monthly cap is spent (router.mjs budgetHint).
    // Without this rule the 503 falls through to SERVER-ERROR and says "retry later", the
    // one thing that never helps: the router never sent the request.
    key: 'OVER-BUDGET',
    when: ({ msg }) => /"reason"\s*:\s*"over_budget"|monthly spend cap for .* is used up/i.test(msg),
    title: 'The monthly spend cap for this provider is used up',
    meaning: (x) => {
      const cap = (x.msg.match(/"capUsd"\s*:\s*([\d.]+)/) || [])[1];
      const spent = (x.msg.match(/"spentUsd"\s*:\s*([\d.]+)/) || [])[1];
      const money = (v) => (v ? `$${Number(v).toFixed(2)}` : null);
      return cap && spent
        ? `The router skipped this target before sending: ${money(spent)} spent against a ${money(cap)} monthly cap. The provider is not the problem and no tokens were bought.`
        : 'The router skipped this target because its monthly spend cap is used up. The request was never sent.';
    },
    action: 'Raise it in Settings > Spend limits (it applies to the next message, no restart), or switch to a free or local model. Retrying will not help until the limit is raised or the month rolls over.',
    retryHelps: false,
  },
  {
    // Evidence, not a guess: the router asked the local server what it is serving after a
    // 5xx and put the answer in the error (router.mjs localModelHint).
    key: 'LOCAL-WRONG-MODEL',
    when: ({ msg }) => /local server on :8080 has "[^"]+" loaded, not "[^"]+"/i.test(msg),
    title: 'The local server has a different model loaded',
    meaning: (x) => {
      const m = x.msg.match(/has "([^"]+)" loaded, not "([^"]+)"/i);
      return m
        ? `The llama-server on :8080 is serving ${m[1]}, and this request asked for ${m[2]}. llama.cpp refuses a model it does not have within a second, which is why this looked like a bare server error.`
        : 'The model this request asked for is not the one the local server has in memory.';
    },
    action: (x) => {
      const m = x.msg.match(/has "([^"]+)" loaded, not "([^"]+)"/i);
      return m
        ? `Pick ${m[1]} in the model picker, or start ${m[2]} first (D:\\llama.cpp\\start-qwen.ps1 starts qwen).`
        : 'Pick the model that is actually loaded, or start the one you want first.';
    },
    retryHelps: false,
  },
  {
    key: 'OC-UPSTREAM-DOWN',
    when: ({ msg }) => /Upstream request failed: Endpoint is unavailable/i.test(msg),
    title: 'OpenCode\'s upstream model server is down',
    meaning: (x) => `OpenCode could not reach the model behind it (an outage on their side, not your quota)${x.status === 429 ? '. OpenCode sends this as HTTP 429, which is why it can look like a rate limit, but it isn\'t one' : ''}.`,
    action: 'It usually comes back on its own within minutes. Retry later or switch models.',
    retryHelps: true,
  },
  {
    key: 'REASONING-HISTORY',
    when: ({ msg }) => /reasoning_content.*must be passed back/i.test(msg),
    title: 'Thinking-mode history is missing for this model',
    meaning: () => 'This model (DeepSeek in thinking mode) requires its earlier reasoning to be sent back with the history, and this conversation\'s history doesn\'t have it. Typical after switching to it mid-session from another model.',
    action: 'Switch back to the previous model, or continue in a new session on this model.',
    retryHelps: false,
  },
  {
    key: 'NO-API-KEY',
    when: ({ msg }) => /No API key for provider/i.test(msg),
    title: 'No API key configured for this provider',
    meaning: (x) => `DSH has no API key for "${(x.msg.match(/No API key for provider:?\s*(\S+)/i) || [])[1] ?? x.provider}". The request never left your machine.`,
    action: 'Add the key in Settings > Providers (or the env var the provider\'s apiKeyEnv names), or pick a model whose provider has one.',
    retryHelps: false,
  },
  {
    key: 'AUTH-INVALID',
    when: ({ msg, status, code }) => status === 401 || /invalid api key|incorrect api key|unauthorized|invalid_api_key/i.test(msg) || code === 'INVALID_CREDENTIAL',
    title: 'The API key was rejected',
    meaning: () => 'The provider says the key is invalid, expired or revoked.',
    action: 'Replace the key in Settings > Providers.',
    retryHelps: false,
  },
  {
    key: 'LOCAL-NO-VISION',
    when: ({ msg }) => /image input is not supported/i.test(msg),
    title: 'An image was sent to qwen without its vision file',
    meaning: () => 'The llama-server on :8080 was started without --mmproj, so it can\'t read images.',
    action: 'Restart qwen with D:\\llama.cpp\\start-qwen.ps1, which loads the vision file, or remove the image.',
    retryHelps: false,
  },
  {
    key: 'LOCAL-LOADING',
    when: ({ msg }) => /Loading model/i.test(msg),
    title: 'qwen is still loading',
    meaning: () => 'The llama-server is up but the model is still loading into VRAM (about 15-60 s).',
    action: 'Wait a minute and retry.',
    retryHelps: true,
  },
  {
    key: 'ROUTER-DOWN',
    when: ({ msg }) => /(127\.0\.0\.1|localhost):8077/.test(msg) && /ECONNREFUSED|fetch failed|connect/i.test(msg),
    title: 'Can\'t reach Rosalena\'s model router',
    meaning: () => 'Nothing answered on 127.0.0.1:8077, the router every Rosalena model call goes through.',
    action: 'Restart Rosalena Harness (it starts the router), or start the router from the router folder.',
    retryHelps: true,
  },
  {
    key: 'LOCAL-DOWN',
    // Codes are optional: Rosalena's router errors carry none.
    when: ({ msg, code, local }) => local && (code === 'TRANSPORT' || code === 'NETWORK' || !code) && /Connection error|ECONNREFUSED|fetch failed|connect/i.test(msg),
    title: 'Can\'t reach the local qwen server',
    meaning: () => 'Nothing answered on http://127.0.0.1:8080: llama-server isn\'t running, crashed, or is being swapped to another model.',
    action: 'Start it with D:\\llama.cpp\\start-qwen.ps1 (the Local Models tab shows whether it\'s up).',
    retryHelps: true,
  },
  {
    key: 'CONNECTION-FAILED',
    when: ({ msg, code }) => (code === 'TRANSPORT' || code === 'NETWORK' || !code) && /Connection error|ECONNREFUSED|ENOTFOUND|ECONNRESET|fetch failed/i.test(msg),
    title: 'Network connection to the provider failed',
    meaning: () => 'The request couldn\'t connect (network down, DNS, or the provider dropped the connection).',
    action: 'Check your internet connection, then retry.',
    retryHelps: true,
  },
  {
    key: 'STREAM-IDLE',
    when: ({ msg }) => /stream idle timeout/i.test(msg),
    title: 'The model went silent mid-request',
    meaning: (x) => {
      const ms = Number((x.msg.match(/after (\d+)ms/) || [])[1])
      const span = ms ? ` for ${Math.round(ms / 60000)} min` : '';
      return x.local
        ? `qwen sent nothing${span}. Usually it was busy with another job or reading a very long prompt.`
        : `The provider sent nothing${span}.`;
    },
    action: (x) => x.local ? 'Check the Local Models tab for another job on qwen, then retry.' : 'Retry; if it repeats, switch models.',
    retryHelps: true,
  },
  {
    key: 'REQUEST-TIMEOUT',
    when: ({ msg, code }) => /Request timed out/i.test(msg) || (code === 'TIMEOUT' && !/idle/i.test(msg)),
    title: 'The request timed out',
    meaning: () => 'The provider didn\'t answer before the request deadline.',
    action: 'Retry; if it repeats, the provider is overloaded, so switch models.',
    retryHelps: true,
  },
  {
    key: 'STREAM-CUT',
    when: ({ msg }) => /Stream ended without finish_reason|^terminated$|socket hang up|premature close/i.test(msg),
    title: 'The reply was cut off mid-stream',
    meaning: (x) => x.local ? 'The connection to qwen closed before the reply finished (server restarted or crashed).' : 'The provider closed the connection before the reply finished.',
    action: 'Retry.',
    retryHelps: true,
  },
  {
    key: 'GATEWAY-500',
    when: ({ msg }) => /^500 status code \(no body\)/i.test(msg),
    title: (x) => x.local ? 'qwen returned an internal error' : 'The provider\'s gateway failed (500, no details)',
    meaning: (x) => x.local
      ? 'llama-server returned HTTP 500 with no explanation; check D:\\llama.cpp\\logs for the cause.'
      : 'The provider\'s gateway hit an internal error and sent no explanation. This is on their side; on OpenCode\'s free route it often comes in long bursts.',
    action: 'Retry later or switch models.',
    retryHelps: true,
  },
  {
    key: 'NOT-FOUND',
    when: ({ status }) => status === 404,
    title: 'Model or endpoint not found (404)',
    meaning: () => 'The provider doesn\'t know this model id or URL: a typo, a retired model, or a wrong baseURL.',
    action: 'Pick the model again from the model picker, or check the provider\'s baseURL in the profile.',
    retryHelps: false,
  },
  {
    key: 'FORBIDDEN',
    when: ({ status, code }) => status === 403 || code === 'AUTH',
    title: 'The provider refused access (403)',
    meaning: (x) => `The provider refused this request${x.inner?.message ? `: "${x.inner.message.slice(0, 160)}"` : '.'}`,
    action: 'Check your plan, key and region for this model.',
    retryHelps: false,
  },
  {
    key: 'RATE-LIMITED',
    when: ({ status, code }) => status === 429 || code === 'RATE_LIMIT' || code === 'QUOTA_EXCEEDED',
    title: 'Rate limited by the provider',
    meaning: (x) => `Too many requests in a short time${x.inner?.message ? `: "${x.inner.message.slice(0, 160)}"` : ''}.`,
    action: 'Wait a bit before retrying.',
    retryHelps: true,
  },
  {
    key: 'SERVER-ERROR',
    when: ({ status, code }) => (status !== null && status >= 500) || code === 'SERVER',
    title: (x) => `The ${x.local ? 'local qwen server' : 'provider'} had a server error${x.status ? ` (${x.status})` : ''}`,
    meaning: (x) => x.inner?.message ? `It said: "${x.inner.message.slice(0, 200)}".` : 'It failed on its side and gave no details.',
    action: 'Retry later or switch models.',
    retryHelps: true,
  },
  {
    key: 'BAD-REQUEST',
    when: ({ status, code }) => status === 400 || code === 'INVALID_REQUEST',
    title: 'The provider rejected the request as invalid (400)',
    meaning: (x) => x.inner?.message ? `It said: "${x.inner.message.slice(0, 220)}".` : 'Something in the request (a parameter or the history) isn\'t accepted by this model.',
    action: 'Switch models or start a new session; if it\'s every request, a profile setting for this model is wrong.',
    retryHelps: false,
  },
  {
    // Thrown while the system prompt is assembled, before any request: it never reaches
    // agent/request-error, so the hook won't see it. Kept so the key covers every logged error.
    key: 'CONFIG-PROMPT-VAR',
    when: ({ msg }) => /unknown prompt variable/i.test(msg),
    title: 'A prompt template uses a variable DSH doesn\'t have',
    meaning: (x) => `${(x.msg.match(/"\{\{[^}]+\}\}" in section "[^"]+"/) || ['A {{variable}}'])[0]} isn't registered in this DSH version, so every turn fails before the model is called.`,
    action: 'Remove that variable from the profile cordis.patch.yml (DSH 0.2.1 only has {{provider}} and {{model}}).',
    retryHelps: false,
  },
  {
    key: 'EMPTY-RESPONSE',
    when: ({ code }) => code === 'EMPTY_RESPONSE',
    title: 'The model returned an empty reply',
    meaning: () => 'The request succeeded but contained no text or tool call.',
    action: 'Retry.',
    retryHelps: true,
  },
];

const UNKNOWN = {
  key: 'UNKNOWN',
  title: 'Unrecognized error',
  meaning: (x) => `No rule matches this error yet (code ${x.code || 'none'}).`,
  action: 'See the original message above.',
  retryHelps: null,
};

const val = (v, x) => (typeof v === 'function' ? v(x) : v);

/**
 * @param {{ message?: string, code?: string }} failure
 * @param {string} provider
 * @param {{ localProviders?: string[] }} [opts]
 */
export function explain(failure, provider, opts = {}) {
  const msg = String(failure?.message ?? '');
  const code = String(failure?.code ?? '');
  const local = opts.local ?? (opts.localProviders ?? DEFAULT_LOCAL_PROVIDERS).includes(provider);
  // "router returned 503: {...}" (Rosalena's router) reads the same as "503: {...}".
  const core = msg.replace(/^[\s\S]*?\breturned\s+(?=\d{3}\b)/i, '');
  const x = { msg, code, status: statusOf(core), inner: innerMessage(core), local, provider };
  const rule = RULES.find((r) => {
    try { return Boolean(r.when(x)); } catch { return false; }
  }) ?? UNKNOWN;
  return {
    key: rule.key,
    title: val(rule.title, x),
    meaning: val(rule.meaning, x),
    action: val(rule.action, x),
    retryHelps: rule.retryHelps,
    providerCode: code || null,
  };
}

export const MARK = '[Rosalena error ';

/** The text appended to the failure message (what "This turn failed" shows). */
export function annotation(e) {
  return `\n\n${MARK}${e.key}] ${e.title}. ${e.meaning} What to do: ${e.action}`;
}
