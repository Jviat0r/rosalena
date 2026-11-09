// Settings > Notifications, the shell's half: one system notification from the page's
// two strings. Text only (title and body, clipped, control characters removed), no icon
// path or action from the page; a click brings the window that asked back to the front.
//
// Its own module so a scratch Electron script can show a real notification through the
// same code main.mjs uses (the `rosalena:notify` channel), without starting the app.

/** The page's request, cleaned: { title, body }. Pure. */
export function cleanNotice(asked) {
  const title = String(asked?.title ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120) || "Rosalena";
  const body = String(asked?.body ?? "").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").trim().slice(0, 400);
  return { title, body };
}

/** `t` when none is given: the English key with its {placeholders} filled in. */
const plainText = (key, vars) => (vars ? String(key).replace(/\{(\w+)\}/g, (whole, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole)) : key);

/**
 * Show it. `Notification` is Electron's class (passed in, so this file imports nothing from
 * electron itself); `win` is the asking window or null; `icon` a path or null; `t` the
 * shell's translator for the refusal reasons the page shows (main.mjs; English without it).
 *
 * Resolves { shown, reason? } once Windows has had a moment to refuse it: Electron emits
 * "show" first and "failed" after when the system's settings block the app's notifications
 * (Focus assist, or notifications off for Rosalena), and the page should say which.
 */
export function showNotice(Notification, asked, { win = null, icon = null, settleMs = 1200, t = plainText } = {}) {
  if (!Notification?.isSupported?.()) return Promise.resolve({ shown: false, reason: t("this system has no notifications") });
  const { title, body } = cleanNotice(asked);
  const note = new Notification({ title, body, silent: false, ...(icon ? { icon } : {}) });
  note.on("click", () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ shown: true }), settleMs);
    note.once("failed", (_event, error) => {
      clearTimeout(timer);
      resolve({
        shown: false,
        reason: t("the system did not show it ({error}); check that notifications are on for Rosalena and Do not disturb is off", {
          error: String(error ?? "refused").replace(/^Notification failed - /, ""),
        }),
      });
    });
    note.show();
  });
}
