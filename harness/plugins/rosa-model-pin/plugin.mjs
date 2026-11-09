// model-pin - stay on one model instead of silently drifting off it.
//
// Every harness step normally names a task CLASS ("orchestrate"), and the router
// picks the provider and falls back down a chain when one fails. That is the
// right default, and the wrong behaviour when the model itself is the variable
// being tested or the local GPU is the thing you want used: a failure quietly
// turns into a different model answering.
//
// A pin names an exact target - "local/qwen3.8-27b". The router builds a
// ONE-TARGET chain for a target, so a pinned step cannot fall back to anything
// else. Then a failed call is retried on that same target with backoff, and when
// the budget runs out the run fails loudly on the pinned model rather than
// passing the work to a model the caller did not choose.
//
// The pin comes from config, from HARNESS_PIN, or from /model-pin set at run
// time. Nothing is written to disk: a pin lasts for the process that set it.

/** A pin is either a task class ("code") or an exact router target ("provider/model"). */
export function normalizePin(value) {
  const pin = String(value ?? "").trim();
  if (!pin || /\s/.test(pin)) return null;
  return pin;
}

export function isTarget(pin) {
  return pin.includes("/");
}

function providerOf(pin) {
  return isTarget(pin) ? pin.split("/")[0] : null;
}

export default {
  id: "rosa-model-pin",
  description: "Pins a run to one router target and retries it rather than drifting to another model",

  commands(ctx) {
    const state = () => {
      const fromEnv = normalizePin(process.env.HARNESS_PIN);
      return { active: activePin ?? fromEnv ?? normalizePin(ctx.config.pin), source: activePin ? "this session" : fromEnv ? "HARNESS_PIN" : ctx.config.pin ? "harness.config.json" : "none" };
    };

    const verify = async (pin) => {
      const routerUrl = ctx.harness?.routerUrl;
      if (!routerUrl) return "not verified (no router url in the plugin context)";
      const base = String(routerUrl).replace(/\/v1\/?$/, "");
      try {
        const health = await (await fetch(`${base}/health`)).json();
        if (!isTarget(pin)) {
          const classes = health?.classes ?? [];
          return classes.includes(pin) ? `class "${pin}" exists` : `UNKNOWN class "${pin}" - the router serves: ${classes.join(", ")}`;
        }
        const status = await (await fetch(`${base}/admin/status`)).json();
        const provider = providerOf(pin);
        return status?.providers?.[provider]
          ? `provider "${provider}" exists`
          : `UNKNOWN provider "${provider}" - the router has: ${Object.keys(status?.providers ?? {}).join(", ")}`;
      } catch (err) {
        return `not verified (router unreachable: ${err?.message ?? err})`;
      }
    };

    return {
      show: async () => {
        const { active, source } = state();
        if (!active) return "no pin: every step names a task class and the router picks, with fallback";
        return `pinned to ${active} (from ${source})\n${await verify(active)}`;
      },
      set: async (argv) => {
        const pin = normalizePin(argv?.[0]);
        if (!pin) return "usage: /model-pin set <class|provider/model>   e.g. local/qwen3.8-27b";
        const check = await verify(pin);
        activePin = pin;
        const caveat = check.startsWith("UNKNOWN") ? `\nWARNING: ${check}` : `\n${check}`;
        return `pinned to ${pin} for this session${caveat}\nto keep it, put it in plugins.model-pin.config.pin (harness.config.json) or set HARNESS_PIN`;
      },
      clear: async () => {
        activePin = null;
        return "pin cleared: steps name a task class again and the router may fall back";
      },
    };
  },

  hooks(ctx) {
    const depthMode = ctx.config.depth === "all" ? "all" : "root";
    const maxAttempts = Math.max(1, Math.min(20, Number(ctx.config.maxAttempts) || 3));
    const backoff = {
      initialDelayMs: Math.max(0, Number(ctx.config.backoff?.initialDelayMs) || 1500),
      maxDelayMs: Math.max(0, Number(ctx.config.backoff?.maxDelayMs) || 12_000),
      jitterRatio: Math.min(1, Math.max(0, Number(ctx.config.backoff?.jitterRatio) || 0.3)),
    };

    const pinNow = () => activePin ?? normalizePin(process.env.HARNESS_PIN) ?? normalizePin(ctx.config.pin);

    return {
      async onRunStart({ run, depth }) {
        const pin = pinNow();
        if (pin) ctx.log(`pinned to ${pin} (${depthMode === "all" ? "every run" : "the orchestrator"}; retry ${maxAttempts}x on the same target)`);
        if (pin) run.state.set("pin", pin);
      },

      async beforeStep({ run, depth }) {
        const pin = run.state.get("pin") ?? pinNow();
        if (!pin) return;
        // A delegated worker is a separate model choice by design, so the pin
        // stops at the orchestrator unless it was explicitly asked to cover all.
        if (depthMode === "root" && depth !== 0) return;
        return {
          model: pin,
          retry: { maxAttempts, ...backoff },
        };
      },
    };
  },

  status(ctx) {
    const pin = activePin ?? normalizePin(process.env.HARNESS_PIN) ?? normalizePin(ctx.config.pin);
    if (!pin) return "no pin (classes + router fallback)";
    const source = activePin ? "session" : process.env.HARNESS_PIN ? "HARNESS_PIN" : "config";
    return `pinned to ${pin} (${source})`;
  },
};

/** Set by /model-pin set for the lifetime of this process. */
let activePin = null;
