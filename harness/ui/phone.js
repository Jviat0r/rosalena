// Phone access: the footer's phone button, its panel, and Settings > Phone access.
//
// The server decides everything (harness/src/remote.mjs). This file asks
// GET /api/remote/status and draws what comes back - the state machine, the link, the
// QR code (an SVG data URI the server built offline), the paired devices - and sends the
// switches back through POST /api/remote/*. It never builds a link or a QR itself, so it
// cannot show one the server would refuse.
//
// Two audiences share it. On the computer running the app the panel is the switch, the
// QR code, the link and the devices. Opened on a paired phone (the server marks the page
// with <html data-remote="1">) the panel only says so and offers "Unpair this device";
// the server refuses every other control from there anyway.

import { t } from "./i18n.mjs";

const TOKEN = document.querySelector('meta[name="rosalena-token"]')?.content ?? "";
const REMOTE = document.documentElement.dataset.remote === "1";
const $ = (id) => document.getElementById(id);

const view = { status: null, open: false, timer: null, busy: false, qrFor: null, note: null, noteUntil: 0 };

async function api(path, { method = "GET", body } = {}) {
  const headers = { accept: "application/json" };
  if (TOKEN && !TOKEN.startsWith("__")) headers["x-rosalena-token"] = TOKEN;
  if (body !== undefined) headers["content-type"] = "application/json";
  try {
    const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = { error: t("the app answered HTTP {status}", { status: res.status }) };
    }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: { error: t("the app did not answer ({error})", { error: err.message }) } };
  }
}

const PILL = { idle: t("Off"), starting: t("Starting"), live: t("Live"), stopping: t("Stopping"), failed: t("Problem") };
// Settings > Phone access names the state in a word; anything else the server says is shown as it is.
const STATE_WORDS = { idle: t("idle"), starting: t("starting"), live: t("live"), stopping: t("stopping"), failed: t("failed") };

function mb(bytes) {
  return `${(Number(bytes || 0) / 1e6).toFixed(0)} MB`;
}

function ago(at) {
  const s = Math.max(0, Math.round((Date.now() - Number(at)) / 1000));
  if (s < 60) return t("just now");
  const m = Math.round(s / 60);
  if (m < 60) return t("{m} min ago", { m });
  const h = Math.round(m / 60);
  if (h < 48) return t("{h} h ago", { h });
  return t("{d} days ago", { d: Math.round(h / 24) });
}

function day(at) {
  try {
    return new Date(Number(at)).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

/** One sentence for what is happening right now. */
function sentence(s) {
  if (!s) return "";
  if (s.state === "idle") return s.lastFailure ? t("Off. The last try failed: {reason}", { reason: s.lastFailure.reason }) : t("Off. Nothing is reachable from outside this computer.");
  if (s.state === "starting") {
    if (s.install?.state === "downloading") {
      const done = s.install.received ? (s.install.total ? t("{got} of {total}", { got: mb(s.install.received), total: mb(s.install.total) }) : mb(s.install.received)) : "";
      return t("Downloading cloudflared from Cloudflare (first time only)...{progress}", { progress: done ? ` ${done}` : "" });
    }
    return t("Starting the tunnel. This takes a few seconds.");
  }
  if (s.state === "stopping") return t("Stopping the tunnel...");
  if (s.state === "failed") return s.reason;
  if (s.state === "live") {
    if (s.mode === "named") return t("Live on your own hostname.");
    return t("Live. Scan the code with your phone.");
  }
  return s.reason;
}

function relayLine(s) {
  const r = s?.relay;
  if (!s || s.state !== "live" || !r) return { text: "", tone: "" };
  if (r.state === "named") return { text: t("Your named tunnel. This address never changes."), tone: "ok" };
  if (r.state === "linked") return { text: t("Stable link. It stays the same after restarts, so a bookmark keeps working."), tone: "ok" };
  if (r.state === "registering") return { text: t("Linking the stable address... the code shows the temporary link until then."), tone: "" };
  if (r.state === "off") return { text: t("Stable link is off: this address changes every time the tunnel starts, and phones have to scan again."), tone: "warn" };
  const why = r.error ? ` (${r.error})` : "";
  return {
    text: t("The stable-link relay isn't reachable{why}, so this is the temporary link. It changes when the tunnel restarts. Rosalena keeps trying.", { why }),
    tone: "warn",
  };
}

function renderDevices(list, devices = []) {
  list.replaceChildren();
  if (!devices.length) {
    const empty = document.createElement("li");
    empty.className = "phone-empty";
    empty.textContent = t("No devices yet. Scan the code to pair one.");
    list.append(empty);
    return;
  }
  for (const d of devices) {
    const row = document.createElement("li");
    row.className = "phone-device";
    const text = document.createElement("div");
    text.className = "phone-device-text";
    const name = document.createElement("strong");
    name.textContent = d.name;
    const meta = document.createElement("span");
    meta.textContent = t("paired {date} · used {ago}", { date: day(d.createdAt), ago: ago(d.lastSeen) });
    text.append(name, meta);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "phone-btn small";
    button.textContent = t("Unpair");
    button.setAttribute("aria-label", t("Unpair {name}", { name: d.name }));
    button.onclick = async () => {
      button.disabled = true;
      const out = await api("/api/remote/devices/remove", { method: "POST", body: { id: d.id } });
      if (out.data?.remote) paint(out.data.remote);
      else flash(out.data?.error ?? t("Could not unpair that device."), "bad");
    };
    row.append(text, button);
    list.append(row);
  }
}

function flash(text, tone = "") {
  view.note = { text, tone };
  view.noteUntil = Date.now() + 8000;
  paint(view.status);
}

function paintPanel(s) {
  const pill = $("phone-pill");
  const retrying = s.state === "failed" && s.wanted && s.restartAt;
  pill.dataset.state = retrying ? "starting" : s.state;
  pill.textContent = retrying ? t("Retrying") : PILL[s.state] ?? s.state;

  const on = s.wanted || s.state === "starting" || s.state === "live";
  const sw = $("phone-switch");
  sw.checked = on;
  sw.disabled = view.busy || s.state === "stopping";
  $("phone-switch-note").textContent = on
    ? s.state === "live"
      ? t("On. Your phone can reach this app.")
      : t("On. Getting the tunnel ready.")
    : t("Off. Turn it on to get a QR code.");

  const reason = $("phone-reason");
  const note = view.note && Date.now() < view.noteUntil ? view.note : null;
  reason.textContent = note?.text ?? sentence(s);
  reason.dataset.tone = note?.tone ?? (s.state === "failed" ? "bad" : s.state === "live" ? "ok" : "");

  const live = $("phone-live");
  live.hidden = !(s.state === "live" && s.link);
  if (!live.hidden) {
    if (view.qrFor !== s.link) {
      $("phone-qr").src = s.qr;
      view.qrFor = s.link;
    }
    $("phone-link").value = s.link;
    const line = relayLine(s);
    const relay = $("phone-relay");
    relay.textContent = line.text;
    relay.dataset.tone = line.tone;
  } else {
    view.qrFor = null;
  }

  const devices = s.devices ?? [];
  $("phone-count").textContent = devices.length ? `(${devices.length})` : "";
  renderDevices($("phone-device-list"), devices);
  $("phone-unpair-all").hidden = !devices.length && s.state !== "live";
}

function paintSettings(s) {
  const page = $("settings-phone");
  if (!page) return;
  const set = s.settings ?? {};
  const state = $("phone-set-state");
  state.textContent = s.state === "live" ? t("live") : s.state === "failed" && s.wanted ? t("retrying") : STATE_WORDS[s.state] ?? s.state;
  const note = view.note && Date.now() < view.noteUntil ? view.note : null;
  const reason = $("phone-set-reason");
  reason.textContent = note?.text ?? sentence(s);
  reason.dataset.tone = note?.tone ?? (s.state === "failed" ? "bad" : "");
  $("phone-set-toggle").textContent = s.wanted || s.state === "live" || s.state === "starting" ? t("Turn off") : t("Turn on");
  $("phone-set-toggle").disabled = view.busy || s.state === "stopping";

  const keep = $("phone-set-keep");
  keep.checked = Boolean(set.keepOn);
  $("phone-set-keep-value").textContent = set.keepOn ? t("on") : t("off");

  const relay = $("phone-set-relay");
  relay.checked = set.relay !== false;
  const named = Boolean(set.hasNamedToken && set.namedHost);
  relay.disabled = named;
  $("phone-set-relay-value").textContent = named ? t("not used with a named tunnel") : set.relay === false ? t("off") : s.relay?.state === "linked" ? t("linked") : t("on");

  const days = $("phone-set-days");
  if (document.activeElement !== days) days.value = String(set.cookieDays ?? 90);

  const devices = s.devices ?? [];
  $("phone-set-devices").textContent = devices.length ? t("{n} devices", { n: devices.length }) : t("none");

  const host = $("phone-set-host");
  const port = $("phone-set-port");
  if (document.activeElement !== host && !host.dataset.dirty) host.value = set.namedHost ?? "";
  if (document.activeElement !== port && !port.dataset.dirty) port.value = String(set.namedPort ?? 47390);
  const token = $("phone-set-token");
  token.placeholder = set.hasNamedToken ? t("saved ({hint})", { hint: set.namedTokenHint }) : t("paste the token from the tunnel's install command");
  $("phone-set-named-value").textContent = named ? t("on: {host}", { host: set.namedHost }) : set.hasNamedToken || set.namedHost ? t("incomplete") : t("not set");
}

function paint(s) {
  if (!s) return;
  view.status = s;
  const dot = $("phone-dot");
  if (dot) {
    dot.hidden = !(s.state === "live" || s.state === "starting" || (s.state === "failed" && s.wanted));
    dot.dataset.state = s.state === "live" ? "live" : s.state === "failed" ? "bad" : "busy";
  }
  if (REMOTE || s.view === "remote") {
    const pill = $("phone-pill");
    pill.dataset.state = "live";
    pill.textContent = t("Paired");
    $("phone-remote-note").textContent = s.device?.name ? t("This device: {name}.", { name: s.device.name }) : "";
    return;
  }
  paintPanel(s);
  paintSettings(s);
}

async function refresh() {
  const out = await api("/api/remote/status");
  if (out.data?.remote) paint(out.data.remote);
  schedule();
}

function settingsVisible() {
  const page = $("settings-phone");
  return Boolean(page && !page.hidden && !$("settings-panel")?.hidden);
}

function schedule() {
  clearTimeout(view.timer);
  const s = view.status;
  const active = view.open || settingsVisible();
  const busy = s && (s.state === "starting" || s.state === "stopping" || (s.state === "live" && s.relay?.state === "registering"));
  const ms = active ? (busy ? 1200 : 4000) : 30000;
  view.timer = setTimeout(() => {
    if (document.visibilityState === "visible" || active) void refresh();
    else schedule();
  }, ms);
}

async function control(action, body) {
  view.busy = true;
  paint(view.status);
  const out = await api(`/api/remote/${action}`, { method: "POST", body: body ?? {} });
  view.busy = false;
  if (out.data?.remote) paint(out.data.remote);
  if (!out.ok && out.data?.error) flash(out.data.error, "bad");
  schedule();
  return out;
}

// ------------------------------------------------------------------- the panel

let returnFocus = null;

function openPanel() {
  if (REMOTE) {
    $("phone-local").hidden = true;
    $("phone-remote").hidden = false;
  }
  view.open = true;
  returnFocus = document.activeElement;
  $("phone-panel").hidden = false;
  $("phone-scrim").hidden = false;
  $("phone-open")?.setAttribute("aria-expanded", "true");
  $("phone-close").focus({ preventScroll: true });
  void refresh();
}

function closePanel() {
  view.open = false;
  $("phone-panel").hidden = true;
  $("phone-scrim").hidden = true;
  $("phone-open")?.setAttribute("aria-expanded", "false");
  if (returnFocus && document.contains(returnFocus)) returnFocus.focus({ preventScroll: true });
  schedule();
}

async function copyLink() {
  const input = $("phone-link");
  const text = input.value;
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    input.select();
    ok = document.execCommand?.("copy") ?? false;
  }
  const button = $("phone-copy");
  button.textContent = ok ? t("Copied") : t("Select and copy");
  setTimeout(() => (button.textContent = t("Copy")), 1600);
}

function wire() {
  $("phone-open")?.addEventListener("click", (event) => {
    event.stopPropagation();
    if (view.open) closePanel();
    else openPanel();
  });
  $("phone-close").onclick = closePanel;
  $("phone-scrim").onclick = closePanel;
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && view.open) {
      event.stopPropagation();
      closePanel();
    }
  });

  $("phone-switch").onchange = (event) => void control(event.target.checked ? "enable" : "disable");
  $("phone-copy").onclick = () => void copyLink();
  $("phone-link").onfocus = (event) => event.target.select();
  $("phone-new-qr").onclick = async () => {
    const out = await control("revoke");
    if (out.ok) flash(t("New QR code. Links shared before now no longer pair a device; paired devices stay paired."), "ok");
  };
  $("phone-check").onclick = async () => {
    const button = $("phone-check");
    button.disabled = true;
    button.textContent = t("Testing...");
    const out = await api("/api/remote/check", { method: "POST", body: {} });
    button.disabled = false;
    button.textContent = t("Test the link");
    const check = out.data?.check;
    if (check?.ok) flash(t("It works: the link answered from the internet in {seconds} s.", { seconds: (check.ms / 1000).toFixed(1) }), "ok");
    else flash(t("The link did not answer: {error}", { error: check?.error ?? out.data?.error ?? t("unknown") }), "bad");
  };
  const unpairAll = async () => {
    if (!confirm(t("Unpair every device, and make a new QR code and a new link? Every phone will have to scan again."))) return;
    const out = await control("unpair-all");
    if (out.ok) flash(t("Unpaired {n} devices. New QR code and new link.", { n: out.data.removed }), "ok");
  };
  $("phone-unpair-all").onclick = unpairAll;
  $("phone-settings").onclick = () => {
    closePanel();
    window.rosalenaSettings?.open("phone");
  };
  $("phone-forget").onclick = async () => {
    if (!confirm(t("Unpair this device? You will need the QR code again to use Rosalena here."))) return;
    await api("/api/remote/unpair", { method: "POST", body: {} });
    location.reload();
  };

  // Settings > Phone access.
  if (!$("settings-phone")) return;
  $("phone-set-show").onclick = () => {
    window.rosalenaSettings?.close();
    openPanel();
    if (!(view.status?.wanted || view.status?.state === "live")) void control("enable");
  };
  $("phone-set-manage").onclick = () => {
    window.rosalenaSettings?.close();
    openPanel();
  };
  $("phone-set-toggle").onclick = () => {
    const s = view.status;
    void control(s?.wanted || s?.state === "live" || s?.state === "starting" ? "disable" : "enable");
  };
  $("phone-set-unpair-all").onclick = unpairAll;
  $("phone-set-keep").onchange = (event) => void control("settings", { keepOn: event.target.checked });
  $("phone-set-relay").onchange = (event) => void control("settings", { relay: event.target.checked });
  $("phone-set-days").onchange = (event) => void control("settings", { cookieDays: Number(event.target.value) });
  for (const id of ["phone-set-host", "phone-set-port"]) $(id).oninput = (event) => (event.target.dataset.dirty = "1");
  $("phone-set-named-save").onclick = async () => {
    const patch = { namedHost: $("phone-set-host").value.trim(), namedPort: Number($("phone-set-port").value) || 47390 };
    const token = $("phone-set-token").value.trim();
    if (token) patch.namedToken = token;
    const out = await control("settings", patch);
    if (out.ok) {
      $("phone-set-token").value = "";
      delete $("phone-set-host").dataset.dirty;
      delete $("phone-set-port").dataset.dirty;
    }
  };
  $("phone-set-named-clear").onclick = async () => {
    const out = await control("settings", { namedHost: "", namedToken: "" });
    if (out.ok) {
      $("phone-set-host").value = "";
      $("phone-set-token").value = "";
    }
  };
}

wire();
void refresh();

window.rosalenaPhone = {
  open: openPanel,
  close: closePanel,
  loadSettings: () => void refresh(),
};
