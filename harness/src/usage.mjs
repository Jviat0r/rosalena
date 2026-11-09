/**
 * What one run used: tokens and dollars, added up from the replies it got.
 *
 * The router already keeps the long view (router/src/usage.mjs: 30 days per model,
 * limits.mjs: the monthly budget). Neither can say what ONE run cost, because two
 * runs at once share them. So each reply carries its own numbers - the provider's
 * `usage` block, and the router's price for that call (`x-router-cost-usd` on a
 * buffered reply, a closing `: x-router-cost` comment on a stream) - and the run
 * adds up exactly the calls it made.
 *
 * Kinds: `step` (the loop's own calls), `summary` (compaction), `judge`, and
 * `workers` (delegated runs, added from their own totals). A reply with no usage
 * counts as a call with unknown tokens; it is never given invented ones.
 */

const EMPTY = () => ({ calls: 0, prompt: 0, completion: 0, cached: 0, unmeasured: 0, usd: 0, priced: 0 });

/** The cached-prompt count, wherever this provider puts it. */
function cachedOf(usage) {
  return Number(usage?.prompt_tokens_details?.cached_tokens ?? usage?.cache_read_input_tokens ?? usage?.cached_tokens ?? 0) || 0;
}

export function createUsageTally() {
  const total = EMPTY();
  const byKind = {};
  const byTarget = {};

  const bump = (bucket, { prompt, completion, cached, measured, usd }) => {
    bucket.calls += 1;
    if (measured) {
      bucket.prompt += prompt;
      bucket.completion += completion;
      bucket.cached += cached;
    } else bucket.unmeasured += 1;
    if (usd !== null) {
      bucket.usd += usd;
      bucket.priced += 1;
    }
  };

  return {
    /** One model call's reply. `usd` is the router's price for it, or null when unknown. */
    add(usage, { kind = "step", target = null, usd = null } = {}) {
      const measured = Boolean(usage) && typeof usage === "object";
      const call = {
        prompt: measured ? Number(usage.prompt_tokens) || 0 : 0,
        completion: measured ? Number(usage.completion_tokens) || 0 : 0,
        cached: measured ? cachedOf(usage) : 0,
        measured,
        usd: Number.isFinite(usd) ? usd : null,
      };
      bump(total, call);
      bump((byKind[kind] ??= EMPTY()), call);
      bump((byTarget[target ?? "unknown"] ??= EMPTY()), call);
    },
    /** A finished child run's own tally (a delegated worker), folded in as `workers`. */
    addRun(child) {
      if (!child?.total) return;
      const into = (bucket) => {
        for (const key of Object.keys(bucket)) bucket[key] += Number(child.total[key]) || 0;
      };
      into(total);
      into((byKind.workers ??= EMPTY()));
      for (const [target, t] of Object.entries(child.byTarget ?? {})) {
        const bucket = (byTarget[target] ??= EMPTY());
        for (const key of Object.keys(bucket)) bucket[key] += Number(t[key]) || 0;
      }
    },
    snapshot() {
      const round = (b) => ({ ...b, usd: Math.round(b.usd * 1e6) / 1e6 });
      return {
        total: round(total),
        byKind: Object.fromEntries(Object.entries(byKind).map(([k, b]) => [k, round(b)])),
        byTarget: Object.fromEntries(Object.entries(byTarget).map(([k, b]) => [k, round(b)])),
      };
    },
  };
}

/** One line for a person: "41.2k in (30.1k cached) / 2.3k out, 12 calls, $0.0031". */
export function formatUsage(snapshot) {
  const t = snapshot?.total;
  if (!t?.calls) return "no model calls";
  const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const cost = !t.priced ? "cost unknown" : t.usd === 0 ? "$0 (free or local)" : `$${t.usd < 0.01 ? t.usd.toFixed(4) : t.usd.toFixed(2)}`;
  const unpriced = t.priced && t.priced < t.calls ? ` (${t.calls - t.priced} call(s) unpriced)` : "";
  const unmeasured = t.unmeasured ? `, ${t.unmeasured} without token counts` : "";
  return `${k(t.prompt)} in${t.cached ? ` (${k(t.cached)} cached)` : ""} / ${k(t.completion)} out, ${t.calls} call(s)${unmeasured}, ${cost}${unpriced}`;
}
