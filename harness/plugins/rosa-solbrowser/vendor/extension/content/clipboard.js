// readClipboard / writeClipboard ops, moved from v1 content.js with behaviour
// unchanged (D-013, P-014).

if (globalThis.__sol) {
  const { register, CsError } = globalThis.__sol;

  // --------------------------------------------------------------- clipboard
  // D-013: the universal editor escape hatch. execCommand is deprecated but it
  // is the reliable route for extensions — navigator.clipboard adds async
  // permission prompts and stricter focus rules for no benefit here.

  function withScratchTextarea(fn) {
    const host = document.body || document.documentElement;
    if (!host) throw new CsError("CLIPBOARD_UNAVAILABLE", "This frame has no document body.");
    const previous = document.activeElement;
    const ta = document.createElement("textarea");
    ta.setAttribute("style", "position:fixed;left:-10000px;top:0;width:10px;height:10px;opacity:0;");
    host.appendChild(ta);
    try {
      return fn(ta);
    } finally {
      ta.remove();
      try {
        previous?.focus?.(); // put focus back so this is safe mid-workflow
      } catch {}
    }
  }

  function readClipboardOp() {
    return withScratchTextarea((ta) => {
      ta.focus();
      let ok = false;
      try {
        ok = document.execCommand("paste");
      } catch (e) {
        throw new CsError("CLIPBOARD_UNAVAILABLE", String(e?.message || e));
      }
      const text = ta.value;
      if (!ok && !text) {
        throw new CsError("CLIPBOARD_UNAVAILABLE", "execCommand('paste') was refused in this frame — the document may not be focused.");
      }
      return { text };
    });
  }

  function writeClipboardOp({ text }) {
    return withScratchTextarea((ta) => {
      ta.value = String(text ?? "");
      ta.focus();
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (e) {
        throw new CsError("CLIPBOARD_UNAVAILABLE", String(e?.message || e));
      }
      if (!ok) throw new CsError("CLIPBOARD_UNAVAILABLE", "execCommand('copy') was refused in this frame.");
      return { written: true };
    });
  }

  register("readClipboard", readClipboardOp);
  register("writeClipboard", writeClipboardOp);
}
