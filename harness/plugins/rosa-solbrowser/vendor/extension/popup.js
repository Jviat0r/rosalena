// Popup: the whole daily-use surface (D-015), multi-tab aware (D-022).
// Server row, attached-tabs list (each with a detach ×), one button that
// connects or disconnects the ACTIVE tab, and the off switch (Disconnect /
// Connect SolBrowser). Opening the popup also makes the worker reconnect
// immediately (unless switched off), so clicking the icon diagnoses and fixes.

const $ = (id) => document.getElementById(id);
const ask = (op, extra) => chrome.runtime.sendMessage({ op, ...extra });

let busy = false;
// Errors must survive the refresh that follows an action, or the popup snaps
// back to "Connect this tab" without saying why it failed.
let lastError = "";

function renderTabs(state) {
  const list = $("tabs");
  list.textContent = "";
  const activeId = state?.activeTab?.tabId;
  for (const tab of state?.attachedTabs || []) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.className = `t${tab.tabId === activeId ? " here" : ""}`;
    label.textContent = tab.title || tab.url || `tab ${tab.tabId}`;
    label.title = tab.url || "";
    const x = document.createElement("button");
    x.className = "x";
    x.textContent = "×";
    x.title = "Disconnect this tab";
    x.disabled = busy;
    x.addEventListener("click", () => act("ui.disconnect", { tabId: tab.tabId }));
    li.append(label, x);
    list.append(li);
  }
}

function render(state) {
  const connected = !!state?.serverConnected;
  const paused = !!state?.paused;
  $("server-dot").className = `dot ${connected ? "ok" : paused ? "" : "bad"}`;
  $("server").textContent = connected
    ? `connected · port ${state.port}`
    : paused
      ? "off (you disconnected it)"
      : state?.slotTaken
      ? "in use by another profile"
      : state?.authError
        ? "server not trusted"
        : "waiting for MCP client";

  const n = state?.attachedTabs?.length || 0;
  $("tab-dot").className = `dot ${n ? "ok" : ""}`;
  $("tab").textContent = n ? `${n} attached` : "none attached";
  renderTabs(state);

  const button = $("action");
  const hint = $("hint");
  const say = (text) => {
    hint.textContent = lastError || text;
    hint.style.color = lastError ? "var(--bad)" : "var(--muted)";
  };

  const power = $("power");
  power.disabled = busy || !state;
  power.textContent = paused ? "Connect SolBrowser" : "Disconnect SolBrowser";
  power.title = paused
    ? "Let agents use this browser again"
    : "Release every tab and stop talking to the SolBrowser server until you connect again";

  const active = state?.activeTab;
  if (paused) {
    button.disabled = true;
    button.textContent = "SolBrowser is off";
    say("Agents can't use this browser until you click Connect SolBrowser. This stays off across browser restarts.");
    return;
  }
  if (active?.attached) {
    button.disabled = busy;
    button.textContent = "Disconnect this tab";
    say(connected ? "This tab is being driven. Chrome shows a debugging banner while attached." : "Attached; waiting for the MCP server.");
    return;
  }
  if (!connected && state?.slotTaken) {
    // REL-6 / P-059: another Chrome profile holds the server's extension slot.
    // The user can move it here explicitly; the other profile is then refused.
    button.disabled = busy;
    button.textContent = "Use SolBrowser in this profile";
    hint.textContent = lastError || state.authError || "Another Chrome profile is connected to the SolBrowser server.";
    hint.style.color = "var(--bad)";
    return;
  }
  if (!connected && state?.authError) {
    button.disabled = true;
    button.textContent = "Not connected";
    hint.textContent = state.authError;
    hint.style.color = "var(--bad)";
    return;
  }
  if (!connected) {
    button.disabled = true;
    button.textContent = "Waiting for MCP server";
    say("Start your MCP client (Claude Code, Codex, OpenCode, Cursor…); it launches the server itself.");
    return;
  }
  button.disabled = busy || !active?.attachable;
  button.textContent = "Connect this tab";
  say(
    active?.attachable
      ? active.title || active.url || ""
      : "This page cannot be driven (chrome:// pages and the Web Store block extensions)."
  );
}

async function refresh() {
  try {
    render(await ask("ui.getState"));
  } catch (e) {
    lastError = String(e?.message || e);
    render(null);
  }
}

async function act(op, extra) {
  if (busy) return;
  busy = true;
  lastError = "";
  $("action").disabled = true;
  $("power").disabled = true;
  try {
    const res = await ask(op, extra);
    if (res?.error) lastError = res.error;
  } catch (e) {
    lastError = String(e?.message || e);
  } finally {
    busy = false;
    await refresh();
  }
}

$("action").addEventListener("click", async () => {
  const state = await ask("ui.getState").catch(() => null);
  if (!state?.serverConnected && state?.slotTaken) {
    await act("transport.takeover");
    setTimeout(refresh, 600);
    return;
  }
  const active = state?.activeTab;
  await act(active?.attached ? "ui.disconnect" : "ui.connect", active ? { tabId: active.tabId } : {});
});

$("forget").addEventListener("click", () => act("ui.forgetPairing"));

// Off switch: releases every tab and stops all reconnects until clicked again.
$("power").addEventListener("click", async () => {
  const state = await ask("ui.getState").catch(() => null);
  await act(state?.paused ? "ui.resume" : "ui.pause");
  // Connecting takes a moment; let the server row catch up.
  setTimeout(refresh, 600);
});

// A5: the port is configurable for the case where 8765 sits in a range Windows
// reserves (Hyper-V/WSL/Docker). The worker reconnects when it changes.
chrome.storage.local.get("port").then(({ port }) => {
  if (port) $("port").value = port;
});
$("port").addEventListener("change", async () => {
  const n = Number($("port").value);
  if (!$("port").value || n === 8765) await chrome.storage.local.remove("port");
  else if (Number.isInteger(n) && n >= 1024 && n <= 65535) await chrome.storage.local.set({ port: n });
  setTimeout(refresh, 600);
});

refresh();
// The worker may still be reconnecting when the popup opens; poll briefly so
// the state flips to "connected" without reopening it.
const poll = setInterval(refresh, 1000);
setTimeout(() => clearInterval(poll), 15_000);
