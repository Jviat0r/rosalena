/**
 * Web search for the public trial: the one tool the free window has.
 *
 * The same engines, in the same order, as the desktop app's `search_web`
 * (harness/src/tools-extra.mjs): Brave when BRAVE_API_KEY is set, Tavily when
 * TAVILY_API_KEY is, and DuckDuckGo's keyless HTML page otherwise. Results only, never
 * a page fetch: the trial can say what a search found, it cannot open what it found.
 *
 * The model asks for a search in text (systemPrompt "on" in trial.mjs shows it how), so
 * every provider in the chain can use it, including ones that take no `tools`.
 */

export const SEARCH_RESULTS = 5;
export const SEARCH_TIMEOUT_MS = 8000;
const MAX_QUERY = 200;
const MAX_SNIPPET = 300;
const MAX_HTML = 512 * 1024;
const QUERY_JSON = /"(?:query|q|search_query|search)"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const QUERY_CALL = /\bquery\s*=\s*"((?:[^"\\]|\\.)*)"/;

const decodeEntities = (text) =>
  String(text)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)));

const plain = (html) => decodeEntities(String(html ?? "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
const clip = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** DuckDuckGo's HTML results, as the desktop app parses them. Each hit: { title, url, snippet }. */
export function parseDuckDuckGo(html) {
  const hits = [];
  const blocks = String(html).split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/i).slice(1);
  for (const block of blocks) {
    const link = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!link) continue;
    let href = decodeEntities(link[1]);
    const redirect = /[?&]uddg=([^&]+)/.exec(href);
    if (redirect) href = decodeURIComponent(redirect[1]);
    if (href.startsWith("//")) href = `https:${href}`;
    if (!/^https?:\/\//i.test(href) || /duckduckgo\.com\/y\.js/.test(href)) continue;
    const snippet = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/i.exec(block)?.[1] ?? "";
    hits.push({ title: plain(link[2]), url: href, snippet: plain(snippet) });
  }
  return hits;
}

/**
 * The search the model asked for, out of whatever it wrote after the tool-call marker.
 * Returns null when the call is for some other tool. A search whose query cannot be read
 * (cut off, or a shape no parser expects) searches for the visitor's own message.
 */
export function searchQueryFrom(call, fallback = "") {
  const text = String(call ?? "");
  // The form the trial's own prompt asks for: [[search: terms]].
  const asked = /^\[\[\s*search\s*:\s*([^\]\n]*)/i.exec(text);
  if (asked) {
    const query = (asked[1].trim() || String(fallback)).replace(/\s+/g, " ").trim();
    return query ? query.slice(0, MAX_QUERY) : null;
  }
  const named =
    /"name"\s*:\s*"([^"]+)"/.exec(text)?.[1] ??
    /<(?:tool_call|function)[=>\s|]*\s*([A-Za-z_][\w.-]*)/.exec(text)?.[1] ??
    /^\W*([A-Za-z_][\w.-]*)\s*[({]/.exec(text.replace(/^[^>\]]*[>\]]/, ""))?.[1] ??
    "";
  if (named && !/search|web|browse|google|bing|lookup|look_up|find/i.test(named)) return null;
  // JSON arguments, or Llama's built-in `brave_search.call(query="...")`.
  const quoted = (QUERY_JSON.exec(text) ?? QUERY_CALL.exec(text))?.[1];
  let query = "";
  if (quoted !== undefined) {
    try {
      query = JSON.parse(`"${quoted}"`);
    } catch {
      query = quoted;
    }
  }
  query = String(query || fallback).replace(/\s+/g, " ").trim();
  return query ? query.slice(0, MAX_QUERY) : null;
}

/**
 * A short answer that only announces a search, or only says the model does not know.
 * Measured: GLM behind OmniRoute writes "I will search for reviews of X ..." and stops,
 * because the host that serves it strips the tool call it wrote (with and without
 * `tools` in the request), and Llama 3.1 8B answers "I couldn't find any information
 * about X". Both are a search the model wanted and could not ask for.
 */
export function wantsSearch(text) {
  const t = String(text ?? "").trim();
  if (!t || t.length > 500) return false;
  return (
    /\b(?:I(?:'ll| will| am going to|'m going to| need to| would need to)|let me)\s+(?:search|look (?:up|for|into)|check|find)\b/i.test(t) ||
    /\bI (?:don't|do not|couldn't|could not|can't|cannot) (?:have|find|access)\b[^.]*\b(?:information|data|details|anything)\b/i.test(t) ||
    /\bI(?:'m| am) not (?:familiar|aware)\b/i.test(t)
  );
}

/** True once a streamed call is complete enough to act on. */
export function callIsComplete(call) {
  const text = String(call ?? "");
  return (
    /^\[\[[^\]\n]*(?:\]|\n)/.test(text) ||
    QUERY_JSON.test(text) ||
    QUERY_CALL.test(text) ||
    /<\/tool_call>|tool_call_end|tool▁call▁end|<\/function>/.test(text) ||
    text.length > 600
  );
}

async function fetchWithin(url, init, { fetchImpl, signal, timeoutMs }) {
  const local = new AbortController();
  const stop = () => local.abort();
  signal?.addEventListener?.("abort", stop);
  const timer = setTimeout(stop, timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: local.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", stop);
  }
}

/** Run one search. Resolves { engine, hits } or throws an Error with a short reason. */
export async function webSearch(query, { env = {}, fetchImpl = fetch, signal, timeoutMs = SEARCH_TIMEOUT_MS, limit = SEARCH_RESULTS } = {}) {
  const q = String(query ?? "").trim();
  if (!q) throw new Error("the query is empty");
  const opts = { fetchImpl, signal, timeoutMs };
  const finish = (engine, hits) => ({
    engine,
    hits: hits
      .filter((hit) => hit.url && /^https?:\/\//i.test(hit.url))
      .slice(0, limit)
      .map((hit) => ({ title: clip(plain(hit.title) || hit.url, 160), url: hit.url, snippet: clip(plain(hit.snippet), MAX_SNIPPET) })),
  });
  if (env.BRAVE_API_KEY) {
    const r = await fetchWithin(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${limit}`, {
      headers: { accept: "application/json", "x-subscription-token": String(env.BRAVE_API_KEY) },
    }, opts);
    if (!r.ok) throw new Error(`Brave search answered HTTP ${r.status}`);
    const results = (await r.json())?.web?.results ?? [];
    return finish("Brave", results.map((x) => ({ title: x.title, url: x.url, snippet: x.description })));
  }
  if (env.TAVILY_API_KEY) {
    const r = await fetchWithin("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: String(env.TAVILY_API_KEY), query: q, max_results: limit }),
    }, opts);
    if (!r.ok) throw new Error(`Tavily answered HTTP ${r.status}`);
    const results = (await r.json())?.results ?? [];
    return finish("Tavily", results.map((x) => ({ title: x.title, url: x.url, snippet: x.content })));
  }
  // DuckDuckGo answers Cloudflare's own addresses with a bot check (measured: a 200 with
  // no results from the Worker, real results from a home connection). The OmniRoute
  // gate on the owner's PC (site/tools/omniroute-tunnel.mjs) runs the same search from
  // there, behind the same key; when the PC is off, the direct search is the last try.
  const gateway = String(env.OMNIROUTE_URL ?? "").trim().replace(/\/+$/, "");
  const gatewayKey = String(env.OMNIROUTE_API_KEY ?? "").trim();
  if (gateway && gatewayKey) {
    try {
      const g = await fetchWithin(`${gateway}/search`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${gatewayKey}` },
        body: JSON.stringify({ query: q, limit }),
      }, { ...opts, timeoutMs: Math.min(timeoutMs, 6000) });
      const data = g.ok ? await g.json() : null;
      if (Array.isArray(data?.hits) && data.hits.length) return finish(String(data.engine || "DuckDuckGo"), data.hits);
    } catch {
      /* the PC is off or the tunnel is gone: search directly */
    }
  }
  const r = await fetchWithin("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) RosalenaHarness/1.0",
      accept: "text/html",
    },
    body: `q=${encodeURIComponent(q)}`,
  }, opts);
  if (!r.ok) throw new Error(`DuckDuckGo answered HTTP ${r.status}`);
  const html = (await r.text()).slice(0, MAX_HTML);
  return finish("DuckDuckGo", parseDuckDuckGo(html));
}

/** The results as the model reads them: numbered, so the answer can cite [1], [2]. */
export function resultsForModel(query, found) {
  if (!found?.hits?.length) {
    return `The web search for "${query}" ${found?.error ? "failed" : "found nothing"}. Answer from what you already know, and say that the search did not help.`;
  }
  const list = found.hits.map((hit, i) => `[${i + 1}] ${hit.title}\n${hit.url}\n${hit.snippet}`).join("\n\n");
  return `Web search results for "${query}" (${found.engine}):\n\n${list}\n\nAnswer my question from these results now. Cite the results you use by number, like [1]. If they do not answer it, say so. Do not search again.`;
}

/** The sources line the visitor reads under the answer. */
export function sourcesBlock(found) {
  if (!found?.hits?.length) return "";
  return `\n\nSources:\n${found.hits.map((hit, i) => `[${i + 1}] ${hit.title}: ${hit.url}`).join("\n")}`;
}
