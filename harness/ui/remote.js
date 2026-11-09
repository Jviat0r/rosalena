// The remote-access page: one poll loop, four buttons, no dependencies.
//
// The server decides almost everything. This file only asks for
// GET /api/remote/status and draws whatever state comes back, because the state machine
// (idle / starting / live / stopping / failed) has to be the same one the API reports -
// a page that invented its own "probably running" would be wrong exactly when the tunnel
// died, which is the moment a person is looking at it.
//
// Two audiences share one page. On the machine running the app the page shows the QR
// code, the link and the controls, and carries the app's write token in
// `window.ROSALENA_TOKEN`. Over the tunnel the server injects an empty token, the
// status reports `canControl: false`, and the page offers exactly one action: forget
// this device. That is not a UI nicety - the server enforces it.

const TOKEN = window.ROSALENA_TOKEN || "";

const $ = (id) => document.getElementById(id);

let timer = null;
let current = null;
let stopping = false;

/** One JSON round trip, with the write token when this page has one. */
async function api(path, { method = "GET", body } = {}) {
  const headers = { accept: "application/json" };
  if (TOKEN) headers["x-rosalena-token"] = TOKEN;
  if (body !== undefined) headers["content-type"] = "application/json";
  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
  } catch (err) {
    return { ok: false, status: 0, data: { error: `the app did not answer (${err.message})` } };
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!data) data = { error: `the app answered HTTP ${res.status} with something that was not JSON` };
  return { ok: res.ok, status: res.status, data };
}

function show(panel) {
  for (const id of ["panel-off", "panel-starting", "panel-live", "panel-phone", "panel-failed", "panel-gone"]) {
    $(id).hidden = id !== panel;
  }
}

const PILL = {
  idle: "Off",
  starting: "Starting",
  live: "Live",
  stopping: "Stopping",
  failed: "Failed",
};

function setPill(state) {
  const pill = $("pill");
  pill.dataset.state = state;
  pill.textContent = PILL[state] ?? state;
}

/** Seconds as a short human phrase, for "live for 4 minutes". */
function duration(ms) {
  if (ms === null || ms === undefined) return "";
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

function render(remote) {
  if (!remote) return;
  current = remote;
  setPill(remote.state);
  stopping = false;

  const local = remote.canControl !== false;
  $("sub").textContent =
    remote.state === "live"
      ? `Live at ${remote.url}${remote.liveForMs ? ` for ${duration(remote.liveForMs)}` : ""}.`
      : "This app, on your phone, through a Cloudflare quick tunnel.";

  if (remote.state === "starting") {
    $("starting-cmd").textContent = remote.tunnelCommand ?? "cloudflared tunnel --url http://127.0.0.1 --no-autoupdate";
    show("panel-starting");
    return;
  }

  if (remote.state === "live") {
    if (!local) {
      $("phone-note").textContent = remote.hasToken
        ? "The tunnel accepts this device's pairing token."
        : "This server holds no pairing token; the next request will be refused.";
      show("panel-phone");
      return;
    }
    show("panel-live");
    if (remote.qr) {
      const img = $("qr");
      if (img.getAttribute("src") !== remote.qr) img.setAttribute("src", remote.qr);
      $("qr-note").textContent = "Point the phone's camera at this code.";
    } else {
      // A live tunnel with no QR means the server could not mint a code; saying so beats
      // an empty box pretending to be scannable.
      $("qr-note").textContent = "No code was issued - use the link below.";
    }
    const link = $("link");
    if (link.value !== (remote.link ?? "")) link.value = remote.link ?? "";
    $("live-note").textContent = remote.hasToken
      ? "The token in that link is the only thing standing between the internet and this app."
      : "This server holds no pairing token; the tunnel will refuse every phone until it is restarted.";
    return;
  }

  if (remote.state === "failed") {
    $("failed-reason").textContent = remote.reason;
    // Only offer the download hint when the failure is about the binary: a refused
    // sandbox or a dead edge connection is not fixed by installing cloudflared.
    const missing = /not found|no such file|not be started|no file there/i.test(remote.reason ?? "");
    $("failed-download").hidden = !missing;
    if (missing && remote.download) {
      $("dl-releases").href = remote.download.releases;
      $("dl-docs").href = remote.download.docs;
    }
    $("btn-enable").disabled = false;
    const note = $("off-note");
    note.hidden = false;
    note.textContent = `Last attempt: ${remote.reason}`;
    show("panel-failed");
    return;
  }

  // idle and stopping: the off card, with the reason underneath when there is one.
  const note = $("off-note");
  const informational = remote.state === "stopping" || /off|stopped/i.test(remote.reason ?? "");
  note.hidden = informational || !remote.reason;
  note.textContent = remote.reason ?? "";
  show("panel-off");
  $("btn-enable").disabled = remote.state === "stopping";
}

async function refresh() {
  const { data } = await api("/api/remote/status");
  if (data?.remote) render(data.remote);
  return data?.remote ?? null;
}

/**
 * Poll while the tunnel is turning into something, and slowly once it is: a tunnel can
 * die on its own, and a page that only updated on a click would show "live" for hours
 * after the edge connection dropped.
 */
function schedule(remote) {
  if (timer) clearTimeout(timer);
  if (stopping || remote?.state === "stopping") return;
  const delay = remote?.state === "starting" ? 1000 : 5000;
  timer = setTimeout(async () => {
    timer = null;
    const next = await refresh();
    schedule(next);
  }, delay);
}

/** Run a control, then draw whatever the server says the result was. */
async function act(action) {
  const buttons = [...document.querySelectorAll("[data-action]")];
  if (stopping) return; // a second click while turning off would only race the first
  if (action === "unpair") {
    const { ok, data } = await api("/api/remote/unpair", { method: "POST" });
    if (ok) {
      stopping = true;
      if (timer) clearTimeout(timer);
      setPill("idle");
      $("sub").textContent = "This device is no longer paired.";
      show("panel-gone");
    } else if (data?.error) {
      flash(data.error);
    }
    return;
  }

  if (action === "disable") stopping = true;
  for (const button of buttons) button.disabled = true;
  try {
    const { ok, data } = await api(`/api/remote/${action}`, { method: "POST" });
    if (data?.remote) render(data.remote);
    else if (!ok) flash(data?.error ?? "the app refused that");

    if (action === "check" && data?.check) {
      const out = data.check;
      const line = $("checked");
      line.hidden = false;
      line.dataset.ok = out.ok ? "yes" : "no";
      line.textContent = out.ok
        ? `The public URL answered through Cloudflare${out.ms ? ` in ${out.ms} ms` : ""}.`
        : `${out.error}${out.status ? ` (HTTP ${out.status})` : ""}`;
    }
    if (action === "revoke" && ok) flash("New code issued; old links now get 403.");
    if (action === "enable" && data?.remote?.state === "failed") {
      flash("The tunnel could not start - the reason is below.");
    }
  } finally {
    for (const button of buttons) button.disabled = false;
    if (action === "disable") stopping = false;
    const state = await refresh();
    schedule(state);
  }
}

/** A short-lived line of feedback that does not move the layout. */
let flashTimer = null;
function flash(text) {
  const line = $("toast");
  if (!line) return;
  line.hidden = false;
  line.textContent = text;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    line.hidden = true;
  }, 4000);
}

async function copyLink() {
  const text = $("link").value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    flash("Link copied.");
  } catch {
    // Clipboard access is denied outside a secure context and on some mobile browsers;
    // selecting the field is the fallback that always works.
    $("link").select();
    flash("Copy was blocked - the link is selected, use your keyboard or long-press.");
  }
}

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "copy") return void copyLink();
  void act(action);
});

// A page restored from the back/forward cache can be hours old.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) void refresh().then(schedule);
});

(async function start() {
  const remote = await refresh();
  schedule(remote);
})();
