// MAIN-world functions (D-003): a FIXED table, never arbitrary code from the
// wire. Each function is serialized by chrome.scripting, so it must be
// self-contained. Arbitrary page JS goes through CDP Runtime.evaluate instead.

import { isAttached } from "./cdp.js";
import { ExtError, errMsg, tabErrorCode, withTimeout } from "./util.js";

const MAIN_TIMEOUT_MS = 5000;

const FNS = {
  readMonaco: () => {
    const m = globalThis.monaco;
    if (!m?.editor?.getModels) return { available: false };
    try {
      return {
        available: true,
        models: m.editor.getModels().map((md) => ({
          uri: String(md.uri),
          languageId: md.getLanguageId?.() ?? null,
          totalChars: md.getValueLength(),
          value: md.getValue(),
        })),
      };
    } catch (e) {
      return { available: false, error: String(e) };
    }
  },
  // evaluate's last-resort route for a frame CDP cannot reach. Not a new power:
  // the server can already run any page JS through ext.cdp Runtime.evaluate, and
  // SOLBROWSER_ALLOW_EVAL gates the tool server-side. Page CSP without
  // 'unsafe-eval' blocks it.
  evaluate: async (expr) => {
    let v = (0, eval)(String(expr));
    if (typeof v === "function") v = v();
    v = await v;
    if (v === undefined || typeof v === "function" || typeof v === "symbol") return v === undefined ? null : String(v);
    if (v instanceof Node) return `<${v.nodeName.toLowerCase()}>`;
    try {
      return JSON.parse(JSON.stringify(v));
    } catch {
      return String(v);
    }
  },
};

/** ext.mainWorld {tabId, frameId, fn, args} */
export async function mainWorld({ tabId, frameId = 0, fn, args }) {
  if (!Number.isInteger(tabId)) throw new ExtError("BAD_ARGS", "tabId (integer) is required");
  const func = FNS[fn];
  if (!func) throw new ExtError("BAD_ARGS", `Unknown MAIN-world function "${fn}"`);
  // SEC-1 defence in depth: free-form eval only where the debugger is attached,
  // so it is behind the same gate (infobar, A6 policy) as Runtime.evaluate.
  if (fn === "evaluate" && !isAttached(tabId)) throw new ExtError("NO_TAB_ATTACHED", `tab ${tabId} is not attached: evaluate needs an attached tab`);
  try {
    const results = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        world: "MAIN",
        injectImmediately: true,
        func,
        args: Array.isArray(args) ? args : args == null ? [] : [args],
      }),
      MAIN_TIMEOUT_MS,
      `mainWorld ${fn}`
    );
    return results?.[0]?.result ?? { available: false };
  } catch (e) {
    if (e?.code === "TIMEOUT") throw e;
    const m = errMsg(e);
    if (tabErrorCode(m)) throw new ExtError("TAB_GONE", m);
    throw new ExtError("MAIN_WORLD_UNAVAILABLE", `frame ${frameId}: ${m}`);
  }
}
