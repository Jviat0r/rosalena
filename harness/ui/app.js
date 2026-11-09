// The whole client. One module, no framework, no build step.
//
// The transcript is rendered from the same event objects the CLI prints and the run
// store records, so a live chat, a replay of a finished chat and a chat from a previous
// process all go through one renderer. That is the point: there is only one description
// of "what happened in this run" in the product.
//
// Rendering of model prose lives in ./format.mjs, which the test suite imports directly.
// This file owns the DOM, the stream, and the small amount of state a chat needs.

// First: the language is read and index.html's static text translated before anything below
// reads the markup (i18n.mjs). Every string a person reads goes through t().
import { chooseLanguage, savedLanguage, t } from "./i18n.mjs";
import {
  ago,
  clip,
  contextTokens,
  escapeHtml,
  formatArgs,
  humanBytes,
  humanMs,
  humanTokens,
  keyStatusNote,
  modelGroupLabel,
  renderMarkdown,
  statusChip,
  toolSummary,
} from "./format.mjs";
import { initPlugins, isCreatorOn, openOmniRoute, openPlugin, refreshPlugins } from "./plugins-ui.js";
import { mountPlugin } from "./plugin-host.js";
import { initUiStyles, styleCommands, styleLabel, styleMenuSection } from "./ui-styles.js";
// The session rail (per-chat info panel): its own module; app.js only feeds it, see "session rail".
import { createSessionRail, idleWindow as railIdleWindow } from "./session-rail.mjs";
import {
  BROWSER_PARTITION,
  HOME_URL,
  WEB_TABS_KEY,
  checkWebUrl,
  isWebTabId,
  newWebTabId,
  pageToChatText,
  parseAddress,
  sanitizeWebState,
  securityOf,
  serializeWebState,
  webTabLabel,
} from "./web-tab.mjs";

const TOKEN = document.querySelector('meta[name="rosalena-token"]').content;
// Set once at the end of this file (createSessionRail); every hook before then is a no-op.
let rail = null;

const el = (id) => document.getElementById(id);
const log = el("log");
const prompt = el("prompt");
const sendBtn = el("send");
const stopBtn = el("stop");
const statusEl = el("status");
const quickModel = el("quick-model");
const attachBtn = el("attach");
const fileInput = el("file-input");
const attachTray = el("attachments");
const app = el("app");
const filterInput = el("filter");
const jumpBtn = el("jump");
const toasts = el("toasts");

// Messages typed while a run is going; see "queue" further down. Each item belongs to the
// chat it was typed in (`chat`), and `paused` holds the chats whose queue waits for Send next.
const queue = { items: [], paused: new Set() };
// The right sidebar's extra tabs (see "extra sidebar tabs"): declared up here because the
// transcript and meter code feed them from the first render on.
const side = { tabs: [], plugins: null, handles: {}, timers: {}, todos: [], compactions: [], meter: null, tab: "files" };
// The sidebar's Browser tabs: each one's last address and title, by tab id (web-tab.mjs).
const web = { state: {}, saveTimer: null };
// Where the terminal element currently lives: its own middle view, or the sidebar tab.
const terminalHome = { parent: null, next: null, where: "main" };

const state = {
  current: null, // {kind:"rosalena"|"external", source?, id}
  parentId: null, // continue this chat's transcript on the next send
  branch: null, // {parentId, from, at}: the next send starts a branch from that point
  stream: null,
  files: [],
  models: [],
  roles: [],
  // The model the composer picker has selected, and the one piece of state the old hidden
  // #model select used to hold. "" means "no model pinned": the request omits `model` and
  // the role (the server default) decides who answers.
  model: "",
  menu: null, // the last /api/models answer, kept so a repaint is not a refetch
  localServer: null, // what the local card holds right now: {up, loading, busy, loaded, pid}
  folders: null, // the last /api/folders answer: { groups: [{id, name, sessions}] }
  all: { chats: [], external: [] },
  busy: false,
  live: null, // the assistant bubble currently receiving deltas
  finalized: new Set(), // steps whose bubble is already closed
  lastAnswer: "",
  pinned: true,
  stats: { steps: 0, tools: 0, tokens: 0, startedAt: null },
  // What the Trajectory tab holds: one entry per run/step/tool/hook/end event of the
  // chat on screen, and the last file path a tool named (the reveal button's target).
  trail: [],
  view: "chat",
  revealPath: "",
  workspace: "",
};

// The empty state is markup, not text: it is put back after every "new chat", so it is
// captured once at load instead of rebuilt by hand.
const WELCOME = log.innerHTML;

// ------------------------------------------------------------------ small pieces

const setStatus = (text, kind) => {
  statusEl.textContent = text;
  statusEl.style.color = kind === "bad" ? "var(--bad)" : kind === "ok" ? "var(--ok)" : "var(--dim-2)";
};

const api = async (path, options) => {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
};

const post = (path, payload) =>
  api(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-rosalena-token": TOKEN },
    body: JSON.stringify(payload),
  });

// Every mutating request carries the token the page was served with; the folder routes
// are mutations too, so they go through the same door rather than a bespoke fetch.
const mutate = (method, path, payload) =>
  api(path, {
    method,
    headers: { "content-type": "application/json", "x-rosalena-token": TOKEN },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });

function toast(text, kind = "") {
  const div = document.createElement("div");
  div.className = `toast ${kind}`;
  div.textContent = text;
  toasts.append(div);
  setTimeout(() => div.remove(), 6000);
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    if (button) {
      const before = button.textContent;
      button.textContent = t("Copied");
      button.classList.add("done");
      setTimeout(() => {
        button.textContent = before;
        button.classList.remove("done");
      }, 1200);
    }
    return true;
  } catch {
    toast(t("The browser refused clipboard access."), "bad");
    return false;
  }
}

// ------------------------------------------------------------------ transcript

function atBottom() {
  return log.scrollTop + log.clientHeight >= log.scrollHeight - 48;
}

function follow(force = false) {
  if (force || state.pinned) log.scrollTop = log.scrollHeight;
  else jumpBtn.hidden = false;
}

function clearLog() {
  log.innerHTML = "";
  state.live = null;
  state.group = null;
  state.runId = null;
  side.compactions = [];
  side.meter = null;
  paintTodos([]);
  // A paint queued for a bubble that no longer exists is not just wasted: it would
  // write into a detached node. Dropping the reference cancels it.
  render.live = null;
  state.pinned = true;
  jumpBtn.hidden = true;
  setStats();
  // A fresh chat has no measurement yet. Hiding the gauge is honest; a 0% one would
  // claim the conversation is empty when it has not been counted at all.
  setContext(null);
  toggleCtxPanel(false);
  // The trajectory belongs to one chat, so it goes with the transcript.
  trailReset();
  paintReveal();
  rail?.reset();
}

/**
 * Branch from one of your messages (Pi's most praised feature): the next send starts a
 * new conversation from the turn before this message, with your edited text instead.
 */
function markBranchable(body, { runId, parentId, text }) {
  const wrap = body?.parentElement;
  if (!wrap || !runId || wrap.querySelector(".branch-btn")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "branch-btn";
  button.textContent = t("Branch");
  button.title = t("Start a new chat from here: edit this message and send it. This chat stays as it is.");
  button.addEventListener("click", () => {
    setBranch({ parentId: parentId ?? null, from: state.current?.thread ?? runId, at: runId });
    prompt.value = text;
    autosize();
    prompt.focus();
  });
  wrap.append(button);
}

function setBranch(branch) {
  state.branch = branch;
  let chip = el("branch-chip");
  if (!branch) {
    chip?.remove();
    return;
  }
  if (!chip) {
    chip = document.createElement("div");
    chip.id = "branch-chip";
    chip.className = "branch-chip";
    const label = document.createElement("span");
    label.textContent = t("Branching from an earlier message: edit it and send. The original chat is kept.");
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "mini-btn";
    cancel.textContent = t("Cancel");
    cancel.addEventListener("click", () => {
      setBranch(null);
      prompt.value = "";
      autosize();
    });
    chip.append(label, cancel);
    document.querySelector(".composer")?.prepend(chip);
  }
}

function addMessage(role, text, { plain = false } = {}) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = role === "user" ? t("you") : role === "error" ? "error" : "rosalena";
  const body = document.createElement("div");
  body.className = "body";
  if (plain) {
    body.style.whiteSpace = "pre-wrap";
    body.textContent = text;
  } else {
    body.innerHTML = renderMarkdown(text);
  }
  wrap.append(who, body);
  log.append(wrap);
  follow();
  return body;
}

/**
 * A chat that ended before finishing says so in a card that cannot be missed: why it
 * stopped, and the two things to do about it. Returns false for a reason it has no words
 * for (the caller then draws the plain line).
 */
function stopCard(event) {
  const steps = Number(event.maxSteps) || null;
  const reasons = {
    max_steps: [
      steps ? t("Stopped: it reached its step limit ({steps} steps)", { steps: steps.toLocaleString() }) : t("Stopped: it reached its step limit"),
      t("Each step is one model call. Send “continue” to pick up where it left off, or raise the limit for longer tasks."),
      true,
    ],
    wall_clock: [
      event.maxWallMs ? t("Stopped: it ran out of time ({time})", { time: minutesText(Math.round(event.maxWallMs / 60000)) }) : t("Stopped: it ran out of time"),
      t("Send “continue” to pick up where it left off, or raise the time limit."),
      true,
    ],
    cost: [t("Stopped: this message hit its spend limit"), t("Send “continue” to keep going, or change the limits in Settings > Spend limits."), false],
    stalled: [t("Stopped: it was repeating itself"), t("The same step kept coming back with the same result, so the run was ended rather than spending more. Say what to try differently, or “continue”."), false],
    guard: [event.plugin != null ? t("Stopped by {plugin}", { plugin: event.plugin }) : t("Stopped by a plugin"), t("{detail} Send “continue” if it should keep going.", { detail: event.detail ?? event.why ?? t("A plugin ended the run.") }), false],
    killed: [t("Stopped: the app or its process ended mid-run"), t("Nothing that finished was lost. Send “continue” to pick it up."), false],
    empty_reply: [t("Stopped: the model kept answering with nothing"), t("This usually means it ran out of room (its output or context limit). Send “continue”, or switch to a model with a bigger window."), false],
    goal_max_rounds: [t("Goal paused: it used all {rounds} rounds", { rounds: event.rounds ?? "" }).replace("  ", " "), t("The goal is not recorded as done. Send “continue” to start more rounds."), false],
    goal_time: [t("Goal paused: it reached its time limit"), t("The goal is not recorded as done. Send “continue” to keep going."), false],
    goal_cost: [t("Goal paused: it reached its spend limit"), t("Send “continue” to keep going, or change the limits in Settings > Spend limits."), false],
    goal_failing: [t("Goal paused: two rounds in a row failed"), t("The model or the router is having trouble. Check the errors above, then send “continue”."), false],
  };
  const entry = reasons[event.reason];
  if (!entry) return false;
  const [title, body, raise] = entry;
  const card = document.createElement("div");
  card.className = "stop-card";
  card.setAttribute("role", "status");
  const head = document.createElement("strong");
  head.textContent = title;
  const text = document.createElement("p");
  text.textContent = body;
  const actions = document.createElement("div");
  actions.className = "stop-actions";
  const go = document.createElement("button");
  go.type = "button";
  go.className = "mini-btn stop-continue";
  go.textContent = t("Continue");
  go.onclick = () => {
    if (state.busy) return toast(t("It is already running."), "warn");
    prompt.value = "continue";
    void send();
  };
  actions.append(go);
  if (raise) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "mini-btn";
    more.textContent = event.reason === "wall_clock" ? t("Raise the time limit") : t("Raise the step limit");
    more.onclick = (click) => {
      click.stopPropagation();
      toggleSettings(true);
      showSettingsPage("agent");
    };
    actions.append(more);
  }
  card.append(head, text, actions);
  log.append(card);
  follow();
  return true;
}

function addLine(text, kind = "", mark = "·") {
  const div = document.createElement("div");
  div.className = `line ${kind}`;
  const m = document.createElement("span");
  m.className = "mark";
  m.textContent = mark;
  const t = document.createElement("span");
  t.className = "line-text";
  t.textContent = text;
  div.append(m, t);
  log.append(div);
  follow();
  return div;
}

function addStepRule(n, target, ms) {
  const div = document.createElement("div");
  div.className = "step-rule";
  div.textContent = `${t("step {n}", { n })}${target ? ` · ${target}` : ""}${ms ? ` · ${humanMs(ms)}` : ""}`;
  log.append(div);
  follow();
}

function addToolCard(event) {
  const ok = event.ok !== false;
  const details = document.createElement("details");
  details.className = `tool${ok ? "" : " bad"}`;

  const head = document.createElement("summary");
  head.className = "tool-head";
  const chev = document.createElement("span");
  chev.className = "chev";
  chev.textContent = "▸";
  const name = document.createElement("span");
  name.className = "tool-name";
  name.textContent = event.name ?? "tool";
  const arg = document.createElement("span");
  arg.className = "tool-arg";
  arg.textContent = toolSummary(event.name, event.args);
  const time = document.createElement("span");
  time.className = "tool-time";
  time.textContent = humanMs(event.ms);
  const mark = document.createElement("span");
  mark.className = "tool-ok";
  mark.textContent = ok ? "✓" : "✗";
  head.append(chev, name, arg, time, mark);

  const body = document.createElement("div");
  body.className = "tool-body";
  const args = formatArgs(event.args);
  if (args) {
    const label = document.createElement("div");
    label.className = "tool-label";
    label.textContent = t("arguments");
    const pre = document.createElement("pre");
    pre.textContent = args;
    body.append(label, pre);
  }
  if (event.preview) {
    const label = document.createElement("div");
    label.className = "tool-label";
    label.textContent = ok ? t("result") : t("error");
    const pre = document.createElement("pre");
    pre.textContent = String(event.preview);
    body.append(label, pre);
  }

  details.append(head, body);
  // A question or a presented file already has its own card; a second line for the same
  // call would only repeat it. The Trajectory tab still lists the call.
  if (event.name === "ask_user" || event.name === "present" || event.name === "exit_plan_mode") return;
  addToGroup(event, details);
}

// ------------------------------------------------------------------ activity groups
//
// Tool calls do not get a row each in the transcript any more. Everything the model does
// between two things it says is folded into one line - "Ran 3 commands, read 2 files" -
// and the line opens to the individual calls, each still expandable to its arguments and
// result. A group holds at most ACTIVITY_GROUP_MAX calls; past that a new line starts, so
// one line never hides a hundred calls. Prose from the model closes the group.

const ACTIVITY_GROUP_MAX = 20;

// verb (from toolVerb) -> its phrase for a count, so "ran" reads "Ran 3 commands". The verbs
// are TOOL_VERBS' English words used as keys: they stay English, only the phrases translate.
const ACTIVITY_NOUNS = {
  ran: (n) => t("ran {n} commands", { n }),
  read: (n) => t("read {n} files", { n }),
  wrote: (n) => t("edited {n} files", { n }),
  listed: (n) => t("listed {n} folders", { n }),
  searched: (n) => t("searched {n} times", { n }),
  delegated: (n) => t("started {n} subagents", { n }),
  "searched the web": (n) => t("searched the web {n} times", { n }),
  fetched: (n) => t("fetched {n} pages", { n }),
  checked: (n) => t("checked {n} jobs", { n }),
  viewed: (n) => t("viewed {n} images", { n }),
};
// The verbs with no count noun (an unknown tool keeps its own name).
const ACTIVITY_VERB_TEXT = { "updated the checklist": t("updated the checklist"), used: t("used") };

/** "Ran 3 commands, read 2 files, recall ×2" from the per-verb tallies, in first-seen order. */
function activitySummary(counts, notes = 0) {
  const parts = [];
  for (const [verb, n] of counts) {
    const phrase = Object.hasOwn(ACTIVITY_NOUNS, verb) ? ACTIVITY_NOUNS[verb] : null;
    const word = ACTIVITY_VERB_TEXT[verb] ?? verb;
    parts.push(phrase ? phrase(n) : `${word}${n > 1 ? ` ×${n}` : ""}`);
  }
  const text = parts.join(", ") || (notes ? t("{n} notes", { n: notes }) : t("Working"));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function closeActivityGroup() {
  const group = state.group;
  if (!group) return;
  group.el.classList.remove("act-live");
  group.now.textContent = "";
  state.group = null;
}

/** The open group, or a new one at the bottom of the transcript. */
function activityGroup() {
  const open = state.group;
  if (open && open.el.isConnected && open.tools < ACTIVITY_GROUP_MAX) return open;
  closeActivityGroup();

  const details = document.createElement("details");
  details.className = "act-group";
  if (state.busy && !render.replay) details.classList.add("act-live");
  const head = document.createElement("summary");
  head.className = "act-head";
  const text = document.createElement("span");
  text.className = "act-text";
  text.textContent = t("Working");
  const fails = document.createElement("span");
  fails.className = "act-fails";
  const now = document.createElement("span");
  now.className = "act-now";
  const chev = document.createElement("span");
  chev.className = "act-chev";
  chev.setAttribute("aria-hidden", "true");
  chev.textContent = "›";
  head.append(text, fails, chev, now);
  const body = document.createElement("div");
  body.className = "act-body";
  details.append(head, body);
  log.append(details);
  follow();

  state.group = { el: details, text, fails, now, body, counts: new Map(), tools: 0, failed: 0, notes: 0 };
  return state.group;
}

/** Put one tool card in the open group and update its line. */
function addToGroup(event, card) {
  const group = activityGroup();
  group.body.append(card);
  noteFileChange(group, event);
  group.tools += 1;
  const verb = toolVerb(event.name);
  group.counts.set(verb, (group.counts.get(verb) ?? 0) + 1);
  if (event.ok === false) group.failed += 1;
  group.text.textContent = activitySummary(group.counts, group.notes);
  group.fails.textContent = group.failed ? t("{n} failed", { n: group.failed }) : "";
  // While the run is live the line also says what it touched last.
  if (group.el.classList.contains("act-live")) {
    const target = trailTarget({ args: event.args, path: "" });
    group.now.textContent = target ? clip(target, 70) : "";
  }
  follow();
}

/** A minor note (retry, hook, cache hit...) goes in the group, not in the conversation. */
function addActivityLine(text, kind = "", mark = "·") {
  const div = addLine(text, kind, mark);
  const group = activityGroup();
  group.body.append(div);
  group.notes += 1;
  group.text.textContent = activitySummary(group.counts, group.notes);
  if (kind === "warn") group.el.classList.add("act-warn");
  return div;
}

/**
 * A compaction, drawn as what it is: a fold in the transcript.
 *
 * Not a message. It has no author and nothing in it was said by the user or the
 * model, so it gets a rule-like marker that is collapsible and closed by default -
 * the conversation reads as continuous, and the evidence that half of it is now a
 * summary is one click away, with the checkpoint text, what it cost before and
 * after, and the original request the summary was told never to lose.
 */
function addCompaction(event) {
  const details = document.createElement("details");
  details.className = "compaction";

  const head = document.createElement("summary");
  head.className = "cmp-head";
  const mark = document.createElement("span");
  mark.className = "cmp-mark";
  mark.textContent = "≡";
  const title = document.createElement("span");
  title.className = "cmp-title";
  const dropped = Number(event.dropped);
  title.textContent = t("context compacted · {n} earlier messages replaced by a summary", { n: Number.isFinite(dropped) ? dropped : "?" });
  const figures = document.createElement("span");
  figures.className = "cmp-figures";
  const before = humanTokens(event.tokensBefore) || "?";
  const after = humanTokens(event.tokensAfter) || "?";
  figures.textContent = `${before} → ${after}`;
  head.append(mark, title, figures);

  const body = document.createElement("div");
  body.className = "cmp-body";

  if (event.originalRequest) {
    const label = document.createElement("div");
    label.className = "tool-label";
    label.textContent = t("original request (kept verbatim)");
    const text = document.createElement("pre");
    text.textContent = String(event.originalRequest);
    body.append(label, text);
  }

  const label = document.createElement("div");
  label.className = "tool-label";
  label.textContent = event.how === "mechanical" ? t("mechanical summary") : t("summary written by the summariser");
  const text = document.createElement("pre");
  text.textContent = String(event.summary ?? event.note ?? "");
  body.append(label, text);

  if (event.note) {
    const note = document.createElement("div");
    note.className = "cmp-note";
    note.textContent = event.note;
    body.append(note);
  }

  details.append(head, body);
  log.append(details);
  follow();
}

// ------------------------------------------------------------------ render rate
//
// A delta arrives per token, and a DOM write per token is wasted work: the compositor
// shows at most one paint per frame anyway. Streaming text is therefore coalesced -
// every delta is appended to the bubble's *text* immediately (nothing is dropped), and
// the DOM write happens on a requestAnimationFrame tick whose time budget comes from
// the render-rate setting. Smooth = 60, Balanced = 30, Low = 15 updates per second.
//
// The counters exist because this is the one claim in the UI that cannot be seen: a
// slower rate looks the same as a faster one at a glance. `applied` counts DOM writes,
// `received` counts deltas, and the settings popover shows both.
const RATES = { 60: 60, 30: 30, 15: 15 };
const render = {
  rate: 30,
  applied: 0,
  received: 0,
  last: 0,
  frame: 0,
  live: null,
  counterAt: 0,
  replay: false,
};

const raf =
  typeof requestAnimationFrame === "function"
    ? (fn) => requestAnimationFrame(fn)
    : (fn) => setTimeout(() => fn(performance.now()), 16);

function readRenderRate() {
  try {
    const saved = Number(localStorage.getItem("rosalena-render-rate"));
    if (RATES[saved]) return saved;
  } catch {
    /* private mode */
  }
  return 30;
}

function updateRateCounter(stamp) {
  const counter = el("rate-counter");
  if (!counter) return;
  counter.textContent = `${render.applied} / ${render.received}`;
  counter.title = t("{applied} of {received} DOM updates applied at {rate}/s", { applied: render.applied, received: render.received, rate: render.rate });
  render.counterAt = stamp ?? performance.now();
}

function paintRateUI() {
  const value = el("rate-value");
  if (value) value.textContent = t("{rate} updates/s", { rate: render.rate });
  for (const button of document.querySelectorAll("#settings-panel .seg-btn[data-rate]")) {
    button.setAttribute("aria-pressed", String(Number(button.dataset.rate) === render.rate));
  }
}

function setRenderRate(rate) {
  const next = Number(rate);
  if (!RATES[next]) return;
  render.rate = next;
  // The next paint is allowed immediately: changing the rate should not look like a
  // stall because the old budget had not elapsed yet.
  render.last = 0;
  try {
    localStorage.setItem("rosalena-render-rate", String(next));
  } catch {
    /* private mode */
  }
  paintRateUI();
}

/** The DOM write itself. Counted, because the count is the proof the rate is real. */
function applyLive(live, stamp) {
  if (!live.el.isConnected) return;
  live.el.innerHTML = renderMarkdown(live.text);
  // A step can stream nothing useful and then call a tool; until it says something,
  // the bubble is a bare frame rather than an empty panel.
  live.wrap.classList.toggle("bare", !live.text.trim());
  render.applied += 1;
  follow();
  // The counter is throttled: it is not worth a DOM write on every frame, and it is
  // only on screen while the settings popover is open.
  if (!render.counterAt || stamp - render.counterAt > 400) updateRateCounter(stamp);
}

function flushPaint(stamp) {
  render.frame = 0;
  const live = render.live;
  if (!live) return;
  const interval = 1000 / render.rate;
  // Time budget: one paint per `interval`, and never more than one per frame because
  // the frame is the scheduling unit. The half-millisecond slack keeps a 60/s budget
  // from being missed on a 60 Hz display by rounding alone.
  if (render.last && stamp - render.last < interval - 0.5) {
    render.frame = raf(flushPaint);
    return;
  }
  render.last = stamp;
  applyLive(live, stamp);
}

/** Re-render a streaming bubble at most `render.rate` times a second, not once a token. */
function paintLive(live) {
  render.live = live;
  if (render.frame) return;
  render.frame = raf(flushPaint);
}

function liveBubble(step) {
  if (state.live && state.live.step === step) return state.live;
  const body = addMessage("assistant", "");
  body.parentElement.classList.add("streaming");
  state.live = { step, el: body, text: "", pending: false, wrap: body.parentElement };
  return state.live;
}

function finalizeLive(step, content, meta) {
  // A step that only called tools has no prose of its own; opening an empty bubble for
  // it would fill the transcript with blank panels.
  const existing = state.live && state.live.step === step ? state.live : null;
  const live = existing ?? (String(content ?? "").trim() ? liveBubble(step) : null);
  state.finalized.add(step);
  if (!live) return;
  // The authoritative text arrives with the `assistant` event. A paint still queued for
  // this bubble would only rewrite it with the same text, so the queue is dropped:
  // one write from the final event is both cheaper and the one that must win.
  if (render.live === live) render.live = null;
  live.text = content ?? live.text;
  if (!String(live.text).trim()) {
    // Nothing was said in this step, only done: no bubble, and the step's figures are a
    // quiet line inside the activity group instead of a "rosalena" row of their own.
    live.wrap.remove();
    if (meta && state.group) {
      const line = document.createElement("div");
      line.className = "act-meta";
      line.textContent = meta;
      state.group.body.append(line);
    }
    if (state.live === live) state.live = null;
    return;
  }
  live.el.innerHTML = renderMarkdown(live.text);
  live.wrap.classList.remove("streaming");
  live.wrap.classList.toggle("bare", !live.text.trim());
  if (meta) {
    const foot = document.createElement("div");
    foot.className = "msg-meta";
    foot.textContent = meta;
    live.wrap.append(foot);
  }
  if (state.live === live) state.live = null;
  follow();
}

// ------------------------------------------------------------------ context meter

const ctxMeter = el("context-meter");
const ctxButton = el("ctx-button");
const ctxPanel = el("ctx-panel");
const ctxArc = el("ctx-arc");
// r=5.5 in a 14x14 viewBox, so the ring is the same shape the reference meter uses.
const RING = 2 * Math.PI * 5.5;

/**
 * Paint one reading of the meter.
 *
 * `meter` is whatever `/api/context` answers or a `ui/context` event carries; null means
 * "no reading yet". The window is a property of the server, not of the conversation, so an
 * idle chat still gets the circle with a zero reading against the real window: a control
 * that only appears after the first answer reads as a missing control, which is how it was
 * reported. A server that cannot name a window hides the gauge instead of inventing one.
 * Nothing here computes a token count: the numbers arrive measured.
 */
function setContext(meter) {
  rail?.context(meter && meter.window ? meter : null);
  if (!meter || !meter.window) {
    const idle = Number(state.menu?.contextWindow) || 0;
    if (!idle) {
      ctxMeter.hidden = true;
      return;
    }
    paintMeter({ used: 0, window: idle, percent: 0, parts: {} });
    return;
  }
  paintMeter(meter);
}

function paintMeter(meter) {
  const { used = 0, window: win = 0, parts = {} } = meter;
  // The sidebar's Context tab reads the same reading.
  side.meter = meter;
  if (side.tab === "context") void renderSideTab("context");
  const fraction = win > 0 ? Math.min(1, Math.max(0, used / win)) : 0;
  const percent = Number.isFinite(Number(meter.percent)) ? Math.round(Number(meter.percent)) : Math.round(fraction * 100);

  ctxMeter.hidden = false;
  el("ctx-percent").textContent = `${percent}%`;
  el("ctx-used").textContent = `${contextTokens(used)} / ${contextTokens(win)}`;
  // The arc is drawn once: dasharray is the whole circumference, and the offset
  // hides the unused part of it. -90deg (in CSS) starts the arc at twelve o'clock.
  ctxArc.style.strokeDasharray = `${RING}`;
  ctxArc.style.strokeDashoffset = `${RING * (1 - fraction)}`;

  el("ctx-headline").textContent = t("{percent}% of context used", { percent });
  el("ctx-system").textContent = contextTokens(parts.system);
  el("ctx-tools").textContent = contextTokens(parts.tools);
  el("ctx-messages").textContent = contextTokens(parts.messages);

  const threshold = Number(meter.threshold) || null;
  const bits = [];
  if (threshold) bits.push(t("compacts at {tokens}", { tokens: contextTokens(threshold) }));
  // Which row is measured rather than estimated. This is the difference between
  // "the provider told us" and "we predict it", and the user is entitled to know.
  if (meter.source === "provider") bits.push(t("messages row measured by the provider"));
  else if (meter.source === "estimate") bits.push(t("projected from an unsent request"));
  el("ctx-foot").textContent = bits.join(" · ");

  // Colour says what the number cannot: near the threshold is worth noticing, and
  // past it the next step is going to compact.
  ctxMeter.classList.toggle("warn", Boolean(threshold) && used > threshold * 0.85 && used <= threshold);
  ctxMeter.classList.toggle("bad", Boolean(threshold) && used > threshold);
}

function toggleCtxPanel(open) {
  const next = open ?? ctxPanel.hidden;
  ctxPanel.hidden = !next;
  ctxButton.setAttribute("aria-expanded", next ? "true" : "false");
}

ctxButton.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleCtxPanel();
});
document.addEventListener("click", (event) => {
  if (!ctxPanel.hidden && !ctxMeter.contains(event.target)) toggleCtxPanel(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !ctxPanel.hidden) toggleCtxPanel(false);
});

/** The reading for a chat that is not live in this page: ask the server. */
async function refreshContext(id) {
  if (!id) return null;
  try {
    const meter = await api(`/api/context?id=${encodeURIComponent(id)}`);
    if (meter.measured === false) return null;
    return meter;
  } catch {
    // A chat whose record has no meter (an old run, a run that never got a reading)
    // hides the gauge instead of showing a fabricated one.
    return null;
  }
}

// ------------------------------------------------------------------ stats

function setStats() {
  const s = state.stats;
  const any = s.steps || s.tools || s.tokens || s.startedAt;
  el("stats").hidden = !any;
  if (!any) return;
  el("stat-steps").textContent = t("{n} steps", { n: s.steps });
  el("stat-tools").textContent = s.tools ? t("{n} tool calls", { n: s.tools }) : "";
  el("stat-time").textContent = s.startedAt ? humanMs(Date.now() - s.startedAt) : "";
  el("stat-tokens").textContent = humanTokens(s.tokens);
  el("stat-target").textContent = modelDisplayName(s.target);
}

function resetStats() {
  state.stats = { steps: 0, tools: 0, tokens: 0, startedAt: null, target: "" };
  setStats();
}

// A ticking clock, but only while a run is live: a static "0s" on an idle chat is noise.
setInterval(() => {
  if (state.busy && state.stats.startedAt) setStats();
}, 1000);

// ------------------------------------------------------------------ one renderer

function renderEvent(event) {
  // The trail sees every event before the transcript does, and before any early `break`,
  // so the two views can never disagree about what happened. Pings are transport noise.
  if (event.type && event.type !== "ping") recordTrail(event);
  if (event.type && event.type !== "ping") rail?.event(event);
  switch (event.type) {
    case "run":
      state.runId = event.id ?? state.runId;
      // A follow-up keeps the conversation's title: it is the same chat, one turn later.
      if (!state.current?.thread || state.current.thread === event.id) setTitle(clip(event.task, 68), `${t("class {cls}", { cls: event.cls })} · ${event.id}`);
      // A run starts from zero: a count left over from the chat that was on screen a
      // moment ago would be shown against this one.
      state.stats = { steps: 0, tools: 0, tokens: 0, startedAt: Date.now(), target: "" };
      setStats();
      render.received = 0;
      render.applied = 0;
      updateRateCounter(performance.now());
      break;

    case "delta": {
      state.stats.steps = Math.max(state.stats.steps, event.step ?? 0);
      const live = liveBubble(event.step ?? 0);
      live.text += event.text ?? "";
      if (String(event.text ?? "").trim()) closeActivityGroup();
      // A replayed transcript is not a stream: its deltas are collected and the step's
      // authoritative text is written once, so nothing here counts as a paint.
      if (render.replay) break;
      // One delta in, at most one paint out per render-rate tick.
      render.received += 1;
      paintLive(live);
      break;
    }

    case "assistant": {
      const step = event.step ?? 0;
      state.stats.steps = Math.max(state.stats.steps, step);
      const usage = event.usage ?? null;
      if (usage) state.stats.tokens += (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
      if (event.target) state.stats.target = event.target;
      const tokens = usage ? humanTokens((usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)) : "";
      const meta = [
        modelDisplayName(event.target),
        event.streamed ? (event.badFrames ? t("{frames} frames ({bad} bad)", { frames: event.frames ?? 0, bad: event.badFrames }) : t("{frames} frames", { frames: event.frames ?? 0 })) : t("one shot"),
        event.ttftMs ? t("{time} to first token", { time: humanMs(event.ttftMs) }) : "",
        event.ms ? humanMs(event.ms) : "",
        tokens,
        event.reasoningChars ? t("{chars} chars of thinking", { chars: event.reasoningChars }) : "",
        event.toolCalls ? t("{n} tool calls", { n: event.toolCalls }) : "",
      ]
        .filter(Boolean)
        .join(" · ");
      // A step that streamed now ends with its authoritative text; a step that did not
      // stream (or arrived after a retry) still needs a bubble of its own.
      if (String(event.content ?? "").trim()) closeActivityGroup();
      finalizeLive(step, event.content, meta);
      state.stats.target = event.target ?? state.stats.target;
      setStats();
      break;
    }

    case "tool":
      state.stats.tools += 1;
      {
        const todos = todosFromToolEvent(event);
        if (todos) paintTodos(todos);
      }
      addToolCard(event);
      if (!render.replay && /^sol_/.test(event.name ?? "") && String(event.preview ?? "").includes(SOLBROWSER_NOT_CONNECTED)) offerSolBrowserSetup();
      setStats();
      break;

    case "notice":
      addActivityLine(`${(event.from ?? []).join(", ") || "plugin"}: ${event.text ?? ""}`, "", "◆");
      break;

    // Steer: the run took in a message sent with the queue's Steer button.
    case "steer":
      addActivityLine(t("took in your message: {text}", { text: clip(event.text ?? "", 140) }), "", "➤");
      break;

    // The run ended before it reached a Steer message: back to the front of the queue.
    case "steer_unused":
      if (!render.replay && Array.isArray(event.texts)) {
        queue.items.unshift(...event.texts.map((text) => ({ text, files: [], chat: queueKey() })));
        renderQueue();
      }
      break;

    case "context_window":
      addActivityLine(t("context window now {to} (was {from})", { to: shortTokens(event.to), from: shortTokens(event.from) }), "", "◆");
      break;

    case "goal_continue":
      addActivityLine(t("goal not done yet: carrying on ({attempt}/{of})", { attempt: event.attempt, of: event.of }), "", "↻");
      break;

    case "mission_round":
      if (event.round > 1) addActivityLine(t("goal: round {round} of up to {of}, starting fresh from the goal file", { round: event.round, of: event.of }), "", "↻");
      break;

    case "retry":
      // A router that stopped answering is waited for (agent.mjs ROUTER_RECONNECT): its
      // own sentence says how long, which reads better than "retry 1/1" repeated.
      addActivityLine(
        event.reason === "router_unreachable"
          ? clip(event.message, 160)
          : t("retry {attempt}/{of} in {wait} · {model} · {reason}: {message}", { attempt: event.attempt, of: event.of, wait: humanMs(event.waitMs), model: event.model ?? "", reason: event.reason, message: clip(event.message, 160) }),
        "warn",
        "↻",
      );
      break;

    case "retry_ok":
      addActivityLine(t("recovered on attempt {attempt} via {target}", { attempt: event.attempt, target: event.target ?? t("the next model") }), "ok", "✓");
      break;

    case "watchdog":
      addActivityLine(`${t("watchdog: {kind} at {time}", { kind: event.kind, time: humanMs(event.ms) })}${event.model ? ` (${event.model})` : ""}`, "warn", "⏱");
      break;

    case "error":
      addMessage("error", event.message ?? t("unknown error"));
      setStatus(t("failed"), "bad");
      break;

    case "ask_user": {
      // The model stopped to ask. Shown as its own message, with the options as buttons
      // that fill the composer: the reply continues this chat.
      closeActivityGroup();
      const body = addMessage("assistant", event.question ?? "");
      body.parentElement.classList.add("asked");
      if (Array.isArray(event.options) && event.options.length) {
        const row = document.createElement("div");
        row.className = "ask-options";
        for (const option of event.options) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "starter";
          button.textContent = option;
          button.onclick = () => {
            prompt.value = option;
            autosize();
            prompt.focus();
          };
          row.append(button);
        }
        body.append(row);
      }
      break;
    }

    case "present": {
      // A finished file, shown as a card: the name, what it is, and a way to open it.
      const card = document.createElement("div");
      card.className = "present-card";
      const name = document.createElement("div");
      name.className = "present-name";
      name.textContent = event.path ?? t("file");
      const note = document.createElement("div");
      note.className = "present-note";
      note.textContent = [event.note, Number.isFinite(event.size) ? humanBytes(event.size) : ""].filter(Boolean).join(" · ");
      const show = document.createElement("button");
      show.type = "button";
      show.className = "mini-btn";
      show.textContent = t("Show in folder");
      show.onclick = () => void revealPath(event.path);
      card.append(name, note, show);
      closeActivityGroup();
      log.append(card);
      follow();
      break;
    }

    case "approval":
      renderApprovalCard(event);
      break;

    case "approval_done":
      markApproval(event.id, event.decision);
      break;

    case "plan":
      // The plan itself is drawn by its approval card.
      break;

    case "plan_approved":
      addActivityLine(t("plan approved: carrying it out"), "ok", "✓");
      break;

    case "plan_rejected":
      addActivityLine(event.note ? t("plan sent back for changes: {note}", { note: clip(event.note, 120) }) : t("plan sent back for changes"), "warn", "↺");
      break;

    case "permission":
      addActivityLine(t("refused {tool}: {reason}", { tool: String(event.tool ?? "").replace(/_/g, " "), reason: clip(event.reason, 140) }), "warn", "⛔");
      break;

    case "image":
      // The read_image tool card already says which picture was viewed.
      break;

    case "instructions":
      addActivityLine(
        t("following the project rules in {files}", { files: (event.files ?? []).map((file) => String(file).split(/[\\/]/).slice(-2).join("/")).join(", ") }),
        "",
        "§",
      );
      break;

    case "empty_reply":
      addActivityLine(t("the model replied with nothing, so it was asked to continue ({attempt} of 2)", { attempt: event.attempt ?? 1 }), "warn", "↻");
      break;

    case "nudge":
      addActivityLine(t("the model had only been reading, so it was told to start making the changes"), "", "◎");
      break;

    case "focus":
      addActivityLine(t("reminded the model of your request (step {step})", { step: event.step ?? "?" }), "", "◎");
      break;

    case "tools_loaded":
      // On-demand tool loading (tool-loading.mjs). When the model asked, its load_tools
      // call is already a row; only a tool loaded because the model called it directly
      // needs a line of its own.
      if (event.by === "call") addActivityLine(t("loaded {names}", { names: (event.names ?? []).join(", ").replace(/_/g, " ") }), "", "◎");
      break;

    case "stopped":
      // Every early end says why, plainly, with what to do about it (stopCard).
      if (event.reason !== "cancelled" && stopCard(event)) break;
      addLine(
        `${t("stopped: {reason}", { reason: event.reason ?? t("asked") })}${event.plugin ? ` ${t("by {plugin}", { plugin: event.plugin })}` : ""}${event.detail ? ` — ${event.detail}` : ""}${event.spent ? ` ${t("after {spent}", { spent: event.spent })}` : ""}`,
        "warn",
        "■",
      );
      break;

    case "compaction":
      // A fold in the transcript, not a message: see addCompaction.
      addCompaction(event);
      side.compactions.push(event);
      if (side.tab === "context") void renderSideTab("context");
      // The numbers moved because the history did; the event that follows this one is
      // the post-compaction reading, so nothing is set here.
      break;

    case "compact":
      // Runs recorded before the event was renamed still have `compact` in their logs.
      addCompaction({
        dropped: event.dropped,
        kept: event.kept,
        how: event.how,
        note: event.note,
        tokensBefore: event.tokensBefore ?? event.before,
        tokensAfter: event.tokensAfter ?? event.after,
        summary: event.summary,
        originalRequest: event.originalRequest,
      });
      break;

    case "compact_skipped":
      addActivityLine(t("compaction skipped: {reason}", { reason: clip(event.reason, 120) }), "", "≡");
      break;

    case "ui/context":
      // A sub-agent's prompt is a different conversation: its numbers would make the
      // gauge jump backwards for the run the page is actually watching.
      if (event.sub) break;
      setContext(event);
      break;

    case "context_cache":
      addActivityLine(t("cache hit: {tool} {path} ({size})", { tool: event.tool, path: event.path, size: humanBytes(event.bytes) }), "", "⧉");
      break;

    case "fix":
      addActivityLine(t("fixed: {text}", { text: clip(event.text ?? event.message ?? JSON.stringify(event), 160) }), "", "✎");
      break;

    case "judge": {
      const verdict = event.verdict ?? event.ok ?? event.result;
      const text = typeof verdict === "string" ? verdict : JSON.stringify(verdict ?? null);
      addActivityLine(t("judge: {text}", { text: clip(text, 160) }), verdict === false ? "warn" : "", "⚖");
      break;
    }

    case "goal":
      addActivityLine(t("goal round {round}", { round: `${event.round ?? "?"}${event.max ? `/${event.max}` : ""}` }), "", "◈");
      break;

    case "goal_written":
      addActivityLine(`${t("goal file updated")}${event.round ? ` (${t("round {round}", { round: event.round })})` : ""}${event.bytes ? ` · ${humanBytes(event.bytes)}` : ""}${event.done ? ` · ${t("marked done")}` : ""}`, event.done ? "ok" : "", "◈");
      break;

    case "goal_error":
      addActivityLine(t("goal file: {message}", { message: clip(event.message, 160) }), "warn", "◈");
      break;

    case "goal_done_requested":
      addActivityLine(t("the agent asked for this goal to be closed"), "ok", "◈");
      break;

    case "hook":
      addActivityLine(clip(event.message, 160), "", "⚙");
      break;

    case "run_end":
      state.stats.steps = Math.max(state.stats.steps, event.steps ?? 0);
      setStats();
      // An end with no "stopped" event of its own (the model kept answering with nothing).
      if (event.stopped === "empty_reply") stopCard({ reason: "empty_reply" });
      break;

    case "goal_stopped":
      stopCard(event);
      break;

    case "run_store_error":
      addLine(t("could not write the run record: {message}", { message: clip(event.message ?? event.error, 160) }), "warn", "!");
      break;

    case "ui/end":
      finishRun(event);
      break;

    default:
      // Unknown event types are not dropped silently in a debugging tool.
      if (event.type && event.type !== "ping") addLine(clip(JSON.stringify(event), 200), "", "?");
  }
}

/**
 * "Good answer / Bad answer" under a finished chat. A bad rating asks for a short note,
 * then goes to the site with the tracking (POST /api/feedback), so a tester's bad answer
 * reaches the person fixing it without a screenshot.
 */
function addFeedbackRow(chatId) {
  const row = document.createElement("div");
  row.className = "msg-feedback";
  const label = document.createElement("span");
  label.textContent = t("How was this answer?");
  const send = async (rating) => {
    let note = "";
    if (rating === "bad") {
      const typed = await askText(t("What went wrong? (optional)"), { multiline: true, okLabel: t("Send report") });
      if (typed === null) return;
      note = typed;
    }
    for (const button of row.querySelectorAll("button")) button.disabled = true;
    try {
      const answer = await mutate("POST", "/api/feedback", { id: chatId, rating, note });
      label.textContent = answer.sent ? t("Thanks, sent.") : t("Thanks. Sharing is off, so it stayed on this computer.");
    } catch (err) {
      label.textContent = t("Could not send: {error}", { error: err.message });
      for (const button of row.querySelectorAll("button")) button.disabled = false;
    }
  };
  const good = document.createElement("button");
  good.type = "button";
  good.className = "fb-btn";
  good.textContent = t("Good");
  good.onclick = () => void send("good");
  const bad = document.createElement("button");
  bad.type = "button";
  bad.className = "fb-btn";
  bad.textContent = t("Report a problem");
  bad.onclick = () => void send("bad");
  row.append(label, good, bad);
  log.append(row);
  follow();
}

function finishRun(event) {
  endStream();
  expireApprovals();
  closeActivityGroup();
  for (const live of log.querySelectorAll(".act-group.act-live")) live.classList.remove("act-live");
  state.busy = false;
  sendBtn.disabled = false;
  stopBtn.hidden = true;
  state.live = null;
  const chip = statusChip(event.status);
  setStatus(chip.label, event.status === "ok" ? "ok" : event.status === "failed" ? "bad" : undefined);
  if (event.answer) state.lastAnswer = event.answer;
  if (event.error) addMessage("error", event.error);
  if (state.current?.kind === "rosalena" && (event.answer || event.error)) addFeedbackRow(state.current.id);
  if (event.status === "failed") toast(t("The run failed. The error is in the transcript."), "bad");
  loadSessions();
  void refreshCommitMode(); // the run may have held work back or committed it
  // A run that has just ended stops being "running now", and the strip should say so
  // without waiting for the next event on a stream that is about to close.
  void refreshActivity({ force: true });
  renderQueue();
  drainQueue(event);
  if (state.current?.kind === "rosalena") {
    const forId = state.current.id;
    const url = new URL(location.href);
    url.searchParams.set("chat", state.current.thread ?? forId);
    history.replaceState(null, "", url);
    // The final reading, from the record rather than from the stream: a finished chat
    // should show the numbers it ended on, and the page may have joined late.
    refreshContext(forId).then((meter) => {
      if (meter && state.current?.id === forId) setContext(meter);
    });
  }
}

// ------------------------------------------------------------------ streams

function endStream() {
  if (state.stream) {
    state.stream.close();
    state.stream = null;
  }
}

function openStream(id) {
  endStream();
  setStatus(t("connecting…"));
  const stream = new EventSource(`/api/stream?id=${encodeURIComponent(id)}`);
  state.stream = stream;
  const started = Date.now();

  stream.onmessage = (message) => {
    let event;
    try {
      event = JSON.parse(message.data);
    } catch {
      return;
    }
    renderEvent(event);
    // Settings > Notifications: only events from the live stream, never a replayed chat.
    notifyFor(event);
    if (event.type !== "ui/end" && event.type !== "run_end") {
      if (!state.busy) setStatus(t("working…"));
      else if (Date.now() - started < 4000) setStatus(t("thinking…"));
    }
    // The only live channel this page already holds is this stream, so the running-work
    // strip rides on it: a delegation or a process starting mid-run shows up on the next
    // event rather than on a timer of its own. refreshActivity throttles internally.
    if (event.type === "tool" || event.type === "run" || event.type === "ui/end") void refreshActivity();
    // A Creator run that published or rolled back a plugin changes the sidebar now.
    if (event.type === "ui/end" || (event.type === "tool" && /^creator_(publish|rollback)$/.test(String(event.name ?? event.tool ?? "")))) void refreshPlugins();
  };

  stream.onerror = () => {
    // The server closes the stream when the run ends; that is not an error, and the
    // page knows the difference because it got an explicit ui/end first.
    if (state.busy) {
      setStatus(t("reconnecting…"), "bad");
      return;
    }
    endStream();
  };
}

// ------------------------------------------------------------------ sessions list

/** One chat row: the same markup as before, plus drag-to-folder and a move menu. */
function chatRow(chat) {
  const chip = statusChip(chat.status);
  const button = document.createElement("button");
  button.className = "chat-item";
  button.dataset.id = chat.id;
  button.draggable = true;
  if (state.current?.kind === "rosalena" && (state.current.thread ?? state.current.id) === chat.id) button.classList.add("active");
  const titleEl = document.createElement("span");
  titleEl.className = "t";
  titleEl.textContent = chat.title || t("(no task)");
  const s = document.createElement("span");
  s.className = "s";
  s.textContent = ago(chat.at);
  const b = document.createElement("span");
  b.className = "b";
  const badge = document.createElement("span");
  badge.className = `badge ${chip.tone}`;
  badge.textContent = chip.label;
  b.append(badge);
  if (chat.turns > 1) {
    const turns = document.createElement("span");
    turns.textContent = t("{turns} messages", { turns: chat.turns });
    b.append(turns);
  }
  if (chat.steps) {
    const steps = document.createElement("span");
    steps.textContent = t("{n} steps", { n: chat.steps });
    b.append(steps);
  }
  if (chat.ms) {
    const ms = document.createElement("span");
    ms.textContent = humanMs(chat.ms);
    b.append(ms);
  }
  // The move control, because drag-and-drop alone is unusable on a touchpad and
  // invisible to anyone who does not try it. It stops the click from opening the chat.
  const move = document.createElement("span");
  move.className = "row-move";
  move.title = t("Move to a folder");
  move.textContent = "⋯";
  move.onclick = (event) => {
    event.stopPropagation();
    showMoveMenu(move, chat.id);
  };
  button.append(titleEl, s, b, move);

  button.onclick = () => openChat(chat.id);
  // Right-click: pin or unpin, open, move. The ⋯ control stays for the folder move alone.
  button.oncontextmenu = (event) => {
    event.preventDefault();
    showChatMenu(event, chat);
  };
  button.ondragstart = (event) => {
    event.dataTransfer.setData("text/plain", chat.id);
    event.dataTransfer.effectAllowed = "move";
    button.classList.add("dragging");
  };
  button.ondragend = () => button.classList.remove("dragging");
  return button;
}

/** A folder heading. Real folders accept drops and can be renamed or deleted. */
function folderHeader(group, count) {
  const header = document.createElement("div");
  header.className = "folder-head";
  const real = group.id !== "ungrouped";
  // Folded state is saved through /api/prefs, so it survives a restart of the app.
  const key = `folder:${group.id}`;
  const collapsed = isFolded(key);
  if (collapsed) header.classList.add("closed");

  const caret = document.createElement("span");
  caret.className = "folder-caret";
  caret.textContent = collapsed ? "▸" : "▾";
  const icon = document.createElement("span");
  icon.className = "folder-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = real ? "▤" : "";
  const name = document.createElement("span");
  name.className = "folder-name";
  name.textContent = real ? group.name || t("(unnamed)") : t("Ungrouped");
  const tally = document.createElement("span");
  tally.className = "folder-count";
  tally.textContent = String(count);

  header.append(caret, ...(real ? [icon] : []), name, tally);

  if (real) {
    const rename = document.createElement("span");
    rename.className = "folder-btn";
    rename.title = t("Rename this folder");
    rename.textContent = "✎";
    rename.onclick = async (event) => {
      event.stopPropagation();
      const next = await askText(t("Rename folder"), { value: group.name, okLabel: t("Rename") });
      if (next === null || !next.trim() || next.trim() === group.name) return;
      folderAction("PATCH", { id: group.id, name: next.trim() });
    };
    const del = document.createElement("span");
    del.className = "folder-btn";
    del.title = t("Delete this folder (its chats are kept and become ungrouped)");
    del.textContent = "×";
    del.onclick = (event) => {
      event.stopPropagation();
      if (!window.confirm(t("Delete the folder \"{name}\"? Its chats are kept and become ungrouped.", { name: group.name }))) return;
      folderAction("DELETE", undefined, `?id=${encodeURIComponent(group.id)}`);
    };
    header.append(rename, del);
  }

  // Every heading is a drop target, Ungrouped included: dropping a chat there takes it
  // out of its folder. `dragover` must be prevented or the browser refuses the drop.
  header.ondragover = (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    header.classList.add("drop");
  };
  header.ondragleave = () => header.classList.remove("drop");
  header.ondrop = (event) => {
    event.preventDefault();
    header.classList.remove("drop");
    const id = event.dataTransfer.getData("text/plain");
    if (id) moveChat(id, real ? group.id : null);
  };

  header.onclick = () => {
    setFolded(key, !header.classList.contains("closed"));
    renderLists();
  };
  return header;
}

/**
 * A fold heading for something that is not a real folder: one harness's sessions, or a
 * chat's subagents. Same look and the same saved fold state as a folder.
 */
function foldHeader({ key, label, count, className = "", defaultFolded = true }) {
  const header = document.createElement("div");
  header.className = `folder-head ${className}`.trim();
  const folded = isFolded(key, defaultFolded);
  if (folded) header.classList.add("closed");
  const caret = document.createElement("span");
  caret.className = "folder-caret";
  caret.textContent = folded ? "▸" : "▾";
  const name = document.createElement("span");
  name.className = "folder-name";
  name.textContent = label;
  const tally = document.createElement("span");
  tally.className = "folder-count";
  tally.textContent = String(count);
  header.append(caret, name, tally);
  header.onclick = (event) => {
    event.stopPropagation();
    setFolded(key, !header.classList.contains("closed"), defaultFolded);
    renderLists();
  };
  return header;
}

const HARNESS_NAMES = {
  claude: "Claude Code",
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  gemini: "Gemini CLI",
  cursor: "Cursor",
  aider: "Aider",
  dsh: "DeepSeek Harness",
};
const harnessName = (source) => HARNESS_NAMES[String(source ?? "").toLowerCase()] ?? String(source || t("Other"));

function externalRow(session) {
  const button = document.createElement("button");
  button.className = "chat-item";
  if (state.current?.kind === "external" && state.current.id === session.id) button.classList.add("active");
  const t = document.createElement("span");
  t.className = "t";
  t.textContent = session.title || session.id;
  const s = document.createElement("span");
  s.className = "s";
  s.textContent = ago(session.at);
  const b = document.createElement("span");
  b.className = "b";
  if (session.project) {
    const project = document.createElement("span");
    project.textContent = clip(session.project, 28);
    b.append(project);
  }
  button.append(t, s, b);
  button.onclick = () => openExternal(session.source, session.id);
  return button;
}

/**
 * One chat row plus, under it, the subagents it started. They are folded behind a
 * "N subagents" line by default, so a run that delegated twenty times is still one row.
 */
function appendChatTree(list, chat, childrenOf, depth = 0) {
  const row = chatRow(chat);
  if (depth) row.classList.add("sub-row");
  row.style.setProperty("--depth", String(depth));
  list.append(row);
  const kids = childrenOf.get(chat.id) ?? [];
  if (!kids.length) return;
  const header = foldHeader({
    key: `subagents:${chat.id}`,
    label: t("{n} subagents", { n: kids.length }),
    count: "",
    className: "sub-fold",
  });
  header.style.setProperty("--depth", String(depth + 1));
  list.append(header);
  if (header.classList.contains("closed")) return;
  for (const kid of kids) appendChatTree(list, kid, childrenOf, depth + 1);
}

function renderLists() {
  const needle = filterInput.value.trim().toLowerCase();
  const match = (item) =>
    !needle ||
    String(item.title ?? "").toLowerCase().includes(needle) ||
    String(item.id ?? "").toLowerCase().includes(needle) ||
    String(item.source ?? "").toLowerCase().includes(needle) ||
    String(item.project ?? "").toLowerCase().includes(needle);

  const chatList = el("chat-list");
  const chats = state.all.chats.filter(match);
  chatList.innerHTML = "";
  if (!chats.length) {
    chatList.innerHTML = `<p class="empty">${needle ? t("No chat matches that filter.") : t("No chats yet.")}</p>`;
  }

  // Subagent runs (depth > 0) are drawn under the chat that started them instead of as
  // separate rows. This is the tree the old Graph tab drew on the right, now in the one
  // list. A subagent whose parent is not in the list (older, filtered out) stays a row.
  const byId = new Map(chats.map((c) => [c.id, c]));
  const childrenOf = new Map();
  const nested = new Set();
  if (!needle) {
    for (const chat of chats) {
      if (!(chat.depth > 0) || !chat.parent || !byId.has(chat.parent)) continue;
      if (!childrenOf.has(chat.parent)) childrenOf.set(chat.parent, []);
      childrenOf.get(chat.parent).push(chat);
      nested.add(chat.id);
    }
  }

  // Grouped rendering: a folder is a heading with its chats under it, and Ungrouped is
  // last. The folder list comes from the server (`/api/folders`) rather than from the
  // session list, because a folder with nothing in it must still be visible.
  const groups = state.folders?.groups ?? [{ id: "ungrouped", name: "Ungrouped", sessions: chats }];
  const hasFolders = groups.some((g) => g.id !== "ungrouped");
  // Pinned chats get their own section above Recent and are not repeated below it. A
  // subagent whose chat is not listed is not shown as a chat of its own: it read as a
  // stray conversation ("random subagent chats") and pushed the real ones down.
  const pinnedIds = pinnedChats();
  const pinnedList = el("pinned-list");
  if (pinnedList) {
    pinnedList.replaceChildren();
    const pinnedRows = pinnedIds.map((id) => byId.get(id)).filter(Boolean).filter(match);
    for (const chat of pinnedRows) appendChatTree(pinnedList, chat, childrenOf);
    if (!pinnedRows.length) {
      const empty = document.createElement("p");
      empty.className = "empty side-empty";
      empty.textContent = needle ? t("No pinned chat matches.") : t("No pinned chats yet. Right-click a chat to pin it.");
      pinnedList.append(empty);
    }
  }
  const shownElsewhere = (chat) => pinnedIds.includes(chat.id) || (!needle && chat.depth > 0);
  const mode = recentGrouping();
  paintGroupBy(mode);
  if (mode !== "folders") {
    const tops = chats.filter((chat) => !nested.has(chat.id) && !shownElsewhere(chat));
    if (mode === "none") {
      for (const chat of tops) appendChatTree(chatList, chat, childrenOf);
    } else {
      // One heading per folder the chats work in, the most recently used folder first.
      const byFolder = new Map();
      for (const chat of tops) {
        const folder = String(chat.workspace ?? "") || "(no folder)";
        if (!byFolder.has(folder)) byFolder.set(folder, []);
        byFolder.get(folder).push(chat);
      }
      for (const [folder, members] of byFolder) {
        const base = folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || folder;
        const header = foldHeader({ key: `ws:${folder}`, label: folder === "(no folder)" ? t("(no folder)") : base, count: members.length, className: "ws-head", defaultFolded: false });
        header.title = folder === "(no folder)" ? t("(no folder)") : folder;
        if (folder !== "(no folder)") {
          const add = document.createElement("button");
          add.type = "button";
          add.className = "ws-new";
          add.textContent = "+";
          add.title = t("New chat in {folder}", { folder });
          add.onclick = (event) => {
            event.stopPropagation();
            newChat();
            state.pendingWorkspace = folder;
            paintWorkspace(folder);
            prompt.focus();
          };
          header.append(add);
        }
        chatList.append(header);
        if (header.classList.contains("closed") && !needle) continue;
        for (const chat of members) appendChatTree(chatList, chat, childrenOf);
      }
    }
    const shown = tops.length;
    el("chat-count").textContent = shown ? String(shown) : "";
    renderExternal(match, needle);
    return;
  }
  for (const group of groups) {
    const members = (group.sessions ?? []).map((s) => byId.get(s.id)).filter((chat) => chat && !nested.has(chat.id) && !shownElsewhere(chat));
    if (needle && !members.length) continue;
    let closed = false;
    if (hasFolders) {
      const header = folderHeader(group, members.length);
      chatList.append(header);
      // A collapsed folder hides its rows but keeps its count: that is what makes
      // collapsing useful in a list of hundreds.
      closed = header.classList.contains("closed");
      if (!closed && !members.length && group.id !== "ungrouped") {
        const hint = document.createElement("p");
        hint.className = "empty folder-empty";
        hint.textContent = t("Drag a chat here, or use its ⋯ menu.");
        chatList.append(hint);
      }
    }
    if (closed) continue;
    for (const chat of members) appendChatTree(chatList, chat, childrenOf);
  }
  const recentCount = chats.filter((chat) => !nested.has(chat.id) && !shownElsewhere(chat)).length;
  el("chat-count").textContent = recentCount ? String(recentCount) : "";
  renderExternal(match, needle);
}

// How Recent is grouped: your folders (the default), the workspace each chat works in, or
// not at all. Kept per window in localStorage.
const GROUP_KEY = "rosalena-recent-group";
const GROUP_MODES = ["folders", "workspace", "none"];
const GROUP_NAMES = { folders: t("Folders (grouping)"), workspace: t("Workspace (grouping)"), none: t("None (grouping)") };
function recentGrouping() {
  const saved = readPref(GROUP_KEY);
  return GROUP_MODES.includes(saved) ? saved : "folders";
}
function paintGroupBy(mode) {
  const button = el("group-by");
  if (button) button.textContent = t("Group: {mode}", { mode: GROUP_NAMES[mode] });
  const folderBtn = el("new-folder");
  if (folderBtn) folderBtn.hidden = mode !== "folders";
}

function renderExternal(match, needle) {
  // Other harnesses: one fold per tool (Claude Code, Codex, ...), so a busy Claude Code
  // history is one line until you open it.
  const externalList = el("external-list");
  const external = state.all.external.filter(match);
  externalList.innerHTML = "";
  if (!external.length) {
    externalList.innerHTML = `<p class="empty">${needle ? t("Nothing matches.") : t("No other harness sessions found.")}</p>`;
  }
  const bySource = new Map();
  for (const session of external) {
    const source = String(session.source ?? "other");
    if (!bySource.has(source)) bySource.set(source, []);
    bySource.get(source).push(session);
  }
  for (const [source, sessions] of bySource) {
    // While searching, every match is shown: a fold that hides the hit defeats the search.
    const header = foldHeader({ key: `harness:${source}`, label: harnessName(source), count: sessions.length, className: "harness-fold" });
    externalList.append(header);
    if (header.classList.contains("closed") && !needle) continue;
    for (const session of sessions) externalList.append(externalRow(session));
  }
  const externalCount = el("external-count");
  if (externalCount) externalCount.textContent = state.all.external.length ? String(state.all.external.length) : "";
}

async function loadSessions() {
  try {
    const body = await api("/api/sessions?limit=60");
    state.all.chats = body.chats ?? [];
    state.all.external = body.external ?? [];
    // The folder list is a second view of the same runs, so it is refreshed with them:
    // a chat that finished while this tab was open must appear inside its folder, not
    // only in the flat list.
    await loadFolders();
    renderLists();
    if (body.notes?.length) el("foot-spend").title = body.notes.join("\n");
  } catch (err) {
    toast(t("Could not list sessions: {error}", { error: err.message }), "bad");
  }
}

// ------------------------------------------------------------------ open things

function setTitle(title, meta) {
  el("chat-title").textContent = title || t("New chat");
  el("chat-meta").textContent = meta || "";
  document.title = `${title || "Rosalena"} — Rosalena`;
}

// On a narrow window the sidebar is a drawer over the transcript, so anything that
// changes what is on screen has to put it away again - otherwise you pick a chat and
// the drawer stays over the answer you just asked for.
function closeDrawer() {
  app.classList.remove("open");
  paintMenuButton();
}

async function openChat(id) {
  setBranch(null);
  closeDrawer();
  endStream();
  clearLog();
  resetStats();
  setStatus(t("loading…"));
  state.current = { kind: "rosalena", id, thread: id };
  state.parentId = id;
  state.busy = false;
  state.goalMode = null;
  paintGoal();
  sendBtn.disabled = false;
  stopBtn.hidden = true;
  // Queued messages stay with the chat they were typed in (see queueKey): the strip now
  // shows this chat's, and the others are delivered to their own chats.
  renderQueue();
  try {
    // The whole conversation: every turn's events, oldest first. `chat.id` is the newest
    // turn, which is what a follow-up continues and what Stop and the stream address.
    const chat = await api(`/api/chat?id=${encodeURIComponent(id)}&thread=1`);
    state.current = { kind: "rosalena", id: chat.id, thread: chat.thread ?? chat.id };
    state.parentId = chat.id;
    rememberChat(chat.thread ?? chat.id);
    if (chat.goal === true) {
      state.goalMode = true;
      paintGoal();
    }
    // A chat from before per-chat models were kept: it reopens on the model its last
    // message actually ran on, not on whatever was picked last in another chat.
    const thread = state.current.thread;
    if (!chatModelFor(thread) && chat.model && (state.models ?? []).some((row) => row?.id === chat.model)) setChatModel(thread, chat.model);
    applyChatModel();
    setChatWorkspace(chat.workspace ?? "");
    const turns = chat.turns?.length ?? 1;
    setTitle(clip(chat.task, 68), `${chat.status}${chat.model ? ` · ${t("class {cls}", { cls: chat.model })}` : ""}${turns > 1 ? ` · ${t("{turns} turns", { turns })}` : ""} · ${state.current.thread}`);
    // A stored transcript arrives all at once. Replaying it through the live path would
    // schedule a paint per delta for a stream that is already finished; instead the deltas
    // are collected and each step's authoritative text is written by `finalizeLive`, so
    // the live counters stay at zero and keep meaning "streamed since this page loaded".
    render.received = 0;
    render.applied = 0;
    render.replay = true;
    if (chat.branchOf?.from) {
      const note = document.createElement("div");
      note.className = "branch-note";
      note.textContent = `${t("Branched from an earlier message of another chat.")} `;
      const open = document.createElement("button");
      open.type = "button";
      open.className = "mini-btn";
      open.textContent = t("Open the original");
      open.addEventListener("click", () => void openChat(chat.branchOf.from));
      note.append(open);
      log.append(note);
    }
    // Each turn's run id, so any of your messages can be branched from: the branch
    // continues from the turn BEFORE it (its parent) with the message as the new text.
    let previousTurn = chat.branchOf?.parent ?? null;
    try {
      for (const event of chat.events) {
        if (event.type === "run" || event.type === "ui/end") {
          // Each turn of the conversation starts with its own `run`: that is where the
          // person's message goes. A subagent's run is part of the turn, not a message.
          if (event.type === "run" && !event.sub && event.task) {
            const body = addMessage("user", event.task, { plain: true });
            markBranchable(body, { runId: event.id, parentId: previousTurn, text: event.task });
            previousTurn = event.id;
          }
          // The transcript renderer skips these two on replay (a stored run has already
          // ended, and replaying its start would reset the counters), but the trajectory
          // wants them: the run row says which class ran, the end row says how it ended.
          recordTrail(event);
          rail?.event(event);
          continue;
        }
        renderEvent(event);
      }
    } finally {
      render.replay = false;
    }
    state.stats.steps = chat.events.filter((event) => event.type === "assistant").length;
    setStats();
    // A replayed log carries its own last `ui/context`; a run recorded by an older
    // build has none, so the record's stored reading is the fallback.
    if (ctxMeter.hidden) {
      const meter = await refreshContext(id);
      if (meter) setContext(meter);
    }
    state.lastAnswer = chat.answer ?? state.lastAnswer;
    const chip = statusChip(chat.status);
    setStatus(chip.label, chat.status === "ok" ? "ok" : chat.status === "failed" ? "bad" : undefined);
    // A chat that is still running in this process can be rejoined live.
    if (chat.status === "running" && !chat.historic && state.current) {
      state.busy = true;
      sendBtn.disabled = false; // Send queues while it runs
      renderQueue();
      stopBtn.hidden = false;
      openStream(chat.id);
    }
    renderLists();
    follow(true);
    // The reveal button now knows which chat it would show, and whether the replay found
    // a file path or only the chat's workspace folder.
    paintReveal();
  } catch (err) {
    addMessage("error", err.message);
    setStatus(t("failed"), "bad");
    // A chat that no longer exists must not be reopened on every start.
    if (/no chat/i.test(String(err.message))) rememberChat(null);
  }
}

// Tool calls in another harness's session can outnumber what was said 30 to 1, so they
// render folded into runs and can be hidden altogether; the choice is remembered.
const EXT_TOOLS_KEY = "rosalena-ext-tools-hidden";

function extToolsHidden() {
  return readPref(EXT_TOOLS_KEY) === "1";
}

function paintExtToolsToggle(button) {
  const hidden = extToolsHidden();
  log.classList.toggle("ext-tools-hidden", hidden);
  if (button) {
    button.textContent = hidden ? t("Show tool calls") : t("Hide tool calls");
    button.setAttribute("aria-pressed", String(hidden));
  }
}

function extToolCard(message) {
  const item = document.createElement("details");
  item.className = `ext-tool${message.ok === false ? " bad" : ""}`;
  const head = document.createElement("summary");
  const name = document.createElement("span");
  name.className = "tool-name";
  name.textContent = message.name ?? "tool";
  const arg = document.createElement("span");
  arg.className = "tool-arg";
  try {
    arg.textContent = toolSummary(message.name, message.args ?? {}) || "";
  } catch {
    arg.textContent = "";
  }
  head.append(name, arg);
  item.append(head);
  item.addEventListener(
    "toggle",
    () => {
      // Bodies are built on first open: a full session can carry thousands of calls.
      if (!item.open || item.dataset.built) return;
      item.dataset.built = "1";
      const args = message.args ? JSON.stringify(message.args, null, 2) : "";
      if (args && args !== "{}") {
        const pre = document.createElement("pre");
        pre.textContent = args;
        item.append(pre);
      }
      if (message.text) {
        const pre = document.createElement("pre");
        pre.className = "ext-tool-result";
        pre.textContent = message.text;
        item.append(pre);
      }
    },
  );
  return item;
}

function extToolGroup() {
  const group = document.createElement("details");
  group.className = "ext-tools";
  const head = document.createElement("summary");
  head.className = "ext-tools-head";
  group.append(head);
  log.append(group);
  return group;
}

function closeExtToolGroup(group) {
  if (!group) return;
  const n = group.children.length - 1;
  group.firstChild.textContent = t("{n} tool calls", { n });
}

async function openExternal(source, id, { full = false } = {}) {
  closeDrawer();
  endStream();
  clearLog();
  resetStats();
  state.current = { kind: "external", source, id };
  state.parentId = null;
  setStatus(t("loading…"));
  try {
    const session = await api(`/api/session?source=${encodeURIComponent(source)}&id=${encodeURIComponent(id)}${full ? "&full=1" : ""}`);
    const meta = session.meta ?? {};
    setTitle(clip(meta.title || id, 68), `${source}${meta.at ? ` · ${ago(meta.at)}` : ""} · ${t("read-only")}`);
    addLine(
      t("A {source} session from another harness. Rosalena shows it read-only; sending below starts a new chat here.", { source }),
      "",
      "◫",
    );
    const hasTools = (session.messages ?? []).some((m) => m.role === "tool");
    if (hasTools) {
      const bar = addLine(t("Tool calls are folded between messages."), "", "⚙");
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "ext-btn";
      toggle.onclick = () => {
        writePref(EXT_TOOLS_KEY, extToolsHidden() ? "" : "1");
        paintExtToolsToggle(toggle);
      };
      bar.append(toggle);
      paintExtToolsToggle(toggle);
    }
    let group = null;
    for (const message of session.messages ?? []) {
      if (message.role === "tool") {
        group = group ?? extToolGroup();
        group.append(extToolCard(message));
        continue;
      }
      closeExtToolGroup(group);
      group = null;
      const role = message.role === "user" ? "user" : message.role === "assistant" ? "assistant" : "error";
      addMessage(role, message.text ?? "", { plain: role === "user" });
    }
    closeExtToolGroup(group);
    if (session.truncated) {
      const line = addLine(t("This transcript was truncated."), "", "…");
      const more = document.createElement("button");
      more.type = "button";
      more.className = "ext-btn";
      more.textContent = t("Load full session");
      more.onclick = () => {
        more.disabled = true;
        more.textContent = t("Loading…");
        openExternal(source, id, { full: true });
      };
      line.append(more);
    }
    setStatus(`${source} · ${t("read-only")}`);
    renderLists();
    follow(true);
    // An imported session is a reading of another tool's log: there is no run folder here
    // for the file manager to open, and the button says that rather than guessing one.
    paintReveal();
  } catch (err) {
    addMessage("error", err.message);
    setStatus(t("failed"), "bad");
  }
}

function newChat() {
  setBranch(null);
  closeDrawer();
  endStream();
  clearLog();
  resetStats();
  state.current = null;
  state.parentId = null;
  state.busy = false;
  state.lastAnswer = "";
  state.goalMode = null;
  paintGoal();
  sendBtn.disabled = false;
  stopBtn.hidden = true;
  renderQueue();
  setTitle(t("New chat"), t("Pick a model and send a prompt."));
  applyChatModel();
  state.pendingWorkspace = "";
  setChatWorkspace("");
  setStatus(t("ready"));
  const url = new URL(location.href);
  url.searchParams.delete("chat");
  history.replaceState(null, "", url);
  log.innerHTML = WELCOME;
  state.finalized.clear();
  bindStarters();
  renderLists();
  paintReveal();
  prompt.focus();
}

// ------------------------------------------------------------------ sending

function autosize() {
  prompt.style.height = "auto";
  prompt.style.height = `${Math.min(prompt.scrollHeight, 220)}px`;
}
// Measured again whenever the prompt's width changes: sized at start before it had a width
// (or in a pane being dragged narrower), it wrapped every few letters and took the full 220px.
if (typeof ResizeObserver === "function") {
  let promptWidth = 0;
  new ResizeObserver(([entry]) => {
    const width = Math.round(entry.contentRect.width);
    if (!width || Math.abs(width - promptWidth) < 2) return;
    promptWidth = width;
    autosize();
  }).observe(prompt);
}

function addFiles(files) {
  for (const file of files) {
    if (state.files.length >= 8) {
      toast(t("Eight attachments is the limit for one message."), "bad");
      break;
    }
    if (file.size > 16 * 1024 * 1024) {
      toast(t("{name} is larger than 16 MB.", { name: file.name }), "bad");
      continue;
    }
    state.files.push(file);
  }
  renderAttachments();
}

function renderAttachments() {
  attachTray.innerHTML = "";
  state.files.forEach((file, index) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = file.name;
    const size = document.createElement("span");
    size.className = "size";
    size.textContent = humanBytes(file.size);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.title = t("Remove");
    remove.onclick = () => {
      state.files.splice(index, 1);
      renderAttachments();
    };
    chip.append(name, size, remove);
    attachTray.append(chip);
  });
}

const readFileBase64 = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });

// ------------------------------------------------------------------ queue

/**
 * Messages sent while a run is going. "one" (the default): each queued message is its own
 * turn, sent when the previous run has finished, so two long prompts are never merged
 * into one turn where the model drops half, and a /compact can sit between them.
 * "together": every queued message goes as one, the way Claude Code does it. A slash
 * command is always sent on its own. A run that failed or was stopped pauses the queue:
 * firing the next prompt into a broken state is worse than waiting for "Send next".
 */
const queueMode = () => (prefs.queueMode === "together" ? "together" : "one");

/** The chat a queued message belongs to: the conversation on screen when it was typed. */
const queueKey = () => (state.current?.kind === "rosalena" ? state.current.thread ?? state.current.id : "draft");
/** This chat's queued messages, in order. */
const queuedHere = () => queue.items.filter((item) => item.chat === queueKey());

function enqueue() {
  const text = prompt.value.trim();
  if (!text && !state.files.length) return;
  queue.items.push({ text, files: state.files, chat: queueKey(), at: Date.now() });
  state.files = [];
  renderAttachments();
  prompt.value = "";
  autosize();
  renderQueue();
}

/** The next batch for one chat: one message, or (together) its queued run of plain messages. */
function takeQueued(key = queueKey(), { noFiles = false } = {}) {
  const mine = queue.items.filter((item) => item.chat === key);
  if (!mine.length) return null;
  // Background delivery cannot send attachments (they are read from this page when sent):
  // it stops at the first message that has files, which waits for its chat to be opened.
  if (noFiles && mine[0].files.length) return null;
  const isCommand = (item) => item.text.startsWith("/");
  let batch;
  if (queueMode() === "one" || isCommand(mine[0])) batch = [mine[0]];
  else {
    batch = [];
    for (const item of mine) {
      if (isCommand(item) || (noFiles && item.files.length)) break;
      batch.push(item);
    }
  }
  queue.items = queue.items.filter((item) => !batch.includes(item));
  return batch.length === 1 ? batch[0] : { text: batch.map((item) => item.text).filter(Boolean).join("\n\n"), files: batch.flatMap((item) => item.files), chat: key };
}

/**
 * A chat's queue is delivered to that chat even when another one is on screen: when its
 * run has finished (checked every few seconds), the next queued message is sent as its
 * follow-up. Measured 2026-11-08: queued messages went into whichever chat was open when
 * the run ended. A chat whose run failed or stopped waits for Send next, as on screen.
 */
let deliveringElsewhere = false;
async function deliverQueuedElsewhere() {
  if (deliveringElsewhere) return;
  const here = queueKey();
  const chats = [...new Set(queue.items.filter((i) => i.chat !== here && i.chat !== "draft" && !queue.paused.has(i.chat)).map((i) => i.chat))];
  if (!chats.length) return;
  deliveringElsewhere = true;
  try {
    for (const chat of chats) {
      // Nothing to send in the background (the next one has files): skip the status check.
      const next = queue.items.find((i) => i.chat === chat);
      if (!next || next.files.length) continue;
      let info;
      try {
        // Status only: the whole transcript every 3 s per waiting chat was a lot to fetch.
        info = await api(`/api/chat?id=${encodeURIComponent(chat)}&thread=1&events=0`);
      } catch {
        continue;
      }
      if (info.status === "running" || queueKey() === chat) continue;
      if (info.status !== "ok") {
        queue.paused.add(chat);
        continue;
      }
      const item = takeQueued(chat, { noFiles: true });
      if (!item) continue;
      try {
        const model = chatModelFor(chat);
        // That chat's own effort and Ultracode, not the one on screen.
        const saved = readChatEfforts()[chat] ?? {};
        const effort = clampEffort(saved.effort ?? readPref(EFFORT_KEY), availableEfforts(state.models, model || ""));
        await post("/api/chat", { task: item.text, parentId: info.id, ...(model ? { model } : {}), effort, ...(saved.ultracode ? { ultracode: true } : {}), attachments: [] });
        toast(t("Sent your queued message to its chat: {task}", { task: clip(info.task ?? "", 48) }), "ok");
        void loadSessions();
      } catch (err) {
        queue.items.unshift({ ...item, chat });
        queue.paused.add(chat);
        toast(t("Could not send a queued message to its chat: {error}", { error: err.message }), "bad");
      }
    }
  } finally {
    deliveringElsewhere = false;
    renderQueue();
  }
}
setInterval(() => void deliverQueuedElsewhere(), 3000);

/** Send one queued batch through the normal path, keeping whatever is being typed. */
async function sendQueued() {
  if (state.busy) return;
  // Attachments being added to the next message stay where they are: send() takes the
  // composer's files, so a queued send waits until those are sent or removed.
  if (state.files.length) {
    queue.paused.add(queueKey());
    renderQueue();
    return;
  }
  const item = takeQueued();
  if (!item) return renderQueue();
  queue.paused.delete(queueKey());
  const draft = prompt.value;
  prompt.value = item.text;
  state.files = item.files;
  const sending = send({ fromQueue: true });
  // send() reads and clears the composer before its first await: put the draft back now.
  prompt.value = draft;
  autosize();
  renderQueue();
  await sending;
}

function drainQueue(event) {
  if (!queuedHere().length) return renderQueue();
  if (event?.status && event.status !== "ok") {
    queue.paused.add(queueKey());
    renderQueue();
    toast(t("The run did not finish, so the queue is paused. Send next when you are ready."), "warn");
    return;
  }
  setTimeout(() => void sendQueued(), 300);
}

function renderQueue() {
  const strip = el("queue-strip");
  if (!strip) return;
  const here = queuedHere();
  const elsewhere = queue.items.length - here.length;
  strip.hidden = here.length === 0;
  sendBtn.textContent = state.busy ? t("Queue") : t("Send");
  sendBtn.title = state.busy ? (queueMode() === "one" ? t("Add to the queue: it runs as its own turn when this one finishes") : t("Add to the queue: queued messages go together when this run ends")) : "";
  if (!here.length) return;
  const paused = queue.paused.has(queueKey());
  el("queue-title").textContent = `${t("{n} queued", { n: here.length })}${paused ? ` · ${t("paused")}` : ""}${elsewhere ? ` · ${t("{n} in other chats", { n: elsewhere })}` : ""}`;
  for (const button of strip.querySelectorAll(".queue-mode-btn")) button.classList.toggle("on", button.dataset.mode === queueMode());
  el("queue-next").hidden = state.busy || !here.length;
  const list = el("queue-list");
  list.replaceChildren(
    ...here.map((item) => {
      const li = document.createElement("li");
      const text = document.createElement("span");
      text.className = "queue-text";
      text.textContent = clip(item.text || t("(attached files)"), 140) + (item.files.length ? `  · ${t("{n} files", { n: item.files.length })}` : "");
      text.title = item.text;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "queue-remove";
      remove.textContent = "✕";
      remove.title = t("Remove from the queue");
      remove.onclick = () => {
        const at = queue.items.indexOf(item);
        if (at >= 0) queue.items.splice(at, 1);
        if (!queuedHere().length) queue.paused.delete(queueKey());
        renderQueue();
      };
      // Steer: send this one into the run that is going now, instead of after it ends.
      // Text only - files go with a normal message.
      if (state.busy && state.current?.kind === "rosalena" && item.text && !item.files.length) {
        const steer = document.createElement("button");
        steer.type = "button";
        steer.className = "queue-steer";
        steer.textContent = t("Steer");
        steer.title = t("Send this now: the running chat takes it in at its next step instead of after it finishes");
        steer.onclick = () => void steerNow(item);
        li.append(text, steer, remove);
        return li;
      }
      li.append(text, remove);
      return li;
    }),
  );
}

async function steerNow(item) {
  const id = state.current?.id;
  if (!id || !state.busy) return;
  try {
    await post("/api/steer", { id, text: item.text });
    const at = queue.items.indexOf(item);
    if (at >= 0) queue.items.splice(at, 1);
    if (!queuedHere().length) queue.paused.delete(queueKey());
    addMessage("user", item.text, { plain: true });
    renderQueue();
    toast(t("Sent: it takes this in at its next step."), "ok");
  } catch (err) {
    toast(t("Could not steer: {error}", { error: err.message }), "bad");
  }
}

async function setQueueMode(mode) {
  if (await savePrefs({ queueMode: mode }, { quiet: true })) prefs.queueMode = mode;
  renderQueue();
}

async function send({ fromQueue = false } = {}) {
  // While a run is going, Send queues instead (see the queue above).
  if (state.busy) {
    if (!fromQueue) enqueue();
    return;
  }
  const text = prompt.value.trim();
  if (!text && !state.files.length) return;
  el("slash-menu").hidden = true;
  slash.open = false;
  // A slash command: an action the page does, or a template that becomes the task.
  let task = text;
  let planFlag = state.planMode;
  let goalFlag = state.goalMode === true;
  const command = parseSlash(text);
  if (command) {
    if (command.action) {
      prompt.value = "";
      autosize();
      runSlashAction(command);
      return;
    }
    if (command.needsArgs && !command.args) {
      toast(t("/{name} needs something after it, e.g. /{name} fix the login page", { name: command.name }), "warn");
      return;
    }
    task = expandSlash(command.template, command.args);
    planFlag = planFlag || command.plan;
    goalFlag = goalFlag || command.goal === true;
  }
  if (state.current?.kind === "external") {
    // The transcript on screen belongs to another tool; it is not this chat's history.
    newChat();
  }
  // A branch is a new conversation that starts from an earlier point of this one: the
  // screen starts fresh with a line saying where it came from, and the old chat is left
  // exactly as it was.
  const branching = state.branch;
  if (branching) {
    clearLog();
    const note = document.createElement("div");
    note.className = "branch-note";
    note.textContent = t("Branched from an earlier message. The original chat is unchanged.");
    log.append(note);
    state.parentId = branching.parentId;
  }
  if (!log.querySelector(".msg")) {
    // Sending from the welcome screen: the welcome belongs to the empty state.
    for (const child of [...log.children]) if (!child.classList.contains("branch-note")) child.remove();
    state.live = null;
  }
  const sentFrom = state.parentId;
  // Which queue key messages typed during this send get, so they can follow the chat.
  const sendKey = queueKey();
  const sendStartedAt = Date.now();
  const userBody = addMessage("user", text, { plain: true });
  // Attached pictures show in the message as thumbnails: they are sent to the model too.
  const pictures = state.files.filter((file) => /^image\/(png|jpe?g|gif|webp)$/i.test(file.type));
  if (pictures.length) {
    const strip = document.createElement("div");
    strip.className = "msg-images";
    for (const file of pictures) {
      const img = document.createElement("img");
      img.alt = file.name;
      img.title = file.name;
      img.src = URL.createObjectURL(file);
      img.onload = () => URL.revokeObjectURL(img.src);
      strip.append(img);
    }
    userBody.append(strip);
  }
  prompt.value = "";
  autosize();
  state.busy = true;
  state.pinned = true;
  // Send stays live while the run goes: pressing it queues the next message.
  sendBtn.disabled = false;
  renderQueue();
  stopBtn.hidden = false;
  setStatus(t("starting…"));
  state.stats.startedAt = Date.now();
  setStats();

  const attachments = [];
  for (const file of state.files) {
    try {
      attachments.push({ name: file.name, dataBase64: await readFileBase64(file) });
    } catch {
      toast(t("Could not read {name}.", { name: file.name }), "bad");
    }
  }
  state.files = [];
  renderAttachments();

  try {
    const wasDraft = !state.current?.thread;
    const body = await post("/api/chat", {
      task: task || "(see the attached files)",
      plan: planFlag,
      // On: a goal. Switched off by hand: not a goal, even as a follow-up to one. Neither:
      // the server decides ("Goal mode. ..." / "Goal: ..." text, or a goal chat's follow-up).
      ...(goalFlag ? { goal: true } : state.goalMode === false ? { goal: false } : {}),
      // Creator mode (plugins-ui.js): build a sidebar plugin through the creator_* tools.
      creator: isCreatorOn(),
      // The role is the server default: the redundant top-bar Role menu is gone, so the
      // request omits `role` and the harness answers with its own assistant role. The
      // composer picker supplies the model, and omits it when nothing is pinned - both
      // fields are optional on POST /api/chat.
      ...(state.model ? { model: state.model } : {}),
      ...(!state.current?.thread && state.pendingWorkspace ? { workspace: state.pendingWorkspace } : {}),
      effort: effectiveEffort(),
      ...(ultracodeOn() ? { ultracode: true } : {}),
      parentId: state.parentId,
      ...(branching ? { branch: { from: branching.from, at: branching.at } } : {}),
      attachments,
    });
    // A follow-up is a new run in the same conversation: the sidebar row, the title and
    // the URL stay on the conversation (`thread`), the stream and Stop follow the new run.
    state.current = { kind: "rosalena", id: body.id, thread: body.thread ?? body.id };
    state.parentId = body.id;
    rememberChat(state.current.thread);
    // Messages queued while this send was in flight were keyed to the draft (or, for a
    // branch, to the chat it branched from): they belong to this chat.
    for (const item of queue.items) {
      if ((item.at ?? 0) >= sendStartedAt && (item.chat === "draft" || item.chat === sendKey) && item.chat !== state.current.thread) item.chat = state.current.thread;
    }
    // The server's word on whether this chat is a goal (it also recognises "Goal mode. ..."
    // and goal follow-ups), so the Goal button shows what is really happening.
    if (typeof body.goal === "boolean") {
      state.goalMode = body.goal ? true : state.goalMode === false ? false : null;
      paintGoal();
    }
    // This chat keeps the model and effort it was just sent with, whatever another chat
    // picks afterwards (and a queued message delivered later uses them too).
    if (state.model) setChatModel(state.current.thread, state.model);
    setChatEffort(state.current.thread, effectiveEffort(), ultracodeOn());
    if (wasDraft) {
      termAdoptDraft(state.current.thread);
      state.filesScope = state.current.thread;
      state.chatWorkspace = body.workspace || currentWorkspace();
      state.pendingWorkspace = "";
      paintWorkspace(currentWorkspace());
    }
    markBranchable(userBody, { runId: body.id, parentId: sentFrom, text });
    if (branching) setBranch(null);
    // Plan mode is for one message.
    if (state.planMode) {
      state.planMode = false;
      paintAccess();
    }
    openStream(body.id);
    loadSessions();
    // A run has started: the strip's counts are stale from this instant.
    paintReveal();
    void refreshActivity({ force: true });
  } catch (err) {
    state.busy = false;
    sendBtn.disabled = false;
    stopBtn.hidden = true;
    addMessage("error", err.message);
    setStatus(t("failed"), "bad");
    // The message never started: anything queued behind it waits for Send next.
    if (queuedHere().length) queue.paused.add(queueKey());
    renderQueue();
  }
}

async function stop() {
  if (!state.current || state.current.kind !== "rosalena") return;
  try {
    await post("/api/cancel", { id: state.current.id });
    setStatus(t("stopping at the next step…"));
  } catch (err) {
    // 409 means the run already finished, which is a normal answer to a late click.
    toast(err.message, "bad");
  }
}

// ------------------------------------------------------------------ health + chrome

async function loadHealth() {
  try {
    const body = await api("/api/health");
    const dot = el("health-dot");
    dot.className = `dot ${body.router?.up ? "ok" : "bad"}`;
    dot.title = body.router?.up ? t("router answering") : t("router down: {error}", { error: body.router?.error ?? t("unknown") });
    state.launchWorkspace = body.workspace ?? "";
    paintWorkspace(currentWorkspace());
    // The reveal button's fallback target: a chat with no file path in it yet can still
    // open the folder the harness works in.
    state.workspace = body.workspace ?? "";
    paintReveal();
    el("foot-router").textContent = body.router?.up
      ? t("router ok · {n} models", { n: (body.router.models ?? []).length })
      : t("router down · {error}", { error: clip(body.router?.error ?? t("unknown"), 40) });

    state.models = body.router?.up ? body.router.models ?? [] : [];
    // What the card holds right now. The picker lists every GGUF on the disk, but only one
    // of them can be resident, and which one is a fact from the server, not from the list.
    state.localServer = body.local ?? null;
    // The picker is its own request, because it answers a different question: not "is
    // the router alive" but "what can I choose, what does it cost, and what does each
    // role do". A router that lists nothing still leaves the roles usable.
    await loadModels();
    const counts = body.sessionCounts ?? {};
    const total = Object.values(counts).reduce((sum, n) => sum + (Number(n) || 0), 0);
    el("foot-spend").textContent = total ? t("{n} sessions found on this machine", { n: total }) : t("no sessions found");
    if (!el("chat-meta").textContent) {
      // Chat models, not rows: the count should match what the menu can actually offer.
      const offered = state.chatModels?.length ?? 0;
      el("chat-meta").textContent = t("{models} model choices · {chats} chats here", { models: offered, chats: state.all.chats.length });
    }
  } catch (err) {
    el("health-dot").className = "dot bad";
    el("foot-router").textContent = t("ui server error: {error}", { error: clip(err.message, 40) });
  }
}

// ------------------------------------------------------------- the model + role pickers
//
// Two axes, one control. A ROLE is a system prompt and a delegation target
// (`data\roles.json`, routed through the router's class of the same name). A MODEL is a
// concrete target - a provider model or a llama.cpp id on this machine. The redundant
// top-bar Role, Model and Orchestrate menus are gone; the harness answers with its own
// default role and the request omits `role`, while the composer keeps one model picker
// because a model is a real per-message choice.
//
// The model dropdown is not a native `<select>` either. Opening it shows the chat models
// and, under them, an effort submenu: effort describes how the model that answers should
// think, so it belongs beside the choice of model rather than in a second control in the
// top bar. `state.model` is the one value every reader in this file uses - there is no
// hidden select kept alive behind the picker.
//
// Three rules the visible list obeys:
//   - real models only: the synthetic "Role default" row is gone. The role is the server
//     default now, and leaving the model empty is no longer a way to choose one.
//   - chat models only: the rules below drop embeddings, image/video/audio renderers,
//     rerankers and moderation models, none of which can answer a chat.
//   - a cloud model by default when one is reachable, then a local one, then nothing at
//     all; the trigger's title and aria-label say which of the three applied and why.
//
// The block between the markers is a byte-identical copy of ui/model-catalog.mjs. The UI
// server serves a fixed list of static files, so the module is inlined here rather than
// imported; test/model-catalog.test.mjs tests the module and fails if the copies drift.

// ==== model-catalog block: begin ====
// How hard a model should think. The router's vocabulary, in the order a person reads it.
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

// Ordered: first match wins. Every family the picker must never offer, with the
// boundary discipline that keeps a real chat model from being caught by accident.
// `qwen3.8-27b`, `deepseek-v4.1-flash-free`, `glm-5.3-flash-free` and
// `claude-sonnet-4-5` are the four names the test pins: none of them may match.
const NON_CHAT_RULES = [
  ["rerank", /rerank|re-rank|(?:^|[-_/])ranker(?:[-_/]|$)/i],
  ["embedding", /embed|(?:^|[-_/])(?:bge|gte|e5|bce|voyage)(?:[-_/]|$)|jina[-_](?:embed|clip)/i],
  ["moderation", /moderat|guardrail|(?:^|[-_/])guard(?:ian)?(?:[-_/]|$)|nsfw/i],
  ["audio", /whisper|audio|voice|speech|music|suno|vocoder|realtime|transcribe|(?:^|[-_/])(?:tts|stt|asr|rvc|orpheus|parakeet|dia[-_]?tts|fish[-_]?speech)(?:[-_/]|$)/i],
  ["image", /image|dall[-_]?e|(?:^|[-_/])flux|sdxl|(?:^|[-_/])sd[-_]?3|stable[-_]?diffusion|kolors|playground|(?:^|[-_/])imagen|diffusion|midjourney|ideogram|recraft|img[-_]?2img/i],
  ["video", /(?:^|[-_/])ltx|ltx[-_]?v|video|movie|(?:^|[-_/])wan[-_]?\d|hunyuan[-_]?video|cogvideo|(?:^|[-_/])svd(?:[-_/]|$)|animatediff|(?:^|[-_/])mochi|(?:^|[-_/])veo\d?|(?:^|[-_/])sora|kling|runway|pika|seedance|hailuo/i],
  ["completion", /(?:^|[-_/])(?:davinci|babbage|curie|ada|codex[-_]?davinci)(?:[-_/]|$)/i],
  ["other", /(?:^|[-_/])(?:yolo|sam2|tokenizer|classifier|clip)(?:[-_/]|$)/i],
];

/**
 * What one entry is. Accepts the id alone or the row the menu returns.
 *
 * The menu's own word beats a name guess in both directions: an entry it marks
 * `chat: false` is out whatever it is called, and an entry it marks `chat: true` is a
 * chat model even when a rule would have called it something else.
 */
function classifyModel(row) {
  const entry = typeof row === "string" ? { id: row } : row ?? {};
  const id = String(entry.id ?? entry.name ?? "");
  const hint = String(entry.kind ?? "").trim().toLowerCase();
  if (entry.chat === false) {
    return { id, kind: hint && hint !== "chat" ? hint : "other", chat: false, why: "the menu marks it as not a chat model" };
  }
  if (hint && hint !== "chat") {
    return { id, kind: hint, chat: false, why: `the menu lists it as ${hint}, not chat` };
  }
  const name = `${id} ${String(entry.model ?? "")}`.trim();
  for (const [kind, re] of NON_CHAT_RULES) {
    const found = re.exec(name);
    if (found) return { id, kind, chat: false, why: `"${found[0]}" reads as a ${kind} model` };
  }
  if (entry.chat === true) return { id, kind: "chat", chat: true, why: "the menu marks it as a chat model" };
  return { id, kind: "chat", chat: true, why: "nothing in the name says otherwise" };
}

/** The one question the picker asks: can this entry answer a chat? */
function isChatModel(row) {
  return classifyModel(row).chat;
}

/** Every entry that can answer a chat, in the order the menu gave them. */
function chatModels(rows) {
  return (Array.isArray(rows) ? rows : []).filter((row) => isChatModel(row));
}

/**
 * A cloud model is one served somewhere other than this machine's llama.cpp host.
 * The menu says so with provider/source; the id prefix is the fallback for a row that
 * carries neither.
 */
function isCloudModel(row) {
  const entry = typeof row === "string" ? { id: row } : row ?? {};
  const id = String(entry.id ?? "");
  const slash = id.indexOf("/");
  const provider = String(entry.provider ?? (slash > 0 ? id.slice(0, slash) : ""));
  return entry.source !== "local" && provider !== "local" && !id.startsWith("local/");
}

/**
 * Which model a picker should point at.
 *
 * Order, and the reason a person is told:
 *   1. the stored choice, when it still exists and can chat (never overridden silently);
 *   2. the first cloud chat model the menu offers and does not mark unavailable;
 *   3. a local chat model, preferring one that is already resident;
 *   4. nothing - with the reason, so the picker can say why it is empty.
 *
 * `errors` is the menu's own `errors` array; a string starting "router" means the
 * router did not answer, one starting "local" means the llama.cpp host did not.
 */
function resolveDefaultModel({ rows = [], stored = "", errors = [] } = {}) {
  const chat = chatModels(rows);
  const messages = (Array.isArray(errors) ? errors : []).map((value) => String(value ?? ""));
  const routerDown = messages.some((text) => /^router\b/i.test(text));
  const localDown = messages.some((text) => /^local\b/i.test(text));
  const want = String(stored ?? "").trim();
  const chosen = want ? chat.find((row) => String(row?.id ?? row) === want) ?? null : null;
  if (chosen) {
    return { id: want, tier: "stored", row: chosen, storedDropped: false, reason: "kept from your last choice" };
  }
  const cloud = routerDown ? [] : chat.filter((row) => isCloudModel(row) && row?.available !== false);
  if (cloud.length) {
    const first = cloud[0];
    return {
      id: String(first.id ?? first),
      tier: "cloud",
      row: first,
      storedDropped: Boolean(want),
      reason: "defaulted to a cloud model, so an answer never waits for a local load",
    };
  }
  if (!localDown) {
    const locals = chat.filter((row) => !isCloudModel(row) && row?.available !== false);
    const loaded = locals.find((row) => row?.loaded === true) ?? null;
    const first = loaded ?? locals[0] ?? null;
    if (first) {
      return {
        id: String(first.id ?? first),
        tier: "local",
        row: first,
        storedDropped: Boolean(want),
        reason: loaded ? "no cloud model is reachable, so the loaded local model is the default" : "no cloud model is reachable, so the default is a local model",
      };
    }
  }
  const why = routerDown && localDown
    ? "no model is selected: neither the router nor the local model server answered"
    : routerDown
      ? "no model is selected: the router did not answer and no local chat model is listed"
      : localDown
        ? "no model is selected: no cloud model is configured and the local model server did not answer"
        : "no model is selected: the menu listed no chat model";
  return { id: "", tier: "none", row: null, storedDropped: Boolean(want), reason: why };
}

/** The levels one model declares, in the vocabulary order. */
function modelEfforts(row) {
  const entry = typeof row === "string" ? { id: row } : row ?? {};
  const list = Array.isArray(entry.efforts) ? entry.efforts.map((value) => String(value)) : [];
  return EFFORT_LEVELS.filter((level) => list.includes(level));
}

/**
 * The levels the effort submenu may offer. A pinned model that declares its own levels
 * gets exactly those; anything else - no model pinned, a model the menu never described,
 * or a cloud row that declares nothing - gets everything the listed chat models declare
 * between them, because that model leaves the decision to the router, which drops the
 * field for a provider that cannot honour it.
 */
function availableEfforts(rows = [], selectedId = "") {
  const list = Array.isArray(rows) ? rows : [];
  const chosen = list.find((row) => String(row?.id ?? row) === String(selectedId ?? "")) ?? null;
  const own = chosen ? modelEfforts(chosen) : [];
  if (own.length) return own;
  const union = new Set();
  for (const row of chatModels(list)) for (const level of modelEfforts(row)) union.add(level);
  return EFFORT_LEVELS.filter((level) => union.has(level));
}

/** A stored level the selected model cannot honour is not sent: "" means "Default". */
function clampEffort(level, efforts) {
  const text = String(level ?? "");
  return (Array.isArray(efforts) ? efforts : []).includes(text) ? text : "";
}
// ==== model-catalog block: end ====

/**
 * The name a person sees for a model. The picker prints `label ?? model ?? id`, and the
 * run header has to print the same thing: the provider-qualified id is how the router
 * addresses a model, not what it is called. A target the catalog does not know keeps its
 * own id, so a local model is never quietly renamed to something it is not.
 */
function modelDisplayName(target) {
  const text = String(target ?? "");
  if (!text) return "";
  const rows = Array.isArray(state.models) ? state.models : [];
  const idOf = (row) => String(row?.id ?? row?.name ?? "");
  const short = text.slice(text.lastIndexOf("/") + 1);
  const exact = rows.find((candidate) => idOf(candidate) === text);
  // A cloud id and a local id can share the part after the provider prefix; the full id
  // wins, and the short match is only tried when the target actually carries a prefix.
  const row =
    exact ??
    (text.includes("/")
      ? rows.find((candidate) => idOf(candidate) === short || idOf(candidate).endsWith(`/${short}`))
      : null);
  // A custom class is a name, not a model: any member of its chain may answer, and the
  // header must keep the name the picker shows instead of revealing which member did.
  // An id the catalog does not know still falls through, so a stray local model is not
  // dressed up as the class it never joined.
  const pick = state.pick?.row;
  if (row && pick && Array.isArray(pick.tags) && pick.tags.includes("custom")) {
    return String(pick.label ?? pick.model ?? pick.id ?? text);
  }
  return row ? String(row.label ?? row.model ?? idOf(row)) : text;
}

// The two preferences that survive a reload, under the keys older builds already wrote.
const MODEL_KEY = "rosalena-model";
// Each conversation's own model, by thread id: switching the model in one chat must not
// move any other chat. MODEL_KEY stays the starting model for a chat that has none yet.
const CHAT_MODELS_KEY = "rosalena-chat-models";
const CHAT_MODELS_LIMIT = 500;

function readChatModels() {
  try {
    const parsed = JSON.parse(readPref(CHAT_MODELS_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The model a conversation was last used with, or "" when it has none. */
function chatModelFor(thread) {
  if (!thread) return "";
  const value = readChatModels()[thread];
  return typeof value === "string" ? value : "";
}

/** Remember a conversation's model; the oldest entries fall off past the limit. */
function setChatModel(thread, id) {
  if (!thread) return;
  const map = readChatModels();
  delete map[thread];
  if (id) map[thread] = id;
  const keys = Object.keys(map);
  for (const key of keys.slice(0, Math.max(0, keys.length - CHAT_MODELS_LIMIT))) delete map[key];
  writePref(CHAT_MODELS_KEY, Object.keys(map).length ? JSON.stringify(map) : "");
}

// Each conversation's effort (and Ultracode) as of its last message, by thread id, so a
// Claude chat on "Max" and a local chat on "Default" each come back the way they were left.
const CHAT_EFFORTS_KEY = "rosalena-chat-efforts";

function readChatEfforts() {
  try {
    const parsed = JSON.parse(readPref(CHAT_EFFORTS_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Remember the effort a chat was last sent with; the oldest entries fall off past the limit. */
function setChatEffort(thread, effort, ultracode) {
  if (!thread) return;
  const map = readChatEfforts();
  delete map[thread];
  map[thread] = { effort: String(effort ?? ""), ultracode: Boolean(ultracode) };
  const keys = Object.keys(map);
  for (const key of keys.slice(0, Math.max(0, keys.length - CHAT_MODELS_LIMIT))) delete map[key];
  writePref(CHAT_EFFORTS_KEY, JSON.stringify(map));
}

/**
 * Point the picker at the model the chat on screen should use: its own pinned model when
 * it has one the menu still offers, otherwise the starting model for new chats. Its effort
 * and Ultracode come back with it.
 */
function applyChatModel() {
  if (!state.models?.length) return; // loadModels resolves it once the menu arrives
  const thread = state.current?.thread ?? null;
  const saved = thread ? readChatEfforts()[thread] : null;
  if (saved && typeof saved === "object") {
    writePref(EFFORT_KEY, EFFORT_LEVELS.includes(saved.effort) ? saved.effort : "");
    writePref(ULTRACODE_KEY, saved.ultracode ? "1" : "");
  } else if (!thread) {
    // A new chat starts from the effort last picked for a new chat, not from whatever the
    // last chat viewed had (an old chat on Max made the next new chat Max too).
    const fresh = readPref(EFFORT_DEFAULT_KEY);
    {
      writePref(EFFORT_KEY, EFFORT_LEVELS.includes(fresh) ? fresh : "");
      writePref(ULTRACODE_KEY, readPref(ULTRACODE_DEFAULT_KEY) === "1" ? "1" : "");
    }
  }
  const own = chatModelFor(thread);
  const resolved = resolveDefaultModel({ rows: state.models, stored: own || readPref(MODEL_KEY), errors: state.menu?.errors ?? [] });
  if (own && resolved.storedDropped) setChatModel(thread, "");
  else if (!own && resolved.storedDropped) writePref(MODEL_KEY, "");
  if (own && !resolved.storedDropped) resolved.reason = "this chat's model";
  state.pick = resolved;
  state.model = resolved.id || "";
  syncQuick();
  if (saved && typeof renderModelTriggers === "function") renderModelTriggers();
}
const EFFORT_KEY = "rosalena-effort";
const ULTRACODE_KEY = "rosalena-ultracode";
// What a new chat starts with (picked while no chat was open), apart from any chat's own.
const EFFORT_DEFAULT_KEY = "rosalena-effort-new-chat";
const ULTRACODE_DEFAULT_KEY = "rosalena-ultracode-new-chat";
const EFFORT_NAMES = { "": t("Default"), low: t("Low"), medium: t("Medium"), high: t("High"), xhigh: t("Extra"), max: t("Max") };

/** A pick's reason (the model-catalog block above writes them in English) as the window shows it. */
function pickReasonText(reason) {
  const shown = {
    "kept from your last choice": t("kept from your last choice"),
    "this chat's model": t("this chat's model"),
    "defaulted to a cloud model, so an answer never waits for a local load": t("defaulted to a cloud model, so an answer never waits for a local load"),
    "no cloud model is reachable, so the loaded local model is the default": t("no cloud model is reachable, so the loaded local model is the default"),
    "no cloud model is reachable, so the default is a local model": t("no cloud model is reachable, so the default is a local model"),
    "no model is selected: neither the router nor the local model server answered": t("no model is selected: neither the router nor the local model server answered"),
    "no model is selected: the router did not answer and no local chat model is listed": t("no model is selected: the router did not answer and no local chat model is listed"),
    "no model is selected: no cloud model is configured and the local model server did not answer": t("no model is selected: no cloud model is configured and the local model server did not answer"),
    "no model is selected: the menu listed no chat model": t("no model is selected: the menu listed no chat model"),
  };
  return Object.prototype.hasOwnProperty.call(shown, reason) ? shown[reason] : reason;
}

/** The selected model's own row in the menu list, when it has one. */
function selectedModelRow() {
  return (state.models ?? []).find((row) => row?.id === (state.model || "")) ?? null;
}

/** "Default (Medium)" where the model says which level its default is; plain "Default" otherwise. */
function effortName(level) {
  if (level) return EFFORT_NAMES[level] ?? level;
  const hint = defaultEffortHint();
  return hint ? t("Default ({hint})", { hint }) : t("Default");
}

/**
 * What "Default" comes to on the selected model, in a word: its provider's own level
 * ("medium" on Claude Opus 5.5, "high" on Sonnet 5.5), "thinking off" where no effort
 * means no thinking (the local model), or "" when the provider does not say.
 */
function defaultEffortTitle() {
  const hint = defaultEffortHint();
  if (hint === t("thinking off")) return t("Send no level: this model then answers without thinking first (fastest)");
  return hint ? t("Send no level: the model uses its own default, {hint}", { hint }) : t("Send no level: the model and its provider decide how hard to think");
}

function defaultEffortHint() {
  const own = selectedModelRow()?.defaultEffort;
  if (own === "off") return t("thinking off");
  return own && EFFORT_NAMES[own] ? EFFORT_NAMES[own].toLowerCase() : "";
}

function readPref(key) {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writePref(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* private mode */
  }
}

/**
 * The menu, from the server: router models, local models, and the roles.
 *
 * A picker that cannot reach the server must not empty the composer: the last known
 * list stays, and the failure is said out loud.
 */
async function loadModels() {
  try {
    const menu = await api("/api/models");
    state.menu = menu;
    state.roles = menu.roles ?? [];
    state.models = menu.models ?? [];
  } catch (err) {
    // A picker that cannot reach the server must not empty the composer: keep the last
    // known list and say what failed.
    toast(t("Could not load the model list: {error}", { error: err.message }), "bad");
  }
  renderPickers();
  // The idle meter needs the context window, and the window arrives with this answer, so
  // the gauge is painted again now that it is known.
  if (!state.current) setContext(null);
  const errors = state.menu?.errors ?? [];
  el("foot-router").title = errors.length ? errors.join("\n") : "";
}

function renderPickers() {
  // The role menu is gone with the other top-bar selects: the harness answers with its
  // own default role, and Settings -> Orchestration only reports what each role is
  // configured to do. `state.roles` is kept for that report's fallback and for the
  // chat-meta line; nothing sends a role with a message any more.

  // Chat models only, grouped the way a person chooses: the free cloud window and the
  // assistant built on it are one heading ("Rosalena Cloud Models"), the machine's own
  // models are the other. The provider id is a wire detail; the heading is not.
  const rows = chatModels(state.models);
  state.chatModels = rows;
  const byProvider = new Map();
  for (const model of rows) {
    const provider = modelGroupLabel(model.provider || "router");
    if (!byProvider.has(provider)) byProvider.set(provider, []);
    byProvider.get(provider).push(model);
  }

  // The stored pick survives a reload unless it stopped being a chat model: an
  // embedding pinned by an older build, a local model that has since been removed, or a
  // row the menu now calls a renderer. Then the key is cleared in silence and the
  // default order decides - never a picker pointing at a model that cannot answer.
  const thread = state.current?.thread ?? null;
  const own = chatModelFor(thread);
  const resolved = resolveDefaultModel({ rows: state.models, stored: own || readPref(MODEL_KEY), errors: state.menu?.errors ?? [] });
  if (own && !resolved.storedDropped) resolved.reason = "this chat's model";
  state.pick = resolved;
  state.model = resolved.id || "";
  if (resolved.storedDropped) {
    if (own) setChatModel(thread, "");
    else writePref(MODEL_KEY, "");
  }
  // Settings > Models and > Generation list the same rows; refreshed when they are showing.
  if (!el("settings-panel")?.hidden) {
    renderSettingsModels();
    paintGeneration();
  }

  if (quickModel) {
    quickModel.innerHTML = "";
    for (const [provider, entries] of byProvider) {
      const group = document.createElement("optgroup");
      group.label = provider;
      for (const model of entries) {
        const option = document.createElement("option");
        option.value = model.id;
        const name = model.label ?? model.model ?? model.id;
        option.textContent = model.cost && model.cost !== "free" ? `${name} · ${model.cost}` : name;
        option.title = `${model.id}${model.note ? ` - ${model.note}` : ""}${model.cost ? ` (${model.cost})` : ""}`;
        group.append(option);
      }
      quickModel.append(group);
    }
    quickModel.value = state.model;
  }
  syncQuick();
}

// ------------------------------------------------------- the model menu (and effort)

/**
 * The dropdown, bought rather than borrowed.
 *
 * A native `<select>` cannot hold a submenu, and the effort control has to live inside
 * the model menu, so the menu is a real popup: a button that owns `aria-haspopup` and
 * `aria-expanded`, a `role="menu"` of `role="menuitemradio"` model rows, and a
 * `role="menuitem"` effort row that opens a `role="menu"` of its own. Focus is real
 * focus (roving tabindex on the items), not a painted highlight, so a screen reader
 * announces the item under the cursor and Escape returns to the trigger.
 *
 * The trigger replaces the native select in the top bar, but the select itself stays in
 * the DOM, hidden, as the single value store this file already reads everywhere.
 */
const pickTriggers = [];
const modelMenu = {
  root: null, // the model list
  effort: null, // the effort submenu
  anchor: null, // which trigger opened it
  open: false,
  subOpen: false,
  items: [], // model rows, in order, plus the effort row at the end
  effortItems: [],
};

function injectModelMenuStyle() {
  if (document.getElementById("model-menu-style")) return;
  // The popup ships its own rules because it only exists once this file has run:
  // styles.css belongs to the static page, and a menu built here should not need an
  // edit there to look like it belongs.
  const style = document.createElement("style");
  style.id = "model-menu-style";
  style.textContent = [
    ".model-trigger{display:inline-flex;align-items:center;gap:6px;max-width:216px;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:5px 8px;font-family:inherit;font-size:12px;color:var(--text-2);cursor:pointer;overflow:hidden;white-space:nowrap;transition:border-color 120ms,color 120ms}",
    ".model-trigger:hover{border-color:var(--accent);color:var(--text)}",
    ".model-trigger:focus-visible{outline:none;border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}",
    ".model-trigger-text{overflow:hidden;text-overflow:ellipsis}",
    ".model-trigger-caret{flex:none;font-size:10px;color:var(--dim)}",
    ".quick-pick .model-trigger{max-width:100%}",
    ".model-menu{position:fixed;z-index:1300;min-width:264px;max-width:420px;max-height:min(70vh,560px);overflow:auto;background:var(--panel-2);border:1px solid var(--line);border-radius:10px;padding:6px;box-shadow:0 18px 48px rgba(0,0,0,.5);font-size:12.5px;color:var(--text-2)}",
    ".model-menu[hidden]{display:none}",
    ".mm-head{padding:6px 8px 3px;font-size:9.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--dim-2)}",
    ".mm-item{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;color:var(--text-2)}",
    ".mm-item:focus{outline:none;background:var(--panel-3);color:var(--text)}",
    ".mm-item[aria-checked='true']{color:var(--text)}",
    ".mm-item[aria-disabled='true']{color:var(--dim-2);cursor:default}",
    ".mm-tick{flex:none;width:12px;color:var(--accent)}",
    ".mm-name{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".mm-cost{flex:none;font-size:10.5px;color:var(--dim)}",
    ".mm-caret{flex:none;font-size:10px;color:var(--dim)}",
    ".mm-sep{height:1px;background:var(--line-soft);margin:6px 4px}",
    ".mm-note{padding:4px 8px 6px;font-size:11px;color:var(--dim-2);white-space:normal}",
    ".mm-note.mm-key-ok{padding-top:0;color:var(--ok)}",
    ".mm-note.mm-key-missing{padding-top:0;color:var(--warn)}",
    ".mm-ctx{padding:6px 8px 8px;display:flex;flex-direction:column;gap:4px}",
    ".mm-ctx-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;color:var(--text-2)}",
    ".mm-ctx-out{font-variant-numeric:tabular-nums;color:var(--text);font-weight:600}",
    ".mm-ctx-slider{width:100%;margin:2px 0;accent-color:var(--accent);cursor:pointer}",
    ".mm-ctx-slider:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}",
    ".mm-ctx-scale{display:flex;justify-content:space-between;font-size:10px;color:var(--dim);font-variant-numeric:tabular-nums}",
    ".mm-ctx-note{font-size:11px;color:var(--dim-2);white-space:normal}",
  ].join("\n");
  document.head.append(style);
}

function noteNode(text) {
  const node = document.createElement("div");
  node.className = "mm-note";
  node.setAttribute("role", "presentation");
  node.textContent = text;
  return node;
}

function separatorNode() {
  const node = document.createElement("div");
  node.className = "mm-sep";
  node.setAttribute("role", "separator");
  return node;
}

/** One trigger per visible picker; both open the same menu, next to themselves. */
function makeModelTrigger(select, id) {
  if (!select) return null;
  injectModelMenuStyle();
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.id = id;
  trigger.className = "model-trigger";
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-controls", "model-menu");
  trigger.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (modelMenu.open && modelMenu.anchor === trigger) closeModelMenu({ focus: true });
    else openModelMenu(trigger);
  });
  trigger.addEventListener("keydown", (event) => {
    if (modelMenu.open) return; // the document handler owns the keys while it is open
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openModelMenu(trigger);
    }
  });
  hidePickerStore(select);
  select.before(trigger);
  pickTriggers.push(trigger);
  return trigger;
}

/**
 * The native select becomes the value store: out of sight, out of the tab order, and
 * still the element every other function in this file reads and writes. `display` is set
 * inline as well as via `hidden`, because styles.css gives these selects author-level
 * box rules and a hidden select that keeps its row would leave a stray gap in the bar.
 */
function hidePickerStore(select) {
  if (!select) return;
  select.hidden = true;
  select.style.display = "none";
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");
}

function initialiseModelPicker() {
  // The standalone effort dropdown is gone from the top bar: effort is a row inside the
  // model menu now. The markup still carries it, because index.html belongs to another
  // surface of the page, so it is removed here rather than left hidden behind the menu.
  el("effort-pick")?.remove();
  // ONE visible model control in the page: the picker beside the composer. The redundant
  // top-bar Role and Model selects are gone from the markup entirely, so this file keeps
  // the choice in `state.model` and offers the composer's own picker. Nothing here needs
  // a hidden select to exist, and nothing throws when one is missing.
  makeModelTrigger(quickModel, "quick-model-trigger");
  buildModelMenu();
  document.addEventListener("keydown", onModelMenuKey, true);
  document.addEventListener("click", (event) => {
    if (!modelMenu.open) return;
    if (modelMenu.root?.contains(event.target) || modelMenu.effort?.contains(event.target)) return;
    if (pickTriggers.some((trigger) => trigger.contains(event.target))) return;
    closeModelMenu();
  });
  // A fixed panel cannot follow a resized window, and a stale position is worse than a
  // closed menu.
  window.addEventListener("resize", () => closeModelMenu());
  renderModelTriggers();
}

function buildModelMenu() {
  if (modelMenu.root) return modelMenu.root;
  injectModelMenuStyle();
  const root = document.createElement("div");
  root.id = "model-menu";
  root.className = "model-menu";
  root.hidden = true;
  root.setAttribute("role", "menu");
  root.setAttribute("aria-label", t("Model and effort"));
  root.addEventListener("click", (event) => event.stopPropagation());
  document.body.append(root);

  const effort = document.createElement("div");
  effort.id = "model-effort-menu";
  effort.className = "model-menu";
  effort.hidden = true;
  effort.setAttribute("role", "menu");
  effort.setAttribute("aria-label", t("Effort"));
  effort.addEventListener("click", (event) => event.stopPropagation());
  document.body.append(effort);

  modelMenu.root = root;
  modelMenu.effort = effort;
  return root;
}

/** What the trigger says: the model, and why that one, in the title and the label. */
function renderModelTriggers() {
  const id = state.model || "";
  const row = state.models.find((model) => model.id === id) ?? null;
  const name = row ? row.label ?? row.model ?? id : id;
  const suffix = row?.cost && row.cost !== "free" ? ` · ${row.cost}` : "";
  const efforts = availableEfforts(state.models, id);
  const effort = clampEffort(readPref(EFFORT_KEY), efforts);
  const why = pickReasonText(state.pick?.reason ?? "");
  const title = id
    ? effort
      ? t("Model: {name}{suffix} ({id}). {why} Effort: {effort}.", { name, suffix, id, why, effort: EFFORT_NAMES[effort] })
      : t("Model: {name}{suffix} ({id}). {why}", { name, suffix, id, why })
    : t("No model is selected. {why}. The role decides who answers.", { why: why || t("the menu listed no chat model") });
  for (const trigger of pickTriggers) {
    trigger.replaceChildren();
    const text = document.createElement("span");
    text.className = "model-trigger-text";
    text.textContent = id ? `${name}${suffix}` : t("No model");
    const caret = document.createElement("span");
    caret.className = "model-trigger-caret";
    caret.setAttribute("aria-hidden", "true");
    caret.textContent = "▾";
    trigger.append(text, caret);
    trigger.title = title;
    trigger.setAttribute("aria-label", title);
  }
  if (modelMenu.open) renderModelMenu();
  paintEffortChip();
}

function openModelMenu(trigger) {
  const root = buildModelMenu();
  closeChoiceMenu();
  modelMenu.anchor = trigger;
  modelMenu.open = true;
  modelMenu.subOpen = false;
  modelMenu.effort.hidden = true;
  renderModelMenu();
  placePanel(root, trigger.getBoundingClientRect());
  setTriggersExpanded(true);
  const checked = modelMenu.items.find((item) => item.getAttribute("aria-checked") === "true") ?? modelMenu.items[0] ?? null;
  checked?.focus();
}

function closeModelMenu({ focus = false } = {}) {
  if (!modelMenu.open) return;
  const anchor = modelMenu.anchor;
  modelMenu.open = false;
  modelMenu.subOpen = false;
  if (modelMenu.effort) modelMenu.effort.hidden = true;
  if (modelMenu.root) modelMenu.root.hidden = true;
  setTriggersExpanded(false);
  if (focus && anchor) anchor.focus();
}

function setTriggersExpanded(open) {
  for (const trigger of pickTriggers) trigger.setAttribute("aria-expanded", String(open));
}

/**
 * Put a fixed panel beside its anchor without letting it leave the window.
 * `align` is the edge of the anchor the panel hangs from: start (below it), right (to its
 * right), or left (to its left). `flip` moves a right-hand panel to the left of its anchor
 * when the right side has no room, which is how the effort submenu stays readable near the
 * window edge instead of being clamped over the menu it belongs to.
 */
function placePanel(panel, rect, { align = "start", gap = 4, flip = false } = {}) {
  panel.hidden = false;
  panel.style.visibility = "hidden";
  const box = panel.getBoundingClientRect();
  const margin = 8;
  let side = align;
  if (flip && align === "right") {
    const rightFits = rect.right + gap + box.width <= window.innerWidth - margin;
    const leftFits = rect.left - gap - box.width >= margin;
    if (!rightFits && leftFits) side = "left";
  }
  let left = rect.left;
  if (side === "right") left = rect.right + gap;
  if (side === "left") left = rect.left - box.width - gap;
  let top = rect.bottom + gap;
  if (side !== "start") top = rect.top;
  if (left + box.width > window.innerWidth - margin) left = window.innerWidth - box.width - margin;
  if (left < margin) left = margin;
  if (top + box.height > window.innerHeight - margin) top = Math.max(margin, rect.top - box.height - gap);
  if (top < margin) top = margin;
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
  panel.style.visibility = "";
}

function renderModelMenu() {
  const root = modelMenu.root;
  if (!root) return;
  root.replaceChildren();
  modelMenu.items = [];
  const rows = state.chatModels ?? chatModels(state.models);
  if (!rows.length) root.append(noteNode(pickReasonText(state.pick?.reason) ?? t("No chat model answered the menu request.")));

  const byProvider = new Map();
  for (const row of rows) {
    const provider = modelGroupLabel(row.provider || "router");
    if (!byProvider.has(provider)) byProvider.set(provider, []);
    byProvider.get(provider).push(row);
  }
  for (const [provider, entries] of byProvider) {
    const head = document.createElement("div");
    head.className = "mm-head";
    head.setAttribute("role", "presentation");
    head.textContent = provider;
    const group = document.createElement("div");
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", provider);
    // Under an API-key heading: whether that key is saved, so a pick that can only fail
    // with "no key" says so before it is made.
    const saved = state.menu?.keys?.[entries[0]?.provider] ?? null;
    const keyNote = keyStatusNote(entries[0]?.provider, saved);
    if (keyNote) {
      const note = noteNode(keyNote);
      if (saved !== null && entries[0]?.provider !== "claude-code" && entries[0]?.provider !== "codex") note.classList.add(saved ? "mm-key-ok" : "mm-key-missing");
      group.append(note);
    }
    for (const row of entries) {
      const item = document.createElement("div");
      const selected = row.id === state.model;
      item.className = "mm-item";
      item.id = `mm-option-${modelMenu.items.length}`;
      item.setAttribute("role", "menuitemradio");
      item.setAttribute("aria-checked", String(selected));
      item.setAttribute("tabindex", "-1");
      item.dataset.model = row.id;
      const tick = document.createElement("span");
      tick.className = "mm-tick";
      tick.setAttribute("aria-hidden", "true");
      tick.textContent = selected ? "✓" : "";
      const name = document.createElement("span");
      name.className = "mm-name";
      name.textContent = row.label ?? row.model ?? row.id;
      item.append(tick, name);
      if (row.cost && row.cost !== "free") {
        const cost = document.createElement("span");
        cost.className = "mm-cost";
        cost.textContent = row.cost;
        item.append(cost);
      }
      item.title = `${row.id}${row.note ? ` - ${row.note}` : ""}${row.cost ? ` (${row.cost})` : ""}`;
      item.addEventListener("mouseenter", () => item.focus());
      item.addEventListener("click", (event) => {
        event.stopPropagation();
        chooseModel(row.id);
        closeModelMenu({ focus: true });
      });
      group.append(item);
      modelMenu.items.push(item);
    }
    root.append(head, group);
  }
  // Why this model is the one selected, in the menu itself: the same sentence the
  // trigger carries, where a person is already looking.
  if (state.pick?.reason) root.append(noteNode(pickReasonText(state.pick.reason)));
  root.append(separatorNode(), buildEffortRow(), buildContextRow(), buildDownloadRow());
}

/**
 * The context window as a slider in the model menu. Its stops are the preset windows up to
 * what the selected model takes natively (1M for Claude Opus and Sonnet through Claude Code),
 * so a long-window model can be given its whole window without typing a number.
 */
function menuCtxStops() {
  const cap = Number(selectedModelRow()?.contextMax) || Infinity;
  const stops = ctxStops().filter((n) => n <= cap);
  return stops.length ? stops : ctxStops().slice(0, 1);
}

function buildContextRow() {
  const stops = menuCtxStops();
  const current = prefs.contextWindow;
  const at = (() => {
    let best = 0;
    stops.forEach((stop, i) => {
      if (stop <= current) best = i;
    });
    return best;
  })();
  const row = document.createElement("div");
  row.className = "mm-ctx";
  row.id = "model-menu-context";
  const head = document.createElement("div");
  head.className = "mm-ctx-head";
  const label = document.createElement("label");
  label.htmlFor = "mm-ctx-slider";
  label.textContent = t("Context window");
  const out = document.createElement("output");
  out.className = "mm-ctx-out";
  out.htmlFor = "mm-ctx-slider";
  head.append(label, out);
  const slider = document.createElement("input");
  slider.type = "range";
  slider.id = "mm-ctx-slider";
  slider.className = "mm-ctx-slider";
  slider.min = "0";
  slider.max = String(stops.length - 1);
  slider.step = "1";
  slider.value = String(at);
  const scale = document.createElement("div");
  scale.className = "mm-ctx-scale";
  scale.setAttribute("aria-hidden", "true");
  scale.append(
    ...stops.map((stop) => {
      const tick = document.createElement("span");
      tick.textContent = shortTokens(stop);
      return tick;
    }),
  );
  const note = document.createElement("div");
  note.className = "mm-ctx-note";
  const paint = () => {
    const tokens = stops[Number(slider.value)] ?? current;
    const isDefault = !prefs.contextWindowSaved && tokens === prefs.contextWindowDefault;
    out.textContent = isDefault ? t("{tokens} (default)", { tokens: shortTokens(tokens) }) : shortTokens(tokens);
    slider.setAttribute("aria-valuetext", `${shortTokens(tokens)} tokens`);
    const cap = Number(selectedModelRow()?.contextMax) || 0;
    note.textContent =
      tokens > 200_000 && cap >= 1_000_000
        ? t("Past 200K Claude Code runs the model's native 1M-context variant. Long prompts cost more.")
        : cap
          ? t("This model takes up to {tokens}.", { tokens: shortTokens(cap) })
          : t("Older turns are summarised once a chat passes this size.");
  };
  paint();
  slider.addEventListener("input", paint);
  slider.addEventListener("change", () => {
    const tokens = stops[Number(slider.value)];
    if (tokens && tokens !== prefs.contextWindow) void setContextWindow(tokens);
  });
  for (const type of ["click", "pointerdown", "keydown"]) slider.addEventListener(type, (event) => event.stopPropagation());
  row.append(head, slider, scale, note);
  return row;
}

/** The way from the picker to more models: the Models page, with chat, image, video and voice. */
function buildDownloadRow() {
  const row = document.createElement("div");
  row.id = "model-menu-download";
  row.className = "mm-item";
  row.setAttribute("role", "menuitem");
  row.setAttribute("tabindex", "-1");
  const name = document.createElement("span");
  name.className = "mm-name";
  name.textContent = t("Download models…");
  const hint = document.createElement("span");
  hint.className = "mm-cost";
  hint.textContent = t("chat · image · video · voice");
  row.append(name, hint);
  row.title = t("See which models this PC runs and download one from Hugging Face");
  row.addEventListener("mouseenter", () => row.focus());
  row.addEventListener("click", (event) => {
    event.stopPropagation();
    closeModelMenu();
    openPage("/models");
  });
  modelMenu.items.push(row);
  return row;
}

/** The effort row: a menuitem that opens a submenu, never a second control in the bar. */
function buildEffortRow() {
  const efforts = availableEfforts(state.models, state.model || "");
  const level = clampEffort(readPref(EFFORT_KEY), efforts);
  const row = document.createElement("div");
  row.id = "model-menu-effort";
  row.className = "mm-item mm-effort";
  row.setAttribute("role", "menuitem");
  row.setAttribute("aria-haspopup", "menu");
  row.setAttribute("aria-expanded", String(modelMenu.subOpen));
  row.setAttribute("aria-controls", "model-effort-menu");
  row.setAttribute("tabindex", "-1");
  row.dataset.effortRow = "1";
  if (!efforts.length) row.setAttribute("aria-disabled", "true");
  const name = document.createElement("span");
  name.className = "mm-name";
  name.textContent = t("Effort");
  const value = document.createElement("span");
  value.className = "mm-cost";
  value.textContent = efforts.length ? `${effortName(level)}${ultracodeOn() ? " · Ultracode" : ""}` : t("not offered");
  const caret = document.createElement("span");
  caret.className = "mm-caret";
  caret.setAttribute("aria-hidden", "true");
  caret.textContent = "▸";
  row.append(name, value, caret);
  row.title = efforts.length
    ? t("Reasoning effort ({levels}): sent only when the answering model honours it", { levels: efforts.join(", ") })
    : t("The selected model declares no reasoning effort, so this row has nothing to offer");
  row.addEventListener("mouseenter", () => row.focus());
  row.addEventListener("click", (event) => {
    event.stopPropagation();
    if (efforts.length) openEffortMenu(row);
  });
  modelMenu.items.push(row);
  return row;
}

function renderEffortMenu() {
  const panel = modelMenu.effort;
  panel.replaceChildren();
  modelMenu.effortItems = [];
  const efforts = availableEfforts(state.models, state.model || "");
  const current = clampEffort(readPref(EFFORT_KEY), efforts);
  const head = document.createElement("div");
  head.className = "mm-head";
  head.setAttribute("role", "presentation");
  head.textContent = t("Effort");
  panel.append(head);
  for (const level of ["", ...EFFORT_LEVELS]) {
    const supported = level === "" || efforts.includes(level);
    const item = document.createElement("div");
    item.className = "mm-item";
    item.id = `mm-effort-${level || "default"}`;
    item.setAttribute("role", "menuitemradio");
    item.setAttribute("aria-checked", String(level === current));
    item.setAttribute("tabindex", "-1");
    if (!supported) item.setAttribute("aria-disabled", "true");
    item.dataset.effort = level;
    const tick = document.createElement("span");
    tick.className = "mm-tick";
    tick.setAttribute("aria-hidden", "true");
    tick.textContent = level === current ? "✓" : "";
    const name = document.createElement("span");
    name.className = "mm-name";
    name.textContent = effortName(level);
    item.append(tick, name);
    item.title = level
      ? supported
        ? t("Ask for {level} reasoning effort", { level: EFFORT_NAMES[level].toLowerCase() })
        : t("{level} is not declared by the selected model, so the router would drop it", { level: EFFORT_NAMES[level] })
      : defaultEffortTitle();
    item.addEventListener("mouseenter", () => item.focus());
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!supported) return;
      chooseEffort(level);
      closeEffortMenu();
      closeModelMenu({ focus: true });
    });
    panel.append(item);
    modelMenu.effortItems.push(item);
  }
  // Ultracode is a switch under the levels, not a sixth level: it stays on at any effort.
  if (efforts.includes("xhigh")) {
    const on = readPref(ULTRACODE_KEY) === "1";
    const item = document.createElement("div");
    item.className = "mm-item mm-ultracode";
    item.id = "mm-ultracode";
    item.setAttribute("role", "menuitemcheckbox");
    item.setAttribute("aria-checked", String(on));
    item.setAttribute("tabindex", "-1");
    const tick = document.createElement("span");
    tick.className = "mm-tick";
    tick.setAttribute("aria-hidden", "true");
    tick.textContent = on ? "✓" : "";
    const name = document.createElement("span");
    name.className = "mm-name";
    name.textContent = "Ultracode";
    const state2 = document.createElement("span");
    state2.className = "mm-cost";
    state2.textContent = on ? t("on") : t("off");
    item.append(tick, name, state2);
    item.title = t("Sends at least Extra effort and has the agent split substantive tasks across parallel workers (delegate), then review the result. Uses many more tokens.");
    item.addEventListener("mouseenter", () => item.focus());
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      writePref(ULTRACODE_KEY, on ? "" : "1");
      const thread = state.current?.kind === "rosalena" ? state.current.thread : null;
      if (thread) setChatEffort(thread, readPref(EFFORT_KEY), !on);
      else writePref(ULTRACODE_DEFAULT_KEY, on ? "0" : "1");
      renderEffortMenu();
      renderModelTriggers();
      toast(on ? t("Ultracode is off.") : t("Ultracode is on: parallel workers for substantive tasks, Extra effort or higher."), "ok");
    });
    const sep = document.createElement("div");
    sep.className = "mm-sep";
    sep.setAttribute("role", "separator");
    panel.append(sep, item);
    modelMenu.effortItems.push(item);
  }
  panel.append(
    noteNode(
      efforts.length
        ? t("Applies where the answering model supports it ({levels}).", { levels: efforts.join(", ") })
        : t("The selected model declares no reasoning effort, so Default is the only honest level."),
    ),
  );
}

function openEffortMenu(row) {
  const panel = modelMenu.effort;
  if (!panel) return;
  modelMenu.subOpen = true;
  row.setAttribute("aria-expanded", "true");
  renderEffortMenu();
  const rect = row.getBoundingClientRect();
  placePanel(panel, rect, { align: "right", flip: true });
  const checked = modelMenu.effortItems.find((item) => item.getAttribute("aria-checked") === "true") ?? modelMenu.effortItems[0] ?? null;
  checked?.focus();
}

function closeEffortMenu({ focusRow = false } = {}) {
  if (!modelMenu.subOpen) return;
  modelMenu.subOpen = false;
  modelMenu.effort.hidden = true;
  const row = modelMenu.root?.querySelector('[data-effort-row="1"]');
  if (row) row.setAttribute("aria-expanded", "false");
  if (focusRow && row) row.focus();
}

/** Arrow keys, Home/End, Enter/Space, Escape and the submenu's left/right, in one place. */
function onModelMenuKey(event) {
  if (!modelMenu.open) return;
  const active = document.activeElement;
  const inside =
    modelMenu.root?.contains(active) || modelMenu.effort?.contains(active) || pickTriggers.some((trigger) => trigger === active);
  if (!inside) return;
  if (active?.id === "mm-ctx-slider" && event.key !== "Escape" && event.key !== "Tab") return;
  const list = modelMenu.subOpen ? modelMenu.effortItems : modelMenu.items;
  const index = list.indexOf(active);
  const swallow = () => {
    event.preventDefault();
    event.stopPropagation();
  };
  switch (event.key) {
    case "Escape":
      swallow();
      if (modelMenu.subOpen) closeEffortMenu({ focusRow: true });
      else closeModelMenu({ focus: true });
      return;
    case "Tab":
      // Focus goes back to the trigger and the browser moves on from there, so Tab
      // leaves the menu without trapping the keyboard in a fixed panel.
      closeModelMenu({ focus: true });
      return;
    case "ArrowDown":
      if (!list.length) return;
      swallow();
      list[index < 0 ? 0 : (index + 1) % list.length]?.focus();
      return;
    case "ArrowUp":
      if (!list.length) return;
      swallow();
      list[index < 0 ? list.length - 1 : (index - 1 + list.length) % list.length]?.focus();
      return;
    case "Home":
      if (!list.length) return;
      swallow();
      list[0]?.focus();
      return;
    case "End":
      if (!list.length) return;
      swallow();
      list[list.length - 1]?.focus();
      return;
    case "ArrowRight":
      if (!modelMenu.subOpen && index >= 0 && list[index]?.dataset.effortRow === "1") {
        swallow();
        openEffortMenu(list[index]);
      }
      return;
    case "ArrowLeft":
      if (modelMenu.subOpen) {
        swallow();
        closeEffortMenu({ focusRow: true });
      }
      return;
    case "Enter":
    case " ":
      if (index < 0) return;
      swallow();
      activateMenuItem(list[index]);
      return;
    default:
      return;
  }
}

function activateMenuItem(item) {
  if (!item || item.getAttribute("aria-disabled") === "true") return;
  if (item.id === "model-menu-download") {
    item.click();
    return;
  }
  if (item.dataset.effortRow === "1") {
    openEffortMenu(item);
    return;
  }
  if ("effort" in item.dataset) {
    chooseEffort(item.dataset.effort);
    closeEffortMenu();
    closeModelMenu({ focus: true });
    return;
  }
  if (item.dataset.model) {
    chooseModel(item.dataset.model);
    closeModelMenu({ focus: true });
  }
}

// ------------------------------------------------- the Access and Commits menus

/**
 * The other composer pickers get the model menu's look. A native `<select>` opens an OS
 * popup that ignores the app's theme: on a dark plugin theme its options came out as pale
 * text on a pale sheet, unreadable. So each select becomes a trigger plus one shared
 * `.model-menu` panel, and the select stays in the DOM, hidden, as the value store. A pick
 * sets its value and fires `change`, so the handlers below never learn the difference.
 */
const choiceMenu = { root: null, anchor: null, select: null, items: [] };
const choiceTriggers = new Map(); // select -> trigger

function makeChoiceTrigger(select) {
  if (!select) return null;
  injectModelMenuStyle();
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.id = `${select.id}-trigger`;
  trigger.className = "model-trigger";
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-controls", "choice-menu");
  trigger.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (choiceMenu.select === select) closeChoiceMenu({ focus: true });
    else openChoiceMenu(select);
  });
  trigger.addEventListener("keydown", (event) => {
    if (choiceMenu.select) return;
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openChoiceMenu(select);
    }
  });
  hidePickerStore(select);
  select.before(trigger);
  choiceTriggers.set(select, trigger);
  renderChoiceTrigger(select);
  return trigger;
}

/** The trigger mirrors its select: the chosen option's words, and disabled with it. */
function renderChoiceTrigger(select) {
  const trigger = choiceTriggers.get(select);
  if (!trigger) return;
  const option = select.selectedOptions[0] ?? select.options[0] ?? null;
  const text = document.createElement("span");
  text.className = "model-trigger-text";
  text.textContent = option?.textContent ?? "";
  const caret = document.createElement("span");
  caret.className = "model-trigger-caret";
  caret.setAttribute("aria-hidden", "true");
  caret.textContent = "▾";
  trigger.replaceChildren(text, caret);
  trigger.disabled = select.disabled;
  trigger.setAttribute("aria-label", `${select.closest("label")?.querySelector(".quick-label")?.textContent ?? ""}: ${option?.textContent ?? ""}`);
}

function openChoiceMenu(select) {
  closeModelMenu();
  closeChoiceMenu();
  const trigger = choiceTriggers.get(select);
  if (!trigger || select.disabled) return;
  if (!choiceMenu.root) {
    const root = document.createElement("div");
    root.id = "choice-menu";
    root.className = "model-menu";
    root.hidden = true;
    root.setAttribute("role", "menu");
    root.addEventListener("click", (event) => event.stopPropagation());
    document.body.append(root);
    choiceMenu.root = root;
  }
  const root = choiceMenu.root;
  root.replaceChildren();
  root.setAttribute("aria-label", select.closest("label")?.querySelector(".quick-label")?.textContent ?? t("Choices"));
  choiceMenu.items = [];
  for (const option of select.options) {
    const selected = option.value === select.value;
    const item = document.createElement("div");
    item.className = "mm-item";
    item.setAttribute("role", "menuitemradio");
    item.setAttribute("aria-checked", String(selected));
    item.setAttribute("tabindex", "-1");
    item.dataset.value = option.value;
    const tick = document.createElement("span");
    tick.className = "mm-tick";
    tick.setAttribute("aria-hidden", "true");
    tick.textContent = selected ? "✓" : "";
    const name = document.createElement("span");
    name.className = "mm-name";
    name.textContent = option.textContent;
    item.append(tick, name);
    item.addEventListener("mouseenter", () => item.focus());
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      chooseChoice(option.value);
    });
    root.append(item);
    choiceMenu.items.push(item);
  }
  choiceMenu.anchor = trigger;
  choiceMenu.select = select;
  placePanel(root, trigger.getBoundingClientRect());
  trigger.setAttribute("aria-expanded", "true");
  (choiceMenu.items.find((item) => item.getAttribute("aria-checked") === "true") ?? choiceMenu.items[0])?.focus();
}

function closeChoiceMenu({ focus = false } = {}) {
  if (!choiceMenu.select) return;
  const anchor = choiceMenu.anchor;
  choiceMenu.root.hidden = true;
  anchor?.setAttribute("aria-expanded", "false");
  choiceMenu.select = null;
  choiceMenu.anchor = null;
  if (focus) anchor?.focus();
}

function chooseChoice(value) {
  const select = choiceMenu.select;
  closeChoiceMenu({ focus: true });
  if (!select || select.value === value) return;
  select.value = value;
  renderChoiceTrigger(select);
  select.dispatchEvent(new Event("change"));
}

function onChoiceMenuKey(event) {
  if (!choiceMenu.select) return;
  const list = choiceMenu.items;
  const index = list.indexOf(document.activeElement);
  if (index < 0 && document.activeElement !== choiceMenu.anchor) return;
  const swallow = () => {
    event.preventDefault();
    event.stopPropagation();
  };
  switch (event.key) {
    case "Escape":
      swallow();
      closeChoiceMenu({ focus: true });
      return;
    case "Tab":
      closeChoiceMenu({ focus: true });
      return;
    case "ArrowDown":
      swallow();
      list[index < 0 ? 0 : (index + 1) % list.length]?.focus();
      return;
    case "ArrowUp":
      swallow();
      list[index < 0 ? list.length - 1 : (index - 1 + list.length) % list.length]?.focus();
      return;
    case "Home":
      swallow();
      list[0]?.focus();
      return;
    case "End":
      swallow();
      list[list.length - 1]?.focus();
      return;
    case "Enter":
    case " ":
      if (index < 0) return;
      swallow();
      chooseChoice(list[index].dataset.value);
      return;
    default:
      return;
  }
}

function initialiseChoiceMenus() {
  makeChoiceTrigger(el("access-mode"));
  makeChoiceTrigger(el("commit-mode"));
  document.addEventListener("keydown", onChoiceMenuKey, true);
  document.addEventListener("click", (event) => {
    if (!choiceMenu.select) return;
    if (choiceMenu.root?.contains(event.target) || choiceMenu.anchor?.contains(event.target)) return;
    closeChoiceMenu();
  });
  window.addEventListener("resize", () => closeChoiceMenu());
}

function chooseEffort(level) {
  const next = EFFORT_LEVELS.includes(String(level ?? "")) ? String(level) : "";
  writePref(EFFORT_KEY, next);
  // A choice made in a chat belongs to that chat (other chats keep theirs); one made on a
  // new chat is what the next new chat starts with.
  const thread = state.current?.kind === "rosalena" ? state.current.thread : null;
  if (thread) setChatEffort(thread, next, readPref(ULTRACODE_KEY) === "1");
  else writePref(EFFORT_DEFAULT_KEY, next || "default");
  renderModelTriggers();
  if (state.busy) toast(t("Takes effect with the next message."), "ok");
}

/** Ultracode: offered where the model takes xhigh (the Claude 5.x rows), remembered locally. */
function ultracodeOn() {
  return readPref(ULTRACODE_KEY) === "1" && availableEfforts(state.models, state.model || "").includes("xhigh");
}

/** The level a request carries: the stored one, unless this model cannot honour it. */
function effectiveEffort() {
  return clampEffort(readPref(EFFORT_KEY), availableEfforts(state.models, state.model || ""));
}

/** The composer's picker is the only control; both triggers follow the one value. */
function syncQuick() {
  const id = state.model ?? "";
  const row = state.models.find((model) => model.id === id) ?? null;
  if (quickModel) {
    quickModel.value = id;
    quickModel.title = row
      ? `${row.id}${row.note ? ` - ${row.note}` : ""}${row.cost ? ` (${row.cost})` : ""}`
      : t("Model for the next message");
  }
  renderModelTriggers();
  syncLocal();
}

/**
 * The local shelf's one control, which is really three states.
 *
 * A model that is on disk but not resident can be loaded; a model that is resident can be
 * unloaded; a model that is resident while a *different* one is selected has to be swapped.
 * Those are three different actions, so the button says which one it will do. A server that
 * is generating is not unloaded - the server refuses, and a button that cannot work should
 * say why and be disabled rather than fail on click.
 */
function syncLocal() {
  const chip = el("local-state");
  const note = el("local-note");
  const button = el("local-toggle");
  if (!chip || !note || !button) return;

  const chosen = state.model || "";
  const row = state.menu?.models?.find((model) => model.id === chosen) ?? null;
  if (!row || !chosen.toLowerCase().startsWith("local/")) {
    chip.hidden = true;
    return;
  }

  const server = state.localServer;
  const name = row.model ?? chosen.slice("local/".length);
  const loaded = server?.loaded === name || row.loaded === true;
  const busy = server?.busy === true;
  chip.hidden = false;
  button.disabled = false;

  if (!server || server.enabled === false) {
    note.textContent = t("local server: not managed");
    button.hidden = true;
    return;
  }
  button.hidden = false;

  if (server.loading) {
    note.textContent = t("{name} is loading…", { name });
    button.textContent = t("Unload");
    button.dataset.action = "unload";
    button.title = t("Stop the server while it is still loading");
    return;
  }
  if (loaded) {
    // A llama-server's context window is fixed at launch, so a bigger window in Settings
    // only takes effect by reloading it. Say so on the row instead of leaving the chat
    // silently capped at the old number (measured 2026-11-07: "stuck at 32k even when I
    // change it in the UI").
    const serveCtx = Number(server?.context) || 0;
    const wantCtx = Number(server?.planContext) || 0;
    const stale = serveCtx > 0 && wantCtx > serveCtx;
    note.textContent = busy
      ? t("{name} is generating", { name })
      : stale
        ? t("{name} is loaded at {served} tokens · Settings says {wanted}", { name, served: serveCtx.toLocaleString(), wanted: wantCtx.toLocaleString() })
        : t("{name} is loaded", { name });
    if (stale && !busy) {
      button.textContent = t("Reload");
      button.disabled = false;
      button.dataset.action = "reload";
      button.title = t("Restart it so the {tokens}-token window in Settings takes effect", { tokens: wantCtx.toLocaleString() });
      return;
    }
    button.textContent = t("Unload");
    button.disabled = busy;
    button.dataset.action = "unload";
    button.title = busy ? t("Wait for this answer to finish, then unload") : t("Stop the server and free the card");
    return;
  }
  if (server.up) {
    const other = server.loaded ?? t("another model");
    note.textContent = t("{name} holds the card", { name: other });
    button.textContent = t("Switch");
    button.disabled = busy;
    button.dataset.action = "switch";
    button.title = busy ? t("Wait for {name} to finish generating", { name: other }) : t("Unload {other} and load {name}", { other, name });
    return;
  }
  note.textContent = t("{name} is not loaded", { name });
  button.textContent = t("Load");
  button.dataset.action = "load";
  button.title = t("Start llama.cpp on {name} ({note})", { name, note: row.note ?? t("on this PC") });
}

/** Do the one thing the button promised, then re-read the server instead of assuming. */
async function toggleLocal() {
  const button = el("local-toggle");
  const action = button.dataset.action;
  const name = (state.model || "").replace(/^local\//, "");
  if (!action || !name) return;
  const label = button.textContent;
  button.disabled = true;
  button.textContent = action === "unload" ? t("Unloading…") : action === "reload" ? t("Reloading…") : t("Loading…");
  try {
    await post("/api/local", action === "reload" ? { action: "load", model: name, reload: true } : { action, model: name });
    toast(
      action === "unload" ? t("Unloaded {name}.", { name }) : action === "reload" ? t("{name} reloaded at the window in Settings.", { name }) : t("{name} is ready.", { name }),
      "ok",
    );
  } catch (err) {
    toast(err.message, "bad");
  }
  // Even a failure needs the real state back: the server may have come up and refused
  // the step, or gone down after the probe that allowed it.
  await loadHealth();
  button.textContent = label;
}

// ---------------------------------------------------------------------- starter model
//
// The welcome screen's offer: the server measures this PC and names one free local model
// it runs well (/api/starter). On a yes it downloads the runner and the model and checks
// both; this page only shows the offer, the progress, and selects the model at the end.

let starterPolling = null;
const gbText = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`);
const starterName = (name) => String(name ?? "").replace(/-Instruct$/i, "").replace(/-/g, " ");

async function loadStarter() {
  try {
    renderStarter(await api("/api/starter"));
  } catch {
    /* no offer is the safe answer when the server cannot measure the machine */
  }
}

function renderStarter(body) {
  const card = el("local-offer");
  const job = body.job;
  const running = job && ["starting", "runtime", "model"].includes(job.phase);
  if (job?.phase === "done") {
    // Only the page that watched the setup selects the model; a later reload just hides.
    // Checked before the card: opening a chat mid-download removes the welcome screen,
    // and the finish still has to land.
    if (starterPolling) void finishStarter(body);
    stopStarterPolling();
    if (card) card.hidden = true;
    return;
  }
  if (!card) return;
  if (!running && (!body.offer || body.installed || body.dismissed)) {
    stopStarterPolling();
    card.hidden = true;
    return;
  }
  const offer = body.offer;
  card.hidden = false;
  const name = starterName(offer.name);
  el("local-offer-title").textContent = t("This PC can run {name} for free", { name });
  el("local-offer-why").textContent = offer.reason;
  const total = offer.bytes + (offer.runtimeNeeded ? offer.runtimeBytes ?? 0 : 0);
  el("local-offer-size").textContent =
    (offer.runtimeNeeded
      ? t("One {size} download, the model plus the llama.cpp runner.", { size: gbText(total) })
      : t("One {size} download.", { size: gbText(total) })) +
    " " +
    t("After that it works offline and nothing you type to it leaves this PC.") +
    (offer.license ? ` ${offer.license}.` : "");

  const go = el("local-offer-go");
  const skip = el("local-offer-skip");
  const progress = el("local-offer-progress");
  if (running) {
    progress.hidden = false;
    const pct = job.total ? Math.min(100, (job.received / job.total) * 100) : 0;
    el("local-offer-fill").style.width = `${pct.toFixed(1)}%`;
    const what = job.phase === "runtime" ? t("the llama.cpp runner") : job.phase === "model" ? name : t("the download");
    el("local-offer-step").textContent = job.phase === "starting"
      ? t("Starting…")
      : t("Downloading {what}: {received} of {total} ({pct}%)", { what, received: gbText(job.received), total: gbText(job.total), pct: Math.floor(pct) });
    go.disabled = true;
    go.textContent = t("Setting up…");
    skip.textContent = t("Cancel");
    skip.dataset.action = "cancel";
    startStarterPolling();
    return;
  }
  stopStarterPolling();
  progress.hidden = !(job?.phase === "failed" || job?.phase === "cancelled");
  if (!progress.hidden) {
    el("local-offer-step").textContent = job.phase === "failed"
      ? t("The setup stopped: {error}", { error: job.error })
      : t("Cancelled. What was downloaded is kept, so it picks up where it stopped.");
  }
  go.disabled = false;
  go.textContent = job?.phase === "failed" || job?.phase === "cancelled" ? t("Resume the setup") : t("Download and set up");
  skip.textContent = t("Not now");
  skip.dataset.action = "dismiss";
}

function startStarterPolling() {
  starterPolling ??= setInterval(() => void loadStarter(), 1000);
}

function stopStarterPolling() {
  if (starterPolling) clearInterval(starterPolling);
  starterPolling = null;
}

async function finishStarter(body) {
  await loadModels();
  const target = body.installed?.target;
  const name = starterName(body.installed?.name ?? t("the local model"));
  if (target && state.models.some((model) => model.id === target)) {
    chooseModel(target);
    toast(t("{name} is set up and selected. The first message loads it, which takes a moment.", { name }), "ok");
  } else {
    toast(t("{name} is set up. Pick it from the model list under Local models.", { name }), "ok");
  }
}

function bindStarterOffer() {
  el("local-offer-go")?.addEventListener("click", async () => {
    el("local-offer-go").disabled = true;
    try {
      await post("/api/starter", { action: "install" });
      startStarterPolling();
      await loadStarter();
    } catch (err) {
      el("local-offer-go").disabled = false;
      toast(err.message, "bad");
    }
  });
  el("local-offer-skip")?.addEventListener("click", async () => {
    const action = el("local-offer-skip").dataset.action || "dismiss";
    try {
      await post("/api/starter", { action });
      if (action === "dismiss") el("local-offer").hidden = true;
      else await loadStarter();
    } catch (err) {
      toast(err.message, "bad");
    }
  });
}

/**
 * Pin a model to the chat on screen. Other chats keep their own model; the pick also
 * becomes the starting model for the next new chat.
 *
 * Only an id the menu offered gets here, so the stored value is always a chat model the
 * server just described; `resolveDefaultModel` would drop anything else on the next load.
 */
function chooseModel(value) {
  const id = String(value ?? "");
  state.model = id;
  writePref(MODEL_KEY, id);
  const thread = state.current?.thread ?? null;
  if (thread) setChatModel(thread, id);
  const row = state.models.find((model) => model.id === id) ?? null;
  state.pick = {
    id,
    tier: "stored",
    row,
    storedDropped: false,
    reason: id ? (thread ? "this chat's model" : "kept from your last choice") : state.pick?.reason ?? "",
  };
  syncQuick();
}

// ---------------------------------------------------------------------- folders
//
// A folder is a VIEW over the session list, never a container: the sessions live in the
// run store and only their assignment to a folder lives in `folders.json`. Deleting a
// folder therefore cannot delete a chat - it ungroups it - which is why this sidebar can
// be organised without any fear about what a delete does.

async function loadFolders() {
  try {
    const body = await api("/api/folders");
    state.folders = body;
    if (body.repaired) toast(t("folders.json could not be read; the folder list was reset. Your chats are untouched."), "warn");
  } catch (err) {
    toast(t("Could not load folders: {error}", { error: err.message }), "bad");
  }
}

async function folderAction(method, payload, query = "") {
  try {
    const body = await mutate(method, `/api/folders${query}`, payload);
    if (body.groups) state.folders = { ...(state.folders ?? {}), groups: body.groups };
    renderLists();
    return body;
  } catch (err) {
    toast(err.message, "bad");
    return null;
  }
}

async function moveChat(id, folderId) {
  try {
    const body = await mutate("POST", "/api/folders/move", { id, folderId });
    if (body.groups) state.folders = { ...(state.folders ?? {}), groups: body.groups };
    renderLists();
    const name = body.groups?.find((g) => g.id === folderId)?.name ?? t("Ungrouped");
    toast(t("Moved to {name}", { name }), "ok");
  } catch (err) {
    toast(t("Could not move that chat: {error}", { error: err.message }), "bad");
  }
}

/**
 * A one-line text question in the page itself. window.prompt() does nothing in the desktop
 * app (Electron does not implement it), which is why "+ Folder" and Rename never opened.
 * Resolves to the text, or null when cancelled.
 */
function askText(title, { value = "", placeholder = "", okLabel = t("OK"), multiline = false } = {}) {
  return new Promise((resolveText) => {
    const back = document.createElement("div");
    back.className = "ask-back";
    const box = document.createElement("form");
    box.className = "ask-box";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", title);
    const heading = document.createElement("p");
    heading.className = "ask-title";
    heading.textContent = title;
    const input = document.createElement(multiline ? "textarea" : "input");
    input.className = "ask-input";
    input.value = value;
    input.placeholder = placeholder;
    if (multiline) input.rows = 3;
    const actions = document.createElement("div");
    actions.className = "ask-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "mini-btn";
    cancel.textContent = t("Cancel");
    const ok = document.createElement("button");
    ok.type = "submit";
    ok.className = "mini-btn ask-ok";
    ok.textContent = okLabel;
    actions.append(cancel, ok);
    box.append(heading, input, actions);
    back.append(box);
    document.body.append(back);
    const done = (answer) => {
      back.remove();
      resolveText(answer);
    };
    cancel.onclick = () => done(null);
    back.addEventListener("pointerdown", (event) => {
      if (event.target === back) done(null);
    });
    box.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        done(null);
      }
      if (multiline && event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        done(input.value);
      }
    });
    box.addEventListener("submit", (event) => {
      event.preventDefault();
      done(input.value);
    });
    setTimeout(() => {
      input.focus();
      input.select?.();
    }, 0);
  });
}

async function newFolder() {
  const name = await askText(t("New folder"), { placeholder: t("Folder name"), okLabel: t("Create") });
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) return toast(t("A folder needs a name."), "bad");
  folderAction("POST", { name: trimmed });
}

/** The little menu a row's ⋯ opens: every folder, plus Ungrouped. */
/** Pinned chat ids, newest pin first, from the saved preferences. */
function pinnedChats() {
  return Array.isArray(prefs.pinned) ? prefs.pinned : [];
}

async function setPinned(id, pin) {
  const rest = pinnedChats().filter((other) => other !== id);
  const next = pin ? [id, ...rest] : rest;
  const before = prefs.pinned;
  prefs.pinned = next;
  renderLists();
  if (!(await savePrefs({ pinned: next }, { quiet: true }))) {
    prefs.pinned = before;
    renderLists();
    toast(t("Could not save the pin."), "bad");
  }
}

/** The right-click menu on a chat row: pin, open, move to a folder. */
function showChatMenu(event, chat) {
  document.querySelector(".move-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "move-menu";
  menu.setAttribute("role", "menu");
  const pinned = pinnedChats().includes(chat.id);
  const item = (label, action) => {
    const button = document.createElement("button");
    button.className = "move-item";
    button.setAttribute("role", "menuitem");
    button.textContent = label;
    button.onclick = () => {
      menu.remove();
      action();
    };
    menu.append(button);
    return button;
  };
  item(pinned ? t("Unpin") : t("Pin to the top"), () => void setPinned(chat.id, !pinned));
  item(t("Open"), () => openChat(chat.id));
  item(t("Move to a folder…"), () => showMoveMenu(menu.isConnected ? menu : document.body, chat.id, { x: event.clientX, y: event.clientY }));
  document.body.append(menu);
  menu.style.top = `${Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 8)}px`;
  menu.style.left = `${Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 8)}px`;
  menu.querySelector("button")?.focus();
  const close = (e) => {
    if (menu.contains(e.target)) return;
    menu.remove();
    document.removeEventListener("mousedown", close);
  };
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") menu.remove();
  });
  setTimeout(() => document.addEventListener("mousedown", close), 0);
}

function showMoveMenu(anchor, chatId, at = null) {
  document.querySelector(".move-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "move-menu";
  const groups = state.folders?.groups ?? [];
  const rows = [{ id: "ungrouped", name: t("Ungrouped") }, ...groups.filter((g) => g.id !== "ungrouped")];
  for (const group of rows) {
    const item = document.createElement("button");
    item.className = "move-item";
    item.textContent = group.name;
    item.onclick = () => {
      menu.remove();
      moveChat(chatId, group.id === "ungrouped" ? null : group.id);
    };
    menu.append(item);
  }
  document.body.append(menu);
  const rect = at ? { bottom: at.y, left: at.x } : anchor.getBoundingClientRect();
  menu.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - menu.offsetHeight - 8)}px`;
  menu.style.left = `${Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8)}px`;
  const close = (event) => {
    if (menu.contains(event.target)) return;
    menu.remove();
    document.removeEventListener("mousedown", close);
  };
  setTimeout(() => document.addEventListener("mousedown", close), 0);
}

// ------------------------------------------------------------- saved preferences
//
// The context window and which folds are closed, kept by the server in ui-prefs.json
// (GET/PUT /api/prefs). Not localStorage: the desktop app serves this page on a new port
// every launch, and a new port is a new origin with empty storage.

const prefs = {
  loaded: false,
  contextWindow: 65536,
  contextWindowDefault: 65536,
  contextWindowSaved: false,
  choices: [16384, 32768, 65536, 131072, 200000, 262144, 524288, 1048576],
  maxSteps: 100,
  maxStepsDefault: 100,
  maxStepsSaved: false,
  stepChoices: [25, 50, 100, 200, 500],
  maxMinutes: 60,
  maxMinutesSaved: false,
  minuteChoices: [15, 30, 60, 120, 0],
  collapsed: {},
};

/** 65536 -> "64K", 200000 -> "200K", 1048576 -> "1M". */
function shortTokens(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "?";
  if (n >= 1048576 && n % 1048576 === 0) return `${n / 1048576}M`;
  if (n % 1024 === 0) return `${n / 1024}K`;
  return `${Math.round(n / 1000)}K`;
}

/** Is this fold closed? Folds are saved as "closed"; `defaultFolded` folds are saved as "open". */
function isFolded(key, defaultFolded = false) {
  if (defaultFolded) return prefs.collapsed[`open:${key}`] !== true;
  return prefs.collapsed[key] === true;
}

/** Remember a fold. Painted at once; saved in the background. */
function setFolded(key, folded, defaultFolded = false) {
  const stored = defaultFolded ? `open:${key}` : key;
  const value = defaultFolded ? !folded : folded;
  if (value) prefs.collapsed[stored] = true;
  else delete prefs.collapsed[stored];
  void savePrefs({ collapsed: { [stored]: value } }, { quiet: true });
}

function applyPrefs(body) {
  if (!body || typeof body !== "object") return;
  if (Number.isFinite(body.contextWindow)) prefs.contextWindow = body.contextWindow;
  if (Number.isFinite(body.contextWindowDefault)) prefs.contextWindowDefault = body.contextWindowDefault;
  prefs.contextWindowSaved = Boolean(body.contextWindowSaved);
  if (Array.isArray(body.contextWindowChoices) && body.contextWindowChoices.length) prefs.choices = body.contextWindowChoices;
  if (Number.isFinite(body.maxSteps)) prefs.maxSteps = body.maxSteps;
  if (Number.isFinite(body.maxStepsDefault)) prefs.maxStepsDefault = body.maxStepsDefault;
  prefs.maxStepsSaved = Boolean(body.maxStepsSaved);
  if (Array.isArray(body.maxStepsChoices) && body.maxStepsChoices.length) prefs.stepChoices = body.maxStepsChoices;
  if (Number.isFinite(body.maxMinutes)) prefs.maxMinutes = body.maxMinutes;
  if (typeof body.accessMode === "string") prefs.accessMode = body.accessMode;
  if (typeof body.toolLoading === "string") prefs.toolLoading = body.toolLoading;
  if (typeof body.queueMode === "string") prefs.queueMode = body.queueMode;
  if ("setup" in body) prefs.setup = body.setup ?? null;
  if (Array.isArray(body.pinned)) prefs.pinned = body.pinned;
  prefs.sandbox = body.sandbox === true;
  prefs.desktop = body.desktop === true;
  prefs.desktopSupport = body.desktopSupport !== false;
  if (body.sandboxSupport) prefs.sandboxSupport = body.sandboxSupport;
  prefs.maxMinutesSaved = Boolean(body.maxMinutesSaved);
  if (Array.isArray(body.maxMinutesChoices) && body.maxMinutesChoices.length) prefs.minuteChoices = body.maxMinutesChoices;
  if (body.collapsed && typeof body.collapsed === "object") prefs.collapsed = { ...body.collapsed };
  // Settings > Notifications and Settings > Generation.
  if (body.notify && typeof body.notify === "object") Object.assign(notifyPrefs, body.notify);
  if (body.generation && typeof body.generation === "object") {
    generation.maxTokens = Number.isFinite(body.generation.maxTokens) ? body.generation.maxTokens : null;
    generation.temperature = Number.isFinite(body.generation.temperature) ? body.generation.temperature : null;
  }
  if (body.generationLimits && typeof body.generationLimits === "object") generation.limits = { ...generation.limits, ...body.generationLimits };
  takeAccount(body);
  prefs.loaded = true;
}

async function loadPrefs() {
  try {
    applyPrefs(await api("/api/prefs"));
  } catch (err) {
    // The defaults above still work; only remembering is lost.
    console.warn(`could not read saved preferences: ${err.message}`);
  }
  paintContextWindowUI();
  paintStepsUI();
  paintMinutesUI();
  paintToolLoading();
  paintSandbox();
  paintDesktop();
  void paintAdvisor();
  void paintSolBrowser();
  paintAccess();
  void refreshCommitMode();
  paintExternalSection();
  applyAccount();
  paintShareAsk();
  maybeOfferSetup();
  // UI styles (ui-styles.js) start once the saved look is known: the first run snapshots
  // this setup as the Default style, so it has to be the real one, not the page defaults.
  if (!uiStylesStarted) {
    uiStylesStarted = true;
    initUiStyles({ snapshot: uiSnapshot, apply: applyUiSnapshot, toast, repaint: paintLayoutLabel });
    el("sb-layout")?.addEventListener("click", (event) => {
      // The page closes the menu on any click outside it; this click must not count as one.
      event.stopPropagation();
      openViewMenu(event.currentTarget);
    });
  }
}
let uiStylesStarted = false;

/** The "load tools when needed" switch: on is "on-demand", off sends every tool every time. */
function paintToolLoading() {
  const box = el("tool-loading");
  const value = el("tool-loading-value");
  const onDemand = (prefs.toolLoading ?? "on-demand") === "on-demand";
  if (box) box.checked = onDemand;
  if (value) value.textContent = onDemand ? t("when needed") : t("all, every message");
}

/** The sandbox switch, disabled with the reason when this machine has no sandbox. */
function paintSandbox() {
  const box = el("sandbox");
  const value = el("sandbox-value");
  const support = prefs.sandboxSupport ?? { available: true };
  if (box) {
    box.checked = prefs.sandbox === true;
    box.disabled = support.available === false;
  }
  if (value) value.textContent = support.available === false ? t("not available") : prefs.sandbox ? t("on") : t("off");
  if (support.available === false && el("sandbox-help")) el("sandbox-help").textContent = t("Not available on this computer: {why}.", { why: support.why ?? t("no sandbox backend found") });
}

async function setSandbox(on) {
  if (await savePrefs({ sandbox: on })) {
    prefs.sandbox = on;
    toast(on ? t("Commands now run in the sandbox: they can only write inside the project folder.") : t("Commands run with your normal permissions again."), "ok");
  }
  paintSandbox();
}

/** The desktop-control switch (src/desktop.mjs). */
function paintDesktop() {
  const box = el("desktop");
  const value = el("desktop-value");
  const supported = prefs.desktopSupport !== false;
  if (box) {
    box.checked = prefs.desktop === true;
    box.disabled = !supported;
  }
  if (value) value.textContent = !supported ? t("not available") : prefs.desktop ? t("on") : t("off");
  if (!supported && el("desktop-help")) el("desktop-help").textContent = t("Not available on this computer: desktop control is built for Windows.");
}

async function setDesktop(on) {
  if (await savePrefs({ desktop: on })) {
    prefs.desktop = on;
    toast(on ? t("Desktop control is on for new messages. Each click or keystroke asks you first unless the chat has Full access.") : t("Desktop control is off."), "ok");
  }
  paintDesktop();
}

/** The advisor plugin's mode, through its own route. */
async function paintAdvisor() {
  try {
    const info = await api("/api/advisor");
    const box = el("advisor");
    if (box) {
      box.checked = info.mode !== "off";
      box.disabled = !info.available;
    }
    if (el("advisor-value")) el("advisor-value").textContent = info.available ? (info.mode === "off" ? t("off") : t("on")) : t("plugin off");
  } catch (err) {
    console.warn(`could not read the advisor mode: ${err.message}`);
  }
}

/** Settings > Your browser (plugins/rosa-solbrowser), through its own route. */
async function paintSolBrowser(extra = null) {
  try {
    const info = extra ?? (await api("/api/solbrowser"));
    const value = el("solbrowser-value");
    for (const id of ["solbrowser-setup", "solbrowser-check"]) if (el(id)) el(id).disabled = !info.available;
    if (value) value.textContent = !info.available ? t("plugin off") : info.connected === true ? t("connected") : info.connected === false ? t("not connected") : info.prepared ? t("extension ready") : t("not set up");
    const help = el("solbrowser-help");
    if (help && info.steps) help.textContent = `${info.steps.join(" ")} (SolBrowser ${info.version ?? ""})`;
    else if (help && info.text) help.textContent = info.text;
  } catch (err) {
    console.warn(`could not read the SolBrowser state: ${err.message}`);
  }
}

async function setUpSolBrowser() {
  try {
    const info = await mutate("POST", "/api/solbrowser/setup", {});
    toast(t("Extension copied to {folder}. Load it on your browser's extensions page.", { folder: info.folder }), "ok");
    void paintSolBrowser(info);
    return info;
  } catch (err) {
    toast(t("Could not set up SolBrowser: {error}", { error: err.message }), "bad");
    return null;
  }
}

// Same text the solbrowser plugin puts first in a result when the extension is missing.
const SOLBROWSER_NOT_CONNECTED = "[SolBrowser: your browser is not connected]";
const SOLBROWSER_DISMISSED = "rosalena.solbrowser.noPrompt";
let solBrowserOffered = false;

/**
 * The agent reached for the person's own browser and the extension is not loaded. The
 * extension is not on the Chrome Web Store yet, so it is a one-time Load unpacked: say so
 * in the chat, once per session, with the setup one click away.
 */
function offerSolBrowserSetup() {
  if (solBrowserOffered) return;
  try {
    if (localStorage.getItem(SOLBROWSER_DISMISSED) === "1") return;
  } catch {
    /* storage blocked: still offer, once */
  }
  solBrowserOffered = true;
  closeActivityGroup();
  const body = addMessage(
    "assistant",
    t("The agent tried to use your own browser, but the SolBrowser extension isn't loaded in it yet. It isn't on the Chrome Web Store yet, so you load it yourself once: Set up copies it to a folder and opens it, then you add that folder on your browser's extensions page. Until then the agent reads public pages without a browser."),
  );
  body.parentElement.classList.add("asked");
  const row = document.createElement("div");
  row.className = "ask-options";
  const button = (label, onclick) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "starter";
    b.textContent = label;
    b.onclick = onclick;
    row.append(b);
    return b;
  };
  button(t("Set up my browser"), async () => {
    const info = await setUpSolBrowser();
    if (!info?.steps) return;
    const list = document.createElement("ol");
    for (const step of info.steps) {
      const li = document.createElement("li");
      li.textContent = step;
      list.append(li);
    }
    row.replaceWith(list);
  });
  button(t("Not now"), () => row.remove());
  button(t("Don't ask again"), () => {
    try {
      localStorage.setItem(SOLBROWSER_DISMISSED, "1");
    } catch {
      /* storage blocked: this session only */
    }
    row.remove();
  });
  body.append(row);
}

// --------------------------------------------------------------- first-run setup
//
// Everything optional Rosalena can download, in one window, with sizes: OmniRoute (free
// backup models, with Rosalena's own Node.js when the PC has none), the free local model
// this PC runs well, voice typing, and the person's own browser. It opens once on the
// first start (prefs.setup unset) and from Settings > General after that. It installs
// nothing itself: each item runs the same install its own page uses, one after another,
// so a step here behaves exactly like the button it stands for.

const setup = { open: false, running: false, state: null, selected: new Set(), lines: {}, results: {} };

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = (promise) => promise.catch(() => null);

/** Each item's state: ready, available (with a size), or unavailable (with why). */
async function readSetupState() {
  const [cloud, starter, voice, browser] = await Promise.all([
    settle(api("/api/cloud")),
    settle(api("/api/starter")),
    settle(api("/api/voice")),
    settle(api("/api/solbrowser")),
  ]);
  const omni = cloud?.omniroute ?? null;
  const offer = starter?.offer ?? null;
  return {
    omniroute: !omni
      ? { status: "unavailable", why: t("Its status could not be read.") }
      : omni.running
        ? { status: "ready", note: t("Running") }
        : omni.installed
          ? { status: "available", size: t("Installed: it just needs starting"), start: true }
          : omni.node
            ? { status: "available", bytes: 2e9 + (omni.node === "download" ? 4e7 : 0), size: omni.node === "download" ? t("about 2 GB, plus Node.js (40 MB) for it") : t("about 2 GB") }
            : { status: "unavailable", why: t("It needs Node.js, which Rosalena cannot fetch for this kind of PC."), getNode: true },
    local: starter?.installed
      ? { status: "ready", note: starterName(starter.installed.name ?? t("Installed")) }
      : offer
        ? { status: "available", bytes: offer.bytes + (offer.runtimeNeeded ? offer.runtimeBytes ?? 0 : 0), name: starterName(offer.name), why: offer.reason }
        : { status: "unavailable", why: t("This PC can't run a local model well (it needs a graphics card with enough memory).") },
    voice: voice?.ok
      ? { status: "ready", note: voice.model ?? t("Ready") }
      : voice?.setup
        ? { status: "available", bytes: voice.setup.bytes ?? 0, id: voice.setup.id, name: voice.setup.name }
        : { status: "unavailable", why: voice?.why ?? t("Voice typing is not available here.") },
    browser: !browser?.available
      ? { status: "unavailable", why: t("The SolBrowser plugin is switched off.") }
      : { status: "manual", prepared: Boolean(browser.prepared) },
  };
}

const SETUP_ITEMS = [
  {
    id: "omniroute",
    name: t("Free backup models (OmniRoute)"),
    recommended: true,
    about: t("Without it, Rosalena stops answering once the free tier's daily limit is used up. With it, Rosalena keeps answering and using its tools. A free gateway that runs on this PC, with its own dashboard in the sidebar."),
  },
  { id: "local", name: t("A free model on this PC"), recommended: true, about: t("Runs offline on your graphics card, with no daily limit. Nothing you type to it leaves this PC.") },
  { id: "voice", name: t("Voice typing"), about: t("Talk instead of typing: the mic button transcribes on this PC, and no audio leaves it.") },
  {
    id: "browser",
    name: t("Your own browser (SolBrowser)"),
    about: t("Lets the agent read and act in your own browser, with your logins, asking before it clicks or types. The extension isn't on the Chrome Web Store yet, so it takes one manual step."),
  },
];

function renderSetup() {
  const list = el("setup-list");
  if (!list || !setup.state) return;
  list.replaceChildren();
  let total = 0;
  for (const item of SETUP_ITEMS) {
    const info = setup.state[item.id] ?? { status: "unavailable" };
    const row = document.createElement("div");
    row.className = `setup-item${info.status === "ready" ? " is-ready" : ""}`;
    const mark = document.createElement(info.status === "available" ? "input" : "span");
    if (info.status === "available") {
      mark.type = "checkbox";
      mark.checked = setup.selected.has(item.id);
      mark.disabled = setup.running;
      mark.id = `setup-pick-${item.id}`;
      mark.addEventListener("change", () => {
        if (mark.checked) setup.selected.add(item.id);
        else setup.selected.delete(item.id);
        renderSetup();
      });
      if (mark.checked) total += info.bytes ?? 0;
    } else {
      mark.className = "setup-mark";
      mark.textContent = info.status === "ready" ? "✓" : info.status === "manual" ? "•" : "–";
    }
    const name = document.createElement(info.status === "available" ? "label" : "span");
    name.className = "setup-name";
    name.textContent = item.id === "local" && info.name ? `${item.name}: ${info.name}` : item.name;
    if (info.status === "available") name.htmlFor = mark.id;
    if (item.recommended && info.status === "available") {
      const badge = document.createElement("span");
      badge.className = "setup-badge";
      badge.textContent = t("Recommended");
      name.append(badge);
    }
    const size = document.createElement("span");
    size.className = "setup-size";
    size.textContent =
      info.status === "ready" ? (info.note ? t("Ready · {note}", { note: info.note }) : t("Ready")) : info.status === "available" ? info.size ?? (info.bytes ? gbText(info.bytes) : "") : info.status === "manual" ? t("one manual step") : t("not available");
    const about = document.createElement("div");
    about.className = "setup-about";
    about.textContent = info.status === "unavailable" ? info.why ?? item.about : item.id === "local" && info.why ? `${item.about} ${info.why}` : item.about;
    row.append(mark, name, size, about);

    const result = setup.results[item.id];
    const lineText = setup.lines[item.id] ?? (result ? result.text : "");
    if (lineText) {
      const line = document.createElement("div");
      line.className = `setup-line${result?.ok === false ? " bad" : result?.ok ? " ok" : ""}`;
      line.textContent = lineText;
      row.append(line);
    }
    if (item.id === "browser" && info.status === "manual") {
      const actions = document.createElement("div");
      actions.className = "setup-actions";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "mini-btn";
      button.textContent = info.prepared ? t("Show me the steps again") : t("Set up my browser");
      button.addEventListener("click", async () => {
        const out = await setUpSolBrowser();
        if (!out?.steps) return;
        setup.state.browser = { status: "manual", prepared: true, steps: out.steps };
        renderSetup();
      });
      actions.append(button);
      row.append(actions);
      if (info.steps) {
        const steps = document.createElement("ol");
        for (const step of info.steps) {
          const li = document.createElement("li");
          li.textContent = step;
          steps.append(li);
        }
        row.append(steps);
      }
    }
    if (info.getNode) {
      const actions = document.createElement("div");
      actions.className = "setup-actions";
      const link = document.createElement("a");
      link.className = "mini-btn";
      link.href = "https://nodejs.org/en/download";
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = t("Get Node.js ↗");
      actions.append(link);
      row.append(actions);
    }
    list.append(row);
  }
  const picked = [...setup.selected].filter((id) => setup.state[id]?.status === "available");
  const anyLeft = SETUP_ITEMS.some((item) => setup.state[item.id]?.status === "available");
  el("setup-total").textContent = setup.running
    ? t("Setting up… you can keep using Rosalena while this runs.")
    : !anyLeft
      ? t("Everything that can be downloaded here is set up.")
      : picked.length
        ? (total ? t("{n} items, about {size}. Free, one time.", { n: picked.length, size: gbText(total) }) : t("{n} items. Free, one time.", { n: picked.length }))
        : t("Nothing selected.");
  const go = el("setup-go");
  go.disabled = setup.running || !picked.length;
  go.textContent = setup.running ? t("Setting up…") : anyLeft ? t("Set up Rosalena") : t("All set");
  el("setup-later").textContent = setup.running ? t("Hide") : anyLeft ? t("Not now") : t("Close");
}

async function openSetup() {
  const overlay = el("setup-overlay");
  if (!overlay) return;
  setup.open = true;
  overlay.hidden = false;
  if (!setup.running) {
    el("setup-list").textContent = t("Checking what this PC already has…");
    setup.state = await readSetupState();
    setup.selected = new Set(SETUP_ITEMS.map((item) => item.id).filter((id) => setup.state[id]?.status === "available"));
  }
  renderSetup();
  el("setup-go")?.focus();
}

function closeSetup() {
  setup.open = false;
  const overlay = el("setup-overlay");
  if (overlay) overlay.hidden = true;
}

/** Poll `read` until `done(value)` says finished; `line(value)` is the progress text. */
async function followSetup(id, read, { done, failed, line }) {
  for (;;) {
    await wait(1500);
    const value = await settle(read());
    if (!value) continue;
    const why = failed(value);
    if (why) throw new Error(why);
    if (done(value)) return value;
    const text = line(value);
    if (text) {
      setup.lines[id] = text;
      if (setup.open) renderSetup();
    }
  }
}

const SETUP_STEPS = {
  async omniroute(info) {
    if (!info.start) {
      await post("/api/cloud", { action: "omniroute-install" });
      await followSetup("omniroute", () => api("/api/cloud"), {
        done: (body) => body.omniroute?.installed && body.omniroute?.job?.phase !== "installing",
        failed: (body) => (body.omniroute?.job?.phase === "failed" ? body.omniroute.job.error : null),
        line: (body) => body.omniroute?.job?.line ?? t("Installing OmniRoute…"),
      });
    }
    setup.lines.omniroute = t("Starting OmniRoute…");
    if (setup.open) renderSetup();
    await post("/api/cloud", { action: "omniroute-start" });
    return t("Installed and running. It also has a tab in the sidebar.");
  },
  async local() {
    await post("/api/starter", { action: "install" });
    const body = await followSetup("local", () => api("/api/starter"), {
      done: (b) => b.job?.phase === "done",
      failed: (b) => (b.job?.phase === "failed" ? b.job.error : b.job?.phase === "cancelled" ? t("cancelled") : null),
      line: (b) => (b.job?.total ? t("Downloading: {received} of {total} ({pct}%)", { received: gbText(b.job.received), total: gbText(b.job.total), pct: Math.floor((b.job.received / b.job.total) * 100) }) : t("Starting…")),
    });
    await loadModels();
    return t("Ready: pick {name} under \"Local models\" in the model list.", { name: starterName(body.installed?.name ?? t("it")) });
  },
  async voice(info) {
    const started = await post("/api/models/download", { action: "start", kind: "voice", id: info.id });
    if (started?.ok === false) throw new Error(started.error ?? t("the download did not start"));
    await followSetup("voice", () => api("/api/models/download"), {
      done: (b) => b.job?.phase === "done",
      failed: (b) => (b.job?.phase === "failed" || b.job?.phase === "cancelled" ? b.job.error ?? b.job.phase : null),
      line: (b) => (b.job?.total ? (b.job.phase === "runtime" ? t("Downloading the runner: {pct}%", { pct: Math.floor((b.job.received / b.job.total) * 100) }) : t("Downloading the speech model: {pct}%", { pct: Math.floor((b.job.received / b.job.total) * 100) })) : t("Starting…")),
    });
    return t("Ready: click the mic beside the message box, talk, click again.");
  },
};

async function runSetup() {
  if (setup.running) return;
  const picked = SETUP_ITEMS.map((item) => item.id).filter((id) => setup.selected.has(id) && setup.state?.[id]?.status === "available" && SETUP_STEPS[id]);
  if (!picked.length) return;
  setup.running = true;
  setup.results = {};
  renderSetup();
  for (const id of picked) {
    setup.lines[id] = t("Starting…");
    if (setup.open) renderSetup();
    try {
      const text = await SETUP_STEPS[id](setup.state[id]);
      setup.results[id] = { ok: true, text };
    } catch (err) {
      setup.results[id] = { ok: false, text: t("Stopped: {error}. Open setup again to retry.", { error: err.message }) };
    }
    delete setup.lines[id];
    if (setup.open) renderSetup();
  }
  setup.running = false;
  await savePrefs({ setup: "done" }, { quiet: true });
  setup.state = await readSetupState();
  setup.selected = new Set();
  if (setup.open) renderSetup();
  const failed = picked.filter((id) => setup.results[id]?.ok === false);
  toast(failed.length ? t("Setup finished, but {n} items stopped. Settings > Advanced > Open setup has the details.", { n: failed.length }) : t("Rosalena is set up."), failed.length ? "bad" : "ok");
  void loadModels();
}

function bindSetup() {
  el("setup-open")?.addEventListener("click", () => {
    toggleSettings(false);
    void openSetup();
  });
  el("setup-close")?.addEventListener("click", () => closeSetup());
  el("setup-go")?.addEventListener("click", () => void runSetup());
  el("setup-later")?.addEventListener("click", async () => {
    // During a run this only hides the window: the installs keep going.
    if (!setup.running && prefs.setup !== "done") await savePrefs({ setup: "later" }, { quiet: true });
    closeSetup();
  });
  el("setup-overlay")?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSetup();
  });
}

/** The first start: open setup once, unless it already ran or was put off. */
function maybeOfferSetup() {
  if (prefs.loaded && !prefs.setup) void openSetup();
}

async function checkSolBrowser() {
  if (el("solbrowser-value")) el("solbrowser-value").textContent = t("checking…");
  try {
    const info = await mutate("POST", "/api/solbrowser/check", {});
    toast(info.connected ? t("Your browser is connected.") : t("Your browser is not connected yet."), info.connected ? "ok" : "bad");
    void paintSolBrowser(info);
  } catch (err) {
    toast(t("Could not check SolBrowser: {error}", { error: err.message }), "bad");
    void paintSolBrowser();
  }
}

async function setAdvisor(on) {
  try {
    await mutate("PUT", "/api/advisor", { mode: on ? "changes" : "off" });
    toast(on ? t("A reviewer now checks each step that changes something.") : t("The per-step reviewer is off."), "ok");
  } catch (err) {
    toast(t("Could not change the reviewer: {error}", { error: err.message }), "bad");
  }
  void paintAdvisor();
}

async function setToolLoading(onDemand) {
  if (await savePrefs({ toolLoading: onDemand ? "on-demand" : "all" })) {
    prefs.toolLoading = onDemand ? "on-demand" : "all";
    toast(onDemand ? t("Tools now load only when a chat needs them.") : t("Every tool is now sent with every message."), "ok");
  }
  paintToolLoading();
}

async function savePrefs(patch, { quiet = false } = {}) {
  try {
    applyPrefs(await mutate("PUT", "/api/prefs", patch));
    return true;
  } catch (err) {
    if (!quiet) toast(t("Could not save that setting: {error}", { error: err.message }), "bad");
    else console.warn(`could not save a preference: ${err.message}`);
    return false;
  }
}

async function setContextWindow(value) {
  const tokens = Math.round(Number(value));
  if (!Number.isFinite(tokens) || tokens < 4096 || tokens > 2000000) {
    toast(t("Pick a context window between 4,096 and 2,000,000 tokens."), "bad");
    return;
  }
  if (await savePrefs({ contextWindow: tokens })) {
    paintContextWindowUI();
    if (modelMenu.open) renderModelMenu();
    // The server hands the new window to a running chat at its next step, and measures an
    // idle chat against it at once: the gauge is re-read now rather than after a send.
    if (state.menu) state.menu.contextWindow = tokens;
    const id = state.current?.kind === "rosalena" ? state.current.id : null;
    if (id && !state.busy) void refreshContext(id).then((meter) => {
      if (state.current?.id === id) setContext(meter);
    });
    else if (!id) setContext(null);
    toast(
      state.busy
        ? t("Context window set to {size}. The running chat uses it from its next step.", { size: shortTokens(tokens) })
        : t("Context window set to {size}.", { size: shortTokens(tokens) }),
      "ok",
    );
  }
}

async function setMaxSteps(value) {
  const steps = Math.round(Number(value));
  if (!Number.isFinite(steps) || steps < 1 || steps > 1000) {
    toast(t("Pick a step limit between 1 and 1,000."), "bad");
    return;
  }
  if (await savePrefs({ maxSteps: steps })) {
    paintStepsUI();
    toast(t("Each message can now take up to {steps} steps.", { steps }), "ok");
  }
}

const minutesText = (minutes) => (minutes === 0 ? t("No limit") : minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`);

async function setMaxMinutes(minutes) {
  if (await savePrefs({ maxMinutes: minutes })) {
    paintMinutesUI();
    toast(minutes === 0 ? t("Messages now have no time limit.") : t("Each message can now run for up to {time}.", { time: minutesText(minutes) }), "ok");
  }
}

function paintMinutesUI() {
  const value = el("minutes-value");
  if (value) value.textContent = `${minutesText(prefs.maxMinutes)}${prefs.maxMinutesSaved ? "" : ` ${t("(default)")}`}`;
  const seg = el("minutes-seg");
  if (!seg) return;
  seg.innerHTML = "";
  for (const choice of prefs.minuteChoices) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "seg-btn ctxwin-btn";
    button.setAttribute("aria-pressed", String(choice === prefs.maxMinutes));
    button.textContent = minutesText(choice);
    button.onclick = () => void setMaxMinutes(choice);
    seg.append(button);
  }
}

function paintStepsUI() {
  const current = prefs.maxSteps;
  const value = el("steps-value");
  if (value) value.textContent = `${current}${prefs.maxStepsSaved ? "" : ` ${t("(default)")}`}`;
  const seg = el("steps-seg");
  if (seg) {
    seg.innerHTML = "";
    for (const choice of prefs.stepChoices) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "seg-btn ctxwin-btn";
      button.setAttribute("aria-pressed", String(choice === current));
      button.textContent = String(choice);
      if (choice === prefs.maxStepsDefault) button.title = t("The default");
      button.onclick = () => void setMaxSteps(choice);
      seg.append(button);
    }
  }
  const input = el("steps-input");
  if (input && document.activeElement !== input) input.value = prefs.stepChoices.includes(current) ? "" : String(current);
}

function paintContextWindowUI() {
  const current = prefs.contextWindow;
  const value = el("ctxwin-value");
  if (value) value.textContent = `${shortTokens(current)}${prefs.contextWindowSaved ? "" : ` ${t("(default)")}`}`;

  const seg = el("ctxwin-seg");
  if (seg) {
    seg.innerHTML = "";
    for (const choice of prefs.choices) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "seg-btn ctxwin-btn";
      button.dataset.window = String(choice);
      button.setAttribute("aria-pressed", String(choice === current));
      button.textContent = shortTokens(choice);
      if (choice === prefs.contextWindowDefault) button.title = t("The default");
      button.onclick = () => void setContextWindow(choice);
      seg.append(button);
    }
  }
  const input = el("ctxwin-input");
  if (input && document.activeElement !== input) input.value = prefs.choices.includes(current) ? "" : String(current);

  // The slider moves over the preset stops (16K ... 1M), not raw tokens: equal steps per
  // preset read better than a linear track where everything below 256K is one sliver.
  // A custom value set in Settings is slotted in as its own stop so it is never lost.
  const slider = el("ctx-window-slider");
  if (slider) {
    const stops = ctxStops();
    slider.max = String(stops.length - 1);
    if (document.activeElement !== slider) slider.value = String(Math.max(0, stops.indexOf(current)));
    paintCtxSliderLabel();
    const scale = el("ctx-window-scale");
    if (scale) {
      scale.replaceChildren(
        ...stops.map((stop) => {
          const tick = document.createElement("span");
          tick.textContent = shortTokens(stop);
          return tick;
        }),
      );
    }
    const ticks = el("ctx-window-ticks");
    if (ticks) ticks.innerHTML = stops.map((_, i) => `<option value="${i}"></option>`).join("");
  }
}

function ctxStops() {
  const current = prefs.contextWindow;
  return prefs.choices.includes(current) ? [...prefs.choices] : [...prefs.choices, current].sort((a, b) => a - b);
}

function paintCtxSliderLabel() {
  const slider = el("ctx-window-slider");
  const out = el("ctx-window-out");
  if (!slider || !out) return;
  const tokens = ctxStops()[Number(slider.value)] ?? prefs.contextWindow;
  out.textContent = shortTokens(tokens);
  slider.setAttribute("aria-valuetext", t("{size} tokens", { size: shortTokens(tokens) }));
  out.title = tokens > 262_144 ? t("Past 256K: only models with a long window (Claude 5.x, some Gemini) take this much.") : "";
}

/** The "Other harnesses" section is one fold too, and remembers it. */
// The sidebar sections whose fold is saved: summary id -> key in the saved folds.
const SAVED_SECTIONS = [
  ["recent-label", "section:recent"],
  ["external-label", "section:external"],
];

function paintExternalSection() {
  for (const [labelId, key] of SAVED_SECTIONS) {
    const details = el(labelId)?.closest("details");
    if (details) details.open = !isFolded(key);
  }
}

function bindPrefControls() {
  el("tool-loading")?.addEventListener("change", (event) => void setToolLoading(event.target.checked));
  el("sandbox")?.addEventListener("change", (event) => void setSandbox(event.target.checked));
  el("desktop")?.addEventListener("change", (event) => void setDesktop(event.target.checked));
  el("advisor")?.addEventListener("change", (event) => void setAdvisor(event.target.checked));
  el("solbrowser-setup")?.addEventListener("click", () => void setUpSolBrowser());
  for (const button of document.querySelectorAll(".queue-mode-btn")) button.addEventListener("click", () => void setQueueMode(button.dataset.mode));
  el("queue-next")?.addEventListener("click", () => {
    queue.paused.delete(queueKey());
    void sendQueued();
  });
  el("queue-clear")?.addEventListener("click", () => {
    const key = queueKey();
    queue.items = queue.items.filter((item) => item.chat !== key);
    queue.paused.delete(key);
    renderQueue();
  });
  el("solbrowser-check")?.addEventListener("click", () => void checkSolBrowser());
  el("ctxwin-apply")?.addEventListener("click", () => void setContextWindow(el("ctxwin-input")?.value));
  el("ctxwin-input")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void setContextWindow(event.currentTarget.value);
    }
  });
  el("steps-apply")?.addEventListener("click", () => void setMaxSteps(el("steps-input")?.value));
  el("steps-input")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void setMaxSteps(event.currentTarget.value);
    }
  });
  el("ctx-window-slider")?.addEventListener("input", () => paintCtxSliderLabel());
  // Saved on release (change), not on every pixel of the drag.
  el("ctx-window-slider")?.addEventListener("change", (event) => {
    const tokens = ctxStops()[Number(event.currentTarget.value)];
    if (tokens && tokens !== prefs.contextWindow) void setContextWindow(tokens);
  });
  for (const [labelId, key] of SAVED_SECTIONS) {
    const details = el(labelId)?.closest("details");
    details?.addEventListener("toggle", () => {
      if (!prefs.loaded) return;
      if (details.open === !isFolded(key)) return;
      setFolded(key, !details.open);
    });
  }
}

// --------------------------------------------------------------- account panel
//
// The row at the bottom of the chats rail is the person using this window: their name,
// an avatar colour, how the window looks, and which parts of it are shown. All of it is
// kept by the server in ui-prefs.json, so it survives a restart and stays on this machine.

const ACCENT_NAMES = { cyan: t("Cyan"), violet: t("Violet"), rose: t("Rose"), green: t("Green"), amber: t("Amber") };
const SWITCH_LABELS = {
  statusbar: [t("Status bar"), t("The strip along the very bottom: runs, tokens, VPN, layout.")],
  messageMeta: [t("Model line under answers"), t("Which model answered, how fast, how many tokens.")],
  contextMeter: [t("Context gauge"), t("How full the conversation is, next to the composer.")],
  otherHarnesses: [t("Other harnesses"), t("Sessions from Claude Code, OpenCode and others in the chats list.")],
  inspector: [t("Files panel"), t("The file tree on the right.")],
};
const LABEL = (value) => String(value).charAt(0).toUpperCase() + String(value).slice(1);
// The look choices on screen; the values themselves stay English (they are what is saved).
const LOOK_NAMES = { auto: t("Auto"), dark: t("Dark"), light: t("Light"), small: t("Small"), normal: t("Normal"), large: t("Large"), comfortable: t("Comfortable"), compact: t("Compact"), petrol: t("Petrol"), midnight: t("Midnight"), graphite: t("Graphite"), dusk: t("Dusk"), forest: t("Forest"), mocha: t("Mocha") };
const LOOK_LABEL = (value) => LOOK_NAMES[value] ?? LABEL(value);
// Each palette's dark background and raised surface, for the picker's swatches (themes.css).
const PALETTE_SWATCH = {
  petrol: ["#0b1d26", "#204550"],
  midnight: ["#0d0e10", "#222328"],
  graphite: ["#17181b", "#30323a"],
  nord: ["#242933", "#3b4252"],
  dusk: ["#14111f", "#2e2744"],
  forest: ["#0f1a15", "#24392f"],
  mocha: ["#1a1614", "#362d27"],
};

const account = {
  profile: { name: "", color: "cyan" },
  appearance: { theme: "auto", palette: "petrol", accent: "cyan", textSize: "normal", density: "comfortable" },
  show: { statusbar: true, messageMeta: true, contextMeter: true, otherHarnesses: true, inspector: true },
  choices: { accents: Object.keys(ACCENT_NAMES), textSizes: ["small", "normal", "large"], densities: ["comfortable", "compact"], themes: ["auto", "dark", "light"], palettes: Object.keys(PALETTE_SWATCH) },
  // Early-build tracking (harness/src/telemetry.mjs): what this install sends to the site.
  sharing: "full",
  sharingChoices: ["full", "usage", "off"],
  // False during early access (always full); true makes it the person's pick, and
  // sharingChosen is false until they have.
  sharingOptional: false,
  sharingChosen: true,
  installId: null,
};

const SHARING_LABELS = { full: t("On (default)"), usage: t("Numbers only"), off: t("Off") };
const SHARING_EARLY_ACCESS =
  t("Early access: Rosalena sends usage numbers and the messages of chats on Rosalena cloud models, so bugs and bad answers can be fixed. Chats on local models are never sent, only usage numbers and the first line of any error.");
const SHARING_HELP = {
  full: t("On by default: for chats on cloud models, sends the task, the answer, the model, tokens, errors and a short trace of each step, with keys and passwords scrubbed out. Chats on local models never leave this PC (numbers and errors only)."),
  usage: t("Sends numbers only: how many chats, tokens, timings, models and errors. No tasks, answers or traces."),
  off: t("Sends only how many tokens your chats used on Rosalena's free cloud models, so one install can't drain the free tier for everyone. No words, no model, nothing about your own keys or local models. Reports you make under an answer stay on this computer."),
};

function takeAccount(body) {
  if (typeof body?.sharing === "string") account.sharing = body.sharing;
  if (Array.isArray(body?.sharingChoices)) account.sharingChoices = body.sharingChoices;
  if ("sharingOptional" in (body ?? {})) account.sharingOptional = Boolean(body.sharingOptional);
  if ("sharingChosen" in (body ?? {})) account.sharingChosen = Boolean(body.sharingChosen);
  if ("installId" in (body ?? {})) account.installId = body.installId ?? null;
  if (body?.profile) account.profile = { ...account.profile, ...body.profile };
  if (body?.appearance) account.appearance = { ...account.appearance, ...body.appearance };
  if (body?.show) account.show = { ...account.show, ...body.show };
  if (body?.choices) account.choices = { ...account.choices, ...body.choices };
}

/** Put the saved look and switches on <html>, where styles.css reads them. */
function applyAccount() {
  const root = document.documentElement;
  const { appearance, show, profile } = account;
  if (root.dataset.theme !== appearance.theme) {
    root.dataset.theme = appearance.theme;
    paintThemeButton();
  }
  root.dataset.accent = appearance.accent;
  root.dataset.palette = appearance.palette ?? "petrol";
  root.dataset.text = appearance.textSize;
  root.dataset.density = appearance.density;
  for (const key of Object.keys(SWITCH_LABELS)) root.toggleAttribute(`data-hide-${key.toLowerCase()}`, show[key] === false);

  const name = profile.name.trim();
  const initial = (name || "R").charAt(0).toUpperCase();
  const nameEl = el("account-name");
  if (nameEl) {
    nameEl.textContent = name || t("Add your name");
    nameEl.classList.toggle("unset", !name);
  }
  if (el("account-initial")) el("account-initial").textContent = initial;
  if (el("acct-avatar-lg")) el("acct-avatar-lg").textContent = initial;
  for (const avatar of [el("account-avatar"), el("acct-avatar-lg")]) if (avatar) avatar.dataset.color = profile.color;
}

async function saveAccount(patch) {
  // Paint first, save after: a switch should move when it is clicked, not a round trip later.
  takeAccount(patch);
  applyAccount();
  paintAccountPanel();
  const ok = await savePrefs(patch);
  if (!ok) {
    // The server refused or could not be reached: show what is actually saved.
    try {
      takeAccount(await api("/api/prefs"));
    } catch {
      /* keep the painted state; the toast already said it was not saved */
    }
    applyAccount();
    paintAccountPanel();
  }
}

// Style Lab (a sidebar plugin with the "appearance" permission) edits these same settings
// through plugin-host.js, so the look lives in one place with its live preview. Only the
// look and the window parts: the name, avatar and sharing stay in the account popover.
window.rosalenaAppearance = {
  get: () => ({
    appearance: { ...account.appearance },
    show: { ...account.show },
    choices: { ...account.choices },
    labels: {
      show: Object.fromEntries(Object.entries(SWITCH_LABELS).map(([key, [title, help]]) => [key, { title, help }])),
      accents: { ...ACCENT_NAMES },
      palettes: Object.fromEntries(Object.entries(PALETTE_SWATCH).map(([name, [base, raised]]) => [name, { base, raised }])),
    },
  }),
  set: async (patch) => {
    const next = {};
    const look = patch?.appearance ?? {};
    const pick = {};
    if (account.choices.themes.includes(look.theme)) pick.theme = look.theme;
    if ((account.choices.palettes ?? []).includes(look.palette)) pick.palette = look.palette;
    if (account.choices.accents.includes(look.accent)) pick.accent = look.accent;
    if (account.choices.textSizes.includes(look.textSize)) pick.textSize = look.textSize;
    if (account.choices.densities.includes(look.density)) pick.density = look.density;
    if (Object.keys(pick).length) next.appearance = pick;
    const shows = {};
    for (const [key, value] of Object.entries(patch?.show ?? {})) if (key in SWITCH_LABELS && typeof value === "boolean") shows[key] = value;
    if (Object.keys(shows).length) next.show = shows;
    if (!Object.keys(next).length) throw new Error("nothing to change: pass appearance { theme, palette, accent, textSize, density } and/or show { ... }");
    await saveAccount(next);
    return window.rosalenaAppearance.get();
  },
};

function segButtons(host, values, current, onPick, label = LOOK_LABEL) {
  if (!host) return;
  host.innerHTML = "";
  for (const value of values) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "seg-btn acct-seg-btn";
    button.textContent = label(value);
    button.setAttribute("aria-pressed", String(value === current));
    button.onclick = () => onPick(value);
    host.append(button);
  }
}

function swatches(host, current, onPick) {
  if (!host) return;
  host.innerHTML = "";
  for (const color of account.choices.accents) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "acct-swatch";
    button.dataset.color = color;
    button.title = ACCENT_NAMES[color] ?? color;
    button.setAttribute("aria-label", ACCENT_NAMES[color] ?? color);
    button.setAttribute("aria-pressed", String(color === current));
    button.onclick = () => onPick(color);
    host.append(button);
  }
}

function paintAccountPanel() {
  const input = el("acct-name");
  if (input && document.activeElement !== input) input.value = account.profile.name;
  swatches(el("acct-colors"), account.profile.color, (color) => void saveAccount({ profile: { color } }));
  swatches(el("acct-accents"), account.appearance.accent, (accent) => void saveAccount({ appearance: { accent } }));
  segButtons(el("acct-theme"), account.choices.themes, account.appearance.theme, (theme) => void saveAccount({ appearance: { theme } }));
  const palettes = el("acct-palettes");
  if (palettes) {
    palettes.innerHTML = "";
    for (const name of account.choices.palettes ?? Object.keys(PALETTE_SWATCH)) {
      const [base, raised] = PALETTE_SWATCH[name] ?? ["#222", "#444"];
      const button = document.createElement("button");
      button.type = "button";
      button.className = "acct-palette";
      button.setAttribute("aria-pressed", String((account.appearance.palette ?? "petrol") === name));
      button.title = t("{name} palette", { name: LOOK_LABEL(name) });
      const dot = document.createElement("span");
      dot.className = "acct-palette-dot";
      dot.style.background = `linear-gradient(135deg, ${base} 0 55%, ${raised} 55% 100%)`;
      const label = document.createElement("span");
      label.textContent = LOOK_LABEL(name);
      button.append(dot, label);
      button.onclick = () => void saveAccount({ appearance: { palette: name } });
      palettes.append(button);
    }
  }
  segButtons(el("acct-text"), account.choices.textSizes, account.appearance.textSize, (textSize) => void saveAccount({ appearance: { textSize } }));
  segButtons(el("acct-density"), account.choices.densities, account.appearance.density, (density) => void saveAccount({ appearance: { density } }));
  // The switch only exists once sharing is a choice; during early access it is on. Someone
  // who already chose in 0.1.4 keeps the switch, since their choice still counts.
  const canChoose = account.sharingOptional || account.sharingChosen;
  el("acct-sharing-row")?.toggleAttribute("hidden", !canChoose);
  if (canChoose) {
    segButtons(el("acct-sharing"), account.sharingChoices, account.sharing, (sharing) => void saveAccount({ sharing }), (value) => SHARING_LABELS[value] ?? LABEL(value));
  }
  const help = el("acct-sharing-help");
  const shareText = `${canChoose ? SHARING_HELP[account.sharing] ?? "" : SHARING_EARLY_ACCESS}${account.installId ? ` ${t("Install ID: {id}", { id: account.installId.slice(0, 8) })}` : ""}`;
  if (help) help.textContent = shareText;
  // Settings > Advanced carries the same switch (and the same early-access rule).
  const advShare = el("adv-sharing");
  if (advShare) {
    advShare.hidden = !canChoose;
    if (canChoose) segButtons(advShare, account.sharingChoices, account.sharing, (sharing) => void saveAccount({ sharing }), (value) => SHARING_LABELS[value] ?? LABEL(value));
  }
  if (el("adv-sharing-help")) el("adv-sharing-help").textContent = shareText;

  const list = el("acct-switches");
  if (list) {
    list.innerHTML = "";
    for (const [key, [title, help]] of Object.entries(SWITCH_LABELS)) {
      const row = document.createElement("label");
      row.className = "acct-switch-row";
      const text = document.createElement("span");
      text.className = "acct-switch-text";
      const name = document.createElement("span");
      name.textContent = title;
      const small = document.createElement("small");
      small.textContent = help;
      text.append(name, small);
      const input = document.createElement("input");
      input.type = "checkbox";
      input.className = "switch";
      input.checked = account.show[key] !== false;
      input.onchange = () => void saveAccount({ show: { [key]: input.checked } });
      row.append(text, input);
      list.append(row);
    }
  }
}

function toggleAccountPanel(open) {
  const panel = el("account-panel");
  const button = el("account");
  if (!panel || !button) return;
  const next = open ?? panel.hidden;
  panel.hidden = !next;
  button.setAttribute("aria-expanded", String(next));
  if (next) {
    // One popover at a time in the sidebar foot.
    el("more-drawer")?.setAttribute("hidden", "");
    el("more-open")?.setAttribute("aria-expanded", "false");
    paintAccountPanel();
  }
}

function bindAccount() {
  el("account")?.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleAccountPanel();
  });
  const input = el("acct-name");
  let timer = null;
  const commit = () => {
    clearTimeout(timer);
    const name = input.value.trim();
    if (name === account.profile.name) return;
    void saveAccount({ profile: { name } });
  };
  input?.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(commit, 600);
  });
  input?.addEventListener("change", commit);
  input?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
      input.blur();
    }
  });
  el("acct-settings")?.addEventListener("click", (event) => {
    // Without this the same click reached the document's "click outside closes Settings"
    // handler and shut the panel it had just opened, so the button seemed to do nothing.
    event.stopPropagation();
    toggleAccountPanel(false);
    toggleSettings(true);
  });
  el("acct-style")?.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleAccountPanel(false);
    openPlugin("rosa-style-lab");
  });
  el("sb-hide")?.addEventListener("click", () => {
    void saveAccount({ show: { statusbar: false } });
    toast(t("Status bar hidden. Turn it back on in Style Lab (your account menu, bottom left > Style Lab)."), "ok");
  });
  document.addEventListener("pointerdown", (event) => {
    const panel = el("account-panel");
    if (!panel || panel.hidden) return;
    if (panel.contains(event.target) || el("account")?.contains(event.target)) return;
    toggleAccountPanel(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !el("account-panel")?.hidden) {
      toggleAccountPanel(false);
      el("account")?.focus();
    }
  });
}

// ------------------------------------------------------------------ the working folder
//
// Shown under the composer. The desktop app can change it (a folder picker in the shell);
// a browser tab cannot, and says how. The default workspace is flagged: a run started
// there has to go hunting for the project it was asked about, which is how it gets lost.
const DEFAULT_WORKSPACE = /[\\/]Rosalena Harness[\\/]workspace[\\/]?$/i;

function paintWorkspace(path) {
  const button = el("workspace");
  if (!button) return;
  const isDefault = DEFAULT_WORKSPACE.test(path);
  button.classList.toggle("ws-default", isDefault);
  button.textContent = isDefault ? t("No project folder · choose one") : path;
  const canPick = typeof window.rosalenaDesktop?.pickWorkspace === "function";
  button.title = isDefault
    ? t("Working in the default folder ({path}). Pick your project folder so the agent starts where your files are.", { path })
    : t("This chat works in {path}\nClick to choose another folder for this chat.", { path });
  // The Commits menu is per folder: show (and change) the one this chat works in.
  if (path !== state.commitFolder) {
    state.commitFolder = path;
    void refreshCommitMode();
  }
}

// Each chat has its own folder. A new chat that has not been sent yet holds its pick in
// `pendingWorkspace`; the first message carries it, and the server keeps it from then on.
state.launchWorkspace = "";
state.chatWorkspace = "";
state.pendingWorkspace = "";

function currentWorkspace() {
  return state.chatWorkspace || state.pendingWorkspace || state.launchWorkspace || state.workspace || "";
}

/** The Files panel, Show in File Explorer and the terminal ask for the chat's folder. */
function withChatScope(path) {
  if (!String(path).startsWith("/api/files")) return path;
  const join = path.includes("?") ? "&" : "?";
  const thread = state.current?.thread;
  if (thread) return `${path}${join}chat=${encodeURIComponent(thread)}`;
  if (state.pendingWorkspace) return `${path}${join}root=${encodeURIComponent(state.pendingWorkspace)}`;
  return path;
}

function resetFilesPanel() {
  try {
    const mounted = inspector.mounted.files;
    if (!mounted) return;
    try {
      mounted.destroy?.();
    } catch {
      /* a panel that fails to clean up is replaced anyway */
    }
    delete inspector.mounted.files;
    document.querySelector('[data-insp-slot="files"]')?.replaceChildren();
    if (layout.tab === "files") void mountInspectorTab("files");
  } catch {
    /* the inspector is not set up yet */
  }
}

/** Show the folder of the chat on screen everywhere that names one. */
function setChatWorkspace(folder) {
  const before = currentWorkspace();
  state.chatWorkspace = folder || "";
  if (!state.current) state.chatWorkspace = "";
  else state.pendingWorkspace = "";
  paintWorkspace(currentWorkspace());
  if (currentWorkspace() !== before || state.filesScope !== (state.current?.thread ?? "draft")) {
    state.filesScope = state.current?.thread ?? "draft";
    resetFilesPanel();
  }
  try {
    termSwitchChat();
  } catch {
    /* the terminal is not set up yet */
  }
  try {
    paintReveal();
  } catch {
    /* nor the reveal button */
  }
  rail?.chatChanged();
}

async function chooseWorkspace() {
  const desktop = window.rosalenaDesktop;
  let folder = "";
  try {
    folder = typeof desktop?.pickFolder === "function"
      ? (await desktop.pickFolder()) ?? ""
      : (await askText(t("Folder for this chat (full path)"), { value: currentWorkspace(), okLabel: t("Use this folder") })) ?? "";
  } catch (err) {
    toast(t("Could not open the folder picker: {error}", { error: err.message }), "bad");
    return;
  }
  folder = String(folder).trim();
  if (!folder || folder === currentWorkspace()) return;
  const thread = state.current?.thread;
  try {
    if (thread) {
      const out = await api("/api/chat/workspace", {
        method: "PUT",
        headers: { "content-type": "application/json", "x-rosalena-token": TOKEN },
        body: JSON.stringify({ chat: thread, path: folder }),
      });
      setChatWorkspace(out.workspace);
    } else {
      // Not sent yet: the server checks the folder exists, and the first message carries it.
      const out = await api(`/api/files?path=&root=${encodeURIComponent(folder)}`, { headers: { "x-rosalena-token": TOKEN } });
      state.pendingWorkspace = out.root || folder;
      setChatWorkspace("");
    }
    toast(t("This chat now works in {path}. Other chats keep their own folder.", { path: currentWorkspace() }), "ok");
  } catch (err) {
    toast(t("Could not use that folder: {error}", { error: err.message }), "bad");
  }
}
el("workspace")?.addEventListener("click", () => void chooseWorkspace());

// ------------------------------------------------------------- access and plan mode
//
// The Access menu is saved (it is how this person wants to work); Plan is for the next
// message only, because a plan is about one task.

state.planMode = false;
state.runId = null;

function paintAccess() {
  const select = el("access-mode");
  if (select && prefs.accessMode) select.value = prefs.accessMode;
  if (select) renderChoiceTrigger(select);
  const plan = el("plan-toggle");
  if (plan) plan.setAttribute("aria-pressed", String(state.planMode));
  prompt.placeholder = state.planMode
    ? t("Plan mode: describe the task. It investigates read-only and asks you to approve a plan before changing anything.")
    : isCreatorOn()
      ? t("Creator mode: describe the plugin you want (a tool, a viewer, a game, a theme). It is verified in a sandbox before it is installed.")
      : t("Send a message…  (Enter to send, Shift+Enter for a new line, / for commands)");
  paintOptsChip();
  rail?.repaint();
}

el("access-mode")?.addEventListener("change", async (event) => {
  const value = event.currentTarget.value;
  if (await savePrefs({ accessMode: value })) {
    prefs.accessMode = value;
    const words = {
      full: t("Full access: it can do anything except what an approval rule asks about."),
      workspace: t("Workspace write: it can change files in this folder; anything outside asks you first."),
      auto: t("Auto: like Workspace write, but a reviewer model decides what would have asked you. After 3 refusals in a row it asks you again."),
      read: t("Read only: it can look but not change anything."),
    };
    toast(words[value] ?? value, "ok");
  }
});
el("plan-toggle")?.addEventListener("click", () => {
  state.planMode = !state.planMode;
  paintAccess();
});

// ------------------------------------------------------------------ goal mode
//
// null = not chosen (the server decides: "/goal", "Goal mode. ...", or a goal chat's
// follow-up), true = on, false = switched off by hand for this chat.
state.goalMode ??= null;

function paintGoal() {
  const button = el("goal-toggle");
  if (!button) return;
  const on = state.goalMode === true;
  button.setAttribute("aria-pressed", String(on));
  button.title = on
    ? t("Goal mode is on: it keeps going, task after task, until the goal is recorded done or it needs you. Click to turn it off for this chat.")
    : t("Goal mode: it keeps going on its own, task after task, until the whole goal is done and verified, or it needs something only you can give it");
}

el("goal-toggle")?.addEventListener("click", () => {
  state.goalMode = state.goalMode === true ? false : true;
  paintGoal();
  toast(
    state.goalMode
      ? t("Goal mode on: it works through every item, round after round, until the goal is done or it needs you.")
      : t("Goal mode off for this chat."),
    "ok",
  );
});
paintGoal();

// ------------------------------------------------------------------ MCP servers
//
// The composer's MCP button: every MCP server the agent can call through the mcp-manager
// plugin, with a switch each. The server writes the same registry the plugin's tools read,
// so a switch counts for the very next call, running chats included.

const mcp = { open: false, data: null, busy: new Set() };

function mcpWorkspaceQuery() {
  const folder = typeof currentWorkspace === "function" ? currentWorkspace() : "";
  return folder ? `?workspace=${encodeURIComponent(folder)}` : "";
}

async function loadMcp() {
  try {
    mcp.data = await api(`/api/mcp${mcpWorkspaceQuery()}`);
  } catch (err) {
    mcp.data = { error: err.message, servers: [], claudeCode: [] };
  }
  paintMcp();
}

async function mcpAction(payload, label) {
  mcp.busy.add(payload.name ?? "*");
  paintMcp();
  try {
    const body = await post(`/api/mcp${mcpWorkspaceQuery()}`, payload);
    mcp.data = body;
    if (body.probe) toast(body.probe.ok ? t("{name}: answered, {count} tool(s).", { name: body.probe.name, count: body.probe.tools }) : t("{name} did not answer: {error}", { name: body.probe.name, error: body.probe.error }), body.probe.ok ? "ok" : "bad");
    else if (body.imported) toast(body.imported.added.length ? t("Added {names} (off until you switch them on).", { names: body.imported.added.join(", ") }) : t("Nothing new to add."), "ok");
    else if (label) toast(label, "ok");
  } catch (err) {
    toast(err.message, "bad");
  } finally {
    mcp.busy.delete(payload.name ?? "*");
    paintMcp();
  }
}

function paintMcp() {
  const data = mcp.data;
  const servers = data?.servers ?? [];
  const on = servers.filter((s) => s.enabled).length;
  const count = el("mcp-count");
  if (count) count.textContent = servers.length ? `${on}/${servers.length}` : "";
  const note = el("mcp-note");
  if (note) {
    const off = data && data.available === false;
    note.classList.toggle("bad", Boolean(data?.error || off));
    note.textContent = data?.error
      ? t("Could not read the MCP list: {error}", { error: data.error })
      : off
        ? t("The MCP plugin (mcp-manager) is switched off on the Plugins page, so models cannot reach these servers until it is on.")
        : t("Switches apply right away, chats that are running included.");
  }
  const list = el("mcp-list");
  if (list) {
    if (!servers.length) {
      const empty = document.createElement("li");
      empty.className = "mcp-empty";
      empty.textContent = t("No MCP servers yet. Add one below, or bring in the ones Claude Code has.");
      list.replaceChildren(empty);
    } else {
      list.replaceChildren(
        ...servers.map((server) => {
          const li = document.createElement("li");
          li.className = "mcp-row";
          const name = document.createElement("span");
          name.className = "mcp-name";
          name.textContent = server.name;
          const actions = document.createElement("span");
          actions.className = "mcp-actions";
          const check = document.createElement("button");
          check.type = "button";
          check.className = "mcp-link";
          check.textContent = mcp.busy.has(server.name) ? t("checking…") : t("Check");
          check.disabled = mcp.busy.has(server.name) || !server.enabled;
          check.title = server.enabled ? t("Start it once and count its tools") : t("Turn it on to check it");
          check.onclick = () => void mcpAction({ action: "probe", name: server.name });
          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "mcp-link";
          remove.textContent = t("Remove");
          remove.onclick = () => {
            if (confirm(t("Remove the MCP server \"{name}\" from Rosalena? (Its program is not touched.)", { name: server.name }))) void mcpAction({ action: "remove", name: server.name }, t("{name} removed.", { name: server.name }));
          };
          const sw = document.createElement("label");
          sw.className = "mcp-switch";
          sw.title = server.enabled ? t("On: models can call it. Click to turn it off.") : t("Off: models cannot call it. Click to turn it on.");
          const input = document.createElement("input");
          input.type = "checkbox";
          input.checked = server.enabled;
          input.disabled = Boolean(server.invalid) || mcp.busy.has(server.name);
          input.setAttribute("aria-label", (server.enabled ? t("{name} on", { name: server.name }) : t("{name} off", { name: server.name })));
          input.onchange = () => void mcpAction({ action: "toggle", name: server.name, enabled: input.checked }, (input.checked ? t("{name} is on.", { name: server.name }) : t("{name} is off.", { name: server.name })));
          sw.append(input, document.createElement("span"));
          actions.append(check, remove, sw);
          const meta = document.createElement("span");
          meta.className = "mcp-meta";
          const probe = server.probe;
          if (server.invalid) {
            meta.classList.add("bad");
            meta.textContent = t("Broken entry: {error}", { error: server.invalid });
          } else if (probe?.ok === true) {
            meta.classList.add("ok");
            meta.textContent = `${t("{count} tool(s)", { count: probe.tools ?? 0 })} · ${server.command ?? server.url ?? ""}`;
          } else if (probe?.ok === false) {
            meta.classList.add("bad");
            meta.textContent = t("Did not answer last time: {error}", { error: clip(probe.error ?? "", 120) });
          } else {
            meta.textContent = clip(server.command ?? server.url ?? "", 120);
          }
          meta.title = server.command ?? server.url ?? "";
          li.append(name, actions, meta);
          return li;
        }),
      );
    }
  }
  // Settings > MCP shows the same list with the same switches.
  paintSettingsMcp();
  rail?.mcp(data);
  const fromClaude = (data?.claudeCode ?? []).filter((s) => !s.added);
  const importBox = el("mcp-import");
  if (importBox) importBox.hidden = !fromClaude.length;
  const importList = el("mcp-import-list");
  if (importList) {
    importList.replaceChildren(
      ...fromClaude.map((server) => {
        const li = document.createElement("li");
        li.className = "mcp-row";
        const name = document.createElement("span");
        name.className = "mcp-name";
        name.textContent = server.name;
        const add = document.createElement("button");
        add.type = "button";
        add.className = "queue-act";
        add.textContent = t("Add");
        add.disabled = !server.importable;
        add.title = server.importable ? t("Add it to Rosalena, switched off") : server.reason ?? "";
        add.onclick = () => void mcpAction({ action: "import", names: [server.name], name: server.name });
        const meta = document.createElement("span");
        meta.className = "mcp-meta";
        meta.textContent = server.importable ? server.source : `${server.source} · ${server.reason}`;
        li.append(name, add, meta);
        return li;
      }),
    );
  }
}

function toggleMcpPanel(open) {
  const panel = el("mcp-panel");
  if (!panel) return;
  mcp.open = open ?? panel.hidden;
  panel.hidden = !mcp.open;
  el("mcp-toggle")?.setAttribute("aria-expanded", String(mcp.open));
  if (mcp.open) void loadMcp();
}

el("mcp-toggle")?.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleMcpPanel();
});
el("mcp-close")?.addEventListener("click", () => toggleMcpPanel(false));
// A core feature that failed to load (written as a plugin, but part of the app) is said
// once, a few seconds after start, instead of the feature quietly vanishing.
setTimeout(async () => {
  try {
    const body = await api("/api/plugins/core");
    if (body.problems?.length) {
      toast(t("A built-in feature did not load: {list}. Chats still work; the Plugins page has the details.", { list: body.problems.map((p) => `${p.id} (${clip(p.reason, 80)})`).join("; ") }), "bad");
    }
  } catch {
    /* an older server without the route: nothing to say */
  }
}, 4000);

// The Plugins page's "MCP servers" opened as its own page lands here as /?mcp=1.
{
  const url = new URL(location.href);
  if (url.searchParams.get("mcp") === "1") {
    url.searchParams.delete("mcp");
    history.replaceState(null, "", url);
    setTimeout(() => toggleMcpPanel(true), 300);
  }
}
el("more-mcp")?.addEventListener("click", (event) => {
  event.stopPropagation();
  const drawer = el("more-drawer");
  if (drawer && !drawer.hidden) el("more-open")?.click();
  setTimeout(() => toggleMcpPanel(true), 0);
});
el("mcp-panel")?.addEventListener("click", (event) => event.stopPropagation());
document.addEventListener("click", () => {
  if (mcp.open) toggleMcpPanel(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && mcp.open) toggleMcpPanel(false);
});

// ------------------------------------------------------------------ composer menus
//
// The composer's tool row keeps two menus instead of six buttons and pickers (2026-11-08):
// Mode (Plan, Goal, Creator) and the folder's options (Access, Commits, MCP). The buttons
// inside are the same elements as before, so their own handlers and state are untouched;
// the chips only read that state back (aria-pressed, the selects, the MCP count).

const composerPops = [
  { button: el("effort-btn"), menu: el("effort-menu"), render: renderEffortChipMenu },
  { button: el("mode-btn"), menu: el("mode-menu") },
  { button: el("opts-btn"), menu: el("opts-menu") },
].filter((pop) => pop.button && pop.menu);

function closeComposerPops(except = null) {
  for (const pop of composerPops) {
    if (pop === except || pop.menu.hidden) continue;
    pop.menu.hidden = true;
    pop.button.setAttribute("aria-expanded", "false");
  }
}

for (const pop of composerPops) {
  pop.button.addEventListener("click", (event) => {
    event.stopPropagation();
    const open = pop.menu.hidden;
    closeComposerPops(pop);
    if (open && mcp.open) toggleMcpPanel(false);
    if (open) pop.render?.();
    pop.menu.hidden = !open;
    pop.button.setAttribute("aria-expanded", String(open));
    if (!open) return;
    // Kept inside the window: in a narrow window the menu would run off the right edge.
    pop.menu.style.left = "";
    const box = pop.menu.getBoundingClientRect();
    const shift = Math.max(Math.min(0, window.innerWidth - 8 - box.right), 8 - box.left);
    if (shift) pop.menu.style.left = `${shift}px`;
    pop.menu.querySelector("button:not([hidden]), select:not(:disabled)")?.focus({ preventScroll: true });
  });
}
// A click anywhere else closes them; the Access and Commits pickers draw their lists in a
// menu of their own on <body>, and a pick there counts as inside.
document.addEventListener("pointerdown", (event) => {
  const target = event.target;
  if (composerPops.some((pop) => pop.menu.contains(target) || pop.button.contains(target))) return;
  if (target?.closest?.(".model-menu")) return;
  closeComposerPops();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const open = composerPops.find((pop) => !pop.menu.hidden);
  if (!open) return;
  event.preventDefault();
  closeComposerPops();
  open.button.focus({ preventScroll: true });
});
// MCP opens its own panel above the composer; the options menu steps out of its way.
el("mcp-toggle")?.addEventListener("click", () => closeComposerPops());

/** The small effort chip beside the model: the chat's level, Ultracode, hidden when none. */
function paintEffortChip() {
  const pop = el("effort-pop");
  const label = el("effort-label");
  const button = el("effort-btn");
  if (!pop || !label || !button) return;
  const efforts = availableEfforts(state.models, state.model || "");
  pop.hidden = !efforts.length;
  const level = clampEffort(readPref(EFFORT_KEY), efforts);
  const ultra = ultracodeOn();
  // "Default" carries a dim hint of what it comes to on this model: (medium), (thinking off).
  const hint = level ? "" : defaultEffortHint();
  const main = document.createTextNode(`${EFFORT_NAMES[level] ?? level}${ultra ? " · Ultra" : ""}`);
  const parts = [main];
  if (hint) parts.push(Object.assign(document.createElement("span"), { className: "effort-hint", textContent: ` (${hint})` }));
  label.replaceChildren(...parts);
  button.classList.toggle("on", Boolean(level) || ultra);
  button.title = (ultra ? t("Reasoning effort for this chat: {level}, Ultracode on. Click to change.", { level: effortName(level) }) : t("Reasoning effort for this chat: {level}. Click to change.", { level: effortName(level) }));
  const menu = el("effort-menu");
  if (menu && !menu.hidden) renderEffortChipMenu();
}

function renderEffortChipMenu() {
  const menu = el("effort-menu");
  if (!menu) return;
  const efforts = availableEfforts(state.models, state.model || "");
  const current = clampEffort(readPref(EFFORT_KEY), efforts);
  const head = document.createElement("p");
  head.className = "cmp-menu-head";
  head.textContent = t("Effort · this chat");
  const rows = [head];
  // Only the levels this model takes, so the list stays short.
  for (const level of ["", ...EFFORT_LEVELS.filter((l) => efforts.includes(l))]) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "cmp-pick";
    item.setAttribute("aria-pressed", String(level === current));
    if (level) item.textContent = effortName(level);
    else {
      const hint = defaultEffortHint();
      item.append(t("Default"));
      if (hint) item.append(Object.assign(document.createElement("span"), { className: "effort-hint", textContent: `(${hint})` }));
      item.title = defaultEffortTitle();
    }
    item.addEventListener("click", () => {
      chooseEffort(level);
      closeComposerPops();
      el("effort-btn")?.focus({ preventScroll: true });
    });
    rows.push(item);
  }
  if (efforts.includes("xhigh")) {
    const on = readPref(ULTRACODE_KEY) === "1";
    const item = document.createElement("button");
    item.type = "button";
    item.className = "cmp-pick cmp-pick-ultra";
    item.setAttribute("aria-pressed", String(on));
    item.textContent = "Ultracode";
    item.title = t("Sends at least Extra effort and has the agent split substantive tasks across parallel workers (delegate), then review the result. Uses many more tokens.");
    item.addEventListener("click", () => {
      writePref(ULTRACODE_KEY, on ? "" : "1");
      const thread = state.current?.kind === "rosalena" ? state.current.thread : null;
      if (thread) setChatEffort(thread, readPref(EFFORT_KEY), !on);
      else writePref(ULTRACODE_DEFAULT_KEY, on ? "0" : "1");
      renderModelTriggers();
      toast(on ? t("Ultracode is off.") : t("Ultracode is on: parallel workers for substantive tasks, Extra effort or higher."), "ok");
    });
    rows.push(item);
  }
  menu.replaceChildren(...rows);
}

function paintModeChip() {
  const button = el("mode-btn");
  const label = el("mode-label");
  if (!button || !label) return;
  const on = [
    ["plan-toggle", t("Plan")],
    ["goal-toggle", t("Goal")],
    ["creator-toggle", t("Creator")],
  ]
    .filter(([id]) => el(id)?.getAttribute("aria-pressed") === "true")
    .map(([, name]) => name);
  label.textContent = on.length ? on.join(" + ") : t("Mode");
  button.classList.toggle("on", on.length > 0);
  button.title = on.length ? t("On for the next message: {modes}. Click to change.", { modes: on.join(", ") }) : t("Plan, Goal and Creator modes (all off)");
}

function paintOptsChip() {
  // Inside, not a module constant: paintAccess calls this before this part of the file runs.
  const ACCESS_SHORT = { full: t("Full access"), workspace: t("Workspace"), auto: t("Auto"), read: t("Read only") };
  const button = el("opts-btn");
  const label = el("opts-label");
  if (!button || !label) return;
  const access = el("access-mode")?.value ?? "";
  const count = el("mcp-count")?.textContent.trim() ?? "";
  const commit = el("commit-pick");
  const commitShown = commit && !commit.hidden;
  // Just the access level on the chip; the MCP count is inside the menu, on its own row.
  label.textContent = ACCESS_SHORT[access] ?? t("Access");
  // Commits waiting for approval show as a dot on the chip, as they did on the old picker.
  button.classList.toggle("has-held", Boolean(commitShown && commit.classList.contains("has-held")));
  const accessText = el("access-mode")?.selectedOptions?.[0]?.textContent ?? access;
  const commitText = commitShown ? ` · ${t("Commits: {mode}", { mode: el("commit-mode")?.selectedOptions?.[0]?.textContent ?? "" })}` : "";
  button.title = `${t("Access: {access}", { access: accessText })}${commitText}${count ? ` · ${t("MCP servers on: {count}", { count })}` : ""}`;
}

{
  const watch = new MutationObserver(() => {
    paintModeChip();
    paintOptsChip();
  });
  for (const id of ["plan-toggle", "goal-toggle", "creator-toggle"]) {
    const node = el(id);
    if (node) watch.observe(node, { attributes: true, attributeFilter: ["aria-pressed"] });
  }
  const count = el("mcp-count");
  if (count) watch.observe(count, { childList: true, characterData: true, subtree: true });
  const commit = el("commit-pick");
  if (commit) watch.observe(commit, { attributes: true, attributeFilter: ["hidden", "class", "title"] });
  el("access-mode")?.addEventListener("change", paintOptsChip);
  el("commit-mode")?.addEventListener("change", paintOptsChip);
  paintModeChip();
  paintOptsChip();
}
el("mcp-add")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = el("mcp-add-name").value.trim();
  const command = el("mcp-add-command").value.trim();
  if (!name || !command) return;
  void mcpAction({ action: "add", name, command }, t("{name} added and switched on. Press Check to test it.", { name })).then(() => {
    if (mcp.data?.servers?.some((s) => s.name === name)) {
      el("mcp-add-name").value = "";
      el("mcp-add-command").value = "";
    }
  });
});
// The count on the button is worth having before the panel is ever opened.
void loadMcp();

// The Commits menu: commit-cadence's mode for this workspace. "Small: commit · Big: ask"
// is the set-it-and-leave-it setting: small verified pieces are committed as they land, and
// big or risky ones wait for one question at the end of the run.
const COMMIT_WORDS = {
  ask: t("Commits: it asks once, at the end of the task, before committing anything."),
  loose: t("Commits: small finished pieces are committed as it goes; big or risky changes wait for one question at the end."),
  autonomous: t("Commits: everything finished is committed, big changes too (secrets still stop it). It never pushes."),
  off: t("Commits: it won't commit and won't ask about committing."),
};

function paintCommitMode(info) {
  setTimeout(() => rail?.repaint(), 0);
  const pick = el("commit-pick");
  const select = el("commit-mode");
  if (!pick || !select) return;
  pick.hidden = !info?.available;
  if (!info?.available) return;
  select.value = info.mode;
  select.disabled = !info.git;
  renderChoiceTrigger(select);
  const held = info.held ? ` ${t("{count} change(s) are held back for your approval.", { count: info.held })}` : "";
  pick.title = info.git
    ? `${COMMIT_WORDS[info.mode] ?? info.mode}${held}`
    : t("This folder is not a git repository, so there is nothing to commit.");
  pick.classList.toggle("has-held", Boolean(info.held));
}

/** The Commits menu's folder: the one the chat on screen works in, not the app's default. */
const commitQuery = () => {
  const folder = currentWorkspace();
  return folder ? `?workspace=${encodeURIComponent(folder)}` : "";
};

async function refreshCommitMode() {
  try {
    paintCommitMode(await api(`/api/commit-mode${commitQuery()}`));
  } catch (err) {
    console.warn(`could not read the commit mode: ${err.message}`);
  }
}

el("commit-mode")?.addEventListener("change", async (event) => {
  const value = event.currentTarget.value;
  try {
    paintCommitMode(await mutate("PUT", `/api/commit-mode${commitQuery()}`, { mode: value }));
    toast(`${COMMIT_WORDS[value] ?? value} (${currentWorkspace() || t("this folder")})`, "ok");
  } catch (err) {
    toast(t("Could not change the commit mode: {error}", { error: err.message }), "bad");
    void refreshCommitMode();
  }
});

// ------------------------------------------------------------------ approval cards

function approvalTitle(event) {
  if (event.kind === "plan") return t("A plan is ready for your approval");
  if (event.tool === "run_command") return t("Allow this command?");
  if (event.tool === "read_file") return t("Allow reading this file?");
  return t("Allow {tool}?", { tool: String(event.tool ?? t("this action")).replace(/_/g, " ") });
}

function renderApprovalCard(event) {
  closeActivityGroup();
  const card = document.createElement("div");
  card.className = `approval-card ${event.kind === "plan" ? "is-plan" : ""}`;
  card.dataset.approval = event.id;
  const title = document.createElement("div");
  title.className = "approval-title";
  title.textContent = approvalTitle(event);
  card.append(title);
  if (event.reason) {
    const why = document.createElement("div");
    why.className = "approval-reason";
    why.textContent = t("Asking because {reason}.", { reason: event.reason });
    card.append(why);
  }
  if (event.kind === "plan") {
    const plan = document.createElement("div");
    plan.className = "approval-plan body";
    plan.innerHTML = renderMarkdown(String(event.plan ?? ""));
    card.append(plan);
  } else if (event.subject) {
    const subject = document.createElement("pre");
    subject.className = "approval-subject";
    subject.textContent = String(event.subject);
    card.append(subject);
  }
  const note = document.createElement("textarea");
  note.className = "approval-note";
  note.rows = 1;
  note.placeholder = event.kind === "plan" ? t("What should change in the plan? (optional)") : t("Why not, or what to do instead (optional)");
  const actions = document.createElement("div");
  actions.className = "approval-actions";
  const choices =
    event.kind === "plan"
      ? [
          ["allow", t("Approve plan"), "primary"],
          ["deny", t("Keep planning"), ""],
        ]
      : [
          ["allow", t("Allow once"), "primary"],
          ["always", t("Always allow in this chat"), ""],
          ["deny", t("Deny"), "danger"],
        ];
  for (const [decision, label, tone] of choices) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `approval-btn ${tone}`;
    button.textContent = label;
    button.onclick = () => void answerApproval(card, event, decision, note.value);
    actions.append(button);
  }
  card.append(note, actions);
  const status = document.createElement("div");
  status.className = "approval-status";
  card.append(status);
  log.append(card);
  follow();
  if (!render.replay) {
    setStatus(t("waiting for your approval"));
    if (document.hidden) toast(t("Rosalena is waiting for your approval."), "warn");
  }
}

async function answerApproval(card, event, decision, note) {
  if (!state.runId) return;
  for (const button of card.querySelectorAll("button")) button.disabled = true;
  try {
    await mutate("POST", "/api/approve", { id: state.runId, approval: event.id, decision, note });
    markApproval(event.id, decision);
    setStatus(t("running…"));
  } catch (err) {
    markApproval(event.id, "gone");
    toast(t("That approval could not be sent: {error}", { error: err.message }), "bad");
  }
}

function markApproval(id, decision) {
  const card = log.querySelector(`.approval-card[data-approval="${CSS.escape(String(id))}"]`);
  if (!card) return;
  card.classList.add("answered");
  for (const control of card.querySelectorAll("button, textarea")) control.disabled = true;
  const plan = card.classList.contains("is-plan");
  const words = plan
    ? { allow: t("Approved"), always: t("Approved"), deny: t("Sent back for changes"), gone: t("No longer waiting") }
    : { allow: t("Allowed"), always: t("Allowed for this chat"), deny: t("Declined"), gone: t("No longer waiting") };
  const status = card.querySelector(".approval-status");
  if (status) status.textContent = words[decision] ?? decision;
  card.dataset.decision = decision;
}

/** A finished run cannot be waiting: any card still open is stale. */
function expireApprovals() {
  for (const card of log.querySelectorAll(".approval-card:not(.answered)")) markApproval(card.dataset.approval, "gone");
}

// ------------------------------------------------------------------- todo progress

function paintTodos(todos) {
  const panel = el("todo-panel");
  const list = el("todo-list");
  if (!panel || !list) return;
  const items = (Array.isArray(todos) ? todos : []).filter((t) => t && String(t.content ?? "").trim());
  // The sidebar's Tasks tab shows the same list.
  side.todos = items;
  if (side.tab === "tasks") void renderSideTab("tasks");
  panel.hidden = items.length === 0;
  if (!items.length) return;
  const done = items.filter((t) => t.status === "completed").length;
  el("todo-count").textContent = `${done}/${items.length}`;
  el("todo-fill").style.width = `${Math.round((done / items.length) * 100)}%`;
  list.innerHTML = "";
  for (const item of items) {
    const li = document.createElement("li");
    li.className = `todo-item ${item.status}`;
    const mark = document.createElement("span");
    mark.className = "todo-mark";
    mark.textContent = item.status === "completed" ? "✓" : item.status === "in_progress" ? "◐" : "○";
    const text = document.createElement("span");
    text.textContent = String(item.content);
    li.append(mark, text);
    list.append(li);
  }
}

el("todo-head")?.addEventListener("click", () => {
  const panel = el("todo-panel");
  const open = panel.classList.toggle("collapsed");
  el("todo-head").setAttribute("aria-expanded", String(!open));
});

function todosFromToolEvent(event) {
  if (event?.name !== "todo_write" || event.ok === false) return null;
  let args = event.args;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return null;
    }
  }
  return Array.isArray(args?.todos) ? args.todos : null;
}

// ------------------------------------------------------------------------- undo

async function undoFromStep(runId, step, group) {
  if (state.busy) return toast(t("Stop the chat first, then undo."), "warn");
  if (!window.confirm(t("Undo every file change from step {step} of this message onward?", { step }))) return;
  try {
    const out = await mutate("POST", "/api/undo", { id: runId, step });
    const count = (out.restored?.length ?? 0) + (out.removed?.length ?? 0);
    toast(count ? t("Undone: {restored} file(s) restored, {removed} new file(s) removed. Changes made by shell commands are not undone.", { restored: out.restored.length, removed: out.removed.length }) : out.note, count ? "ok" : "warn");
    for (const g of log.querySelectorAll(".act-group")) {
      if (g.dataset.runId === runId && Number(g.dataset.changeStep) >= step) g.classList.add("undone");
    }
    group?.classList.add("undone");
    rail?.filesChanged();
  } catch (err) {
    toast(t("Could not undo: {error}", { error: err.message }), "bad");
  }
}

/** Called for each tool card added to a group: a file change makes the group undoable. */
function noteFileChange(group, event) {
  if (!["write_file", "edit_file"].includes(event.name) || event.ok === false || !state.runId) return;
  const step = Number(event.step) || 1;
  const first = Number(group.el.dataset.changeStep) || Infinity;
  if (step >= first) return;
  group.el.dataset.changeStep = String(step);
  group.el.dataset.runId = state.runId;
  let button = group.el.querySelector(".act-undo");
  if (!button) {
    button = document.createElement("button");
    button.type = "button";
    button.className = "act-undo";
    button.textContent = t("Undo from here");
    button.title = t("Put back every file this message changed from this point on");
    group.el.querySelector(".act-head").append(button);
  }
  const runId = state.runId;
  button.onclick = (clickEvent) => {
    clickEvent.preventDefault();
    clickEvent.stopPropagation();
    void undoFromStep(runId, Number(group.el.dataset.changeStep), group.el);
  };
}

// --------------------------------------------------------------- slash commands

const slash = { commands: [], loaded: false, open: false, index: 0, matches: [] };

async function loadSlashCommands() {
  try {
    slash.commands = (await api("/api/commands")).commands ?? [];
    slash.loaded = true;
  } catch {
    slash.commands = [];
  }
}

function parseSlash(text) {
  const match = /^\/([a-z0-9_-]+)(?:\s+([\s\S]*))?$/i.exec(String(text).trim());
  if (!match) return null;
  const command = slash.commands.find((c) => c.name === match[1].toLowerCase());
  return command ? { ...command, args: (match[2] ?? "").trim() } : null;
}

function expandSlash(template, args) {
  const words = args ? args.split(/\s+/) : [];
  const hasSlot = /\$ARGUMENTS|\$[1-9]/.test(template);
  let out = template.replace(/\$ARGUMENTS/g, args).replace(/\$([1-9])/g, (_m, n) => words[Number(n) - 1] ?? "");
  if (!hasSlot && args) out = `${out}\n\n${args}`;
  return out.trim();
}

function paintSlashMenu() {
  const menu = el("slash-menu");
  const value = prompt.value;
  const match = /^\/([a-z0-9_-]*)$/i.exec(value);
  if (!match || !slash.commands.length) {
    menu.hidden = true;
    slash.open = false;
    return;
  }
  const needle = match[1].toLowerCase();
  slash.matches = slash.commands.filter((c) => c.name.startsWith(needle) || (needle.length > 1 && c.name.includes(needle))).slice(0, 30);
  if (!slash.matches.length) {
    menu.hidden = true;
    slash.open = false;
    return;
  }
  slash.index = Math.min(slash.index, slash.matches.length - 1);
  menu.innerHTML = "";
  slash.matches.forEach((command, i) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `slash-item${i === slash.index ? " active" : ""}`;
    item.setAttribute("role", "option");
    const name = document.createElement("span");
    name.className = "slash-name";
    name.textContent = `/${command.name}`;
    const desc = document.createElement("span");
    desc.className = "slash-desc";
    desc.textContent = command.description;
    item.append(name, desc);
    if (command.source && command.source !== "built-in") item.title = command.source;
    item.onmousedown = (event) => {
      event.preventDefault();
      pickSlash(i);
    };
    menu.append(item);
  });
  menu.hidden = false;
  slash.open = true;
}

function pickSlash(i) {
  const command = slash.matches[i];
  if (!command) return;
  prompt.value = `/${command.name} `;
  el("slash-menu").hidden = true;
  slash.open = false;
  autosize();
  prompt.focus();
  if (command.action && !command.needsArgs) void send();
}

/** Arrow keys, Tab and Enter while the menu is open. Returns true when it used the key. */
function slashKey(event) {
  if (!slash.open) return false;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    slash.index = (slash.index + (event.key === "ArrowDown" ? 1 : -1) + slash.matches.length) % slash.matches.length;
    paintSlashMenu();
    return true;
  }
  if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
    event.preventDefault();
    pickSlash(slash.index);
    return true;
  }
  if (event.key === "Escape") {
    el("slash-menu").hidden = true;
    slash.open = false;
    return true;
  }
  return false;
}

prompt.addEventListener("input", paintSlashMenu);

/** A command the page does itself. */
function runSlashAction(command) {
  if (command.action === "clear") {
    newChat();
    return;
  }
  if (command.action === "help") {
    if (!log.querySelector(".msg")) log.innerHTML = "";
    addMessage("assistant", [t("Slash commands:"), "", ...slash.commands.map((c) => `- \`/${c.name}\` ${c.description}`)].join("\n"));
    return;
  }
  if (command.action === "undo") {
    const groups = [...log.querySelectorAll(".act-group[data-change-step]")].filter((g) => !g.classList.contains("undone"));
    const last = groups.at(-1);
    if (!last) return toast(t("Nothing to undo in this chat: no file was changed by a file tool."), "warn");
    const runId = last.dataset.runId;
    const first = groups.filter((g) => g.dataset.runId === runId).map((g) => Number(g.dataset.changeStep));
    void undoFromStep(runId, Math.min(...first), last);
  }
}

function bindStarters() {
  for (const button of log.querySelectorAll(".starter")) {
    button.onclick = () => {
      prompt.value = button.dataset.prompt ?? "";
      autosize();
      prompt.focus();
    };
  }
}

// ------------------------------------------------------------------ theme
//
// Three states, because a desktop app should not force a choice it can read from the
// system: Auto follows the operating system (`@media (prefers-color-scheme: light)`
// in styles.css), Dark and Light pin one. All three are remembered.
const THEMES = ["auto", "dark", "light"];

function themeMode() {
  return document.documentElement.dataset.theme || "auto";
}

function paintThemeButton() {
  const mode = themeMode();
  const button = el("theme");
  if (!button) return;
  const next = THEMES[(THEMES.indexOf(mode) + 1) % THEMES.length];
  const word = (value) => ({ auto: t("auto (theme)"), dark: t("dark (theme)"), light: t("light (theme)") })[value] ?? value;
  button.textContent = mode === "dark" ? "◑" : mode === "light" ? "○" : "◐";
  button.title = t("Theme: {mode}. Next: {next}.", { mode: word(mode), next: word(next) });
  button.setAttribute("aria-label", t("Theme: {mode}. Switch to {next}.", { mode: word(mode), next: word(next) }));
}

function applyTheme(theme) {
  const mode = THEMES.includes(theme) ? theme : "auto";
  document.documentElement.dataset.theme = mode;
  try {
    localStorage.setItem("rosalena-theme", mode);
  } catch {
    /* private mode */
  }
  paintThemeButton();
}

// ------------------------------------------------------------------ desktop shell
//
// `window.rosalenaDesktop` exists only in the Electron window, where
// desktop/preload.mjs builds it over the context bridge. In a browser it is
// undefined, and every call below is guarded: the page keeps the in-page header and
// renders no window button that could not work. That is the whole browser/desktop
// difference at this layer - the same page, the same features, one optional bridge.
const desktop = window.rosalenaDesktop ?? null;
const windowState = { resizable: true };

function paintMaximise(maximised) {
  const button = el("win-max");
  if (!button) return;
  const glyph = button.querySelector("span");
  // Windows glyphs: one square means "maximise", two overlapping squares mean "restore
  // down". The bar on the minimise button and the X on Close never change.
  if (glyph) glyph.textContent = maximised ? "❐" : "□";
  button.title = maximised ? t("Restore down") : t("Maximise");
  button.setAttribute("aria-label", maximised ? t("Restore window") : t("Maximise window"));
  button.disabled = !windowState.resizable;
}

function paintWindowButtons() {
  const max = el("win-max");
  if (max) max.disabled = !windowState.resizable;
  const value = el("resize-value");
  if (value) value.textContent = windowState.resizable ? t("on") : t("off");
  const label = el("resizable-label");
  if (label) label.textContent = windowState.resizable ? t("Drag the window edges") : t("Size locked");
}

/** Ask the shell to allow or refuse resizing; the shell owns the real flag. */
async function setWindowResizable(on) {
  windowState.resizable = Boolean(on);
  paintWindowButtons();
  try {
    localStorage.setItem("rosalena-resizable", windowState.resizable ? "on" : "off");
  } catch {
    /* private mode */
  }
  if (!desktop) return;
  try {
    await desktop.setResizable(windowState.resizable);
  } catch (err) {
    // The window is the authority. If it refused, the switch goes back rather than
    // showing a lock that is not in force.
    windowState.resizable = !windowState.resizable;
    el("resizable").checked = windowState.resizable;
    paintWindowButtons();
    toast(t("The window refused that: {error}", { error: err.message }), "bad");
  }
}

function initialiseDesktop() {
  const input = el("resizable");
  if (!desktop) {
    // Honest in a browser: the switch is real in the desktop app only, so it says so
    // instead of pretending to have locked a tab's size.
    input.disabled = true;
    input.checked = true;
    el("resizable-label").textContent = t("Desktop app only");
    el("resize-help").textContent =
      t("This page is in a browser tab, whose size belongs to the browser. The switch works in the Rosalena window.");
    el("resize-value").textContent = t("n/a");
    return;
  }

  document.documentElement.classList.add("is-desktop");
  if (desktop.platform) document.documentElement.dataset.platform = desktop.platform;

  el("win-close").onclick = () => desktop.close();
  el("win-min").onclick = () => desktop.minimise();
  el("win-max").onclick = () => desktop.maximise();
  desktop.onMaximised?.((value) => paintMaximise(Boolean(value)));
  const maximised = desktop.isMaximised?.();
  if (maximised?.then) maximised.then((value) => paintMaximise(Boolean(value))).catch(() => {});

  // The saved preference is applied through the same call the switch uses, so a
  // reload cannot leave the checkbox disagreeing with the window.
  let saved = true;
  try {
    saved = localStorage.getItem("rosalena-resizable") !== "off";
  } catch {
    /* private mode */
  }
  input.checked = saved;
  input.onchange = () => setWindowResizable(input.checked);
  void setWindowResizable(saved);

  const currentState = desktop.getResizable?.();
  if (currentState?.then) {
    currentState
      .then((current) => {
        if (typeof current !== "boolean" || current === windowState.resizable) return;
        // The shell was started locked (or changed outside this page): follow it rather
        // than fighting it.
        input.checked = current;
        void setWindowResizable(current);
      })
      .catch(() => {});
  }
}

// ------------------------------------------------------------------ settings
//
// A dialog over the window with a grouped menu (settings section further down). Escape,
// a click on the scrim, the close button or the gear itself closes it; focus goes back to
// what had it before.
let settingsReturnFocus = null;
// phone.js opens Settings > Phone access from its panel, and closes Settings for "Show QR code".
window.rosalenaSettings = {
  open(page) {
    toggleSettings(true);
    if (page) showSettingsPage(page, { focusTab: true });
  },
  close() {
    toggleSettings(false);
  },
};

function toggleSettings(open) {
  const panel = el("settings-panel");
  const button = el("settings");
  const next = open ?? panel.hidden;
  if (next === !panel.hidden) {
    if (next) loadSettingsPage(currentSettingsPage(), { force: true });
    return;
  }
  panel.hidden = !next;
  el("settings-scrim").hidden = !next;
  button.setAttribute("aria-expanded", next ? "true" : "false");
  if (!next) {
    clearSettingsSearch();
    const back = settingsReturnFocus;
    settingsReturnFocus = null;
    if (back && document.contains(back)) back.focus({ preventScroll: true });
    return;
  }
  settingsReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  updateRateCounter();
  paintAccountPanel();
  settingsSearch.primed = false;
  // Opening re-reads the page that is showing: the roles file or a key can have changed in
  // another window, and a stale figure is worse than a short spinner.
  loadSettingsPage(currentSettingsPage(), { force: true });
  panel.querySelector('.settings-tab[aria-selected="true"]')?.focus({ preventScroll: true });
}

// ------------------------------------------------------------------ wiring

sendBtn.onclick = send;
stopBtn.onclick = stop;
attachBtn.onclick = () => fileInput.click();
fileInput.onchange = () => {
  addFiles([...fileInput.files]);
  fileInput.value = "";
};
el("new-chat").onclick = newChat;
el("refresh-sessions").onclick = loadSessions;
el("menu").onclick = () => {
  // Narrow windows get the drawer (the CSS moves the left dock over the transcript);
  // wide ones get the dock taken away and given back, which is what the button means
  // once there is room for both.
  if (window.matchMedia("(max-width: 860px)").matches) app.classList.toggle("open");
  else app.classList.toggle("collapsed");
  paintMenuButton();
};
el("scrim").onclick = closeDrawer;
filterInput.oninput = renderLists;
el("copy-answer").onclick = () => {
  const answer = state.lastAnswer || [...log.querySelectorAll(".msg.assistant .body")].pop()?.innerText || "";
  if (!answer) return toast(t("There is no answer to copy yet."), "bad");
  copyText(answer, el("copy-answer"));
};
el("theme").onclick = () => {
  const mode = themeMode();
  const theme = THEMES[(THEMES.indexOf(mode) + 1) % THEMES.length];
  applyTheme(theme);
  // Saved with the rest of the appearance, so it survives the new port the next launch gets.
  void saveAccount({ appearance: { theme } });
};

// The settings popover. The seg buttons are the render rate; the switch is the window.
el("settings").onclick = (event) => {
  event.stopPropagation();
  toggleSettings();
};
document.addEventListener("click", (event) => {
  const panel = el("settings-panel");
  if (panel.hidden) return;
  if (panel.contains(event.target) || el("settings").contains(event.target)) return;
  toggleSettings(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || el("settings-panel").hidden) return;
  // A page opened from Settings (Plugins, Models on this PC) sits on top: Esc is its.
  if (el("page-overlay") && !el("page-overlay").hidden) return;
  // First Esc empties the search, the next one closes.
  if (el("settings-search")?.value) {
    clearSettingsSearch();
    el("settings-search").focus();
    return;
  }
  toggleSettings(false);
});
for (const button of document.querySelectorAll("#settings-panel .seg-btn[data-rate]")) {
  button.onclick = () => setRenderRate(button.dataset.rate);
}

// The composer's picker persists, because the choice a person makes is about how they
// want to work, not about one chat. Its trigger is a button that opens the shared menu;
// this change handler only fires if something else drives the native select.
quickModel.onchange = () => chooseModel(quickModel.value);
el("local-toggle").onclick = toggleLocal;
el("new-folder").onclick = newFolder;
el("group-by")?.addEventListener("click", () => {
  const next = GROUP_MODES[(GROUP_MODES.indexOf(recentGrouping()) + 1) % GROUP_MODES.length];
  writePref(GROUP_KEY, next);
  renderLists();
  toast(next === "workspace" ? t("Recent is grouped by the folder each chat works in.") : next === "none" ? t("Recent is one list, newest first.") : t("Recent is grouped by your folders."), "ok");
});

// One delegated handler for every "Copy" button a rendered code block carries.
log.addEventListener("click", (event) => {
  const button = event.target.closest("[data-copy]");
  if (!button) return;
  const code = button.closest(".code-wrap")?.querySelector("pre.code code");
  if (code) copyText(code.textContent, button);
});

// Stop the transcript from yanking itself down while the user is reading history.
log.addEventListener("scroll", () => {
  state.pinned = atBottom();
  if (state.pinned) jumpBtn.hidden = true;
});
jumpBtn.onclick = () => {
  state.pinned = true;
  jumpBtn.hidden = true;
  log.scrollTop = log.scrollHeight;
};

prompt.addEventListener("input", autosize);
prompt.addEventListener("keydown", (event) => {
  if (slashKey(event)) return;
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    send();
  }
});

// Escape closes whatever is open on top first; it only stops a running chat when nothing
// was open. Judged before any handler runs (window, capture phase), since the panel's own
// handler has usually closed it by the time this one looks (bug hunt 2026-11-08: Esc on the
// MCP panel during a run also cancelled the run).
let escapeHadSurface = false;
function surfaceOpen() {
  const openIds = ["settings-panel", "mcp-panel", "ctx-panel", "account-panel", "page-overlay", "more-drawer", "run-panel", "palette", "slash-menu", "plugin-versions-menu", "mode-menu", "opts-menu", "effort-menu"];
  if (openIds.some((id) => el(id) && !el(id).hidden)) return true;
  if (document.querySelector(".ask-back, .side-menu")) return true;
  if (modelMenu.open || choiceMenu.select) return true;
  if (document.documentElement.classList.contains("side-full") || document.fullscreenElement) return true;
  if (rail?.overlayOpen()) return true;
  return Boolean(document.querySelector("#plugin-view:not([hidden]), .plugin-view:not([hidden])"));
}
window.addEventListener(
  "keydown",
  (event) => {
    if (event.key === "Escape") escapeHadSurface = surfaceOpen();
  },
  true,
);

document.addEventListener("keydown", (event) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "");
  if (event.key === "Escape") {
    if (!el("run-panel").hidden) toggleActivity(false);
    if (escapeHadSurface || event.defaultPrevented) return;
    if (state.busy) stop();
    else if (app.classList.contains("open")) app.classList.remove("open");
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    newChat();
    return;
  }
  if (event.key === "/" && !typing) {
    event.preventDefault();
    filterInput.focus();
  }
});

// Ctrl+V with an image (a screenshot, a copied picture) attaches it like a dropped file.
// Text pastes are left alone, so pasting into the prompt still works as before.
window.addEventListener("paste", (event) => {
  const items = [...(event.clipboardData?.items ?? [])];
  const images = items.filter((item) => item.kind === "file" && item.type.startsWith("image/"));
  if (!images.length) return;
  event.preventDefault();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const files = images
    .map((item, i) => {
      const file = item.getAsFile();
      if (!file) return null;
      const ext = (item.type.split("/")[1] || "png").replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "");
      const name = `pasted-${stamp}${images.length > 1 ? `-${i + 1}` : ""}.${ext}`;
      return new File([file], name, { type: file.type || item.type });
    })
    .filter(Boolean);
  if (files.length) {
    addFiles(files);
    toast((files.length === 1 ? t("Attached {name} from the clipboard.", { name: files[0].name }) : t("Attached {count} images from the clipboard.", { count: files.length })));
  }
});

// Drag and drop anywhere in the window attaches files.
let dragDepth = 0;
window.addEventListener("dragenter", (event) => {
  if (!event.dataTransfer?.types?.includes("Files")) return;
  event.preventDefault();
  dragDepth += 1;
  app.classList.add("dragging");
});
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) app.classList.remove("dragging");
});
window.addEventListener("drop", (event) => {
  event.preventDefault();
  dragDepth = 0;
  app.classList.remove("dragging");
  if (event.dataTransfer?.files?.length) addFiles([...event.dataTransfer.files]);
});

// ------------------------------------------------------------------ layout
//
// Three regions: sessions, document, inspector. `document` is the chat itself and
// stays in the centre, where a transcript belongs; the other two are panels that live
// in one of two docks (left, right) and can be dragged between them. The bottom dock and
// the Recent runs panel it held are gone: the run strip in the top bar already answers
// "what is running", and the strip cost the document a slice of every window's height.
//
// The arrangement is one object, saved under one versioned key. Loading is total: a
// value that is missing, unparsable, the wrong version, or out of range falls back
// preset-by-preset and panel-by-panel to the defaults, so a corrupt string can only
// ever cost the arrangement, never the page.
//
// That is the shape of the arrangement. The panels it arranges are the list below, and
// it holds one fewer than it used to: the "nav" rail was rebuilt into the session list,
// so a name the markup no longer has cannot be laid out and is not listed.

const LAYOUT_KEY = "rosalena-layout-v1";
// The inspector is the chat's own surface. Pinning it to the right dock is what makes
// "collapsed" its only off state: there is no arrangement in which it is not on screen.
const PINNED_PANEL = "inspector";
const LAYOUT_PANELS = ["sessions", "inspector"];
const LAYOUT_DOCKS = ["left", "right", "bottom"];
// Widths that look right at 1440x900: two 520px panels still leave 400px of transcript,
// while 240px is the narrowest a file row or a graph card stays readable in.
const DOCK_LIMITS = {
  left: { min: 240, max: 520 },
  right: { min: 240, max: 520 },
  bottom: { min: 30, max: 320 },
};
const CHAT_MIN = 340;
// The two splitter columns sit between a dock and the transcript; their pixels are part of
// the row too, so the chat's floor is only met if they are subtracted from the budget.
const SIDE_SPLITTERS = 2;
const PANEL_MIN = 30;
// Written beside the layout key rather than folded into it, so a width survives a preset
// switch and an older layout string cannot erase it.
const PANEL_WIDTHS_KEY = "rosalena-panel-widths-v1";
// Tab order is not panel layout: both tabs live in one panel, and a saved name that no
// longer exists must be dropped rather than leave a hole in the tablist.
const TAB_ORDER_KEY = "rosalena-panel-order-v1";
// Sessions live in the chats rail on the left only; the inspector is the file tree.
const INSPECTOR_TABS = ["files"];

const LAYOUT_PRESETS = {
  // Reference A: the session list over a wide inspector, with the recent-runs strip.
  // Every panel visible.
  cockpit: {
    docks: { left: { size: 292 }, right: { size: 322 }, bottom: { size: 58 } },
    tab: "files",
    panels: {
      sessions: { dock: "left", order: 0, size: 0, closed: false, collapsed: false },
      inspector: { dock: "right", order: 0, size: 0, closed: false, collapsed: false },
    },
  },
  // Reference B: sessions and a document-and-files split, a single line of status at the
  // very bottom.
  studio: {
    docks: { left: { size: 258 }, right: { size: 372 }, bottom: { size: 30 } },
    tab: "files",
    panels: {
      sessions: { dock: "left", order: 0, size: 0, closed: false, collapsed: false },
      inspector: { dock: "right", order: 0, size: 0, closed: false, collapsed: false },
    },
  },
};

const clone = (value) => JSON.parse(JSON.stringify(value));
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
const clampNum = (value, min, max, fallback) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
};
/** A saved size is accepted only inside its range; anything else is the preset default. */
const pickSize = (value, min, max, fallback, allowZero = false) => {
  if (!isNumber(value)) return fallback;
  if (value === 0 && allowZero) return 0;
  return value >= min && value <= max ? Math.round(value) : fallback;
};

/** The default arrangement for a preset, deep-cloned so callers cannot edit the source. */
function presetLayout(name) {
  const preset = LAYOUT_PRESETS[name] ?? LAYOUT_PRESETS.cockpit;
  const base = { preset: LAYOUT_PRESETS[name] ? name : "cockpit", tab: preset.tab, docks: clone(preset.docks), panels: {} };
  for (const id of LAYOUT_PANELS) base.panels[id] = clone(preset.panels[id]);
  return base;
}

/**
 * Turn anything into a usable layout. Each field is checked on its own, so one bad
 * number costs one panel's size, not the whole arrangement.
 */
function sanitiseLayout(raw) {
  const fallback = presetLayout(raw?.preset === "studio" ? "studio" : raw?.preset === "custom" ? "cockpit" : "cockpit");
  const preset = ["cockpit", "studio", "custom"].includes(raw?.preset) ? raw.preset : "cockpit";
  const layout = presetLayout(preset === "custom" ? "cockpit" : preset);
  layout.preset = preset;
  for (const dock of LAYOUT_DOCKS) {
    const limits = DOCK_LIMITS[dock];
    layout.docks[dock].size = pickSize(raw?.docks?.[dock]?.size, limits.min, limits.max, fallback.docks[dock].size);
  }
  layout.tab = "files";
  for (const id of LAYOUT_PANELS) {
    const given = raw?.panels?.[id];
    const start = fallback.panels[id];
    const pinned = id === PINNED_PANEL;
    const dock = pinned ? "right" : LAYOUT_DOCKS.includes(given?.dock) ? given.dock : start.dock;
    const limits = DOCK_LIMITS[dock];
    layout.panels[id] = {
      dock,
      order: isNumber(given?.order) && given.order >= 0 && given.order < LAYOUT_PANELS.length ? Math.round(given.order) : start.order,
      size: pickSize(given?.size, PANEL_MIN, limits.max, start.size, true),
      closed: pinned ? false : typeof given?.closed === "boolean" ? given.closed : start.closed,
      collapsed: typeof given?.collapsed === "boolean" ? given.collapsed : start.collapsed,
    };
  }
  return layout;
}

/** The last widths a person chose, or null for "use the arrangement's own". */
function readPanelWidths() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(PANEL_WIDTHS_KEY) ?? "null");
  } catch {
    saved = null;
  }
  return saved && typeof saved === "object" ? saved : null;
}

/**
 * The top bar wraps when the title is long, so its height is not a constant. The
 * narrow-window inspector is fixed to the viewport edge and would otherwise cover the
 * settings button; publishing the measured height lets the CSS start that dock below it.
 */
function publishTopbarHeight() {
  const bar = document.querySelector(".topbar");
  if (!bar) return;
  const publish = () => document.documentElement.style.setProperty("--topbar-h", `${Math.round(bar.getBoundingClientRect().height)}px`);
  publish();
  if (typeof ResizeObserver === "function") new ResizeObserver(publish).observe(bar);
}

function readLayout() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null");
  } catch {
    saved = null;
  }
  const layout = sanitiseLayout(saved);
  // A first run on a narrow window starts with the inspector railed rather than expanded:
  // an expanded inspector is a drawer there, and opening one over a 720px transcript
  // before the person has asked for it is not a default, it is an obstruction. This is a
  // starting position and is never written back, so their own choice still saves.
  if (!saved && window.matchMedia("(max-width: 860px)").matches) layout.panels.inspector.collapsed = true;
  const widths = readPanelWidths();
  if (widths) {
    for (const dock of ["left", "right"]) {
      const limits = DOCK_LIMITS[dock];
      layout.docks[dock].size = pickSize(widths[dock], limits.min, limits.max, layout.docks[dock].size);
    }
  }
  return layout;
}

function saveLayout() {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ v: 1, ...layout }));
  } catch {
    /* private mode: the arrangement lasts this page */
  }
}

function savePanelWidths() {
  try {
    localStorage.setItem(
      PANEL_WIDTHS_KEY,
      JSON.stringify({ v: 1, left: layout.docks.left.size, right: layout.docks.right.size }),
    );
  } catch {
    /* private mode: the width lasts this page */
  }
}

const layout = readLayout();
publishTopbarHeight();

const panelNode = (id) => document.querySelector(`[data-panel="${id}"]`);
// `.dock[data-dock]` only: a splitter must never answer to this selector, or a panel
// would be appended into its own handle.
const dockNode = (dock) => document.querySelector(`.dock[data-dock="${dock}"]`);
const layoutRow = el("app-row");

/** Every panel currently in a dock, in order. Closed panels are not in it. */
function dockPanels(dock) {
  return LAYOUT_PANELS.filter((id) => layout.panels[id].dock === dock && !layout.panels[id].closed).sort(
    (a, b) => layout.panels[a].order - layout.panels[b].order,
  );
}

/** Keep order values dense (0..n-1) after a move, so dragging stays predictable. */
function renumber(dock) {
  dockPanels(dock).forEach((id, index) => {
    layout.panels[id].order = index;
  });
}

/** What the splitter resizes: a dock's width/height, or a panel's size within a dock. */
function makeSplitter(kind, axis, target) {
  const node = document.createElement("div");
  node.className = `splitter ${axis}`;
  node.setAttribute("role", "separator");
  node.setAttribute("aria-orientation", axis === "vertical" ? "vertical" : "horizontal");
  node.tabIndex = 0;
  node.dataset.split = kind;
  if (target) node.dataset.target = target;
  node.title = t("Drag to resize · double-click to reset · arrow keys to nudge");
  return node;
}

/** Dock height for left/right is a width; the bottom dock's is a height. */
function dockAxis(dock) {
  return dock === "bottom" ? "height" : "width";
}

/**
 * The two side widths, solved together. Sizing them one at a time is how a right-hand drag
 * can quietly push the chat column under its floor; here the pair is scaled down around
 * the 240px minimums until both fit in `rowWidth - CHAT_MIN`. Below a 480px row there is
 * no room for two minimums, so the floors drop evenly instead of one panel disappearing.
 */
function sideWidths(rowWidth) {
  const left = layout.docks.left.size;
  const right = layout.docks.right.size;
  const budget = Math.max(0, rowWidth - CHAT_MIN - SIDE_SPLITTERS);
  if (left + right <= budget) return { left, right };
  if (budget < 2) return { left: budget, right: 0 };
  const floor = Math.min(DOCK_LIMITS.left.min, DOCK_LIMITS.right.min, Math.floor(budget / 2));
  const shrinkable = Math.max(1, left - floor + (right - floor));
  const scale = (budget - floor * 2) / shrinkable;
  let fittedLeft = Math.floor(floor + (left - floor) * scale);
  // Whole pixels, and never more than the budget: a fractional width would leave the chat
  // a half-pixel short, which is exactly the overflow this exists to prevent.
  fittedLeft = Math.max(1, Math.min(budget - 1, fittedLeft));
  return { left: fittedLeft, right: budget - fittedLeft };
}

/**
 * The size a dock can actually take right now: its wanted size, clamped so the document
 * keeps at least 340px. This is computed, never written back - a narrow window must not
 * permanently shrink an arrangement that is only too big at that moment.
 */
function dockEffective(dock) {
  if (dock === "left" || dock === "right") {
    return sideWidths(layoutRow?.clientWidth || window.innerWidth)[dock];
  }
  const limits = DOCK_LIMITS[dock];
  const rowHeight = layoutRow?.clientHeight || window.innerHeight;
  const room = rowHeight - 200;
  const max = Math.max(limits.min, Math.min(limits.max, room));
  return Math.min(max, Math.max(limits.min, layout.docks[dock].size));
}

function applyDockSize(dock) {
  const node = dockNode(dock);
  if (!node) return;
  node.style.setProperty(dock === "bottom" ? "--dock-h" : "--dock-w", `${dockEffective(dock)}px`);
}

function applyPanelSize(id) {
  const node = panelNode(id);
  const state = layout.panels[id];
  if (!node) return;
  const dock = state.dock;
  const limits = DOCK_LIMITS[dock];
  if (state.size > 0) {
    state.size = clampNum(state.size, PANEL_MIN, limits.max, state.size);
    node.dataset.grow = "0";
    node.style.flex = `0 0 ${state.size}px`;
  } else {
    node.dataset.grow = "1";
    node.style.flex = "";
  }
}

/**
 * Draw the whole shell from `layout`. Panels are appended in order, so a move is just
 * an append; splitters are rebuilt each time, so their handles always match what is on
 * screen. A dock with nothing in it is hidden rather than left as an empty column.
 */
function renderLayout() {
  for (const dock of LAYOUT_DOCKS) {
    const node = dockNode(dock);
    if (!node) continue;
    const ids = dockPanels(dock);
    node.hidden = ids.length === 0;
    node.classList.toggle("dock-is-empty", ids.length === 0);
    // Drop the panel splitters from the last render; keep anything else (rail, hint).
    node.querySelectorAll(":scope > .splitter[data-split='panel']").forEach((s) => s.remove());
    // Panels already in this dock, in this order, are not moved: moving a node reloads every
    // frame inside it (a sidebar plugin, a Browser tab's page), so collapsing the sidebar
    // would otherwise reload them all. Only a real move appends.
    const present = ids.map(panelNode).filter(Boolean);
    const inPlace = present.every((panel) => panel.parentElement === node) && [...node.children].filter((child) => present.includes(child)).every((child, i) => child === present[i]);
    ids.forEach((id, index) => {
      const panel = panelNode(id);
      if (!panel) return;
      if (inPlace) {
        panel.hidden = false;
        panel.classList.toggle("collapsed", layout.panels[id].collapsed);
        panel.dataset.dock = dock;
        applyPanelSize(id);
        if (index < ids.length - 1) panel.after(makeSplitter("panel", dock === "bottom" ? "vertical" : "horizontal", id));
        return;
      }
      node.append(panel);
      panel.hidden = false;
      panel.classList.toggle("collapsed", layout.panels[id].collapsed);
      panel.dataset.dock = dock;
      applyPanelSize(id);
      if (index < ids.length - 1) node.append(makeSplitter("panel", dock === "bottom" ? "vertical" : "horizontal", id));
    });
    // Anything closed is parked off-screen rather than deleted: its state, and the
    // modules mounted inside it, survive a close and reopen.
    applyDockSize(dock);
  }
  for (const id of LAYOUT_PANELS) {
    const node = panelNode(id);
    if (node) node.hidden = layout.panels[id].closed;
  }
  paintDockSplitters();
  paintLayoutLabel();
  paintMenuButton();
}

/** The three splitters that separate a dock from the document. */
function paintDockSplitters() {
  for (const dock of LAYOUT_DOCKS) {
    const splitter = document.querySelector(`.splitter[data-split="dock"][data-target="${dock}"]`);
    if (splitter) splitter.hidden = dockNode(dock)?.hidden !== false;
  }
}

function paintLayoutLabel() {
  const label = el("sb-layout");
  if (label) {
    label.textContent = styleLabel();
    label.title = (layout.preset === "custom" ? t("Layout: custom. Click to switch styles (Ctrl+Alt+1..9).") : t("Layout: {preset} preset. Click to switch styles (Ctrl+Alt+1..9).", { preset: layout.preset }));
  }
  document.documentElement.dataset.layout = layout.preset;
}

/** What a UI style holds (ui-styles.js): the arrangement, the look, and the switches. */
function uiSnapshot() {
  return {
    layout: { preset: layout.preset, docks: clone(layout.docks), panels: clone(layout.panels) },
    appearance: { ...account.appearance },
    show: { ...account.show },
  };
}

/** Put a UI style on screen: the layout through the same path a preset takes, the rest through saveAccount. */
function applyUiSnapshot(snap) {
  if (snap?.layout) {
    const next = sanitiseLayout({ ...snap.layout, preset: ["cockpit", "studio"].includes(snap.layout.preset) ? snap.layout.preset : "custom" });
    layout.preset = next.preset;
    layout.tab = next.tab;
    layout.docks = next.docks;
    layout.panels = next.panels;
    for (const dock of LAYOUT_DOCKS) {
      const node = dockNode(dock);
      if (node) node.hidden = false;
    }
    renderLayout();
    switchInspector(layout.tab);
    saveLayout();
    savePanelWidths();
  }
  const patch = {};
  if (snap?.appearance) patch.appearance = { ...snap.appearance };
  if (snap?.show) patch.show = { ...snap.show };
  if (patch.appearance || patch.show) void saveAccount(patch);
}

/**
 * The hamburger's own state. It closes the chats panel two different ways because the
 * sheet does: on a narrow window the panel is a drawer (`.app.open`), on a wide one it is
 * a dock that can be taken away (`.app.collapsed`). Both states must be readable from the
 * button, or the click that opened it looks like it did nothing.
 */
function paintMenuButton() {
  const button = el("menu");
  if (!button) return;
  const drawer = window.matchMedia("(max-width: 860px)").matches;
  const open = drawer ? app.classList.contains("open") : !app.classList.contains("collapsed");
  button.setAttribute("aria-expanded", open ? "true" : "false");
  button.setAttribute("aria-controls", "sidebar");
  button.title = open ? t("Close the chats panel") : t("Open the chats panel");
}

/** Commit a size change: clamp, draw, persist. */
function commitDockSize(dock, size) {
  const limits = DOCK_LIMITS[dock];
  layout.docks[dock].size = Math.round(Math.min(limits.max, Math.max(limits.min, size)));
  applyDockSize(dock);
  markCustom();
  saveLayout();
  if (dock !== "bottom") savePanelWidths();
}

function commitPanelSize(id, size) {
  layout.panels[id].size = Math.max(PANEL_MIN, Math.round(size));
  applyPanelSize(id);
  markCustom();
  saveLayout();
}

/** A hand-made arrangement is the `custom` preset, and says so in the status strip. */
function markCustom() {
  if (layout.preset !== "custom") {
    layout.preset = "custom";
    paintLayoutLabel();
  }
}

function applyPreset(name) {
  const next = presetLayout(name);
  layout.preset = next.preset;
  layout.tab = next.tab;
  layout.docks = next.docks;
  layout.panels = next.panels;
  for (const dock of LAYOUT_DOCKS) {
    const node = dockNode(dock);
    if (node) node.hidden = false;
  }
  renderLayout();
  switchInspector(layout.tab);
  saveLayout();
  // The width key outlives a preset, so the preset's own widths have to replace it or the
  // next reload would undo the arrangement that was just picked.
  savePanelWidths();
  toast((name === "studio" ? t("Studio preset") : t("Cockpit preset")), "ok");
}

// Dragging a splitter. One handler for both axes: the delta is measured along the
// splitter's own axis, and the clamp lives in the commit, so a drag can never produce
// a zero-width panel or a document with no room.
function wireSplitter(splitter) {
  let drag = null;
  const isDock = () => splitter.dataset.split === "dock";

  const start = (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    const target = splitter.dataset.target;
    if (!target) return;
    const dock = isDock() ? target : layout.panels[target].dock;
    const axis = splitter.classList.contains("vertical") ? "x" : "y";
    const startSize = isDock() ? layout.docks[dock].size : layout.panels[target].size;
    // A zero-sized panel grows, so its drag starts from what it currently occupies.
    const measured = isDock()
      ? startSize
      : startSize || panelNode(target)?.getBoundingClientRect()[dockAxis(dock)] || PANEL_MIN;
    drag = { axis, dock, panelId: isDock() ? null : target, startSize: measured, origin: axis === "x" ? event.clientX : event.clientY };
    splitter.classList.add("active");
    // The move and the release are listened for on the document: a 5px splitter is left
    // behind by the first pixel of a drag, so the drag must not depend on the pointer
    // still being over it (nor on pointer capture being granted).
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", end, { once: true });
    document.addEventListener("pointercancel", end, { once: true });
    event.preventDefault();
  };

  const move = (event) => {
    if (!drag) return;
    const now = drag.axis === "x" ? event.clientX : event.clientY;
    // A left dock grows to the right; a right dock grows to the left; the bottom one up.
    const direction = drag.panelId ? 1 : drag.dock === "right" || drag.dock === "bottom" ? -1 : 1;
    const size = drag.startSize + direction * (now - drag.origin);
    if (drag.panelId) commitPanelSize(drag.panelId, size);
    else commitDockSize(drag.dock, size);
  };

  const end = () => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", end);
    document.removeEventListener("pointercancel", end);
    if (!drag) return;
    drag = null;
    splitter.classList.remove("active");
  };

  splitter.addEventListener("pointerdown", start);
  splitter.addEventListener("dblclick", () => {
    const target = splitter.dataset.target;
    if (!target) return;
    if (isDock()) {
      const name = layout.preset === "custom" ? "cockpit" : layout.preset;
      commitDockSize(target, presetLayout(name).docks[target].size);
    } else {
      layout.panels[target].size = 0;
      applyPanelSize(target);
      markCustom();
      saveLayout();
    }
  });
  splitter.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 48 : 16;
    const target = splitter.dataset.target;
    if (!target) return;
    const growKey = splitter.classList.contains("vertical")
      ? event.key === "ArrowRight"
        ? step
        : event.key === "ArrowLeft"
          ? -step
          : 0
      : event.key === "ArrowDown"
        ? step
        : event.key === "ArrowUp"
          ? -step
          : 0;
    if (growKey) {
      event.preventDefault();
      if (isDock()) commitDockSize(target, layout.docks[target].size + (target === "right" ? -growKey : growKey));
      else commitPanelSize(target, layout.panels[target].size + growKey);
    } else if (event.key === "Home" || event.key === "Enter") {
      event.preventDefault();
      if (isDock()) commitDockSize(target, presetLayout("cockpit").docks[target].size);
      else {
        layout.panels[target].size = 0;
        applyPanelSize(target);
        saveLayout();
      }
    }
  });
}

/** Build the three dock splitters once, then let renderLayout show or hide them. */
function buildDockSplitters() {
  for (const dock of LAYOUT_DOCKS) {
    const node = dockNode(dock);
    if (!node) continue;
    const splitter = makeSplitter("dock", dock === "bottom" ? "horizontal" : "vertical", dock);
    if (dock === "bottom") node.before(splitter);
    else if (dock === "left") node.after(splitter);
    else node.before(splitter);
    wireSplitter(splitter);
  }
}

// ------------------------------------------------------------ moving a panel
//
// Drag a panel's grip: a ghost follows the pointer, a 2px line shows where it would
// land, and the drop is committed on pointerup. The target is geometric (the pointer's
// distance to each edge plus the panel midpoints of the dock under it), so a hidden
// dock is still a target - dragging to the right edge brings the inspector back.

let panelDrag = null;

function dropTargetFor(x, y) {
  const row = layoutRow.getBoundingClientRect();
  const edge = 44;
  const pick = (dock) => {
    const ids = dockPanels(dock);
    const node = dockNode(dock);
    if (!ids.length || !node || node.hidden) return { dock, index: 0 };
    const boxes = ids.map((id) => panelNode(id).getBoundingClientRect());
    const axis = dock === "bottom" ? "x" : "y";
    const here = dock === "bottom" ? x : y;
    let index = boxes.findIndex((box) => here < box[axis === "x" ? "left" : "top"] + box[axis === "x" ? "width" : "height"] / 2);
    if (index < 0) index = ids.length;
    return { dock, index };
  };
  if (y > row.bottom - edge) return pick("bottom");
  if (x < row.left + edge) return pick("left");
  if (x > row.right - edge) return pick("right");
  const over = document.elementFromPoint(x, y)?.closest?.(".dock");
  if (over?.dataset.dock) return pick(over.dataset.dock);
  return null;
}

function showDropLine(target, axis) {
  document.querySelectorAll(".drop-line").forEach((line) => line.remove());
  if (!target) return;
  const node = dockNode(target.dock);
  if (!node) return;
  node.hidden = false;
  const line = document.createElement("div");
  line.className = `drop-line ${axis}`;
  const ids = dockPanels(target.dock);
  const before = ids[target.index] ? panelNode(ids[target.index]) : null;
  if (before) node.insertBefore(line, before);
  else node.append(line);
}

function clearDragArtifacts() {
  document.querySelectorAll(".drop-line, .drag-ghost").forEach((node) => node.remove());
  document.body.classList.remove("dragging-panel");
  for (const dock of LAYOUT_DOCKS) paintDockSplitters();
}

function commitMove(id, target) {
  if (!target) return;
  // The inspector has no grip, so this is only a belt-and-braces check: a dock drop must
  // never be able to take the chat's own surface out of the right column.
  if (id === PINNED_PANEL) return;
  const from = layout.panels[id].dock;
  layout.panels[id].dock = target.dock;
  layout.panels[id].closed = false;
  const ids = dockPanels(target.dock).filter((other) => other !== id);
  ids.splice(target.index, 0, id);
  renumber(from);
  ids.forEach((other, index) => {
    layout.panels[other].order = index;
  });
  renderLayout();
  applyDockSize("left");
  applyDockSize("right");
  applyDockSize("bottom");
  markCustom();
  saveLayout();
}

function wirePanelGrip(grip) {
  grip.addEventListener("pointerdown", (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    const id = grip.dataset.grip;
    if (!id || panelDrag || id === PINNED_PANEL) return;
    event.preventDefault();
    const ghost = document.createElement("div");
    ghost.className = "drag-ghost";
    ghost.textContent = document.querySelector(`[data-panel="${id}"] .panel-title`)?.textContent ?? id;
    document.body.append(ghost);
    document.body.classList.add("dragging-panel");
    panelDrag = { id, ghost, target: null };
    // Moving the pointer off a 40px grip is the whole point, so the move and the drop
    // are listened for on the document rather than on the grip: no pointer capture to
    // depend on, and a release anywhere in the window still lands.
    document.addEventListener("pointermove", onGripMove);
    document.addEventListener("pointerup", onGripUp, { once: true });
    document.addEventListener("pointercancel", onGripUp, { once: true });
  });
}

function onGripMove(event) {
  if (!panelDrag) return;
  // The chip follows the pointer but never leaves the window: dragging to the right edge
  // is how a panel gets dropped into the right dock, and the chip used to be cut off there.
  const { ghost } = panelDrag;
  const left = Math.min(event.clientX + 12, window.innerWidth - ghost.offsetWidth - 8);
  const top = Math.min(event.clientY + 4, window.innerHeight - ghost.offsetHeight - 8);
  ghost.style.left = `${Math.max(8, left)}px`;
  ghost.style.top = `${Math.max(8, top)}px`;
  const target = dropTargetFor(event.clientX, event.clientY);
  panelDrag.target = target;
  showDropLine(target, target?.dock === "bottom" ? "vertical" : "horizontal");
}

function onGripUp() {
  document.removeEventListener("pointermove", onGripMove);
  document.removeEventListener("pointerup", onGripUp);
  document.removeEventListener("pointercancel", onGripUp);
  if (!panelDrag) return;
  const { id, target } = panelDrag;
  panelDrag = null;
  clearDragArtifacts();
  if (target) commitMove(id, target);
  else renderLayout();
}

// --------------------------------------------------------------- View menu

function closeViewMenu() {
  const menu = el("view-menu");
  menu.hidden = true;
  el("view")?.setAttribute("aria-expanded", "false");
}

function openViewMenu(anchor) {
  const menu = el("view-menu");
  if (!menu.hidden) {
    closeViewMenu();
    return;
  }
  menu.innerHTML = "";
  const heading = (text) => {
    const h = document.createElement("h3");
    h.textContent = text;
    menu.append(h);
    return h;
  };
  styleMenuSection(menu, closeViewMenu);
  heading(t("Presets"));
  for (const name of ["cockpit", "studio"]) {
    const item = document.createElement("button");
    item.className = "view-item";
    item.type = "button";
    item.innerHTML = `<span class="tick">${layout.preset === name ? "✓" : ""}</span><span>${name === "cockpit" ? "Cockpit" : "Studio"}</span><span class="hint">${name === "cockpit" ? t("graph + runs") : t("files, no runs")}</span>`;
    item.addEventListener("click", () => {
      applyPreset(name);
      closeViewMenu();
    });
    menu.append(item);
  }
  const customRow = document.createElement("div");
  customRow.className = "view-item";
  customRow.innerHTML = `<span class="tick">${layout.preset === "custom" ? "✓" : ""}</span><span>${t("Custom")}</span><span class="hint">${t("your arrangement")}</span>`;
  menu.append(customRow);
  menu.append(document.createElement("hr"));
  heading(t("Panels"));
  for (const id of LAYOUT_PANELS) {
    const state = layout.panels[id];
    const panelLabel = { sessions: t("sessions"), inspector: t("inspector") }[id] ?? id;
    const row = document.createElement("div");
    row.className = "view-item";
    row.style.cursor = "default";
    const toggle = document.createElement("button");
    toggle.className = "view-item";
    toggle.type = "button";
    toggle.style.padding = "2px 4px";
    toggle.style.width = "auto";
    toggle.innerHTML = `<span class="tick">${state.closed ? "" : "✓"}</span><span>${panelLabel}</span>`;
    toggle.title = state.closed ? t("Show the {name} panel", { name: panelLabel }) : t("Hide the {name} panel", { name: panelLabel });
    toggle.addEventListener("click", () => {
      setPanel(id, { closed: !state.closed });
      closeViewMenu();
    });
    const collapse = document.createElement("button");
    collapse.className = "view-item";
    collapse.type = "button";
    collapse.style.padding = "2px 4px";
    collapse.style.width = "auto";
    collapse.textContent = state.collapsed ? t("expand") : t("collapse");
    collapse.disabled = state.closed;
    collapse.addEventListener("click", () => {
      setPanel(id, { collapsed: !state.collapsed });
      closeViewMenu();
    });
    const where = document.createElement("span");
    where.className = "hint";
    where.textContent = state.closed ? t("closed") : `${{ left: t("left"), right: t("right"), bottom: t("bottom") }[state.dock] ?? state.dock}${state.collapsed ? ` · ${t("rail")}` : ""}`;
    // The inspector row has no hide control: collapsed is the only off state it has, and
    // the collapse button beside it already offers that.
    if (id !== PINNED_PANEL) row.append(toggle);
    row.append(collapse, where);
    menu.append(row);
  }
  menu.hidden = false;
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth || 220;
  menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
  // Opened from the status bar it would fall off the bottom of the window, so it opens upward there.
  const height = menu.offsetHeight || 0;
  menu.style.top = `${rect.bottom + 6 + height > window.innerHeight ? Math.max(8, rect.top - height - 6) : rect.bottom + 6}px`;
  el("view")?.setAttribute("aria-expanded", "true");
  el("view")?.focus?.();
}

function setPanel(id, patch) {
  const state = layout.panels[id];
  if (!state) return;
  // One guard, here, covers every caller: the close buttons, the View menu, the palette
  // and the drag grip. A bug in any of them cannot make the inspector disappear.
  const safe = id === PINNED_PANEL ? { ...patch, closed: false, dock: "right" } : patch;
  Object.assign(state, safe);
  if (safe.closed === false) {
    // Reopening into a dock that is empty needs an order that is not already taken.
    renumber(state.dock);
    state.order = dockPanels(state.dock).length - 1;
  }
  renderLayout();
  markCustom();
  saveLayout();
}

// ----------------------------------------------------------- command palette

// A layout panel's and a dock's name as the window shows them (the ids stay English).
const panelName = (id) => ({ sessions: t("sessions"), inspector: t("inspector") })[id] ?? id;
const dockName = (dock) => ({ left: t("left"), right: t("right"), bottom: t("bottom") })[dock] ?? dock;

function paletteCommands() {
  const commands = [
    ...styleCommands(),
    { title: t("Layout: Cockpit preset"), hint: t("graph + runs"), run: () => applyPreset("cockpit") },
    { title: t("Layout: Studio preset"), hint: t("files, no runs"), run: () => applyPreset("studio") },
    { title: t("Layout: reset to Cockpit defaults"), run: () => applyPreset("cockpit") },
    ...LAYOUT_PANELS.filter((id) => id !== PINNED_PANEL).map((id) => ({
      title: layout.panels[id].closed ? t("Panel: show {id}", { id: panelName(id) }) : t("Panel: hide {id}", { id: panelName(id) }),
      hint: layout.panels[id].closed ? t("closed") : dockName(layout.panels[id].dock),
      run: () => setPanel(id, { closed: !layout.panels[id].closed }),
    })),
    ...LAYOUT_PANELS.map((id) => ({
      title: layout.panels[id].collapsed ? t("Panel: expand {id}", { id: panelName(id) }) : t("Panel: collapse {id}", { id: panelName(id) }),
      run: () => setPanel(id, { collapsed: !layout.panels[id].collapsed }),
    })),
    { title: t("Open: Monitor"), run: () => openPage("/monitor") },
    { title: t("Open: Wi-Fi networks"), run: () => openPage("/network") },
    { title: t("Open: VPN exits"), run: () => openPage("/exits") },
    { title: t("Open: Tokens"), run: () => openPage("/usage") },
    { title: t("Open: What this PC can run"), run: () => openPage("/models") },
    // One entry per Settings page, by the name in its menu.
    ...[...document.querySelectorAll("#settings-panel [data-settings-page-body]")].map((body) => ({
      title: t("Settings: {name}", { name: body.dataset.title ?? LABEL(body.dataset.settingsPageBody) }),
      // After the palette's own click has finished bubbling: that click lands outside the
      // dialog, and the "click outside closes Settings" handler would shut it at once.
      run: () =>
        setTimeout(() => {
          showSettingsPage(body.dataset.settingsPageBody);
          toggleSettings(true);
        }, 0),
    })),
    { title: t("Theme: cycle auto / dark / light"), run: () => el("theme").click() },
    { title: t("Chat: new chat"), run: () => el("new-chat").click() },
    ...(rail?.commands() ?? []),
  ];
  return commands;
}

function openPalette(open = true) {
  const node = el("palette");
  if (node.hidden === !open) return;
  node.hidden = !open;
  if (!open) return;
  const input = el("palette-input");
  input.value = "";
  paintPalette("");
  input.focus();
}

function paintPalette(query) {
  const list = el("palette-list");
  const all = paletteCommands();
  const needle = query.trim().toLowerCase();
  const matches = needle ? all.filter((c) => c.title.toLowerCase().includes(needle)) : all;
  list.innerHTML = "";
  matches.forEach((command, index) => {
    const item = document.createElement("li");
    item.className = "palette-item";
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", index === 0 ? "true" : "false");
    item.innerHTML = `<span>${command.title}</span>${command.hint ? `<span class="hint">${command.hint}</span>` : ""}`;
    item.addEventListener("click", () => {
      openPalette(false);
      command.run();
    });
    list.append(item);
  });
  if (!matches.length) {
    const empty = document.createElement("li");
    empty.className = "palette-item";
    empty.dataset.empty = "1";
    empty.textContent = t("No command matches.");
    list.append(empty);
  }
  el("palette").dataset.matches = String(matches.length);
  el("palette").dataset.commands = JSON.stringify(matches.map((c) => c.title));
}

function runPaletteSelection() {
  const first = el("palette-list").querySelector(".palette-item");
  if (first && !first.dataset.empty) first.click();
}

// ------------------------------------------------------------- status strip
//
// Every figure is fetched from a route that already exists. The one derived number -
// tok/s - is the difference between two /api/usage readings divided by the real
// elapsed time, and it says so rather than presenting a rate the server never measured.

const status = { usage: null, written: null, hardware: null, hardwareAt: 0 };

function setStatusText(id, text, title) {
  const node = el(id);
  if (!node) return;
  if (node.textContent !== text) node.textContent = text;
  if (title !== undefined && node.title !== title) node.title = title;
}

async function paintStatus() {
  const health = await api("/api/health").catch(() => null);
  if (health) {
    const models = health.router?.models?.length ?? 0;
    setStatusText("sb-router", health.router?.up ? t("router up · {models} models", { models }) : t("router down · {models} models", { models }), "GET /api/health");
  } else {
    setStatusText("sb-router", t("router unreachable"), t("GET /api/health failed"));
  }

  // No limit: the counts must describe the whole graph, and `limit` truncates the body
  // and the counts together.
  const graph = await api("/api/graph").catch(() => null);
  if (graph?.counts) {
    const counts = graph.counts;
    setStatusText(
      "sb-graph",
      t("graph {running} running · {total} total · {failed} failed", { running: counts.running, total: counts.total, failed: counts.failed }),
      t("GET /api/graph counts (whole graph, deepest depth {deepest})", { deepest: counts.deepest }),
    );
  } else {
    setStatusText("sb-graph", t("graph unavailable"), t("GET /api/graph failed"));
  }

  const usage = await api("/api/usage?days=1").catch(() => null);
  if (usage?.totals) {
    const totals = usage.totals;
    const now = Date.now();
    let rate = "";
    if (status.usage) {
      const seconds = (now - status.usage.at) / 1000;
      const tokens = totals.tokens - status.usage.tokens;
      if (seconds >= 1 && tokens >= 0) {
        rate = ` · ${t("{rate} tok/s avg over {seconds}s", { rate: (tokens / seconds).toFixed(1), seconds: Math.round(seconds) })}`;
        if (Number.isFinite(tokens / seconds)) status.written = { rate: tokens / seconds, at: now };
      }
    }
    setStatusText(
      "sb-usage",
      `${t("{tokens} tok today · {calls} calls", { tokens: totals.tokens.toLocaleString(), calls: totals.calls.toLocaleString() })}${rate}`,
      rate
        ? t("Two /api/usage?days=1 readings: the rate is the token difference over the elapsed wall time")
        : t("Waiting for a second /api/usage sample to measure tok/s"),
    );
    status.usage = { tokens: totals.tokens, at: now };
  } else {
    setStatusText("sb-usage", t("usage unavailable"), t("GET /api/usage failed"));
  }

  // VPN: shown only when a supported client is installed on this PC. A machine with none
  // gets no item at all rather than a permanent "off".
  const exits = await api("/api/exits").catch(() => null);
  const installedVpns = (exits?.providers ?? []).filter((client) => client.installed !== false);
  const showVpn = Boolean(exits?.supported) && installedVpns.length > 0;
  el("sb-exits").hidden = !showVpn;
  el("sb-exits-sep").hidden = !showVpn;
  if (showVpn) {
    const up = installedVpns.filter((client) => client.running === true).map((client) => client.label);
    setStatusText(
      "sb-exits",
      up.length ? `VPN ${up.join(" + ")}` : t("VPN off"),
      exits.conflict ? t("{names} are all running: Windows will only route through one", { names: up.join(t("and (list joiner)")) }) : t("VPN clients on this PC"),
    );
  }

  setStatusText(
    "sb-rate",
    t("{applied} / {received} paints · {rate} Hz", { applied: render.applied.toLocaleString(), received: render.received.toLocaleString(), rate: render.rate }),
    t("DOM updates applied / deltas received since this page loaded"),
  );

  // The GPU line. /api/recommend measures the card itself; the figure is only shown
  // when the total exists, and the free figure only when it was measured too.
  if (!status.hardware || Date.now() - status.hardwareAt > 60000) {
    status.hardwareAt = Date.now();
    status.hardware = await api("/api/recommend").catch(() => status.hardware);
  }
  const gpu = status.hardware?.hardware?.gpu;
  const hardware = el("sb-hardware");
  const hardwareSep = el("sb-hardware-sep");
  if (gpu && isNumber(gpu.vramTotalBytes) && gpu.vramTotalBytes > 0) {
    const gib = (bytes) => bytes / 1024 ** 3;
    const total = Math.round(gib(gpu.vramTotalBytes));
    const short = (gpu.name || "GPU").replace(/^(NVIDIA GeForce|NVIDIA|AMD Radeon|AMD|Intel)\s+/i, "");
    const free = isNumber(gpu.vramFreeBytes) ? gib(gpu.vramFreeBytes) : null;
    if (hardware) {
      hardware.textContent = `${short} · ${free === null ? `${total} GiB` : t("{free} of {total} GiB free", { free: free.toFixed(1), total })}`;
      hardware.title = free === null ? t("{name} ({source}) · {total} B total", { name: gpu.name, source: gpu.source ?? t("measured"), total: gpu.vramTotalBytes.toLocaleString() }) : t("{name} ({source}) · {total} B total, {free} B free", { name: gpu.name, source: gpu.source ?? t("measured"), total: gpu.vramTotalBytes.toLocaleString(), free: gpu.vramFreeBytes.toLocaleString() });
      hardware.hidden = false;
    }
    if (hardwareSep) hardwareSep.hidden = false;
  } else if (hardware) {
    // No measurement, no item: nothing here is guessed.
    hardware.hidden = true;
    hardware.textContent = "";
    if (hardwareSep) hardwareSep.hidden = true;
  }
}

// The bottom Recent runs strip is gone. It used to own this timer, and the timer is worth
// keeping: the strip in the top bar can change without this page doing anything - a run
// started in another window, a background job that exited - and a read every 30 s is the
// only way an idle page notices. Nothing is painted here; the strip paints itself.
function tickActivity() {
  void refreshActivity();
}

// --------------------------------------------------------------- inspector
//
// The contents come from panels.js, which another agent owns. It is imported lazily and
// guarded: a missing module, a module that throws on mount, or one that returns nothing
// all end in the same empty state, because a panel that cannot load must never take the
// shell down.

const inspector = { mod: null, mounted: {}, error: null, api: null };

function inspectorEmpty(text) {
  const node = el("insp-empty");
  if (!node) return;
  node.hidden = false;
  node.innerHTML = `<p>${text}</p>`;
}

function openSession(id) {
  openChat(id);
}

async function loadInspectorModule() {
  if (inspector.mod || inspector.error) return inspector.mod;
  try {
    const mod = await import("./panels.js");
    const panels = mod.panels ?? mod.default;
    if (!panels?.graph?.mount && !panels?.files?.mount) throw new Error("panels.js exported no mountable panels");
    inspector.mod = panels;
    // The stylesheet is added only once the module is known to exist, so a missing
    // panels.css cannot cost an error in the console of a build that has no panels.js.
    if (!document.querySelector('link[href="/panels.css"]')) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "/panels.css";
      document.head.append(link);
    }
    return panels;
  } catch (err) {
    inspector.error = err?.message ?? String(err);
    return null;
  }
}

async function mountInspectorTab(tab) {
  const slot = document.querySelector(`[data-insp-slot="${tab}"]`);
  if (!slot) return;
  const panels = await loadInspectorModule();
  if (!panels) {
    inspectorEmpty(
      t("The inspector could not load ({error}). The chat, the sidebar and every other panel keep working.", { error: inspector.error ?? t("no panels.js") }),
    );
    slot.hidden = tab !== layout.tab;
    return;
  }
  el("insp-empty").hidden = true;
  const entry = panels[tab];
  if (!entry?.mount) {
    inspectorEmpty(t("panels.js has no {tab} panel.", { tab }));
    return;
  }
  if (!inspector.mounted[tab]) {
    inspector.api ??= { fetchJson: (path) => api(withChatScope(path), { headers: { "x-rosalena-token": TOKEN } }), openSession, toast, fetch: (path, options) => fetch(path, options) };
    try {
      inspector.mounted[tab] = entry.mount(slot, inspector.api) ?? {};
      // A file picked in the Files tab opens in a viewer tab of its own.
      if (tab === "files") inspector.mounted.files.onSelect = (rel) => void openFileTab(rel);
    } catch (err) {
      inspectorEmpty(t("{tab} failed to mount: {error}. The rest of the app is unaffected.", { tab, error: err?.message ?? err }));
      return;
    }
  }
  slot.hidden = false;
  try {
    await inspector.mounted[tab].refresh?.();
  } catch {
    /* a refresh that throws leaves the last good drawing in place */
  }
}

function switchInspector(tab) {
  // Files, or an extra tab the person added with "+" (see "extra sidebar tabs").
  layout.tab = tab && (tab === "files" || side.tabs.includes(tab)) ? tab : "files";
  side.tab = layout.tab;
  document.querySelectorAll(".insp-tab").forEach((button) => {
    button.setAttribute("aria-selected", button.dataset.insp === layout.tab ? "true" : "false");
  });
  document.querySelectorAll("[data-insp-slot]").forEach((slot) => {
    slot.hidden = slot.dataset.inspSlot !== layout.tab;
  });
  if (layout.tab === "files") mountInspectorTab("files");
  else void mountSideTab(layout.tab);
  saveLayout();
}

// ---------------------------------------------------- inspector tab order
//
// Both tabs are buttons in one panel, so their order is a preference, not a panel move.
// It gets its own key: a saved name that no longer exists is filtered out and a missing
// tab is appended, so neither a stale string nor a future tab can leave a hole or drop
// a tab from the list.

let tabOrder = readTabOrder();

function readTabOrder() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(TAB_ORDER_KEY) ?? "null");
  } catch {
    saved = null;
  }
  const listed = Array.isArray(saved) ? saved : Array.isArray(saved?.tabs) ? saved.tabs : [];
  const order = [];
  for (const id of listed) if (INSPECTOR_TABS.includes(id) && !order.includes(id)) order.push(id);
  for (const id of INSPECTOR_TABS) if (!order.includes(id)) order.push(id);
  return order;
}

function saveTabOrder() {
  try {
    localStorage.setItem(TAB_ORDER_KEY, JSON.stringify({ v: 1, tabs: tabOrder }));
  } catch {
    /* private mode: the order lasts this page */
  }
}

/** Draw the stored order. Appending is enough: the list holds nothing else. */
function paintTabOrder() {
  const list = document.querySelector(".insp-tabs");
  if (!list) return;
  for (const id of tabOrder) {
    const button = list.querySelector(`.insp-tab[data-insp="${id}"]`);
    if (button) list.append(button);
  }
  // The added tabs and the + button stay after the built-in ones.
  for (const node of list.querySelectorAll(".insp-tab.side-extra, .insp-add")) list.append(node);
}

/** Move a tab one slot from the keyboard and keep focus on it. */
function nudgeTab(id, delta) {
  const from = tabOrder.indexOf(id);
  const to = Math.max(0, Math.min(tabOrder.length - 1, from + delta));
  if (from < 0 || to === from) return false;
  tabOrder.splice(from, 1);
  tabOrder.splice(to, 0, id);
  paintTabOrder();
  saveTabOrder();
  document.querySelector(`.insp-tab[data-insp="${id}"]`)?.focus();
  return true;
}

function wireInspectorTab(button) {
  const id = button.dataset.insp;
  if (!id) return;
  button.addEventListener("keydown", (event) => {
    if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    if (nudgeTab(id, event.key === "ArrowLeft" ? -1 : 1)) event.preventDefault();
  });
  // The whole tab starts a drag: there is no grip glyph to aim at any more. The slop in
  // `move` is what keeps a plain click a click, so selecting a tab and reordering the tabs
  // are the same gesture on the same target. The move itself is pointer-based rather than
  // HTML5 drag: the tab is a button, and a native drag would not start from it reliably.
  button.addEventListener("pointerdown", (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    const list = button.parentElement;
    if (!list) return;
    button.focus();
    const start = { x: event.clientX, y: event.clientY };
    let moved = false;
    const move = (next) => {
      // A few pixels of slop keeps a click from becoming a one-pixel reorder.
      if (!moved && Math.hypot(next.clientX - start.x, next.clientY - start.y) < 4) return;
      if (!moved) next.preventDefault?.();
      moved = true;
      button.classList.add("is-dragging");
      const over = document.elementFromPoint(next.clientX, next.clientY)?.closest?.(".insp-tab");
      if (!over || over === button || over.parentElement !== list) return;
      const box = over.getBoundingClientRect();
      list.insertBefore(button, next.clientX < box.left + box.width / 2 ? over : over.nextSibling);
    };
    const end = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", end);
      document.removeEventListener("pointercancel", end);
      button.classList.remove("is-dragging");
      if (!moved) return;
      tabOrder = [...list.querySelectorAll(".insp-tab")]
        .map((node) => node.dataset.insp)
        .filter((value) => INSPECTOR_TABS.includes(value));
      saveTabOrder();
      // The release is followed by a click on the same button; swallowing it keeps a
      // reorder from also switching the inspector to the tab that was dragged.
      button.dataset.suppressClick = "1";
      setTimeout(() => delete button.dataset.suppressClick, 0);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", end, { once: true });
    document.addEventListener("pointercancel", end, { once: true });
  });
  button.addEventListener("click", (event) => {
    if (button.dataset.suppressClick === "1") {
      delete button.dataset.suppressClick;
      event.preventDefault();
      return;
    }
    switchInspector(id);
  });
}

// ------------------------------------------------------------- extra sidebar tabs
//
// The right sidebar had one tab (Files) and no way to add another. "+" now adds live views
// (Tasks, Local models, Context & compaction, Chat models, Terminal) and any sidebar plugin
// (Style Lab, Paper Reader, ...). Open tabs are remembered; each has an × to close it.

const SIDE_TABS_KEY = "rosalena-side-tabs";
const SIDE_BUILTINS = {
  tasks: { label: t("Tasks"), hint: t("The current chat's task list, live") },
  local: { label: t("Local models"), hint: t("What the local model server has loaded and what it is doing") },
  context: { label: t("Context"), hint: t("How full this chat is, and every compaction so far") },
  pins: { label: t("Chat models"), hint: t("The model and effort each chat keeps") },
  terminal: { label: t("Terminal"), hint: t("Your terminal, in the sidebar") },
};
// The app's own sidebar plugins took rosa- names on 2026-11-08; a tab saved under the old
// name opens the same plugin.
const RENAMED_SIDE_PLUGINS = new Set(["style-lab", "fuyu", "paper-reader", "poster-studio", "transformer-3d", "video-editor", "world-architecture-3d"]);
function readSideTabs() {
  try {
    const saved = JSON.parse(readPref(SIDE_TABS_KEY) || "[]");
    if (!Array.isArray(saved)) return [];
    const tabs = saved
      .filter((id) => typeof id === "string" && (SIDE_BUILTINS[id] || id.startsWith("plugin:") || id.startsWith("file:") || id.startsWith("folder:") || isWebTabId(id)))
      .map((id) => (id.startsWith("plugin:") && RENAMED_SIDE_PLUGINS.has(id.slice(7)) ? `plugin:rosa-${id.slice(7)}` : id));
    return [...new Set(tabs)];
  } catch {
    return [];
  }
}
function saveSideTabs() {
  writePref(SIDE_TABS_KEY, side.tabs.length ? JSON.stringify(side.tabs) : "");
}
function sideTabLabel(id) {
  if (SIDE_BUILTINS[id]) return SIDE_BUILTINS[id].label;
  if (id.startsWith("file:")) return id.slice(5).split(/[\\/]/).pop() || t("File");
  if (id.startsWith("folder:")) return `▤ ${folderLabel(id.slice(7))}`;
  if (isWebTabId(id)) return webTabLabel(web.state[id]);
  const plugin = (side.plugins ?? []).find((p) => `plugin:${p.id}` === id);
  if (plugin?.title) return plugin.title;
  // Before the plugin list has loaded: "rosa-style-lab" reads as "Style Lab".
  return id
    .slice("plugin:".length)
    .replace(/^rosa-/, "")
    .split("-")
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ");
}

async function loadSidePlugins(fresh = false) {
  if (side.plugins && !fresh) return side.plugins;
  try {
    side.plugins = ((await api("/api/plugins/ui")).plugins ?? []).filter((p) => p.enabled !== false && p.url);
  } catch {
    // Not remembered: a failed read (server still starting) is tried again next time.
    return side.plugins ?? [];
  }
  return side.plugins;
}

/** Draw the extra tab buttons (after Files) and their slots, plus the + button. */
function paintSideTabs() {
  const list = document.querySelector(".insp-tabs");
  const body = el("inspector-body");
  if (!list || !body) return;
  for (const old of list.querySelectorAll(".insp-tab.side-extra, .insp-add")) old.remove();
  for (const id of side.tabs) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "insp-tab side-extra";
    button.dataset.insp = id;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(layout.tab === id));
    const name = document.createElement("span");
    name.className = "insp-name";
    name.textContent = sideTabLabel(id);
    if (isWebTabId(id)) button.append(webTabIcon(id));
    const close = document.createElement("span");
    close.className = "insp-close";
    close.textContent = "×";
    close.title = t("Close {name}", { name: sideTabLabel(id) });
    close.onclick = (event) => {
      event.stopPropagation();
      closeSideTab(id);
    };
    button.append(name, close);
    button.title =
      SIDE_BUILTINS[id]?.hint ??
      (id.startsWith("file:")
        ? id.slice(5)
        : id.startsWith("folder:")
          ? t("{path} (folder)", { path: id.slice(7) })
          : isWebTabId(id)
            ? webTabHint(id)
            : t("{name} (sidebar plugin)", { name: sideTabLabel(id) }));
    button.onclick = () => switchInspector(id);
    list.append(button);
    if (!body.querySelector(`[data-insp-slot="${CSS.escape(id)}"]`)) {
      const slot = document.createElement("div");
      slot.className = "insp-slot side-slot";
      slot.dataset.inspSlot = id;
      slot.hidden = true;
      body.append(slot);
    }
  }
  const add = document.createElement("button");
  add.type = "button";
  add.className = "insp-add";
  add.textContent = "+";
  add.title = t("Add a sidebar tab");
  add.setAttribute("aria-haspopup", "menu");
  add.onclick = (event) => {
    event.stopPropagation();
    void openSideMenu(add);
  };
  list.append(add);
}

/**
 * Show a .side-menu under `anchor`, and take it away on a click elsewhere or Esc (which
 * then does nothing else: no chat is stopped, no full-screen sidebar is left).
 */
function floatSideMenu(menu, anchor) {
  document.body.append(menu);
  const box = anchor.getBoundingClientRect();
  menu.style.top = `${Math.round(box.bottom + 4)}px`;
  menu.style.left = `${Math.round(Math.max(8, Math.min(box.left, window.innerWidth - menu.offsetWidth - 8)))}px`;
  const done = () => {
    menu.remove();
    document.removeEventListener("pointerdown", away, true);
    document.removeEventListener("keydown", escape, true);
  };
  const away = (event) => {
    if (!menu.contains(event.target)) done();
  };
  const escape = (event) => {
    // A menu item already closed it: let go of Esc.
    if (!menu.isConnected) return done();
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    done();
    anchor.focus?.();
  };
  setTimeout(() => document.addEventListener("pointerdown", away, true), 0);
  document.addEventListener("keydown", escape, true);
}

async function openSideMenu(anchor) {
  document.querySelector(".side-menu")?.remove();
  // Fresh each time: a plugin switched on or installed since shows without a restart.
  const plugins = await loadSidePlugins(true);
  const menu = document.createElement("div");
  menu.className = "side-menu";
  menu.setAttribute("role", "menu");
  const section = (title) => {
    const p = document.createElement("p");
    p.className = "side-menu-head";
    p.textContent = title;
    menu.append(p);
  };
  const item = (id, label, hint) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "side-menu-item";
    button.setAttribute("role", "menuitem");
    const open = side.tabs.includes(id);
    button.textContent = open ? `${label} ✓` : label;
    button.title = hint ?? "";
    button.onclick = () => {
      menu.remove();
      if (!open) {
        side.tabs.push(id);
        saveSideTabs();
        paintSideTabs();
      }
      switchInspector(id);
    };
    menu.append(button);
  };
  section(t("Files"));
  // Another Files tab, on any folder on this PC (not only the chat's workspace). As many as
  // you like; each opens on the folder you pick and can go up from there.
  const folder = document.createElement("button");
  folder.type = "button";
  folder.className = "side-menu-item";
  folder.setAttribute("role", "menuitem");
  folder.textContent = t("Folder…");
  folder.title = t("A Files tab on any folder on this PC, browsable like File Explorer");
  folder.onclick = () => {
    menu.remove();
    void addFolderTab();
  };
  menu.append(folder);
  for (const id of side.tabs.filter((tab) => tab.startsWith("folder:"))) item(id, sideTabLabel(id), id.slice(7));
  // Web pages in the sidebar (any number of tabs), and the agent's way into your own browser.
  section(t("Web"));
  const action = (label, hint, run) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "side-menu-item";
    button.setAttribute("role", "menuitem");
    button.textContent = label;
    button.title = hint;
    button.onclick = () => {
      menu.remove();
      run();
    };
    menu.append(button);
    return button;
  };
  action(t("Browser"), canBrowse() ? t("A web page in the sidebar, with its own back, forward and address bar") : t("Needs the desktop app; here it offers to open pages in your browser"), () => addWebTab());
  for (const id of side.tabs.filter(isWebTabId)) item(id, sideTabLabel(id), webTabHint(id));
  action(t("Get SolBrowser…"), SOLBROWSER_LINE, () => openSolBrowserMenu(anchor));
  section(t("Live views"));
  for (const [id, info] of Object.entries(SIDE_BUILTINS)) item(id, info.label, info.hint);
  if (plugins.length) {
    section(t("Sidebar plugins"));
    for (const plugin of plugins) item(`plugin:${plugin.id}`, plugin.title ?? plugin.id, plugin.description ?? "");
  }
  floatSideMenu(menu, anchor);
}

function closeSideTab(id) {
  side.tabs = side.tabs.filter((tab) => tab !== id);
  saveSideTabs();
  side.handles[id]?.destroy?.();
  delete side.handles[id];
  clearInterval(side.timers[id]);
  delete side.timers[id];
  if (id === "terminal") placeTerminal("main");
  if (isWebTabId(id)) {
    delete web.state[id];
    saveWebState();
  }
  document.querySelector(`[data-insp-slot="${CSS.escape(id)}"]`)?.remove();
  paintSideTabs();
  if (layout.tab === id) switchInspector("files");
}

/** Fill (or refresh) one extra tab's slot. */
// ------------------------------------------------------------- folder tabs
//
// The + menu's "Folder…": a Files tab on any folder on this PC, not only the chat's
// workspace, so several folders can sit in the sidebar at once. Each is the same Files
// panel, reading through /api/files with that folder as its root (which needs the page
// token). "Up" moves the tab to the parent folder, so it browses like File Explorer.

/** "Rosalena Harness" for D:\AppDev\Rosalena Harness, "D:" for a drive's root. */
function folderName(path) {
  const parts = String(path).split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(path);
}

/**
 * A folder tab's name: the folder's own, plus its parent's when another open folder tab
 * has the same name ("src (Rosalena Harness)" next to "src (Tessaly)").
 */
function folderLabel(path) {
  const name = folderName(path);
  const twin = side.tabs.some(
    (tab) => tab.startsWith("folder:") && !sameFolder(tab.slice(7), path) && folderName(tab.slice(7)).toLowerCase() === name.toLowerCase(),
  );
  const parent = twin ? folderName(parentFolder(path)) : "";
  return parent ? `${name} (${parent})` : name;
}

/** The folder above this one, or "" at the top ("D:\", "/", or a share's "\\server\share"). */
function parentFolder(path) {
  const text = String(path).replace(/[\\/]+$/, "");
  // A network share's root has nothing above it that can be listed ("\\server" is not a folder).
  if (/^[\\/]{2}[^\\/]+[\\/][^\\/]+$/.test(text)) return "";
  const cut = Math.max(text.lastIndexOf("\\"), text.lastIndexOf("/"));
  if (cut < 0) return "";
  const parent = text.slice(0, cut);
  // "D:" alone means "the current folder on D:", not its root.
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
  return parent || (text.startsWith("/") ? "/" : "");
}

/** The same folder, however it was typed: Windows paths ignore case and slash direction. */
function sameFolder(a, b) {
  const windows = (p) => /^[A-Za-z]:|^[\\/]{2}/.test(p);
  const tidy = (p) => String(p).replace(/[\\/]+$/, "").replace(/\//g, "\\");
  if (windows(a) && windows(b)) return tidy(a).toLowerCase() === tidy(b).toLowerCase();
  return String(a).replace(/\/+$/, "") === String(b).replace(/\/+$/, "");
}

/** The open folder tab showing this folder, if any. */
function folderTabFor(folder) {
  return side.tabs.find((tab) => tab.startsWith("folder:") && sameFolder(tab.slice(7), folder)) ?? null;
}

/**
 * Ask the server whether this is a folder it can list, and get its full path back (so a
 * typed "src" or "D:/AppDev/" becomes one real path). Throws with a sentence when not.
 */
async function checkFolder(path) {
  let out;
  try {
    out = await api(`/api/files?root=${encodeURIComponent(path)}`, { headers: { "x-rosalena-token": TOKEN } });
  } catch (err) {
    throw /^not a folder:/i.test(err.message) ? new Error(t("there is no folder there")) : err;
  }
  if (!out?.root) throw new Error(t("there is no folder there"));
  return out.root;
}

async function pickFolderPath(start = "") {
  const desktop = window.rosalenaDesktop;
  try {
    const picked = typeof desktop?.pickFolder === "function"
      ? await desktop.pickFolder({ purpose: "sidebar", start: start || currentWorkspace() })
      : await askText(t("Folder to show in the sidebar (full path)"), { value: start || currentWorkspace(), okLabel: t("Open") });
    return String(picked ?? "").trim();
  } catch (err) {
    toast(t("Could not open the folder picker: {error}", { error: err.message }), "bad");
    return "";
  }
}

/** Open a folder tab (or switch to it when that folder is already open). */
async function addFolderTab(path = "") {
  const asked = path || (await pickFolderPath());
  if (!asked) return;
  let folder;
  try {
    folder = await checkFolder(asked);
  } catch (err) {
    return toast(t("Cannot show {path}: {error}", { path: asked, error: err.message }), "bad");
  }
  const id = folderTabFor(folder) ?? `folder:${folder}`;
  if (!side.tabs.includes(id)) {
    side.tabs.push(id);
    saveSideTabs();
    paintSideTabs();
  }
  switchInspector(id);
}

function dropSideHandle(id) {
  side.handles[id]?.destroy?.();
  delete side.handles[id];
}

/** Point a folder tab at another folder (Up, or Change…), keeping its place in the row. */
async function replaceFolderTab(oldId, asked) {
  let folder;
  try {
    folder = await checkFolder(asked);
  } catch (err) {
    return toast(t("Cannot show {path}: {error}", { path: asked, error: err.message }), "bad");
  }
  // The tab may have been closed while the server was asked.
  if (!side.tabs.includes(oldId)) return;
  const open = folderTabFor(folder);
  if (open === oldId) return;
  dropSideHandle(oldId);
  document.querySelector(`[data-insp-slot="${CSS.escape(oldId)}"]`)?.remove();
  const id = open ?? `folder:${folder}`;
  if (open) side.tabs = side.tabs.filter((tab) => tab !== oldId);
  else side.tabs = side.tabs.map((tab) => (tab === oldId ? id : tab));
  saveSideTabs();
  paintSideTabs();
  switchInspector(id);
}

async function mountFolderTab(slot, id) {
  const folder = id.slice("folder:".length);
  // Taken at once, so a second switch to this tab while the panel module loads does not
  // mount a second copy (and leak the first).
  const marker = { pending: true, destroy() {} };
  side.handles[id] = marker;
  // Closed, moved (Up, Change…) or redrawn while this was loading: let go, so opening the
  // folder again mounts a fresh panel instead of finding a handle with nothing on screen.
  const gone = () => !slot.isConnected || !side.tabs.includes(id);
  slot.replaceChildren();
  const bar = document.createElement("div");
  bar.className = "fx-bar";
  const up = document.createElement("button");
  up.type = "button";
  up.className = "mini-btn";
  up.textContent = t("↑ Up");
  const parent = parentFolder(folder);
  up.disabled = !parent;
  up.title = parent ? t("Go up to {path}", { path: parent }) : t("This is the top of the drive");
  const where = document.createElement("span");
  where.className = "fx-path";
  where.textContent = folder;
  where.title = folder;
  const change = document.createElement("button");
  change.type = "button";
  change.className = "mini-btn";
  change.textContent = t("Change…");
  change.title = t("Show another folder in this tab");
  const reveal = document.createElement("button");
  reveal.type = "button";
  reveal.className = "mini-btn";
  reveal.textContent = t("Open");
  reveal.title = t("Open this folder in File Explorer");
  bar.append(up, where, change, reveal);
  const host = document.createElement("div");
  host.className = "fx-host";
  slot.append(bar, host);
  up.onclick = () => parent && void replaceFolderTab(id, parent);
  change.onclick = async () => {
    const next = await pickFolderPath(folder);
    if (next) await replaceFolderTab(id, next);
  };
  reveal.onclick = async () => {
    try {
      // The folder's own window, the way File Explorer opens it (not selected in its parent).
      await post("/api/reveal", { path: folder, root: folder, open: true });
    } catch (err) {
      toast(err.message, "bad");
    }
  };

  const panels = await loadInspectorModule();
  if (gone()) {
    if (side.handles[id] === marker) delete side.handles[id];
    return;
  }
  if (!panels?.files?.mount) {
    host.replaceChildren(Object.assign(document.createElement("p"), { className: "side-empty", textContent: t("The Files panel could not load ({error}).", { error: inspector.error ?? t("no panels.js") }) }));
    side.handles[id] = { destroy() {} };
    return;
  }
  // The same panel as the Files tab, rooted at this folder instead of the chat's.
  const port = {
    fetchJson: (path) => api(`${path}${String(path).includes("?") ? "&" : "?"}root=${encodeURIComponent(folder)}`, { headers: { "x-rosalena-token": TOKEN } }),
    openSession,
    toast,
    fetch: (path, options) => fetch(path, options),
    rootTag: "folder",
  };
  let handle;
  try {
    handle = panels.files.mount(host, port) ?? {};
  } catch (err) {
    host.replaceChildren(Object.assign(document.createElement("p"), { className: "side-empty", textContent: t("This folder could not be shown: {error}", { error: err?.message ?? err }) }));
    side.handles[id] = { destroy() {} };
    return;
  }
  // A file picked here opens in a viewer tab, read from this folder.
  handle.onSelect = (rel) => void openFileTab(rel, { root: folder });
  side.handles[id] = handle;
  try {
    await handle.refresh?.();
  } catch {
    /* the panel says what went wrong in its own body */
  }
}

// ------------------------------------------------------------- browser tabs
//
// The + menu's "Browser": a web page in the sidebar, as many tabs as you like, each with
// Back, Forward, Reload/Stop, an address box (an address, or words to search for), a lock,
// "To chat" and "Open in your browser". In the desktop app the page is a <webview> in its
// own session, locked down by the shell (desktop/main.mjs, "Browser tabs"). It is part of
// the page, so menus and Settings draw over it, and it follows the sidebar's size, the
// full-screen sidebar and tab switches by plain CSS. Each tab's last address is kept
// across restarts (WEB_TABS_KEY). In a plain browser there is no webview: the tab says so
// and opens addresses in a real browser tab instead.

const canBrowse = () => Boolean(window.rosalenaDesktop?.canBrowse);
const SOLBROWSER_LINE = t("SolBrowser lets the agent use your own Chrome, Brave or Edge, with your logins. It is a browser extension that ships with Rosalena.");
const SOLBROWSER_PAGE = "https://rosalena.dev/download/solbrowser/";

function loadWebState() {
  web.state = sanitizeWebState(readPref(WEB_TABS_KEY), side.tabs, { appOrigin: location.origin });
}

function saveWebState() {
  clearTimeout(web.saveTimer);
  web.saveTimer = setTimeout(() => writePref(WEB_TABS_KEY, serializeWebState(web.state)), 250);
}

function webTabHint(id) {
  const entry = web.state[id];
  return entry?.url && entry.url !== "about:blank" ? `${entry.title ? `${entry.title}\n` : ""}${entry.url}` : t("Browser tab");
}

/** The tab's small site icon: the page's favicon once it has one, a globe until then. */
function webTabIcon(id) {
  const icon = web.state[id]?.icon;
  if (icon) {
    const img = document.createElement("img");
    img.className = "insp-icon";
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.src = icon;
    img.onerror = () => img.replaceWith(Object.assign(document.createElement("span"), { className: "insp-icon", textContent: "◍" }));
    return img;
  }
  return Object.assign(document.createElement("span"), { className: "insp-icon", textContent: "◍" });
}

/** Redraw one Browser tab's button (title, icon, hint) without touching its page. */
function refreshWebTabButton(id) {
  const button = document.querySelector(`.insp-tab[data-insp="${CSS.escape(id)}"]`);
  if (!button) return;
  const name = button.querySelector(".insp-name");
  if (name) name.textContent = sideTabLabel(id);
  button.querySelector(".insp-icon")?.replaceWith(webTabIcon(id));
  button.title = webTabHint(id);
}

/** An address in the person's own browser (the desktop shell hands window.open to it). */
function openOutside(url) {
  if (!url || url === "about:blank") return;
  if (!checkWebUrl(url, { appOrigin: location.origin }).ok) return toast(t("That address cannot be opened."), "bad");
  window.open(url, "_blank", "noopener");
}

function addWebTab(url = HOME_URL) {
  const id = newWebTabId(side.tabs);
  web.state[id] = { url, title: "" };
  saveWebState();
  side.tabs.push(id);
  saveSideTabs();
  paintSideTabs();
  switchInspector(id);
  return id;
}

/** Put text in the composer (after what is there), on the chat view, ready to edit. */
function addToComposer(text) {
  if (state.view !== "chat") showView("chat");
  const before = prompt.value.replace(/\s+$/, "");
  prompt.value = before ? `${before}\n\n${text}` : text;
  autosize();
  prompt.focus();
  prompt.setSelectionRange(prompt.value.length, prompt.value.length);
}

function mountWebTab(slot, id) {
  const entry = (web.state[id] ??= { url: HOME_URL, title: "" });
  slot.classList.add("web-slot");
  slot.replaceChildren();
  const bar = document.createElement("form");
  bar.className = "web-bar";
  bar.setAttribute("role", "toolbar");
  const button = (text, title) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mini-btn";
    b.textContent = text;
    b.title = title;
    b.setAttribute("aria-label", title);
    return b;
  };
  const back = button("←", t("Back"));
  const forward = button("→", t("Forward"));
  const reload = button("⟳", t("Reload"));
  const lock = document.createElement("span");
  lock.className = "web-lock";
  const address = document.createElement("input");
  address.type = "text";
  address.className = "web-address";
  address.spellcheck = false;
  address.autocomplete = "off";
  address.placeholder = t("Search or type an address");
  address.setAttribute("aria-label", t("Address"));
  address.value = entry.url === "about:blank" ? "" : entry.url;
  const send = button(t("To chat"), t("Send this page to the chat: its title, its address and any text you selected"));
  send.classList.add("web-send");
  const outside = button("↗", t("Open in your browser"));
  // Only in a narrow sidebar (styles.css): ends the button row, so the address gets its own.
  const wrap = document.createElement("span");
  wrap.className = "web-break";
  bar.append(back, forward, reload, lock, address, send, outside, wrap);
  const note = document.createElement("p");
  note.className = "web-note";
  note.hidden = true;
  const host = document.createElement("div");
  host.className = "web-host";
  slot.append(bar, note, host);

  const paintLock = (url) => {
    const kind = securityOf(url);
    lock.dataset.state = kind;
    lock.textContent = kind === "secure" ? "🔒" : kind === "insecure" ? "⚠" : kind === "local" ? "⌂" : "";
    lock.title = kind === "secure" ? t("Secure (https)") : kind === "insecure" ? t("Not secure: this page is not encrypted (http)") : kind === "local" ? t("A page on this PC or your network") : "";
  };
  const remember = (url, { resetTitle = false } = {}) => {
    if (!url || !checkWebUrl(url, { appOrigin: location.origin }).ok) return;
    entry.url = url;
    if (resetTitle) {
      entry.title = "";
      entry.icon = "";
    }
    if (document.activeElement !== address) address.value = url === "about:blank" ? "" : url;
    paintLock(url);
    saveWebState();
    refreshWebTabButton(id);
  };
  paintLock(entry.url);
  address.addEventListener("focus", () => address.select());
  address.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    // Esc puts the address back; it does not also stop a run or close the sidebar.
    event.preventDefault();
    event.stopPropagation();
    address.value = entry.url === "about:blank" ? "" : entry.url;
    address.blur();
  });
  /** What the address box asked for, checked; null (with a toast) when it cannot be opened. */
  const asked = () => {
    const parsed = parseAddress(address.value);
    if (!parsed) return null;
    if (parsed.error) {
      toast(parsed.error, "bad");
      return null;
    }
    const check = checkWebUrl(parsed.url, { appOrigin: location.origin });
    if (!check.ok) {
      toast(t("Not opened: {reason}.", { reason: check.reason }), "bad");
      return null;
    }
    return parsed.url;
  };
  outside.onclick = () => openOutside(entry.url);

  if (!canBrowse()) {
    // The web version of the app: a page cannot show other sites inside itself.
    for (const b of [back, forward, reload]) b.disabled = true;
    const empty = document.createElement("div");
    empty.className = "side-empty web-empty";
    const text = document.createElement("p");
    text.textContent = t("Browser tabs need the Rosalena desktop app: a web page cannot show other sites inside itself. Type an address or search above and it opens in your browser.");
    const open = document.createElement("button");
    open.type = "button";
    open.className = "mini-btn";
    open.textContent = t("Open in your browser");
    open.onclick = () => openOutside(entry.url);
    empty.append(text, open);
    host.append(empty);
    bar.onsubmit = (event) => {
      event.preventDefault();
      const url = asked();
      if (!url) return;
      remember(url, { resetTitle: true });
      openOutside(url);
    };
    send.onclick = () => addToComposer(pageToChatText({ url: entry.url, title: entry.title }));
    side.handles[id] = { destroy() {} };
    return;
  }

  const view = document.createElement("webview");
  view.className = "web-view";
  // Set before src and before it joins the page: the shell refuses any other partition.
  view.setAttribute("partition", BROWSER_PARTITION);
  // New-window requests reach the shell, which opens them in this same tab.
  view.setAttribute("allowpopups", "");
  view.setAttribute("src", entry.url || HOME_URL);
  host.append(view);

  let ready = false;
  const paintNav = () => {
    if (!ready) return;
    try {
      back.disabled = !view.canGoBack();
      forward.disabled = !view.canGoForward();
    } catch {
      /* the guest is between pages */
    }
  };
  back.disabled = true;
  forward.disabled = true;
  const loading = (on) => {
    reload.textContent = on ? "✕" : "⟳";
    reload.title = on ? t("Stop") : t("Reload");
    reload.setAttribute("aria-label", reload.title);
    reload.dataset.loading = on ? "1" : "";
  };
  back.onclick = () => ready && view.canGoBack() && view.goBack();
  forward.onclick = () => ready && view.canGoForward() && view.goForward();
  reload.onclick = () => {
    if (!ready) return;
    if (reload.dataset.loading) view.stop();
    else view.reload();
  };
  bar.onsubmit = (event) => {
    event.preventDefault();
    const url = asked();
    if (!url) return;
    note.hidden = true;
    remember(url, { resetTitle: true });
    // A load replaced by the next one rejects with ERR_ABORTED; did-fail-load says the rest.
    if (ready) view.loadURL(url).catch(() => {});
    else view.src = url;
    view.focus();
  };
  send.onclick = async () => {
    let selection = "";
    try {
      selection = String(await view.executeJavaScript("String(window.getSelection ? window.getSelection() : '')"));
    } catch {
      /* a page that is still loading has no selection to give */
    }
    let url = entry.url;
    let title = entry.title;
    try {
      url = view.getURL() || url;
      title = view.getTitle() || title;
    } catch {
      /* not attached yet: the saved address and title */
    }
    addToComposer(pageToChatText({ url, title, selection }));
    toast(selection ? t("The page and your selection are in the message box.") : t("The page is in the message box."), "ok");
  };

  view.addEventListener("dom-ready", () => {
    ready = true;
    paintNav();
  });
  view.addEventListener("did-start-loading", () => loading(true));
  view.addEventListener("did-stop-loading", () => {
    loading(false);
    paintNav();
  });
  view.addEventListener("did-navigate", (event) => {
    note.hidden = true;
    remember(event.url, { resetTitle: event.url !== entry.url });
    paintNav();
  });
  view.addEventListener("did-navigate-in-page", (event) => {
    if (event.isMainFrame) remember(event.url);
    paintNav();
  });
  view.addEventListener("page-title-updated", (event) => {
    entry.title = String(event.title ?? "").slice(0, 160);
    saveWebState();
    refreshWebTabButton(id);
  });
  view.addEventListener("page-favicon-updated", (event) => {
    const icon = (event.favicons ?? []).find((src) => /^(https?:|data:image\/)/i.test(String(src)));
    if (!icon || icon === entry.icon) return;
    entry.icon = icon;
    refreshWebTabButton(id);
  });
  view.addEventListener("did-fail-load", (event) => {
    // -3 is "aborted": the person (or the page) moved on before it finished.
    if (!event.isMainFrame || event.errorCode === -3) return;
    note.hidden = false;
    note.textContent = t("Could not open {url}: {error}.", { url: clip(String(event.validatedURL ?? ""), 120), error: event.errorDescription || t("error {code}", { code: event.errorCode }) });
  });
  view.addEventListener("render-process-gone", () => {
    note.hidden = false;
    note.textContent = t("This page stopped working. Reload to try again.");
    loading(false);
  });
  side.handles[id] = {
    view,
    destroy() {
      view.remove();
    },
  };
}

/** "Get SolBrowser…": one line on what it is, then set it up, see the steps, or the download page. */
function openSolBrowserMenu(anchor) {
  document.querySelector(".side-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "side-menu sol-menu";
  menu.setAttribute("role", "menu");
  const head = document.createElement("p");
  head.className = "side-menu-head";
  head.textContent = "SolBrowser";
  const line = document.createElement("p");
  line.className = "side-menu-note";
  line.textContent = SOLBROWSER_LINE;
  menu.append(head, line);
  const action = (label, hint, run) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "side-menu-item";
    b.setAttribute("role", "menuitem");
    b.textContent = label;
    b.title = hint;
    b.onclick = run;
    menu.append(b);
    return b;
  };
  action(t("Set up and show the folder"), t("Copies the extension to your data folder and opens that folder"), async () => {
    const info = await setUpSolBrowser();
    if (!info?.steps) return;
    // The menu stays: the steps are what to do next.
    const list = document.createElement("ol");
    list.className = "side-menu-steps";
    for (const step of info.steps) list.append(Object.assign(document.createElement("li"), { textContent: step }));
    menu.querySelectorAll(".side-menu-item, .side-menu-steps").forEach((node) => node.remove());
    menu.append(list);
  });
  action(t("Open the download page"), t("{url} (the extension as a .zip, and how to load it)", { url: SOLBROWSER_PAGE }), () => {
    menu.remove();
    if (canBrowse()) addWebTab(SOLBROWSER_PAGE);
    else openOutside(SOLBROWSER_PAGE);
  });
  floatSideMenu(menu, anchor);
}

async function mountSideTab(id) {
  const slot = document.querySelector(`[data-insp-slot="${CSS.escape(id)}"]`);
  if (!slot) return;
  el("insp-empty").hidden = true;
  slot.hidden = false;
  if (id.startsWith("plugin:")) {
    if (side.handles[id]) return;
    const plugins = await loadSidePlugins();
    const plugin = plugins.find((p) => `plugin:${p.id}` === id);
    if (!plugin) {
      slot.innerHTML = `<p class="side-empty">${t("That plugin is not installed or is switched off.")}</p>`;
      return;
    }
    slot.replaceChildren();
    side.handles[id] = mountPlugin({
      container: slot,
      plugin,
      compose: (text) => {
        prompt.value = text;
        autosize();
        prompt.focus();
      },
      onThemeChange: () => toast(t("The app's look was changed by a plugin. Style Lab's Default look puts it back."), "ok"),
    });
    return;
  }
  if (id === "terminal") {
    placeTerminal("side");
    return;
  }
  if (id.startsWith("file:")) {
    if (!slot.dataset.shown) {
      slot.dataset.shown = "1";
      void renderFileViewer(slot, id.slice(5));
    }
    return;
  }
  if (id.startsWith("folder:")) {
    if (!side.handles[id]) await mountFolderTab(slot, id);
    else await side.handles[id].refresh?.();
    return;
  }
  if (isWebTabId(id)) {
    if (!side.handles[id]) mountWebTab(slot, id);
    return;
  }
  renderSideTab(id);
  if (id === "local" && !side.timers[id]) side.timers[id] = setInterval(() => layout.tab === "local" && renderSideTab("local"), 3000);
}

function sideRow(label, value, kind = "") {
  const row = document.createElement("div");
  row.className = `side-row ${kind}`.trim();
  const a = document.createElement("span");
  a.textContent = label;
  const b = document.createElement("span");
  b.className = "side-val";
  b.textContent = value;
  row.append(a, b);
  return row;
}

async function renderSideTab(id) {
  const slot = document.querySelector(`[data-insp-slot="${CSS.escape(id)}"]`);
  if (!slot || slot.hidden) return;
  const box = document.createElement("div");
  box.className = "side-view";
  if (id === "tasks") {
    const items = side.todos.filter((t) => String(t?.content ?? "").trim());
    if (!items.length) box.innerHTML = `<p class="side-empty">${t("This chat has no task list yet. It appears here as soon as the agent writes one.")}</p>`;
    else {
      const done = items.filter((t) => t.status === "completed").length;
      box.append(sideRow(t("Progress"), t("{done} of {total}", { done, total: items.length })));
      const ol = document.createElement("ol");
      ol.className = "side-todos";
      for (const t of items) {
        const li = document.createElement("li");
        li.dataset.status = String(t.status ?? "pending");
        li.textContent = `${t.status === "completed" ? "✓" : t.status === "in_progress" ? "◐" : "○"} ${t.content}`;
        ol.append(li);
      }
      box.append(ol);
    }
  } else if (id === "local") {
    let probe = null;
    try {
      probe = await api("/api/local-model");
    } catch (err) {
      box.innerHTML = `<p class="side-empty">${t("Could not ask the local server: {error}", { error: err.message })}</p>`;
    }
    if (probe) {
      const state2 = probe.loading ? t("loading") : !probe.up ? t("not running") : probe.busy ? t("generating") : t("idle");
      box.append(sideRow(t("Server"), state2, probe.up ? (probe.busy ? "busy" : "ok") : "bad"));
      if (probe.model) box.append(sideRow(t("Model"), String(probe.model).split(/[\\/]/).pop()));
      if (probe.ctx) box.append(sideRow(t("Context"), t("{tokens} tokens", { tokens: Number(probe.ctx).toLocaleString() })));
      if (probe.totalSlots) box.append(sideRow(t("Slots"), t("{free} free of {total}", { free: probe.slotsAvailable ?? "?", total: probe.totalSlots })));
      for (const s of probe.slots ?? []) {
        if (!s.busy) continue;
        const what = s.task ? clip(String(s.task), 60) : t("working");
        const progress = Number.isFinite(Number(s.promptProgress)) ? ` · ${t("prompt {pct}%", { pct: Math.round(Number(s.promptProgress) * 100) })}` : "";
        box.append(sideRow(t("Slot {id}", { id: s.id }), `${what}${s.decoded ? ` · ${t("{tokens} tokens out", { tokens: s.decoded })}` : ""}${progress}`, "busy"));
      }
      if (probe.queued) box.append(sideRow(t("Waiting"), String(probe.queued)));
      const calls = (probe.harnessCalls ?? []).slice(-6).reverse();
      if (calls.length) {
        const head = document.createElement("p");
        head.className = "side-head";
        head.textContent = t("Recent calls");
        box.append(head);
        for (const c of calls) box.append(sideRow(clip(String(c.cls ?? c.target ?? t("call")), 28), `${c.state ?? (c.ok ? t("done") : t("failed"))}${c.ms ? ` · ${humanMs(c.ms)}` : ""}`, c.ok === false ? "bad" : ""));
      }
      if (probe.error) box.append(sideRow(t("Problem"), clip(String(probe.error), 120), "bad"));
    }
  } else if (id === "context") {
    const m = side.meter;
    if (!m?.window) box.innerHTML = `<p class="side-empty">${t("No reading yet for this chat. Send a message and it fills in.")}</p>`;
    else {
      const pct = Math.round((Number(m.used) / Number(m.window)) * 100);
      box.append(sideRow(t("Used"), t("{used} of {window} ({pct}%)", { used: contextTokens(m.used), window: contextTokens(m.window), pct }), pct > 85 ? "bad" : ""));
      const bar = document.createElement("div");
      bar.className = "side-bar";
      const fill = document.createElement("span");
      fill.style.width = `${Math.min(100, pct)}%`;
      bar.append(fill);
      if (m.threshold) {
        const mark = document.createElement("i");
        mark.style.left = `${Math.min(100, (Number(m.threshold) / Number(m.window)) * 100)}%`;
        mark.title = t("compacts at {tokens}", { tokens: contextTokens(m.threshold) });
        bar.append(mark);
      }
      box.append(bar);
      if (m.threshold) box.append(sideRow(t("Compacts at"), contextTokens(m.threshold)));
      box.append(sideRow(t("System"), contextTokens(m.parts?.system)), sideRow(t("Tools"), contextTokens(m.parts?.tools)), sideRow(t("Messages"), contextTokens(m.parts?.messages)));
    }
    const head = document.createElement("p");
    head.className = "side-head";
    head.textContent = side.compactions.length ? t("Compactions ({count})", { count: side.compactions.length }) : t("No compactions in this chat");
    box.append(head);
    for (const c of side.compactions.slice().reverse()) {
      box.append(sideRow(t("Step {step}", { step: c.step ?? "?" }), `${t("{before} → {after} · {dropped} messages summarised", { before: contextTokens(c.tokensBefore), after: contextTokens(c.tokensAfter), dropped: c.dropped ?? 0 })}${c.how ? ` (${c.how})` : ""}`));
    }
  } else if (id === "pins") {
    const efforts = readChatEfforts();
    const here = state.current?.kind === "rosalena" ? state.current.thread : null;
    const rows = (state.all.chats ?? []).filter((c) => !(c.depth > 0)).slice(0, 40);
    if (!rows.length) box.innerHTML = `<p class="side-empty">${t("No chats yet.")}</p>`;
    for (const chat of rows) {
      const model = chatModelFor(chat.id) || chat.model || chat.cls || "";
      const effort = efforts[chat.id]?.effort;
      const row = sideRow(clip(chat.title ?? chat.id, 34), `${modelDisplayName(model) || t("default")}${effort ? ` · ${EFFORT_NAMES[effort] ?? effort}` : ""}`, chat.id === here ? "here" : "");
      row.classList.add("side-link");
      row.title = t("Open this chat");
      row.onclick = () => openChat(chat.id);
      box.append(row);
    }
  }
  slot.replaceChildren(box);
}

// ------------------------------------------------------------- file viewer tabs
//
// Clicking a file in the Files tab opens it in a tab of its own: text and code with line
// numbers, Markdown rendered, pictures, PDF, video and audio, an HTML page (sandboxed),
// and PowerPoint / Word / Excel as their slides, pages and sheets. Read through /api/file
// (file-preview.mjs on the server), which serves only files inside the workspace.

const FILE_TABS_MAX = 8;
// An <img>, <iframe> or <video> cannot send the token header, and the token must never sit
// in a URL (a sandboxed HTML file could read its own address). So each draw asks for a
// ticket: good for this one file, for 30 minutes.
const fileUrl = (ticket, route = "/api/file", extra = "") => `${route}?k=${encodeURIComponent(ticket)}${extra}`;
// Read through the file's own folder, so a file opened from a folder tab (anywhere on this
// PC) reads the same as one in the workspace. Still behind the page token: the server only
// takes a root from a request that carries it.
const fileScope = (abs) => {
  const folder = abs ? parentFolder(abs) : currentWorkspace();
  return folder ? `&root=${encodeURIComponent(folder)}` : "";
};
async function fileTicket(abs) {
  const out = await api(`/api/file/ticket?abs=${encodeURIComponent(abs)}${fileScope(abs)}`, { headers: { "x-rosalena-token": TOKEN } });
  return out.ticket;
}

/** The Files tab picked a file: open (or switch to) its viewer tab. */
async function openFileTab(rel, { root = "" } = {}) {
  // From a folder tab: that folder. From the Files tab: the chat's folder.
  const scope = root
    ? `&root=${encodeURIComponent(root)}`
    : state.current?.kind === "rosalena"
      ? `&chat=${encodeURIComponent(state.current.thread ?? state.current.id)}`
      : currentWorkspace()
        ? `&root=${encodeURIComponent(currentWorkspace())}`
        : "";
  let info;
  try {
    info = await api(`/api/file/info?path=${encodeURIComponent(rel)}${scope}`, { headers: { "x-rosalena-token": TOKEN } });
  } catch (err) {
    return toast(`Could not open ${rel}: ${err.message}`, "bad");
  }
  const id = `file:${info.abs}`;
  if (!side.tabs.includes(id)) {
    side.tabs.push(id);
    // Only the newest few files stay open; the oldest file tab closes first.
    const files = side.tabs.filter((tab) => tab.startsWith("file:"));
    for (const old of files.slice(0, Math.max(0, files.length - FILE_TABS_MAX))) {
      side.tabs = side.tabs.filter((tab) => tab !== old);
      document.querySelector(`[data-insp-slot="${CSS.escape(old)}"]`)?.remove();
    }
    saveSideTabs();
    paintSideTabs();
  }
  switchInspector(id);
}

function viewerBar(abs, info, onReload) {
  const bar = document.createElement("div");
  bar.className = "fv-bar";
  const name = document.createElement("strong");
  name.textContent = abs.split(/[\\/]/).pop();
  name.title = abs;
  const meta = document.createElement("span");
  meta.className = "fv-meta";
  meta.textContent = info ? `${humanBytes(info.size)} · ${info.kind}` : "";
  const reload = document.createElement("button");
  reload.type = "button";
  reload.className = "mini-btn";
  reload.textContent = t("Reload");
  reload.onclick = onReload;
  const reveal = document.createElement("button");
  reveal.type = "button";
  reveal.className = "mini-btn";
  reveal.textContent = t("Show in folder");
  reveal.onclick = async () => {
    try {
      await post("/api/reveal", { path: abs, root: abs.replace(/[\\/][^\\/]*$/, "") });
    } catch (err) {
      toast(err.message, "bad");
    }
  };
  bar.append(name, meta, reload, reveal);
  return bar;
}

async function renderFileViewer(slot, abs) {
  const draw = () => void renderFileViewer(slot, abs);
  let info = null;
  let ticket = "";
  try {
    info = await api(`/api/file/info?abs=${encodeURIComponent(abs)}${fileScope(abs)}`, { headers: { "x-rosalena-token": TOKEN } });
    ticket = await fileTicket(abs);
  } catch (err) {
    slot.replaceChildren(viewerBar(abs, null, draw), Object.assign(document.createElement("p"), { className: "side-empty", textContent: t("Cannot open it: {error}", { error: err.message }) }));
    return;
  }
  const view = document.createElement("div");
  view.className = `fv fv-${info.kind}`;
  const src = fileUrl(ticket);
  const frame = (sandboxed) => {
    const iframe = document.createElement("iframe");
    iframe.name = "rosalena-file";
    iframe.className = "fv-frame";
    iframe.title = info.name;
    if (sandboxed) iframe.setAttribute("sandbox", "allow-scripts");
    iframe.src = src;
    return iframe;
  };
  try {
    if (info.kind === "image") {
      const img = document.createElement("img");
      img.className = "fv-image";
      img.alt = info.name;
      img.src = src;
      view.append(img);
    } else if (info.kind === "pdf") {
      view.append(frame(false));
    } else if (info.kind === "html") {
      const note = document.createElement("p");
      note.className = "fv-note";
      note.textContent = t("Shown sandboxed: its scripts run, but it cannot reach the app or your other files.");
      view.append(note, frame(true));
    } else if (info.kind === "video" || info.kind === "audio") {
      const media = document.createElement(info.kind);
      media.controls = true;
      media.src = src;
      media.className = "fv-media";
      view.append(media);
    } else if (info.kind === "text" || info.kind === "markdown") {
      const res = await fetch(src);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      const text = await res.text();
      if (info.kind === "markdown") {
        const md = document.createElement("div");
        md.className = "fv-markdown md";
        md.innerHTML = renderMarkdown(text);
        view.append(md);
      } else {
        const pre = document.createElement("pre");
        pre.className = "fv-code";
        const lines = text.split(/\r?\n/);
        const shown = lines.slice(0, 20000);
        pre.textContent = shown.map((line, i) => `${String(i + 1).padStart(String(shown.length).length, " ")}  ${line}`).join("\n");
        view.append(pre);
        if (lines.length > shown.length) view.append(Object.assign(document.createElement("p"), { className: "fv-note", textContent: t("Showing the first {shown} of {total} lines.", { shown: shown.length.toLocaleString(), total: lines.length.toLocaleString() }) }));
      }
    } else if (info.kind === "office") {
      const preview = await api(fileUrl(ticket, "/api/file/office"));
      const part = (entry) => fileUrl(ticket, "/api/file/part", `&entry=${encodeURIComponent(entry)}`);
      if (preview.kind === "slides") {
        for (const slide of preview.slides) {
          const card = document.createElement("section");
          card.className = "fv-slide";
          const head = document.createElement("span");
          head.className = "fv-slide-n";
          head.textContent = t("Slide {number}", { number: slide.n });
          card.append(head);
          for (const line of slide.lines) card.append(Object.assign(document.createElement("p"), { textContent: line }));
          for (const entry of slide.images) card.append(Object.assign(document.createElement("img"), { className: "fv-slide-img", src: part(entry), alt: "" }));
          view.append(card);
        }
        if (!preview.slides.length) view.append(Object.assign(document.createElement("p"), { className: "side-empty", textContent: t("No slides found.") }));
      } else if (preview.kind === "document") {
        const doc = document.createElement("div");
        doc.className = "fv-doc";
        for (const line of preview.paragraphs) doc.append(Object.assign(document.createElement("p"), { textContent: line }));
        for (const entry of preview.images) doc.append(Object.assign(document.createElement("img"), { className: "fv-slide-img", src: part(entry), alt: "" }));
        view.append(doc);
      } else if (preview.kind === "sheets") {
        for (const sheet of preview.sheets) {
          view.append(Object.assign(document.createElement("p"), { className: "side-head", textContent: sheet.name }));
          const table = document.createElement("table");
          table.className = "fv-table";
          for (const row of sheet.rows) {
            const tr = document.createElement("tr");
            for (const cell of row) tr.append(Object.assign(document.createElement("td"), { textContent: cell }));
            table.append(tr);
          }
          view.append(table);
        }
      }
      view.append(Object.assign(document.createElement("p"), { className: "fv-note", textContent: t("A text-and-pictures preview. Layout, fonts and animations show in the app the file belongs to (Show in folder, then open it).") }));
    } else {
      view.append(Object.assign(document.createElement("p"), { className: "side-empty", textContent: t("No preview for this kind of file. Show it in its folder to open it with its own app.") }));
    }
  } catch (err) {
    view.append(Object.assign(document.createElement("p"), { className: "side-empty", textContent: t("Could not show it: {error}", { error: err.message }) }));
  }
  slot.replaceChildren(viewerBar(abs, info, draw), view);
}

// The sidebar's full-screen button: the right dock fills the window; the button or Esc
// puts it back. Esc is taken in the capture phase so one press does only this.
function setSideFull(on) {
  const root = document.documentElement;
  const next = on ?? !root.classList.contains("side-full");
  // Full screen on a sidebar folded to its rail filled the window with an empty rail:
  // open it first (it stays open afterwards, which is what asking to see it means).
  if (next && layout.panels?.inspector?.collapsed) setPanel("inspector", { collapsed: false });
  root.classList.toggle("side-full", next);
  const button = el("side-full");
  if (button) {
    button.setAttribute("aria-pressed", String(next));
    button.textContent = next ? "✕" : "⛶";
    button.title = next ? t("Back to the normal layout (Esc)") : t("Fill the window with the sidebar (Esc to go back)");
  }
}
el("side-full")?.addEventListener("click", () => setSideFull());
document.addEventListener(
  "keydown",
  (event) => {
    if (event.key !== "Escape" || document.fullscreenElement || !document.documentElement.classList.contains("side-full")) return;
    if (document.querySelector(".ask-back, .side-menu")) return;
    event.stopImmediatePropagation();
    setSideFull(false);
  },
  true,
);

/** Refresh whichever live tab is showing (called when the chat's events move). */
function refreshSideTabs() {
  if (layout.tab && SIDE_BUILTINS[layout.tab] && layout.tab !== "terminal") void renderSideTab(layout.tab);
}

// The terminal can live in the middle (its own view) or in the sidebar tab; it is one
// element, moved between the two, so its shells and scrollback are the same either way.
function placeTerminal(where) {
  const node = el("terminal");
  if (!node) return;
  if (!terminalHome.parent) {
    terminalHome.parent = node.parentElement;
    terminalHome.next = node.nextSibling;
  }
  if (where === "side") {
    const slot = document.querySelector('[data-insp-slot="terminal"]');
    if (!slot) return;
    if (state.view === "terminal") showView("chat");
    slot.replaceChildren(node);
    node.hidden = false;
    node.classList.add("in-side");
    terminalHome.where = "side";
    void termBoot();
  } else if (terminalHome.where === "side") {
    terminalHome.parent.insertBefore(node, terminalHome.next);
    node.classList.remove("in-side");
    terminalHome.where = "main";
    node.hidden = state.view !== "terminal";
    const slot = document.querySelector('[data-insp-slot="terminal"]');
    if (slot) slot.innerHTML = `<p class="side-empty">${t("The terminal is open in the middle. Click this tab again to bring it here.")}</p>`;
  }
}

// ------------------------------------------------------------- the trajectory view
//
// The Trajectory tab is the same event stream the transcript uses, reduced to what
// changed: one compact row per tool call, oldest first, newest at the bottom. A row reads
// "<verb> <target>" - "wrote harness/ui/app.js", "ran node --test", "read data/roles.json"
// - with a tick or a cross for whether the call succeeded.
//
// Rows are not invented. A row exists because the harness emitted a `tool` event; its verb
// comes from the tool's own name, and its target is the path the arguments name, else the
// command / pattern / task the tool was given, else nothing at all. A chat whose run used
// no tools has no rows and says "nothing changed yet" rather than showing a step list that
// only looks like a change log. The tab is read-only: it reports, it changes nothing.
//
// What it cannot show: the harness records the call and the first 300 characters of its
// result, not side effects. A file written by a shell command therefore appears as the
// command that ran, never as a diff, and a call is only labelled a write if the tool's own
// name says it writes.

const TRAIL_LIMIT = 600;
const trailEl = el("trail");
const trailList = el("trail-list");

// Tool name -> the verb a person would use for it. This table renames calls; it never
// reinterprets them, so only a tool whose name says it writes gets "wrote".
const TOOL_VERBS = [
  [/^(write|write_file|writefile|edit|edit_file|apply_patch|create|create_file|append|append_file|patch)$/i, t("wrote")],
  [/^(read|read_file|readfile|view|open_file)$/i, t("read (past)")],
  [/^(list_dir|listdir|list|ls|list_files)$/i, t("listed")],
  [/^(search|grep|find|search_files|rg|glob)$/i, t("searched")],
  [/^web_search$/i, t("searched the web")],
  [/^web_fetch$/i, t("fetched")],
  [/^(job_output|job_list)$/i, t("checked (past)")],
  [/^todo_(write|read)$/i, t("updated the checklist")],
  [/^read_image$/i, t("viewed")],
  [/^(run_command|run|bash|shell|exec|execute|run_terminal_cmd|powershell|pwsh)$/i, t("ran")],
  [/^(delegate|subagent|spawn|task)$/i, t("delegated")],
];

function toolVerb(name) {
  const text = String(name ?? "").trim();
  for (const [pattern, verb] of TOOL_VERBS) if (pattern.test(text)) return verb;
  // An unknown tool still gets a row, and its own name is the most honest word for it.
  return text ? text.replace(/[_-]+/g, " ") : t("used (past)");
}

/** The one thing a tool call was told to act on, in the tool's own terms. */
function trailTarget(entry) {
  const args = entry.args;
  if (typeof args === "string") {
    const line = args.replace(/\s+/g, " ").trim();
    return line ? clip(line, 140) : "";
  }
  if (!args || typeof args !== "object") return entry.path || "";
  // The file keys come first, and unlike toolPath they accept a bare directory name: a
  // trajectory row may name `docs`, which is not a path the reveal button could open.
  for (const key of [
    "path",
    "file_path",
    "filepath",
    "file",
    "filename",
    "dir",
    "directory",
    "target",
    "command",
    "cmd",
    "pattern",
    "query",
    "url",
    "task",
    "prompt",
    "include",
    "name",
  ]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return clip(value.replace(/\s+/g, " ").trim(), 140);
  }
  return entry.path || "";
}

/** Reset both the data and the DOM: the trajectory belongs to one chat at a time. */
function trailReset() {
  state.trail = [];
  state.revealPath = "";
  if (trailList) trailList.textContent = "";
  trailEl?.classList.remove("has-rows");
  paintTrailCount();
}

function paintTrailCount() {
  const badge = el("trail-count");
  if (!badge) return;
  const rows = state.trail?.length ?? 0;
  badge.hidden = rows === 0;
  badge.textContent = String(rows);
  badge.title = rows === 0 ? "" : t("{n} changes in this chat", { n: rows });
}

/**
 * One event -> one change, or nothing. Only a tool call is a change: a model step, a run
 * starting and a run ending are not. Deltas are never rows.
 *
 * The row keeps what the harness actually recorded: the call's name, the arguments it was
 * given, whether it succeeded, how long it took, and the first 300 characters of the result
 * (`preview`). There is no diff, because the run log has no diff - the row shows the call
 * that caused a change, not the change itself, and says so in the tab's own empty state.
 */
function trailEntry(event) {
  if (event?.type !== "tool") return null;
  const args = event.args ?? null;
  const name = event.name ?? "tool";
  return {
    kind: "tool",
    at: Date.now(),
    step: Number.isFinite(event.step) ? event.step : null,
    name,
    verb: toolVerb(name),
    args,
    ok: event.ok !== false,
    ms: event.ms ?? null,
    preview: typeof event.preview === "string" ? event.preview : "",
    path: toolPath(args),
  };
}

/** The file a tool call names, if it names one in a field tools actually use. */
function toolPath(args) {
  if (!args || typeof args !== "object") return "";
  for (const key of ["path", "file_path", "filepath", "file", "target", "filename", "dir", "directory"]) {
    const value = args[key];
    if (typeof value !== "string" || !value) continue;
    // A bare word ("readme") is not a path this page could reveal; a separator or a dot
    // in the last segment makes it one.
    if (/[\\/]/.test(value) || /\.[a-z0-9]{1,8}$/i.test(value)) return value;
  }
  return "";
}

function recordTrail(event) {
  const entry = trailEntry(event);
  if (!entry) return;
  state.trail ??= [];
  state.trail.push(entry);
  // Appended, not re-derived: a 300-call run costs one row per call rather than a repaint
  // of the whole list per event, and every row is a real event.
  if (trailList && state.trail.length <= TRAIL_LIMIT) trailList.append(trailRow(entry));
  if (state.trail.length === TRAIL_LIMIT + 1 && trailList) {
    const note = document.createElement("li");
    note.className = "trail-row trail-more";
    note.textContent = t("the list stops at {limit} rows; this chat made more calls", { limit: TRAIL_LIMIT });
    trailList.append(note);
  }
  trailEl?.classList.add("has-rows");
  paintTrailCount();
  if (entry.path) {
    // The reveal button targets the file the last tool named, which is the only file path
    // the page can honestly claim to know about.
    state.revealPath = entry.path;
    paintReveal();
  }
}

function trailRow(entry) {
  const row = document.createElement("li");
  // No `tool` class: the transcript's .tool blocks are boxed cards, and a trajectory row
  // is a line. The kind lives in a data attribute, which styles and tests can both read.
  row.className = "trail-row";
  row.dataset.kind = entry.kind;

  // The sentence: a tick or a cross, the verb, the thing it acted on, then the quiet facts.
  const head = document.createElement("div");
  head.className = "trail-head";

  const mark = document.createElement("span");
  mark.className = `trail-mark${entry.ok ? " ok" : " bad"}`;
  mark.textContent = entry.ok ? "✓" : "×";
  mark.setAttribute("aria-hidden", "true");

  const verb = document.createElement("span");
  verb.className = "trail-verb";
  verb.textContent = entry.verb;
  head.append(mark, verb);

  const target = trailTarget(entry);
  if (target) {
    const what = document.createElement("span");
    what.className = "trail-what";
    what.textContent = target;
    head.append(document.createTextNode(" "), what);
  }
  if (!entry.ok) {
    const failed = document.createElement("span");
    failed.className = "trail-tag bad";
    failed.textContent = t("failed");
    head.append(failed);
  }

  // Step number and duration: the two numbers the harness records for every call, kept on
  // the right so a column of rows can be read down.
  const meta = document.createElement("span");
  meta.className = "trail-meta";
  meta.textContent = [entry.step !== null ? t("step {step}", { step: entry.step }) : "", entry.ms !== null ? humanMs(entry.ms) : ""]
    .filter(Boolean)
    .join(" · ");
  if (meta.textContent) head.append(meta);
  row.append(head);

  // The arguments, clipped to one line. This is what the model asked for, verbatim: a path,
  // a command, a pattern. Without it a row says "edited" and nothing more.
  const args = trailArgs(entry.args);
  if (args) {
    const line = document.createElement("p");
    line.className = "trail-args";
    line.textContent = args;
    line.title = args;
    row.append(line);
  }

  // The first 300 characters of what the call returned, on one line: the run log's own
  // summary, not a diff the page invented.
  if (entry.preview) {
    const line = document.createElement("p");
    line.className = `trail-preview${entry.ok ? "" : " bad"}`;
    line.textContent = clip(entry.preview.replace(/\s+/g, " ").trim(), 200);
    line.title = entry.preview;
    row.append(line);
  }

  // The tool's real name stays in the title: the row itself is the sentence.
  row.title = `${entry.name}${entry.ms !== null ? ` · ${humanMs(entry.ms)}` : ""}${entry.ok ? "" : ` · ${t("failed")}`}`;
  return row;
}

/** The arguments of a call as one readable line, or "" when there were none. */
function trailArgs(args) {
  if (args === null || args === undefined) return "";
  if (typeof args === "string") {
    const text = args.replace(/\s+/g, " ").trim();
    return text ? clip(text, 200) : "";
  }
  if (typeof args !== "object") return "";
  const keys = Object.keys(args);
  if (!keys.length) return "";
  try {
    return clip(JSON.stringify(args), 200);
  } catch {
    return "";
  }
}

/** One tab row, two panels: the transcript and the trajectory occupy the same cell. */
function showView(view) {
  const next = view === "trajectory" || view === "terminal" ? view : "chat";
  state.view = next;
  app.dataset.view = next;
  for (const tab of document.querySelectorAll(".view-tab")) {
    tab.setAttribute("aria-selected", tab.dataset.view === next ? "true" : "false");
  }
  if (log) log.hidden = next !== "chat";
  if (trailEl) trailEl.hidden = next !== "trajectory";
  // The terminal may be sitting in the sidebar tab: the middle Terminal view takes it back.
  if (next === "terminal" && terminalHome.where === "side") placeTerminal("main");
  const terminalEl = el("terminal");
  const terminalInSide = terminalHome.where === "side";
  if (terminalEl && !terminalInSide) terminalEl.hidden = next !== "terminal";
  // The composer belongs to the chat; the terminal has its own input line.
  const composerEl = document.querySelector(".composer");
  if (composerEl) composerEl.hidden = next === "terminal";
  if (next === "terminal") {
    void termBoot();
    setTimeout(() => el("term-input")?.focus(), 0);
  }
  paintTrailCount();
}

// ------------------------------------------------------------------ terminal tab
//
// The person's own console (src/terminal.mjs on the server): one shell per sub-tab, kept
// alive while the window is open, replayed on reconnect. Not a model tool.

const term = { sessions: [], active: null, history: [], historyAt: -1, booted: false };
const termEl = el("terminal");
const termOut = el("term-out");
const termInput = el("term-input");

function termSession(id = term.active) {
  return term.sessions.find((s) => s.id === id) ?? null;
}

/** The chat the Terminal tab is showing: its thread, or "draft" for a chat not sent yet. */
function termKey() {
  return state.current?.thread ?? "draft";
}

function termMine() {
  return term.sessions.filter((s) => (s.tag ?? "draft") === termKey());
}

/** Another chat is on screen: show its shells, and open one in its folder if it has none. */
function termSwitchChat() {
  if (!term.booted) return;
  const mine = termMine();
  term.active = mine.at(-1)?.id ?? null;
  termPaintTabs();
  termPaintOutput();
  if (!mine.length && state.view === "terminal") void termOpen();
}

/** A new chat's shells become that chat's once its first message creates the thread. */
function termAdoptDraft(thread) {
  for (const s of term.sessions) {
    if ((s.tag ?? "draft") !== "draft") continue;
    s.tag = thread;
    void post("/api/terminal/tag", { id: s.id, tag: thread }).catch(() => null);
  }
}

function termPaintTabs() {
  const bar = el("term-tabs");
  if (!bar) return;
  bar.replaceChildren(
    ...termMine().map((s, i) => {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "term-tab";
      tab.setAttribute("aria-pressed", String(s.id === term.active));
      tab.textContent = `${s.shell} ${i + 1}${s.exited ? ` (${t("exited")})` : ""}`;
      tab.title = s.cwd;
      tab.onclick = () => termSelect(s.id);
      return tab;
    }),
  );
}

function termPaintOutput() {
  const s = termSession();
  termOut.textContent = s ? s.text : "";
  termOut.scrollTop = termOut.scrollHeight;
  if (termInput) termInput.disabled = !s || Boolean(s.exited);
  el("term-stop").disabled = !s;
}

// Shell output carries ANSI colour codes now and then; a plain <pre> shows them as junk.
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*\x07/g;

function termAttach(s) {
  s.stream?.close();
  const es = new EventSource(`/api/terminal/stream?id=${encodeURIComponent(s.id)}&token=${encodeURIComponent(TOKEN)}`);
  s.stream = es;
  es.onmessage = (message) => {
    const event = JSON.parse(message.data);
    if (event.type === "out") {
      const text = event.data.replace(ANSI, "").replace(/\r\n/g, "\n").replace(/\r/g, "");
      s.text = event.replay ? text : s.text + text;
      if (s.text.length > 400_000) s.text = s.text.slice(-300_000);
    } else if (event.type === "exit") {
      s.exited = { code: event.code };
      s.text += `\n${event.code === null || event.code === undefined ? t("[process exited]") : t("[process exited with code {code}]", { code: event.code })}\n`;
      es.close();
      termPaintTabs();
    }
    if (s.id === term.active) {
      const atEnd = termOut.scrollHeight - termOut.scrollTop - termOut.clientHeight < 40;
      termOut.textContent = s.text;
      if (atEnd) termOut.scrollTop = termOut.scrollHeight;
      if (s.exited) termPaintOutput();
    }
  };
}

function termSelect(id) {
  term.active = id;
  termPaintTabs();
  termPaintOutput();
  termInput?.focus();
}

async function termOpen(shell) {
  try {
    const s = await post("/api/terminal/open", { shell: shell || el("term-shell")?.value, cwd: currentWorkspace(), tag: termKey() });
    const session = { ...s, text: "" };
    term.sessions.push(session);
    termAttach(session);
    termSelect(session.id);
  } catch (err) {
    toast(t("Terminal: {error}", { error: err.message }), "bad");
  }
}

async function termBoot() {
  if (term.booted) return;
  term.booted = true;
  try {
    const body = await api("/api/terminal", { headers: { "x-rosalena-token": TOKEN } });
    const pick = el("term-shell");
    if (pick) pick.innerHTML = body.shells.map((name) => `<option value="${name}">${name}</option>`).join("");
    // Shells survive a page reload on the server: pick them back up instead of leaking them.
    for (const s of body.terminals) {
      const session = { ...s, text: "" };
      term.sessions.push(session);
      if (!s.exited) termAttach(session);
    }
    const mine = termMine();
    if (mine.length) termSelect(mine.at(-1).id);
    else await termOpen(body.shells[0]);
  } catch (err) {
    term.booted = false;
    termOut.textContent = t("The terminal could not start: {error}", { error: err.message });
  }
}

async function termSend(line) {
  const s = termSession();
  if (!s || s.exited) return;
  if (line.trim()) {
    term.history.push(line);
    if (term.history.length > 200) term.history.shift();
  }
  term.historyAt = -1;
  // cmd echoes what it runs; PowerShell on a pipe does not, so the line is shown here.
  if (s.shell !== "cmd") {
    s.text += `PS> ${line}\n`;
    termOut.textContent = s.text;
    termOut.scrollTop = termOut.scrollHeight;
  }
  try {
    await post("/api/terminal/input", { id: s.id, data: `${line}\r\n` });
  } catch (err) {
    toast(t("Terminal: {error}", { error: err.message }), "bad");
  }
}

async function termStop() {
  const s = termSession();
  if (!s) return;
  s.stream?.close();
  await post("/api/terminal/close", { id: s.id }).catch(() => null);
  term.sessions = term.sessions.filter((x) => x.id !== s.id);
  term.active = termMine().at(-1)?.id ?? null;
  termPaintTabs();
  termPaintOutput();
}

function bindTerminal() {
  if (!termEl) return;
  el("term-new")?.addEventListener("click", () => void termOpen());
  el("term-stop")?.addEventListener("click", () => void termStop());
  el("term-clear")?.addEventListener("click", () => {
    const s = termSession();
    if (s) s.text = "";
    termPaintOutput();
  });
  termOut.addEventListener("click", () => {
    if (!window.getSelection()?.toString()) termInput?.focus();
  });
  termInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const line = termInput.value;
      termInput.value = "";
      void termSend(line);
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      if (!term.history.length) return;
      event.preventDefault();
      const n = term.history.length;
      term.historyAt = event.key === "ArrowUp"
        ? (term.historyAt < 0 ? n - 1 : Math.max(0, term.historyAt - 1))
        : (term.historyAt < 0 ? -1 : term.historyAt + 1);
      if (term.historyAt >= n) term.historyAt = -1;
      termInput.value = term.historyAt < 0 ? "" : term.history[term.historyAt];
    } else if (event.key === "c" && event.ctrlKey && !termInput.selectionEnd) {
      // No TTY means no Ctrl+C signal to send: stopping kills the shell and its children.
      event.preventDefault();
      void termStop().then(() => termOpen());
    }
  });
}
bindTerminal();


// --------------------------------------------------------- show in file explorer
//
// The button in the top bar opens the OS file manager at one path. Which path is the
// honest question: the file the trajectory last touched when a tool named one, otherwise
// the chat's own workspace folder. With no chat open there is nothing to reveal, so the
// button is disabled and its title says why rather than pretending to be a no-op.
//
// The refusal rules (outside the workspace, missing path, spawn failure) live in
// src/reveal.mjs on the server and are tested there; the page only shows the answer.

function revealTarget() {
  if (!state.current) {
    return { path: "", why: t("Show in File Explorer - open a chat first") };
  }
  if (state.current.kind !== "rosalena") {
    return { path: "", why: t("Show in File Explorer - this is an imported session with no run folder on this machine") };
  }
  if (state.revealPath) return { path: state.revealPath, label: clip(state.revealPath, 64) };
  if (currentWorkspace()) return { path: currentWorkspace(), label: t("this chat's folder"), folder: true };
  return { path: "", why: t("Show in File Explorer - the server has not reported a workspace yet") };
}

function paintReveal() {
  const button = el("reveal-button");
  if (!button) return;
  const target = revealTarget();
  const ready = Boolean(target.path);
  button.disabled = !ready;
  button.classList.toggle("ready", ready);
  button.title = ready ? t("Show {target} in File Explorer", { target: target.label }) : target.why;
}

async function revealPath(path) {
  const target = path ? { path, label: clip(path, 64) } : revealTarget();
  if (!target.path) {
    toast(target.why ?? t("There is nothing to show yet."), "bad");
    return;
  }
  try {
    const result = await post("/api/reveal", { path: target.path, ...(state.current?.thread ? { chat: state.current.thread } : {}) });
    setStatus(result.isDir ? t("opened the folder in the file manager") : t("opened the file in the file manager"), "ok");
  } catch (err) {
    // A refusal is a real answer: the path is outside the workspace, or the file is gone.
    // Showing the server's sentence is better than a button that appears to do nothing.
    toast(t("Could not show that: {error}", { error: err.message }), "bad");
  }
}

// ------------------------------------------------------- running work, in the top bar
//
// "Is anything running?" is answered by GET /api/activity and by nothing else: live runs
// in the run store split into chats and the subagents they started, plus the processes
// the process tracker still holds as alive. The strip is refreshed by things that already
// happen - the open stream's events (throttled), a run starting or ending, opening a chat,
// coming back to the tab, and a click on the pill. The one timer belongs to the open list:
// it runs only while the panel is on screen, and it stops the moment the panel closes.

const activity = { data: null, at: 0, busy: false, lastAt: 0 };

async function refreshActivity({ force = false } = {}) {
  const now = Date.now();
  if (activity.busy) return;
  if (!force && now - activity.lastAt < 1500) return;
  activity.busy = true;
  activity.lastAt = now;
  try {
    const body = await api("/api/activity");
    activity.data = body;
    activity.at = now;
    paintActivity();
  } catch (err) {
    activity.data = null;
    paintActivity(t("Could not read /api/activity: {error}", { error: err.message }));
  } finally {
    activity.busy = false;
  }
}

// ------------------------------------------------------------- the open-list poll
//
// A timer on an idle page would be a poll for news that cannot exist, so this one belongs
// to the open list rather than to the page: it starts when the panel is shown and stops the
// moment the panel closes, when the window loses focus, or when the tab is backgrounded.
// Everything the list shows without the timer (a run starting, a tool call, a run ending)
// arrives on the stream that is already open.
const activityPoll = { timer: null };

function startActivityPoll() {
  if (activityPoll.timer !== null) return;
  const panel = el("run-panel");
  if (!panel || panel.hidden || document.visibilityState !== "visible") return;
  activityPoll.timer = setInterval(() => {
    if (document.visibilityState !== "visible") {
      stopActivityPoll();
      return;
    }
    const live = el("run-panel");
    if (!live || live.hidden) {
      stopActivityPoll();
      return;
    }
    void refreshActivity({ force: true });
  }, 3000);
}

function stopActivityPoll() {
  if (activityPoll.timer === null) return;
  clearInterval(activityPoll.timer);
  activityPoll.timer = null;
}

function activityRow({ mark, title, detail, tone = "", onClick = null }) {
  const row = document.createElement(onClick ? "button" : "div");
  if (onClick) row.type = "button";
  row.className = `run-row${tone ? ` ${tone}` : ""}`;
  const badge = document.createElement("span");
  badge.className = "run-row-mark";
  badge.textContent = mark;
  const text = document.createElement("span");
  text.className = "run-row-text";
  const name = document.createElement("span");
  name.className = "run-row-title";
  name.textContent = title;
  const sub = document.createElement("span");
  sub.className = "run-row-detail";
  sub.textContent = detail;
  text.append(name, sub);
  row.append(badge, text);
  if (onClick) row.addEventListener("click", onClick);
  return row;
}

/** The panel's empty state: what is not running, and where the count came from. */
function activityEmpty(text, source) {
  const box = document.createElement("div");
  box.className = "run-empty";
  const line = document.createElement("p");
  line.textContent = text;
  box.append(line);
  if (source) {
    const where = document.createElement("p");
    where.className = "run-source";
    where.textContent = source;
    box.append(where);
  }
  return box;
}

function paintActivity(error = "") {
  rail?.activity();
  const strip = el("run-strip");
  const pill = el("run-pill");
  const dot = el("run-dot");
  const label = el("run-label");
  const panel = el("run-panel");
  const body = el("run-panel-body");
  if (!strip || !pill || !label) return;
  const data = activity.data;
  const counts = data?.counts ?? null;
  const agents = (counts?.runs ?? 0) + (counts?.subagents ?? 0);
  const jobs = counts?.processes ?? 0;
  const total = agents + jobs;

  // Three states, and only one of them hides the control.
  //
  // Before the first read answers there is nothing honest to say, so the strip stays out of
  // the way. After that a zero IS the answer: the pill stays and reads "nothing running",
  // because a control that vanishes when work stops makes "quiet right now" indistinguishable
  // from "this build has no such control", and the list behind the pill is how a person finds
  // out the counts exist at all. A failed read is a third state - the counts are unknown, not
  // zero - and the pill says exactly that instead of claiming quiet.
  const quiet = Boolean(counts) && total === 0;

  if (!counts && !error) {
    strip.hidden = true;
    if (panel) panel.hidden = true;
    pill.setAttribute("aria-expanded", "false");
    pill.classList.remove("has-work");
    label.textContent = "";
    if (dot) dot.className = "run-dot";
    pill.title = t("Reading /api/activity…");
    stopActivityPoll();
    return;
  }

  if (!counts || quiet) {
    const when = data?.at ? new Date(data.at).toLocaleTimeString() : t("just now");
    strip.hidden = false;
    label.textContent = counts ? t("nothing running") : t("activity unknown");
    if (dot) dot.className = counts ? "run-dot" : "run-dot bad";
    pill.classList.remove("has-work");
    pill.setAttribute("aria-expanded", panel && !panel.hidden ? "true" : "false");
    pill.title = counts
      ? t("Nothing is running: no chat runs, subagent runs or background jobs · read {when} · click for the list", { when })
      : t("{error} · the counts are unknown, not zero", { error });
    stopActivityPoll();
    if (body && panel && !panel.hidden) {
      body.textContent = "";
      body.append(
        activityEmpty(
          counts
            ? t("Nothing is running: no chat run, no subagent run and no background job is live right now.")
            : t("The counts could not be read, so this list is unknown rather than empty. {error}", { error }),
          // No source line on purpose. `data/runs` and `data/process-ledger.json` are paths
          // on whichever machine is running this, so in a build handed to someone else they
          // are noise at best and their own folder names at worst. The line above already
          // answers "is anything running".
          "",
        ),
      );    }
    return;
  }

  strip.hidden = false;
  pill.classList.add("has-work");
  // Two numbers, not three: a chat and the subagents it started are all agents, and the
  // background jobs are a different kind of thing. "2 agents · 1 job" is what a person
  // asks for; the split lives in the panel and in the title.
  const bits = [];
  if (agents) bits.push(t("{n} agents", { n: agents }));
  if (jobs) bits.push(t("{n} jobs", { n: jobs }));
  label.textContent = bits.join(" · ");
  if (dot) dot.className = "run-dot live";
  pill.setAttribute("aria-expanded", panel && !panel.hidden ? "true" : "false");
  pill.title =
    `${bits.join(" · ")} · ${t("{n} chat runs", { n: counts.runs })} · ` +
    `${t("{n} subagent runs", { n: counts.subagents })} · ` +
    `${t("{n} background jobs", { n: counts.processes })} · ` +
    `${t("read {time} · click for the list", { time: new Date(data.at).toLocaleTimeString() })}`;

  // The stream already refreshes this strip: a run starting, every tool call, a run ending
  // and opening a chat all read /api/activity. The timer exists only for the numbers the
  // stream cannot carry - steps and quiet time of work that is still going - and only while
  // the list is open on screen. Close the panel and the timer stops.
  if (panel && !panel.hidden) startActivityPoll();
  else stopActivityPoll();

  if (!body || !panel || panel.hidden) return;
  body.textContent = "";

  const section = (text, rows) => {
    if (!rows.length) return;
    const head = document.createElement("p");
    head.className = "run-section";
    head.textContent = text;
    body.append(head, ...rows);
  };

  section(
    t("Chats · {count}", { count: data.runs.length }),
    data.runs.map((run) =>
      activityRow({
        mark: "▶",
        title: run.task ? clip(run.task, 70) : run.id,
        detail: [
          run.model || run.cls ? t("model {name}", { name: modelDisplayName(run.model || run.cls) || run.model || run.cls }) : "",
          run.steps !== null ? t("{steps} steps", { steps: run.steps }) : "",
          run.tools !== null ? t("{tools} tool calls", { tools: run.tools }) : "",
          run.lastTool ? t("last: {tool}", { tool: run.lastTool }) : "",
          run.idleMs !== null ? t("quiet {time}", { time: humanMs(run.idleMs) }) : "",
        ]
          .filter(Boolean)
          .join(" · "),
        tone: run.status === "stale" ? "warn" : "",
        onClick: () => {
          toggleActivity(false);
          openChat(run.id);
        },
      }),
    ),
  );

  section(
    t("Subagents · {count}", { count: data.subagents.length }),
    data.subagents.map((run) =>
      activityRow({
        mark: "↳",
        title: run.task ? clip(run.task, 70) : run.id,
        detail: [
          t("depth {depth}", { depth: run.depth }),
          run.parent ? t("parent {id}", { id: run.parent }) : "",
          run.steps !== null ? t("{steps} steps", { steps: run.steps }) : "",
          run.lastTool ? t("last: {tool}", { tool: run.lastTool }) : "",
        ]
          .filter(Boolean)
          .join(" · "),
        tone: run.status === "stale" ? "warn" : "",
        onClick: () => {
          toggleActivity(false);
          openChat(run.id);
        },
      }),
    ),
  );

  section(
    t("Background jobs · {count}", { count: data.processes.length }),
    data.processes.map((proc) => {
      // What the program is, which chat started it and for how long: "remoting_desktop.exe,
      // pid 42948" told nobody what the job was for.
      const exe = String(proc.name ?? "").toLowerCase();
      const what = PROGRAM_NAMES[exe] ?? "";
      const since = proc.firstSeen ? Date.now() - Date.parse(proc.firstSeen) : null;
      return activityRow({
        mark: "⚙",
        title: what ? `${what} (${proc.name})` : proc.name ?? `pid ${proc.pid ?? "?"}`,
        detail: [
          proc.chat?.title ? t("started by the chat “{title}”", { title: clip(proc.chat.title, 60) }) : proc.runId ? t("started by run {id}", { id: proc.runId }) : "",
          proc.model ? t("model {name}", { name: modelDisplayName(proc.model) || proc.model }) : "",
          Number.isFinite(since) && since > 0 ? t("running {time}", { time: humanMs(since) }) : "",
          proc.cmd && proc.cmd !== proc.name ? t("command: {cmd}", { cmd: clip(proc.cmd, 90) }) : "",
          proc.pid ? `pid ${proc.pid}` : "",
          proc.chat?.id ? t("click to open that chat") : "",
        ]
          .filter(Boolean)
          .join(" · "),
        onClick: proc.chat?.id
          ? () => {
              toggleActivity(false);
              openChat(proc.chat.id);
            }
          : null,
      });
    }),
  );
}

// Plain names for programs a chat commonly leaves running.
const PROGRAM_NAMES = {
  "remoting_desktop.exe": "Chrome Remote Desktop",
  "node.exe": t("Node.js program"),
  "python.exe": t("Python program"),
  "pythonw.exe": t("Python program"),
  "powershell.exe": "PowerShell",
  "pwsh.exe": "PowerShell",
  "cmd.exe": t("Command Prompt"),
  "llama-server.exe": t("Local model server"),
  "chrome.exe": "Chrome",
  "msedge.exe": "Edge",
  "brave.exe": "Brave",
  "electron.exe": t("Electron app"),
  "npm.exe": "npm",
  "git.exe": "Git",
  "ffmpeg.exe": "ffmpeg",
};

function toggleActivity(open) {
  const panel = el("run-panel");
  const pill = el("run-pill");
  if (!panel || !pill) return;
  const next = open ?? panel.hidden;
  panel.hidden = !next;
  pill.setAttribute("aria-expanded", next ? "true" : "false");
  if (next) {
    paintActivity();
    void refreshActivity({ force: true });
  } else {
    // A closed list is not being read, so nothing should be reading for it.
    stopActivityPoll();
  }
}

// ------------------------------------------------------------- check for updates
//
// In the desktop app the shell owns the whole flow (desktop/updater.mjs): it checks, asks
// with a native dialog, and on "Update and restart" downloads, verifies the SHA-256,
// installs and reopens. The page just waits for the verdict.
//
// In a browser tab there is no shell, so it falls back to GET /api/update?fresh=1: the
// server compares this build's version with the published feed and answers current /
// available / unknown, and "available" names the release page. The row is disabled while
// either runs so a second click cannot queue a second check, and in the browser path a
// hung network gets 5 s before the page admits it could not ask.
const UPDATE_TIMEOUT_MS = 5000;

async function checkForUpdates() {
  const button = el("check-updates");
  const text = el("check-updates-text");
  if (!button || button.disabled) return;
  const label = text ?? button;
  const restore = t("Check for updates");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  label.textContent = t("Checking...");
  const desktop = window.rosalenaDesktop;
  if (typeof desktop?.checkForUpdates === "function") {
    try {
      const verdict = await desktop.checkForUpdates();
      if (verdict?.state === "busy") toast(t("An update check is already open."), "warn");
    } catch (err) {
      toast(t("Could not check for updates: {error}", { error: err.message }), "bad");
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      label.textContent = restore;
    }
    return;
  }
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), UPDATE_TIMEOUT_MS);
  try {
    const body = await api("/api/update?fresh=1", { signal: stop.signal });
    const state = body?.state ?? "unknown";
    const current = body?.current ?? "unknown";
    if (state === "available") {
      const latest = body?.latest ?? t("a newer version");
      toast(`${t("Version {latest} is available; this build is {current}.", { latest, current })}${body?.url ? ` ${body.url}` : ""}`, "warn");
    } else if (state === "current") {
      toast(t("Up to date: {current} is the newest published version.", { current }), "ok");
    } else {
      toast(t("Could not compare versions: {reason}", { reason: body?.reason ?? t("the release feed did not answer") }), "warn");
    }
  } catch (err) {
    toast(
      err?.name === "AbortError"
        ? t("Checking for updates timed out after 5 seconds.")
        : t("Could not check for updates: {error}", { error: err.message }),
      "bad",
    );
  } finally {
    clearTimeout(timer);
    button.disabled = false;
    button.removeAttribute("aria-busy");
    label.textContent = restore;
  }
}

// ------------------------------------------------------------------ settings pages
//
// A dialog with a grouped menu down the left (Basics, Agent, Extend, Advanced) and a page
// per entry. The model fallback figures come from GET /api/orchestration (data/roles.json +
// the router config through the menu the picker already uses + the plugin host); nothing on
// a page is an input the harness cannot honour. The older page names (general, cloud,
// spend, orchestration) still work: they open the page that holds that part now.

const SETTINGS_PAGES = ["appearance", "models", "providers", "notifications", "phone", "agent", "permissions", "skills", "mcp", "plugins", "templates", "generation", "advanced"];
const SETTINGS_ALIASES = {
  general: ["appearance"],
  cloud: ["providers", "settings-cloud"],
  spend: ["providers", "settings-spend"],
  orchestration: ["models", "settings-orchestration"],
};
const orchestration = { data: null, at: 0, error: "" };

function currentSettingsPage() {
  return document.querySelector('#settings-panel .settings-tab[aria-selected="true"]')?.dataset.settingsPage ?? "appearance";
}

function showSettingsPage(page, { anchor = null, focusTab = false } = {}) {
  const [aliased, aliasAnchor] = SETTINGS_ALIASES[page] ?? [page, null];
  const next = SETTINGS_PAGES.includes(aliased) ? aliased : "appearance";
  for (const tab of document.querySelectorAll("#settings-panel [data-settings-page]")) {
    const on = tab.dataset.settingsPage === next;
    tab.setAttribute("aria-selected", on ? "true" : "false");
    tab.tabIndex = on ? 0 : -1;
    if (on && focusTab) tab.focus();
    // In a narrow window the menu is a row that scrolls sideways: keep the page's tab in it.
    if (on && !el("settings-panel")?.hidden) tab.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  let shown = null;
  for (const body of document.querySelectorAll("#settings-panel [data-settings-page-body]")) {
    body.hidden = body.dataset.settingsPageBody !== next;
    if (!body.hidden) shown = body;
  }
  const title = el("settings-page-title");
  if (title) title.textContent = shown?.dataset.title ?? LABEL(next);
  const pages = el("settings-pages");
  if (pages) pages.scrollTop = 0;
  loadSettingsPage(next);
  const target = anchor ?? aliasAnchor;
  if (target) {
    const spot = typeof target === "string" ? el(target) : target;
    if (spot) requestAnimationFrame(() => flashSettingsRow(spot));
  }
}

/** Scroll a row into view and wash it with the accent for a moment. */
function flashSettingsRow(row) {
  row.scrollIntoView({ block: "center", behavior: "smooth" });
  row.classList.remove("settings-hit");
  void row.offsetWidth;
  row.classList.add("settings-hit");
  setTimeout(() => row.classList.remove("settings-hit"), 1700);
}

/** What each page reads when it is shown. `force` re-reads pages that cache. */
function loadSettingsPage(page, { force = false } = {}) {
  if (el("settings-panel")?.hidden && !force) return;
  switch (page) {
    case "appearance":
      paintAccountPanel();
      break;
    case "models":
      void loadOrchestration({ force });
      renderSettingsModels();
      break;
    case "providers":
      void loadCloud();
      void loadSpend();
      void loadProviders();
      break;
    case "notifications":
      paintNotify();
      break;
    case "phone":
      // phone.js owns the page (and the panel the footer's phone button opens).
      window.rosalenaPhone?.loadSettings();
      break;
    case "permissions":
      paintPermissions();
      void loadRules();
      break;
    case "skills":
      void loadSettingsSkills();
      break;
    case "mcp":
      void loadMcp();
      break;
    case "plugins":
      void loadSettingsPlugins();
      break;
    case "templates":
      void loadTemplates();
      break;
    case "generation":
      paintGeneration();
      break;
    case "advanced":
      void loadCloud();
      void loadAdvanced();
      paintAccountPanel();
      break;
    default:
      break;
  }
}

/** Arrow keys move through the menu (and open the page), Home and End jump to the ends. */
function settingsNavKeys(event) {
  const tabs = [...document.querySelectorAll("#settings-panel .settings-tab")].filter((tab) => tab.offsetParent !== null);
  const at = tabs.indexOf(document.activeElement);
  if (at < 0) return;
  const vertical = !window.matchMedia("(max-width: 760px)").matches;
  const nextKey = vertical ? "ArrowDown" : "ArrowRight";
  const prevKey = vertical ? "ArrowUp" : "ArrowLeft";
  let to = null;
  if (event.key === nextKey) to = (at + 1) % tabs.length;
  else if (event.key === prevKey) to = (at - 1 + tabs.length) % tabs.length;
  else if (event.key === "Home") to = 0;
  else if (event.key === "End") to = tabs.length - 1;
  if (to === null) return;
  event.preventDefault();
  showSettingsPage(tabs[to].dataset.settingsPage, { focusTab: true });
}

// ------------------------------------------------------------- settings search
//
// Filters by the visible text: every row, heading and list item on every page. The menu
// dims the pages with nothing that matches and counts the hits on the others; the results
// list replaces the page until a hit is picked, which opens its page and flashes the row.

const settingsSearch = { primed: false, hits: [], index: 0 };

const SEARCH_UNITS = ".settings-row, .settings-subhead, .prov-row, .rule-row, .reset-row, .cloud-key, .spend-row, .key-program, .model-row, .acct-switch-row";

/**
 * A node's words with a space between elements ("skill" + "yours" is not "skillyours"),
 * leaving out button captions (Copy path, Insert), which are not what a row is about.
 */
function spacedText(node) {
  const parts = [];
  const walk = (n) => {
    if (n.nodeType === Node.TEXT_NODE) parts.push(n.data);
    else if (n.nodeType === Node.ELEMENT_NODE && n.tagName !== "BUTTON" && n.tagName !== "OPTION" && n.tagName !== "SCRIPT") for (const child of n.childNodes) walk(child);
  };
  walk(node);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function unitTitle(unit) {
  const pick = unit.matches(".settings-subhead")
    ? unit
    : unit.querySelector(".row-label > span:first-child, .prov-name > span:not(.prov-tag), .cloud-key-name, .acct-switch-text > span, .key-program-head, .spend-name, code, .model-row > span");
  return spacedText(pick ?? unit).slice(0, 90);
}

function settingsHits(query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits = [];
  for (const body of document.querySelectorAll("#settings-panel [data-settings-page-body]")) {
    const page = body.dataset.settingsPageBody;
    const pageTitle = body.dataset.title ?? LABEL(page);
    if (words.every((word) => pageTitle.toLowerCase().includes(word))) hits.push({ page, pageTitle, unit: null, title: pageTitle, snippet: t("the whole page") });
    for (const unit of body.querySelectorAll(SEARCH_UNITS)) {
      // A row inside another matching unit is listed once, by its own (smaller) unit.
      const text = spacedText(unit);
      const hay = text.toLowerCase();
      if (!words.every((word) => hay.includes(word))) continue;
      if ([...unit.querySelectorAll(SEARCH_UNITS)].some((inner) => words.every((word) => spacedText(inner).toLowerCase().includes(word)))) continue;
      const first = hay.indexOf(words[0]);
      const snippet = text.slice(Math.max(0, first - 40), first + 80).trim();
      hits.push({ page, pageTitle, unit, title: unitTitle(unit), snippet });
    }
  }
  return hits;
}

/** The text with each search word wrapped in <mark>, safely. */
function markWords(text, words) {
  let html = escapeHtml(text);
  for (const word of words) {
    if (!word) continue;
    const safe = escapeHtml(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    html = html.replace(new RegExp(`(${safe})`, "gi"), "<mark>$1</mark>");
  }
  return html;
}

function runSettingsSearch() {
  const input = el("settings-search");
  const query = String(input?.value ?? "").trim();
  const results = el("settings-results");
  const pages = el("settings-pages");
  const tabs = [...document.querySelectorAll("#settings-panel .settings-tab")];
  for (const tab of tabs) {
    tab.classList.remove("no-match");
    tab.querySelector(".tab-hits")?.remove();
  }
  if (!query) {
    results.hidden = true;
    pages.hidden = false;
    settingsSearch.hits = [];
    const shown = document.querySelector("#settings-panel [data-settings-page-body]:not([hidden])");
    el("settings-page-title").textContent = shown?.dataset.title ?? t("Settings");
    return;
  }
  // The pages that fill themselves from the server are read once, so their rows can match.
  if (!settingsSearch.primed) {
    settingsSearch.primed = true;
    renderSettingsModels();
    // Each list joins the results as soon as it arrives (the plugin list can take seconds).
    const again = () => {
      const now = el("settings-search")?.value.trim() ?? "";
      if (now) runSettingsSearch();
    };
    for (const load of [loadProviders, loadCloud, loadSpend, loadRules, loadSettingsSkills, loadMcp, loadSettingsPlugins, loadTemplates, loadAdvanced]) {
      Promise.resolve()
        .then(load)
        .catch(() => {})
        .then(again);
    }
    paintNotify();
    paintPermissions();
    paintGeneration();
  }
  const hits = settingsHits(query);
  settingsSearch.hits = hits;
  settingsSearch.index = 0;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const counts = new Map();
  for (const hit of hits) counts.set(hit.page, (counts.get(hit.page) ?? 0) + 1);
  for (const tab of tabs) {
    const count = counts.get(tab.dataset.settingsPage) ?? 0;
    tab.classList.toggle("no-match", count === 0);
    if (count) {
      const badge = document.createElement("span");
      badge.className = "tab-hits";
      badge.textContent = String(count);
      badge.setAttribute("aria-label", t("{n} matches", { n: count }));
      tab.append(badge);
    }
  }
  el("settings-page-title").textContent = hits.length ? t("{n} matches for \"{query}\"", { n: hits.length, query }) : t("Nothing matches \"{query}\"", { query });
  results.replaceChildren();
  let lastPage = null;
  hits.forEach((hit, i) => {
    if (hit.page !== lastPage) {
      lastPage = hit.page;
      const head = document.createElement("p");
      head.className = "results-page";
      head.textContent = hit.pageTitle;
      results.append(head);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "settings-result";
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(i === 0));
    button.dataset.hit = String(i);
    const title = document.createElement("span");
    title.innerHTML = markWords(hit.title, words);
    const small = document.createElement("small");
    small.innerHTML = markWords(hit.snippet, words);
    button.append(title, small);
    button.onclick = () => openSettingsHit(i);
    button.onkeydown = (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const all = [...results.querySelectorAll(".settings-result")];
        const to = Math.max(0, Math.min(all.length - 1, i + (event.key === "ArrowDown" ? 1 : -1)));
        if (event.key === "ArrowUp" && i === 0) el("settings-search").focus();
        else all[to].focus();
      }
    };
    results.append(button);
  });
  if (!hits.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = t("Try another word: a setting's name, what it does, a provider, a skill or a template.");
    results.append(empty);
  }
  results.hidden = false;
  pages.hidden = true;
}

function openSettingsHit(i) {
  const hit = settingsSearch.hits[i];
  if (!hit) return;
  clearSettingsSearch();
  showSettingsPage(hit.page, { anchor: hit.unit ?? null });
  // A row inside a closed <details> is opened so it can be seen.
  hit.unit?.closest("details")?.setAttribute("open", "");
}

function clearSettingsSearch() {
  const input = el("settings-search");
  if (!input) return;
  if (input.value) input.value = "";
  runSettingsSearch();
}

function bindSettings() {
  const nav = document.querySelector("#settings-panel .settings-nav");
  nav?.addEventListener("keydown", settingsNavKeys);
  el("settings-close")?.addEventListener("click", () => toggleSettings(false));
  const input = el("settings-search");
  input?.addEventListener("input", runSettingsSearch);
  input?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (settingsSearch.hits.length) openSettingsHit(0);
    } else if (event.key === "ArrowDown") {
      const first = el("settings-results")?.querySelector(".settings-result");
      if (first) {
        event.preventDefault();
        first.focus();
      }
    }
  });
  // Ctrl+F (Cmd+F) inside Settings goes to its own search.
  el("settings-panel")?.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      input?.focus();
      input?.select();
    }
  });
  bindNotify();
  bindPermissions();
  bindSettingsMisc();
  bindTemplates();
  bindGeneration();
  bindLanguage();
}

// ------------------------------------------------------------------- language
//
// Settings > Appearance > Language: English (the default), Español, or the system's language.
// i18n.mjs reads the choice once when the page loads, so a change saves it (persist.js keeps
// it with the window's look, the shell rebuilds its menus) and reloads the page, which then
// opens Settings on this page again. Runs live in the server and carry on through it.

const REOPEN_SETTINGS = "rosalena-reopen-settings";

function bindLanguage() {
  const select = el("language-select");
  if (!select) return;
  select.value = savedLanguage();
  select.addEventListener("change", () => {
    try {
      sessionStorage.setItem(REOPEN_SETTINGS, "appearance");
    } catch {
      /* the page still switches; Settings just stays closed */
    }
    chooseLanguage(select.value);
  });
  let reopen = null;
  try {
    reopen = sessionStorage.getItem(REOPEN_SETTINGS);
    sessionStorage.removeItem(REOPEN_SETTINGS);
  } catch {
    reopen = null;
  }
  if (reopen) {
    requestAnimationFrame(() => {
      toggleSettings(true);
      showSettingsPage(reopen, { anchor: el("language-row") });
    });
  }
}

// --------------------------------------------------------------- notifications
//
// Settings > Notifications: a system notification for the chat on screen when it finishes,
// fails or waits for an approval while the window is in the background. The desktop shell
// shows a Windows notification (preload's notify); a browser tab uses the Notification API
// after asking once. The switches are saved in ui-prefs.json (`notify`).

const notifyPrefs = { done: true, failed: true, approval: true };
const notified = new Set();

function windowInBackground() {
  return document.visibilityState === "hidden" || !document.hasFocus();
}

/** Show one notification. Resolves {shown, reason}. */
async function showSystemNotification(title, body) {
  const shell = window.rosalenaDesktop;
  if (typeof shell?.notify === "function") {
    try {
      return (await shell.notify({ title, body })) ?? { shown: true };
    } catch (err) {
      return { shown: false, reason: err.message };
    }
  }
  if (typeof Notification === "undefined") return { shown: false, reason: t("this browser has no notifications") };
  if (Notification.permission === "default") {
    try {
      await Notification.requestPermission();
    } catch {
      /* an old browser with the callback form only: treated as not granted */
    }
  }
  if (Notification.permission !== "granted") return { shown: false, reason: t("this browser blocks notifications for this page (allow them in the site settings)") };
  const note = new Notification(title, { body, tag: `rosalena-${Date.now()}` });
  note.onclick = () => {
    window.focus();
    note.close();
  };
  return { shown: true };
}

/** A live stream event that may deserve a notification. Never for a replayed chat. */
function notifyFor(event) {
  if (!event?.type) return;
  const chatTitle = clip(el("chat-title")?.textContent || t("Your chat"), 60);
  let kind = null;
  let title = "";
  let body = "";
  if (event.type === "approval") {
    kind = "approval";
    title = t("Rosalena is waiting for you");
    body = `${chatTitle}: ${approvalTitle(event)}`;
  } else if (event.type === "stopped") {
    // The person's own Stop is not news to them; any other early end still is.
    if (event.reason === "cancelled") notified.add(`${state.runId ?? ""}:cancelled`);
  } else if (event.type === "ui/end") {
    if (notified.has(`${state.runId ?? ""}:cancelled`)) return;
    if (event.status === "failed") {
      kind = "failed";
      title = t("A run failed");
      body = `${chatTitle}: ${clip(String(event.error ?? t("it stopped with an error")), 160)}`;
    } else if (event.status === "ok" || event.status === "stopped") {
      kind = "done";
      title = event.status === "ok" ? t("Answer ready") : t("A run stopped");
      body = `${chatTitle}: ${clip(String(event.answer || (event.status === "ok" ? t("it finished") : t("it stopped before it was done"))).replace(/\s+/g, " "), 160)}`;
    }
  }
  if (!kind || !notifyPrefs[kind] || !windowInBackground()) return;
  const key = `${state.runId ?? ""}:${event.type}:${event.id ?? event.status ?? ""}`;
  if (notified.has(key)) return;
  notified.add(key);
  void showSystemNotification(title, body);
}

function paintNotify() {
  for (const key of Object.keys(notifyPrefs)) {
    const input = el(`notify-${key}`);
    if (input) input.checked = notifyPrefs[key] !== false;
  }
  const stateEl = el("notify-state");
  if (!stateEl) return;
  if (typeof window.rosalenaDesktop?.notify === "function") stateEl.textContent = t("desktop notifications");
  else if (typeof Notification === "undefined") stateEl.textContent = t("not available in this browser");
  else stateEl.textContent = { granted: t("allowed in this browser"), denied: t("blocked in this browser"), default: t("the browser will ask") }[Notification.permission] ?? "";
}

function bindNotify() {
  for (const key of Object.keys(notifyPrefs)) {
    el(`notify-${key}`)?.addEventListener("change", async (event) => {
      const on = event.currentTarget.checked;
      notifyPrefs[key] = on;
      if (await savePrefs({ notify: { [key]: on } })) toast(on ? t("Saved: you get a notification for that when the window is in the background.") : t("Saved: no notification for that."), "ok");
      // A browser has to ask once; better now, from this click, than at the moment it matters.
      if (on && typeof window.rosalenaDesktop?.notify !== "function" && typeof Notification !== "undefined" && Notification.permission === "default") {
        try {
          await Notification.requestPermission();
        } catch {
          /* see showSystemNotification */
        }
      }
      paintNotify();
    });
  }
  el("notify-test")?.addEventListener("click", async () => {
    const out = await showSystemNotification("Rosalena", t("Notifications work. This is what you get when an answer is ready, a run fails, or a run waits for your approval."));
    paintNotify();
    toast(out.shown ? t("Sent a test notification.") : t("No notification: {reason}.", { reason: out.reason ?? t("it was refused") }), out.shown ? "ok" : "bad");
  });
}

// ----------------------------------------------------------------- permissions

const ACCESS_HELP = {
  read: t("Read only: it can look but not change anything."),
  workspace: t("Workspace write: it can change files in this folder; anything outside it, and actions on the machine, ask you first."),
  auto: t("Auto: like Workspace write, but a reviewer model decides what would have asked you."),
  full: t("Full access: it can do anything except what an approval rule asks about or refuses."),
};

function paintPermissions() {
  const access = el("access-mode")?.value || prefs.accessMode || "workspace";
  for (const button of document.querySelectorAll("#perm-access [data-access]")) button.setAttribute("aria-pressed", String(button.dataset.access === access));
  if (el("perm-access-help")) el("perm-access-help").textContent = `${ACCESS_HELP[access] ?? access} ${t("Changing it here is the same as the Access menu beside the message box.")}`;
  if (el("perm-auto-value")) el("perm-auto-value").textContent = access === "auto" ? t("on (Auto access)") : t("off");
  const pick = el("commit-pick");
  const select = el("commit-mode");
  const available = pick && !pick.hidden;
  const git = available && select && !select.disabled;
  for (const button of document.querySelectorAll("#perm-commits [data-commit]")) {
    button.setAttribute("aria-pressed", String(Boolean(git) && button.dataset.commit === select.value));
    button.disabled = !git;
  }
  const value = el("perm-commits-value");
  if (value) value.textContent = !available ? t("commits are off (plugin not loaded)") : !git ? t("not a git folder") : currentWorkspace() || t("this folder");
  const help = el("perm-commits-help");
  if (help) help.textContent = git ? `${COMMIT_WORDS[select.value] ?? ""} ${t("This is the composer's Commits menu, for the folder this chat works in.")}` : t("The folder this chat works in is not a git repository, so there is nothing to commit.");
}

const perms = { rules: [], file: "" };

async function loadRules() {
  const list = el("perm-rules");
  if (!list) return;
  try {
    const body = await api("/api/permissions");
    perms.rules = body.rules ?? [];
    perms.file = body.file ?? "";
    paintRules(body);
  } catch (err) {
    list.replaceChildren(settingsEmpty(t("Could not read the rules: {error}", { error: err.message })));
  }
}

const RULE_WORDS = { allow: t("Allow"), ask: t("Ask"), deny: t("Refuse") };
const TOOL_WORDS = { run_command: t("Commands"), write_file: t("Writing files"), edit_file: t("Editing files"), web_fetch: t("Web pages"), "*": t("Any tool") };

function ruleRow(rule, { onRemove = null } = {}) {
  const row = document.createElement("div");
  row.className = "rule-row";
  const action = document.createElement("span");
  action.className = `rule-action ${rule.action}`;
  action.textContent = RULE_WORDS[rule.action] ?? rule.action;
  const tool = document.createElement("span");
  tool.className = "rule-tool";
  tool.textContent = TOOL_WORDS[rule.tool] ?? rule.tool;
  const pattern = document.createElement("code");
  pattern.textContent = rule.pattern;
  row.append(action, tool, pattern);
  if (onRemove) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "mini-btn";
    remove.textContent = t("Remove");
    remove.onclick = onRemove;
    row.append(remove);
  } else row.append(document.createElement("span"));
  if (rule.why) {
    const why = document.createElement("span");
    why.className = "rule-why";
    why.textContent = rule.why;
    row.append(why);
  }
  return row;
}

function paintRules(body) {
  const list = el("perm-rules");
  list.replaceChildren(
    ...(perms.rules.length
      ? perms.rules.map((rule, i) => ruleRow(rule, { onRemove: () => void saveRules(perms.rules.filter((_r, j) => j !== i), t("Rule removed.")) }))
      : [settingsEmpty(t("No rules of your own yet. Add one below, for example: Refuse, Commands, *npm publish*."))]),
  );
  const note = el("perm-rules-note");
  if (note) note.textContent = body?.broken ? t("{file} is not valid JSON, so it is ignored. Fix or delete it to save rules here.", { file: perms.file }) : perms.file ? t("Saved in {file}", { file: perms.file }) : "";
  const builtIn = el("perm-builtin");
  if (builtIn && body?.builtIn) builtIn.replaceChildren(...body.builtIn.map((rule) => ruleRow(rule)));
}

async function saveRules(rules, message) {
  try {
    const body = await mutate("PUT", "/api/permissions", { rules });
    perms.rules = body.rules ?? [];
    paintRules(body);
    toast(message, "ok");
    return true;
  } catch (err) {
    toast(t("Could not save the rules: {error}", { error: err.message }), "bad");
    return false;
  }
}

function bindPermissions() {
  for (const button of document.querySelectorAll("#perm-access [data-access]")) {
    button.addEventListener("click", () => {
      const select = el("access-mode");
      if (!select || select.value === button.dataset.access) return;
      select.value = button.dataset.access;
      // The composer's own handler saves it and says what it means.
      select.dispatchEvent(new Event("change", { bubbles: true }));
      renderChoiceTrigger(select);
      paintPermissions();
    });
  }
  el("access-mode")?.addEventListener("change", () => paintPermissions());
  for (const button of document.querySelectorAll("#perm-commits [data-commit]")) {
    button.addEventListener("click", () => {
      const select = el("commit-mode");
      if (!select || select.disabled || select.value === button.dataset.commit) return;
      select.value = button.dataset.commit;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      paintPermissions();
    });
  }
  el("commit-mode")?.addEventListener("change", () => setTimeout(paintPermissions, 400));
  const add = async () => {
    const pattern = el("perm-rule-pattern").value.trim();
    if (!pattern) {
      toast(t("Write a pattern first, for example *npm publish*."), "bad");
      el("perm-rule-pattern").focus();
      return;
    }
    const rule = { action: el("perm-rule-action").value, tool: el("perm-rule-tool").value, pattern };
    if (await saveRules([...perms.rules, rule], t("Rule added: {action} {tool} matching {pattern}. It applies from the next tool call.", { action: RULE_WORDS[rule.action], tool: TOOL_WORDS[rule.tool] ?? rule.tool, pattern }))) {
      el("perm-rule-pattern").value = "";
    }
  };
  el("perm-rule-add")?.addEventListener("click", () => void add());
  el("perm-rule-pattern")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void add();
    }
  });
}

// ---------------------------------------------------------------------- lists

function settingsEmpty(text) {
  const p = document.createElement("p");
  p.className = "empty";
  p.textContent = text;
  return p;
}

/** One row: a status dot, a name with tags, a line of detail, actions on the right. */
function provRow({ name, dot = null, tags = [], meta = "", desc = "", actions = [], search = "" }) {
  const row = document.createElement("div");
  row.className = "prov-row";
  if (search) row.dataset.search = search;
  const main = document.createElement("div");
  main.className = "prov-main";
  const title = document.createElement("div");
  title.className = "prov-name";
  if (dot) {
    const d = document.createElement("i");
    d.className = `prov-dot ${dot}`;
    d.setAttribute("aria-hidden", "true");
    title.append(d);
  }
  const label = document.createElement("span");
  label.textContent = name;
  title.append(label);
  for (const tag of tags) {
    const t = document.createElement("span");
    t.className = `prov-tag ${tag.tone ?? ""}`;
    t.textContent = tag.text;
    title.append(t);
  }
  main.append(title);
  if (meta) {
    const m = document.createElement("div");
    m.className = "prov-meta";
    m.textContent = meta;
    main.append(m);
  }
  const side = document.createElement("div");
  side.className = "prov-actions";
  side.append(...actions);
  row.append(main, side);
  if (desc) {
    const p = document.createElement("div");
    p.className = "prov-desc";
    p.textContent = desc;
    row.append(p);
  }
  return row;
}

/** A switch like the MCP panel's: a checkbox styled as a switch, with its own label. */
function settingsSwitch(on, label, onChange, { disabled = false } = {}) {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.className = "switch";
  input.checked = Boolean(on);
  input.disabled = disabled;
  input.setAttribute("aria-label", label);
  input.onchange = () => onChange(input.checked, input);
  return input;
}

function smallButton(text, onClick, { title = "" } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn";
  button.textContent = text;
  if (title) button.title = title;
  button.onclick = onClick;
  return button;
}

/** Hide the rows of one list that do not contain the filter's words. */
function filterRows(rows, query) {
  const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  for (const row of rows) row.hidden = words.length > 0 && !words.every((word) => row.textContent.toLowerCase().includes(word));
}

// ------------------------------------------------------------------- providers

async function loadProviders(fresh = false) {
  const local = el("providers-local");
  const subs = el("providers-subs");
  if (!local) return;
  let body;
  try {
    // `fresh` (Check again) asks Claude Code and Codex again instead of using the 5-minute
    // answer, so a sign-in made a moment ago shows.
    body = await api(fresh ? "/api/providers?fresh=1" : "/api/providers");
  } catch (err) {
    local.replaceChildren(settingsEmpty(t("Could not check the providers: {error}", { error: err.message })));
    return;
  }
  const kindWord = { "this-pc": t("this PC"), lan: t("your network") };
  local.replaceChildren(
    ...(body.local?.length
      ? body.local.map((row) => {
          const actions = [];
          if (row.id === "omniroute") actions.push(smallButton(t("Manage"), () => showSettingsPage("advanced"), { title: t("OmniRoute's install, start and stop are under Advanced") }));
          if (row.id === "local" || row.id === "comfyui") actions.push(smallButton(t("Models on this PC"), () => openPage("/models")));
          return provRow({
            name: row.label,
            dot: row.listening ? "on" : "off",
            tags: [
              { text: row.listening ? t("listening") : t("nothing there"), tone: row.listening ? "ok" : "" },
              { text: kindWord[row.kind] ?? row.kind },
              ...(row.inRouter ? [{ text: t("in the model list") }] : [{ text: t("not in the model list") }]),
            ],
            meta: `${row.baseUrl}${row.listening ? ` · ${t("answered in {ms} ms", { ms: row.ms })}` : row.error ? ` · ${row.error}` : ""}`,
            actions,
          });
        })
      : [settingsEmpty(t("No local servers are set up."))]),
  );
  const routerNote = el("providers-router");
  if (routerNote) {
    routerNote.textContent = body.router?.up
      ? t("Rosalena's router at {url} answered; this list is its live provider list.", { url: body.router.url })
      : body.router?.source ? t("The router at {url} did not answer, so the addresses come from {source}.", { url: body.router?.url ?? "?", source: body.router.source }) : t("The router at {url} did not answer.", { url: body.router?.url ?? "?" });
  }
  if (subs) {
    subs.replaceChildren(
      ...(body.subscriptions ?? []).map((sub) => {
        const status = !sub.found ? t("not installed") : sub.loggedIn ? t("signed in") : t("not signed in");
        // Each subscription names its own setup, sign-in and pick lines (GET /api/providers).
        const detail = !sub.found
          ? sub.setup ?? t("Install it and sign in once, then press Check again.")
          : sub.loggedIn
            ? `${t("Version {version}", { version: sub.version ?? "?" })}${sub.authMethod ? `, ${sub.authMethod}` : ""}. ${sub.pick ?? ""}`.trim()
            : t("Version {version} is installed but not signed in: {signIn}", { version: sub.version ?? "?", signIn: sub.signIn ?? t("sign in once in a terminal.") });
        return provRow({ name: sub.label, dot: sub.loggedIn ? "on" : sub.found ? "warn" : "off", tags: [{ text: status, tone: sub.loggedIn ? "ok" : "" }], meta: detail, desc: sub.what });
      }),
    );
  }
  filterProviders();
}

function filterProviders() {
  const query = el("providers-filter")?.value ?? "";
  const page = el("settings-providers");
  if (!page) return;
  filterRows(page.querySelectorAll(".prov-row, .cloud-key, .spend-row, .key-program"), query);
}

// -------------------------------------------------------------------- models

function renderSettingsModels() {
  const list = el("models-list");
  if (!list) return;
  const rows = chatModels(state.models ?? []);
  if (!rows.length) {
    list.replaceChildren(settingsEmpty(state.menu ? t("The model list is empty: the router did not answer and there is no local model. See Providers.") : t("Reading the model list…")));
    return;
  }
  const groups = new Map();
  for (const row of rows) {
    const label = modelGroupLabel(row.provider || "router");
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(row);
  }
  const nodes = [];
  for (const [label, members] of groups) {
    const head = document.createElement("p");
    head.className = "model-heading";
    head.textContent = `${label} · ${members.length}`;
    nodes.push(head);
    for (const row of members) {
      const line = document.createElement("div");
      line.className = "model-row";
      const name = document.createElement("span");
      name.textContent = row.label ?? modelDisplayName(row.id);
      const where = document.createElement("span");
      where.className = "model-where";
      where.textContent = [row.unavailable ? t("unavailable now") : "", row.note ?? ""].filter(Boolean).join(" · ");
      const id = document.createElement("span");
      id.className = "model-id";
      id.textContent = row.id;
      line.append(name, where, id);
      nodes.push(line);
    }
  }
  list.replaceChildren(...nodes);
  const note = el("models-note");
  if (note) note.textContent = `${t("{n} chat models", { n: rows.length })}${state.menu?.errors?.length ? ` · ${state.menu.errors.join("; ")}` : ""}`;
  filterModels();
}

function filterModels() {
  const list = el("models-list");
  if (!list) return;
  filterRows(list.querySelectorAll(".model-row"), el("models-filter")?.value ?? "");
  // A heading whose models are all hidden goes too.
  let head = null;
  let any = false;
  const flush = () => {
    if (head) head.hidden = !any;
  };
  for (const node of list.children) {
    if (node.classList.contains("model-heading")) {
      flush();
      head = node;
      any = false;
    } else if (!node.hidden) any = true;
  }
  flush();
}

// -------------------------------------------------------------------- skills

async function loadSettingsSkills() {
  const list = el("skills-list");
  if (!list) return;
  let body;
  try {
    body = await api("/api/skills");
  } catch (err) {
    list.replaceChildren(settingsEmpty(t("Could not read the skills: {error}", { error: err.message })));
    return;
  }
  const skills = body.skills ?? [];
  list.replaceChildren(
    ...(skills.length
      ? skills.map((skill) =>
          provRow({
            name: skill.name,
            dot: skill.enabled ? "on" : "off",
            tags: [{ text: skill.bundled ? t("built in") : t("yours") }],
            meta: skill.folder,
            desc: skill.description || t("(no description in its SKILL.md)"),
            actions: [
              smallButton(t("Copy path"), () => copyText(skill.file), { title: skill.file }),
              settingsSwitch(skill.enabled, skill.enabled ? t("{name} on", { name: skill.name }) : t("{name} off", { name: skill.name }), async (on, input) => {
                input.disabled = true;
                try {
                  await mutate("PUT", "/api/skills", { name: skill.name, enabled: on });
                  toast(on ? t("{name} is on: the agent can load it again.", { name: skill.name }) : t("{name} is off: the agent is not offered it, and it is not loaded by itself.", { name: skill.name }), "ok");
                } catch (err) {
                  toast(t("Could not switch {name}: {error}", { name: skill.name, error: err.message }), "bad");
                }
                await loadSettingsSkills();
              }),
            ],
          }),
        )
      : [settingsEmpty(t("No skills found."))]),
  );
  const note = el("skills-note");
  if (note) {
    const off = skills.filter((s) => !s.enabled).length;
    note.textContent = `${t("{n} skills", { n: skills.length })}${off ? `, ${t("{off} off", { off })}` : ""}. ${t("Add your own: a folder with a SKILL.md in {folder}. A skill of yours with the same name as a built-in one wins. Switches are saved in {file}.", { folder: body.addTo ?? "~/.rosalena/skills", file: body.file })}`;
  }
}

// ----------------------------------------------------------------------- MCP

/** Settings > MCP: the same servers and switches as the composer's MCP panel. */
function paintSettingsMcp() {
  const list = el("settings-mcp-list");
  if (!list) return;
  const data = mcp.data;
  const servers = data?.servers ?? [];
  if (!data) {
    list.replaceChildren(settingsEmpty(t("Reading…")));
    return;
  }
  list.replaceChildren(
    ...(servers.length
      ? servers.map((server) =>
          provRow({
            name: server.name,
            dot: server.invalid ? "warn" : server.enabled ? "on" : "off",
            tags: [
              { text: server.enabled ? t("on") : t("off"), tone: server.enabled ? "ok" : "" },
              ...(server.probe?.ok === true ? [{ text: t("{n} tool(s)", { n: server.probe.tools ?? 0 }) }] : server.probe?.ok === false ? [{ text: t("did not answer"), tone: "bad" }] : []),
            ],
            meta: server.invalid ? t("Broken entry: {error}", { error: server.invalid }) : clip(server.command ?? server.url ?? "", 140),
            actions: [
              smallButton(mcp.busy.has(server.name) ? t("Checking…") : t("Check"), () => void mcpAction({ action: "probe", name: server.name }), { title: t("Start it once and count its tools") }),
              settingsSwitch(server.enabled, server.enabled ? t("{name} on", { name: server.name }) : t("{name} off", { name: server.name }), (on) => void mcpAction({ action: "toggle", name: server.name, enabled: on }, on ? t("{name} is on.", { name: server.name }) : t("{name} is off.", { name: server.name })), { disabled: Boolean(server.invalid) || mcp.busy.has(server.name) }),
            ],
          }),
        )
      : [settingsEmpty(t("No MCP servers yet. Add one, or bring in the ones Claude Code has, with the button below."))]),
  );
  const note = el("settings-mcp-note");
  if (note) {
    const fromClaude = (data.claudeCode ?? []).filter((s) => !s.added).length;
    note.textContent = data.error
      ? t("Could not read the MCP list: {error}", { error: data.error })
      : data.available === false
        ? t("The MCP plugin (rosa-mcp-manager) is switched off under Plugins, so models cannot reach these servers until it is on.")
        : fromClaude
          ? t("{n} server(s) from Claude Code can be brought in with the button above.", { n: fromClaude })
          : "";
  }
}

// ------------------------------------------------------------------- plugins

const CORE_OFF_WARNING = t("It is part of Rosalena: switching it off turns off the feature it provides until you switch it back on. Continue?");

async function loadSettingsPlugins() {
  const list = el("settings-plugins-list");
  if (!list) return;
  let body;
  try {
    body = await api("/api/plugins/manage");
  } catch (err) {
    list.replaceChildren(settingsEmpty(t("Could not read the plugins: {error}", { error: err.message })));
    return;
  }
  const act = async (action, id, label) => {
    try {
      const out = await mutate("POST", "/api/plugins/manage", { action, id });
      if (out.ok === false) throw new Error(out.error ?? t("refused"));
      toast(label, "ok");
      if (action.startsWith("page-")) void refreshPlugins();
    } catch (err) {
      toast(t("Could not change {id}: {error}", { id, error: err.message }), "bad");
    }
    await loadSettingsPlugins();
  };
  const rows = [];
  const tools = body.tools ?? [];
  const pages = body.pages ?? [];
  if (tools.length) {
    const head = document.createElement("p");
    head.className = "model-heading";
    head.textContent = t("Tool plugins · {n}", { n: tools.length });
    rows.push(head);
  }
  for (const plugin of tools) {
    rows.push(
      provRow({
        name: plugin.id,
        dot: plugin.problems?.length ? "warn" : plugin.enabled ? "on" : "off",
        tags: [{ text: plugin.core ? t("built in") : plugin.source === "user" ? t("yours") : t("bundled") }, ...(plugin.problems?.length ? [{ text: t("problem"), tone: "bad" }] : [])],
        meta: [plugin.tools?.length ? t("{n} tool(s)", { n: plugin.tools.length }) : "", plugin.hooks?.length ? t("{n} hook(s)", { n: plugin.hooks.length }) : "", plugin.version ? `v${plugin.version}` : ""].filter(Boolean).join(" · "),
        desc: plugin.problems?.length ? plugin.problems.join("; ") : plugin.description,
        actions: [
          settingsSwitch(plugin.enabled, plugin.enabled ? t("{name} on", { name: plugin.id }) : t("{name} off", { name: plugin.id }), (on, input) => {
            if (!on && plugin.core && !confirm(`${plugin.id}: ${CORE_OFF_WARNING}`)) {
              input.checked = true;
              return;
            }
            void act(on ? "tool-on" : "tool-off", plugin.id, on ? t("{name} is on from the next message.", { name: plugin.id }) : t("{name} is off from the next message.", { name: plugin.id }));
          }),
        ],
      }),
    );
  }
  if (pages.length) {
    const head = document.createElement("p");
    head.className = "model-heading";
    head.textContent = t("Sidebar pages · {n}", { n: pages.length });
    rows.push(head);
  }
  for (const page of pages) {
    const on = page.enabled !== false;
    rows.push(
      provRow({
        name: page.title ?? page.name ?? page.id,
        dot: on ? "on" : "off",
        tags: [{ text: page.core ? t("built in") : page.source === "user" ? t("yours") : t("bundled") }],
        meta: page.id,
        desc: page.description ?? "",
        actions: [
          settingsSwitch(on, on ? t("{name} on", { name: page.id }) : t("{name} off", { name: page.id }), (next, input) => {
            if (!next && page.core && !confirm(`${page.id}: ${CORE_OFF_WARNING}`)) {
              input.checked = true;
              return;
            }
            void act(next ? "page-on" : "page-off", page.id, next ? t("{name} is in the sidebar.", { name: page.title ?? page.id }) : t("{name} is out of the sidebar.", { name: page.title ?? page.id }));
          }),
        ],
      }),
    );
  }
  list.replaceChildren(...(rows.length ? rows : [settingsEmpty(t("No plugins found."))]));
  const note = el("settings-plugins-note");
  if (note) note.textContent = body.folders ? t("Your own tool plugins: {tools} · your pages: {pages}", { tools: body.folders.tools, pages: body.folders.pages }) : "";
}

// ------------------------------------------------------------------ templates

const templates = { list: [], dir: "", editing: null };

async function loadTemplates() {
  const list = el("templates-list");
  if (!list) return;
  let body;
  try {
    body = await api("/api/templates");
  } catch (err) {
    list.replaceChildren(settingsEmpty(t("Could not read the templates: {error}", { error: err.message })));
    return;
  }
  paintTemplates(body);
}

function templateWhere(tpl) {
  if (tpl.editable) return t("yours");
  if (tpl.source === "built-in") return t("built in");
  return String(tpl.source).replace(/\\/g, "/").split("/").slice(-3, -1).join("/");
}

/** Put a template in the message box: its text, or "/name " when it takes arguments or a mode. */
function insertTemplate(tpl) {
  const usesSlash = Boolean(tpl.mode) || /\$ARGUMENTS|\$[1-9]/.test(tpl.body);
  const text = usesSlash ? `/${tpl.name} ` : tpl.body;
  const start = prompt.selectionStart ?? prompt.value.length;
  const end = prompt.selectionEnd ?? prompt.value.length;
  prompt.value = `${prompt.value.slice(0, start)}${text}${prompt.value.slice(end)}`;
  toggleSettings(false);
  prompt.focus();
  const caret = start + text.length;
  prompt.setSelectionRange(caret, caret);
  prompt.dispatchEvent(new Event("input", { bubbles: true }));
  toast(usesSlash ? t("/{name} is in the message box: add what it is about after it.", { name: tpl.name }) : t("Template {name} is in the message box.", { name: tpl.name }), "ok");
}

function paintTemplates(body) {
  templates.list = body.templates ?? [];
  templates.dir = body.dir ?? "";
  const list = el("templates-list");
  const mine = templates.list.filter((t) => t.editable);
  const others = templates.list.filter((t) => !t.editable);
  const row = (tpl) => {
    const actions = [smallButton(t("Insert"), () => insertTemplate(tpl), { title: t("Put it in the message box") })];
    if (tpl.editable) {
      actions.push(smallButton(t("Edit"), () => openTemplateEditor(tpl)));
      actions.push(
        smallButton(t("Delete"), async () => {
          if (!confirm(t("Delete the template /{name}? Its file in {dir} is removed.", { name: tpl.name, dir: templates.dir }))) return;
          try {
            paintTemplates(await mutate("DELETE", `/api/templates?name=${encodeURIComponent(tpl.name)}`));
            void loadSlashCommands();
            toast(t("/{name} deleted.", { name: tpl.name }), "ok");
          } catch (err) {
            toast(t("Could not delete it: {error}", { error: err.message }), "bad");
          }
        }),
      );
    } else {
      actions.push(smallButton(t("Customise"), () => openTemplateEditor({ ...tpl, editable: false }), { title: t("Make your own copy; yours wins over this one") }));
    }
    const node = provRow({
      name: `/${tpl.name}`,
      tags: [{ text: templateWhere(tpl) }, ...(tpl.mode ? [{ text: tpl.mode === "goal" ? t("goal") : t("plans first") }] : [])],
      meta: tpl.description,
      actions,
    });
    const pre = document.createElement("pre");
    pre.className = "tpl-body";
    pre.textContent = tpl.body;
    node.append(pre);
    return node;
  };
  const nodes = [];
  const heading = (text) => {
    const p = document.createElement("p");
    p.className = "model-heading";
    p.textContent = text;
    return p;
  };
  nodes.push(heading(t("Yours · {n}", { n: mine.length })));
  nodes.push(...(mine.length ? mine.map(row) : [settingsEmpty(t("None yet. New template saves one, and it works as a slash command at once."))]));
  nodes.push(heading(t("Built in and from other tools · {n}", { n: others.length })));
  nodes.push(...others.map(row));
  list.replaceChildren(...nodes);
  const note = el("tpl-note");
  if (note) note.textContent = templates.dir ? t("Your templates are files in {dir}", { dir: templates.dir }) : "";
}

function openTemplateEditor(tpl = null) {
  const form = el("tpl-editor");
  templates.editing = tpl?.editable ? tpl.name : null;
  el("tpl-name").value = tpl?.name ?? "";
  el("tpl-desc").value = tpl?.description ?? "";
  el("tpl-mode").value = tpl?.mode ?? "";
  el("tpl-body").value = tpl?.body ?? "";
  el("tpl-save").textContent = tpl?.editable ? t("Save changes") : t("Save template");
  form.hidden = false;
  (tpl ? el("tpl-body") : el("tpl-name")).focus();
}

function bindTemplates() {
  el("tpl-new")?.addEventListener("click", () => openTemplateEditor(null));
  el("tpl-cancel")?.addEventListener("click", () => {
    el("tpl-editor").hidden = true;
    templates.editing = null;
  });
  el("tpl-editor")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = {
      name: el("tpl-name").value.trim().toLowerCase(),
      description: el("tpl-desc").value.trim(),
      mode: el("tpl-mode").value,
      body: el("tpl-body").value,
      previous: templates.editing ?? "",
    };
    try {
      const body = await mutate("POST", "/api/templates", payload);
      paintTemplates(body);
      el("tpl-editor").hidden = true;
      templates.editing = null;
      void loadSlashCommands();
      toast(t("Saved /{name}. Type /{name} in the message box to use it.", { name: body.saved }), "ok");
    } catch (err) {
      toast(t("Could not save the template: {error}", { error: err.message }), "bad");
    }
  });
}

// ------------------------------------------------------------------ generation

const generation = { maxTokens: null, temperature: null, limits: { maxTokensMin: 256, maxTokensMax: 131072, maxTokensChoices: [8192, 16384, 32768, 65536], temperatureMax: 2, maxTokensDefault: 4096 } };

function paintGeneration() {
  const select = el("gen-model");
  if (select) {
    const stored = readPref(MODEL_KEY);
    const rows = chatModels(state.models ?? []);
    const groups = new Map();
    for (const row of rows) {
      const label = modelGroupLabel(row.provider || "router");
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(row);
    }
    const auto = document.createElement("option");
    auto.value = "";
    auto.textContent = t("Rosalena picks (the first model that can answer)");
    const nodes = [auto];
    for (const [label, members] of groups) {
      const group = document.createElement("optgroup");
      group.label = label;
      for (const row of members) {
        const option = document.createElement("option");
        option.value = row.id;
        option.textContent = row.label ?? modelDisplayName(row.id);
        group.append(option);
      }
      nodes.push(group);
    }
    if (stored && !rows.some((row) => row.id === stored)) {
      const gone = document.createElement("option");
      gone.value = stored;
      gone.textContent = t("{name} (not in the list right now)", { name: modelDisplayName(stored) });
      nodes.push(gone);
    }
    select.replaceChildren(...nodes);
    select.value = stored;
    const value = el("gen-model-value");
    if (value) value.textContent = stored ? "" : state.pick?.id ? t("now: {name}", { name: modelDisplayName(state.pick.id) }) : "";
  }
  const effort = el("gen-effort");
  if (effort) effort.value = EFFORT_LEVELS.includes(readPref(EFFORT_DEFAULT_KEY)) ? readPref(EFFORT_DEFAULT_KEY) : "";
  const limits = generation.limits;
  const seg = el("gen-tokens-seg");
  if (seg) {
    const choices = [null, ...(limits.maxTokensChoices ?? [])];
    seg.style.gridTemplateColumns = `repeat(${choices.length}, minmax(0, 1fr))`;
    seg.replaceChildren(
      ...choices.map((value) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "seg-btn";
        button.textContent = value === null ? t("Default") : shortTokens(value);
        button.setAttribute("aria-pressed", String(generation.maxTokens === value));
        button.onclick = () => void saveGeneration({ maxTokens: value });
        return button;
      }),
    );
  }
  const tokensValue = el("gen-tokens-value");
  if (tokensValue) tokensValue.textContent = generation.maxTokens ? t("{amount} tokens", { amount: generation.maxTokens.toLocaleString() }) : t("default ({amount})", { amount: Number(limits.maxTokensDefault ?? 4096).toLocaleString() });
  const on = el("gen-temp-on");
  const range = el("gen-temp");
  if (on && range) {
    on.checked = generation.temperature !== null;
    range.disabled = !on.checked;
    if (generation.temperature !== null) range.value = String(generation.temperature);
    range.max = String(limits.temperatureMax ?? 2);
  }
  const tempValue = el("gen-temp-value");
  if (tempValue) tempValue.textContent = generation.temperature !== null ? String(generation.temperature) : t("the model's own");
}

async function saveGeneration(patch) {
  if (await savePrefs({ generation: patch })) {
    paintGeneration();
    const parts = [];
    if ("maxTokens" in patch) parts.push(patch.maxTokens ? t("replies may be up to {amount} tokens", { amount: Number(patch.maxTokens).toLocaleString() }) : t("replies use the default length"));
    if ("temperature" in patch) parts.push(patch.temperature !== null ? t("temperature {value}", { value: patch.temperature }) : t("the model's own temperature"));
    toast(t("Saved: {changes}, from the next message.", { changes: parts.join(", ") }), "ok");
  } else paintGeneration();
}

function bindGeneration() {
  el("gen-model")?.addEventListener("change", (event) => {
    const id = event.currentTarget.value;
    writePref(MODEL_KEY, id);
    // With no chat open, the picker shows the new-chat model: follow it now.
    if (!state.current?.thread) applyChatModel();
    paintGeneration();
    toast(id ? t("New chats start on {name}.", { name: modelDisplayName(id) }) : t("New chats start on the first model that can answer."), "ok");
  });
  el("gen-effort")?.addEventListener("change", (event) => {
    const level = event.currentTarget.value;
    writePref(EFFORT_DEFAULT_KEY, level);
    if (!state.current?.thread) {
      applyChatModel();
      if (typeof renderModelTriggers === "function") renderModelTriggers();
    }
    toast(t("New chats start on effort: {effort}.", { effort: EFFORT_NAMES[level] ?? level }), "ok");
  });
  const applyTokens = () => {
    const input = el("gen-tokens-input");
    const value = Math.round(Number(input.value));
    const { maxTokensMin = 256, maxTokensMax = 131072 } = generation.limits;
    if (!Number.isFinite(value) || value < maxTokensMin || value > maxTokensMax) {
      toast(t("Pick a number from {min} to {max}.", { min: maxTokensMin, max: maxTokensMax.toLocaleString() }), "bad");
      return;
    }
    input.value = "";
    void saveGeneration({ maxTokens: value });
  };
  el("gen-tokens-apply")?.addEventListener("click", applyTokens);
  el("gen-tokens-input")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyTokens();
    }
  });
  el("gen-temp-on")?.addEventListener("change", (event) => {
    const range = el("gen-temp");
    range.disabled = !event.currentTarget.checked;
    void saveGeneration({ temperature: event.currentTarget.checked ? Number(range.value) : null });
  });
  el("gen-temp")?.addEventListener("input", (event) => {
    el("gen-temp-value").textContent = String(Number(event.currentTarget.value));
  });
  el("gen-temp")?.addEventListener("change", (event) => void saveGeneration({ temperature: Number(event.currentTarget.value) }));
}

// -------------------------------------------------------------------- advanced

async function loadAdvanced() {
  const routerBox = el("adv-router");
  const folders = el("adv-folders");
  const line = (label, value, { copy = true } = {}) => {
    const row = document.createElement("div");
    row.className = "adv-line";
    const name = document.createElement("span");
    name.textContent = label;
    const code = document.createElement("code");
    code.textContent = value || t("unknown");
    row.append(name, code);
    if (copy && value) row.append(smallButton(t("Copy"), () => copyText(value)));
    else row.append(document.createElement("span"));
    return row;
  };
  const [health, skills, tpl, rules] = await Promise.allSettled([api("/api/health"), api("/api/skills"), api("/api/templates"), api("/api/permissions")]);
  const h = health.status === "fulfilled" ? health.value : null;
  if (routerBox) {
    const value = el("adv-router-value");
    if (value) value.textContent = !h ? t("could not ask") : h.router?.up ? t("answering · {n} models", { n: h.router.models?.length ?? 0 }) : t("not answering");
    routerBox.replaceChildren(
      line(t("Address"), h?.routerUrl ?? ""),
      ...(h && !h.router?.up && h.router?.error ? [line(t("Problem"), h.router.error, { copy: false })] : []),
      ...(h?.local?.enabled ? [line(t("Local server"), h.local.up ? `${t("up")}${h.local.loaded ? `, ${h.local.loaded}` : ""}` : t("down"), { copy: false })] : []),
    );
  }
  if (folders) {
    folders.replaceChildren(
      line(t("App data"), h?.home ?? ""),
      line("Chats", h?.runsDir ?? ""),
      line(t("Workspace"), h?.workspace ?? ""),
      line(t("Your skills"), skills.status === "fulfilled" ? skills.value.addTo ?? "" : ""),
      line(t("Your templates"), tpl.status === "fulfilled" ? tpl.value.dir ?? "" : ""),
      line(t("Approval rules"), rules.status === "fulfilled" ? rules.value.file ?? "" : ""),
    );
  }
}

function bindSettingsMisc() {
  el("settings-style-lab")?.addEventListener("click", () => {
    toggleSettings(false);
    openPlugin("rosa-style-lab");
  });
  el("models-open-pc")?.addEventListener("click", () => openPage("/models"));
  el("models-filter")?.addEventListener("input", filterModels);
  el("providers-filter")?.addEventListener("input", filterProviders);
  el("providers-refresh")?.addEventListener("click", () => {
    void loadProviders(true);
    void loadCloud();
    void loadSpend();
  });
  el("settings-mcp-open")?.addEventListener("click", () => {
    toggleSettings(false);
    setTimeout(() => toggleMcpPanel(true), 0);
  });
  el("settings-plugins-open")?.addEventListener("click", () => openPage("/plugins"));
  el("adv-router-check")?.addEventListener("click", () => void loadAdvanced());
  el("adv-updates")?.addEventListener("click", () => void checkForUpdates());
  el("reset-layout")?.addEventListener("click", () => {
    if (confirm(t("Put the layout back to the Cockpit preset, with its panel sizes?"))) applyPreset("cockpit");
  });
  el("reset-limits")?.addEventListener("click", async () => {
    if (!confirm(t("Set steps per message, time per message and the context window back to their defaults?"))) return;
    if (await savePrefs({ maxSteps: null, maxMinutes: null, contextWindow: null })) {
      paintStepsUI();
      paintMinutesUI();
      paintContextWindowUI();
      toast(t("Limits are back to the defaults: {steps} steps, {time}, {context} context.", { steps: prefs.maxSteps, time: prefs.maxMinutes ? t("{minutes} minutes", { minutes: prefs.maxMinutes }) : t("no time limit"), context: shortTokens(prefs.contextWindow) }), "ok");
    }
  });
  el("reset-generation")?.addEventListener("click", () => void saveGeneration({ maxTokens: null, temperature: null }));
  el("reset-chat-picks")?.addEventListener("click", () => {
    if (!confirm(t("Forget which model and effort each chat was left on? The chats themselves stay; each one opens on the model for new chats."))) return;
    writePref(CHAT_MODELS_KEY, "");
    writePref(CHAT_EFFORTS_KEY, "");
    applyChatModel();
    toast(t("Forgotten. Every chat now opens on the model for new chats."), "ok");
  });
  // Settings > Providers > Cloud API's rows are drawn by loadCloud; the filter is re-applied
  // when they arrive, so a filter typed early still holds.
  new MutationObserver(() => filterProviders()).observe(el("settings-providers") ?? document.createElement("div"), { childList: true, subtree: true });
}

// ---------------------------------------------------------------- spend limits
//
// Settings > Spend limits (/api/budgets): this month's spend per paid provider and its
// monthly cap. Saving goes to the router, which applies it to the very next request.

const money = (n) => (Number.isFinite(Number(n)) ? `$${Number(n).toFixed(2)}` : "-");

async function loadSpend() {
  const list = el("spend-list");
  const note = el("spend-note");
  if (!list) return;
  let body;
  try {
    body = await api("/api/budgets");
  } catch (err) {
    list.innerHTML = "";
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = t("Could not read the limits: {error}", { error: err.message });
    list.append(p);
    return;
  }
  if (note) note.textContent = body.month ? t("Month: {month} (UTC). Spend is what the router has recorded for your keys this month.", { month: body.month }) : "";
  if (!body.providers?.length) {
    list.innerHTML = `<p class="empty">${t("No paid providers are set up.")}</p>`;
    return;
  }
  list.replaceChildren(
    ...body.providers.map((p) => {
      const row = document.createElement("form");
      row.className = "spend-row";
      const label = document.createElement("div");
      label.className = "row-label";
      const name = document.createElement("span");
      name.textContent = p.label;
      const value = document.createElement("span");
      value.className = `row-value${p.withinBudget ? "" : " bad"}`;
      const cap = Number(p.capUsd) > 0 ? money(p.capUsd) : t("no limit");
      value.textContent = `${t("{spent} spent of {cap}", { spent: money(p.spentUsd), cap })}${p.withinBudget ? "" : ` · ${t("limit reached")}`}${p.hasKey ? "" : ` · ${t("no key saved")}`}`;
      label.append(name, value);
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.step = "5";
      input.inputMode = "decimal";
      input.className = "spend-input";
      input.value = String(Number(p.capUsd) || 0);
      input.setAttribute("aria-label", t("Monthly limit for {name}, in dollars", { name: p.label }));
      const save = document.createElement("button");
      save.type = "submit";
      save.className = "mini-btn";
      save.textContent = t("Save");
      const dollar = document.createElement("span");
      dollar.className = "spend-dollar";
      dollar.textContent = "$";
      const controls = document.createElement("span");
      controls.className = "spend-controls";
      controls.append(dollar, input, save);
      row.append(label, controls);
      row.addEventListener("submit", async (event) => {
        event.preventDefault();
        const usd = Number(input.value);
        if (!Number.isFinite(usd) || usd < 0) {
          toast(t("Enter a number of dollars, 0 for no limit."), "bad");
          return;
        }
        save.disabled = true;
        try {
          await mutate("PUT", "/api/budgets", { provider: p.id, monthlyUsd: usd });
          toast(usd > 0 ? t("{name}: limit is now {amount} a month. It applies to your next message.", { name: p.label, amount: money(usd) }) : t("{name}: no monthly limit.", { name: p.label }), "ok");
          await loadSpend();
        } catch (err) {
          toast(t("Could not save the limit: {error}", { error: err.message }), "bad");
          save.disabled = false;
        }
      });
      return row;
    }),
  );
}

// ---------------------------------------------------------------- cloud models
//
// Settings > Cloud models (/api/cloud): OmniRoute as an optional download, and the
// person's own provider keys. A key is sent once and never comes back to the page.

let cloudPoll = null;

async function loadCloud() {
  let body;
  try {
    body = await api("/api/cloud");
  } catch (err) {
    el("omni-status").textContent = t("Could not read the cloud settings: {error}", { error: err.message });
    return;
  }
  renderOmni(body.omniroute);
  renderKeys(body.keys, body.router);
  renderPrograms(body.programs, body.keys, body.router);
}

/**
 * The free-key cards. A program whose key fits one of the router's providers gets the
 * same paste-and-save as the key list below; one whose credits only work in its own tool
 * (Copilot, Kiro) says so instead of offering a field that could never work.
 */
function renderPrograms(data, keys, routerUp) {
  const host = el("key-programs");
  if (!host) return;
  host.innerHTML = "";
  const programs = data?.programs ?? [];
  if (!programs.length) {
    host.innerHTML = `<p class="empty">${t("No programs listed.")}</p>`;
    return;
  }
  const keyed = new Map((keys ?? []).map((k) => [k.id, k]));
  const groups = [
    ["student", t("For students")],
    ["anyone", t("Free for anyone")],
  ];
  for (const [group, title] of groups) {
    const list = programs.filter((p) => (p.group ?? "anyone") === group);
    if (!list.length) continue;
    const heading = document.createElement("p");
    heading.className = "key-programs-group";
    heading.textContent = title;
    host.append(heading);
    for (const p of list) {
      const card = document.createElement("article");
      card.className = "key-program";
      const head = document.createElement("div");
      head.className = "key-program-head";
      const name = document.createElement("strong");
      name.textContent = p.name;
      const by = document.createElement("span");
      by.className = "key-program-by";
      by.textContent = p.by;
      const slot = p.provider ? keyed.get(p.provider) : null;
      const badge = document.createElement("span");
      badge.className = `key-program-badge ${p.provider ? "ok" : "no"}`;
      badge.textContent = p.provider ? (slot?.set ? t("Works in Rosalena · key saved") : t("Works in Rosalena")) : t("Not usable in Rosalena");
      head.append(name, by, badge);
      const what = document.createElement("p");
      what.className = "key-program-what";
      what.textContent = p.what;
      const how = document.createElement("p");
      how.className = "key-program-how";
      how.textContent = p.how;
      const link = document.createElement("a");
      link.className = "key-program-link";
      link.href = p.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = `${p.link ?? p.name} ↗`;
      card.append(head, what, how, link);

      if (p.provider && routerUp) {
        const row = document.createElement("div");
        row.className = "key-program-paste";
        const input = document.createElement("input");
        input.type = "password";
        input.autocomplete = "off";
        input.spellcheck = false;
        const label = slot?.label ?? p.provider;
        input.placeholder = slot?.set ? t("Replace your {name} key", { name: label }) : t("Paste your {name} key", { name: label });
        input.setAttribute("aria-label", t("{name} API key from {program}", { name: label, program: p.name }));
        const save = document.createElement("button");
        save.type = "button";
        save.className = "mini-btn";
        save.textContent = t("Save key");
        save.onclick = async () => {
          if (!input.value.trim()) return toast(t("Paste the key first."), "warn");
          save.disabled = true;
          try {
            await post("/api/cloud", { action: "save-key", provider: p.provider, key: input.value });
            input.value = "";
            toast(t("{name} key saved. It works on your next message.", { name: label }), "ok");
            await loadCloud();
            void loadModels();
          } catch (err) {
            toast(err.message, "bad");
          } finally {
            save.disabled = false;
          }
        };
        row.append(input, save);
        card.append(row);
      }
      host.append(card);
    }
  }
  const note = el("key-programs-note");
  if (note) note.textContent = data.checked ? t("Program details checked {date}. Offers change; the program's own page has the current terms.", { date: data.checked }) : "";
}

function renderOmni(omni) {
  const status = el("omni-status");
  const line = el("omni-line");
  const install = el("omni-install");
  const start = el("omni-start");
  const dash = el("omni-dashboard");
  if (!status || !omni) return;
  const installing = omni.job?.phase === "installing";
  const m = omni.manager ?? {};
  install.hidden = omni.running || omni.installed || installing;
  start.hidden = omni.running || !omni.installed;
  dash.hidden = !omni.running;
  line.hidden = !installing && omni.job?.phase !== "failed" && !m.gaveUp && !omni.job?.warning;
  // Inside Rosalena: a child process with no window, which Stop and Restart act on. Outside:
  // its own window (the Startup-folder script, a terminal), which only "Run it inside" moves.
  el("omni-adopt").hidden = !(omni.running && !m.managed && m.external?.isOmniRoute !== false);
  el("omni-restart").hidden = !m.managed;
  el("omni-stop").hidden = !m.managed;
  el("omni-log-toggle").hidden = !omni.installed;
  el("omni-prefs").hidden = !omni.installed;
  el("omni-autostart").checked = m.autostart !== false;
  el("omni-keep").checked = m.keepAfterQuit === true;
  if (m.managed) {
    const up = m.startedAt ? humanMs(Date.now() - m.startedAt) : "";
    status.textContent = `${t("Running inside Rosalena, with no window of its own")}${up ? `, ${t("up {time}", { time: up })}` : ""}${m.restarts ? `, ${t("restarted {n} times after a crash", { n: m.restarts })}` : ""}. ${t("\"OmniRoute auto\" is in the model list.")}`;
  } else if (omni.running && m.external?.isOmniRoute === false) {
    status.textContent = t("Something else (pid {pid}) is using OmniRoute's port 20128.", { pid: m.external.pid });
  } else if (omni.running) {
    status.textContent = `${t("Running outside Rosalena")}${m.external?.pid ? ` ${t("(pid {pid}, in its own window)", { pid: m.external.launcherPid ?? m.external.pid })}` : ""}. ${t("\"Run it inside Rosalena\" stops that copy and runs it here, with no window.")}`;
  } else if (m.gaveUp) status.textContent = t("Stopped: it kept crashing, so Rosalena stopped restarting it. The log says why.");
  else if (installing) status.textContent = t("Installing OmniRoute… this downloads about 2 GB and can take several minutes.");
  else if (omni.installed) status.textContent = t("Installed, not running. It starts by itself when you send a message on OmniRoute, or start it now.");
  else if (omni.node === "download") status.textContent = t("Not installed. Install sets up everything it needs, including Rosalena's own copy of Node.js (about 40 MB, only Rosalena uses it). About 2 GB in all.");
  else if (omni.node === "rosalena") status.textContent = t("Not installed. Rosalena's own Node.js is here, so it can be installed now.");
  else if (omni.node) status.textContent = omni.npm ? t("Not installed. Node.js is here (npm {npm}), so it can be installed now.", { npm: omni.npm }) : t("Not installed. Node.js is here, so it can be installed now.");
  else status.textContent = t("Not installed. It needs Node.js, and Rosalena has no download for this kind of PC: get the LTS version from nodejs.org, then reopen this page.");
  install.disabled = !omni.node;
  const getNode = el("omni-get-node");
  if (getNode) getNode.hidden = Boolean(omni.node) || omni.installed || omni.running || installing;
  if (!line.hidden) line.textContent = m.gaveUp ? m.gaveUp.reason : omni.job?.phase === "failed" ? t("The install stopped: {error}", { error: omni.job.error }) : installing ? omni.job?.line ?? "" : omni.job?.warning ?? "";
  if (!el("omni-log").hidden) void loadOmniLog();
  if (installing) cloudPoll ??= setInterval(() => void loadCloud(), 2000);
  else if (cloudPoll) {
    clearInterval(cloudPoll);
    cloudPoll = null;
    if (omni.installed) toast(t("OmniRoute is installed. Start it, then pick OmniRoute auto in the model list."), "ok");
  }
}

function renderKeys(rows, routerUp) {
  const host = el("cloud-keys");
  if (!host) return;
  host.innerHTML = "";
  const summary = el("cloud-key-summary");
  if (!routerUp) {
    host.innerHTML = `<p class="empty">${t("The router is not answering, so keys cannot be saved right now.")}</p>`;
    if (summary) summary.replaceChildren();
    return;
  }
  // At a glance: which providers have a key saved (a dot and a word, not just a colour).
  if (summary) {
    summary.replaceChildren(
      ...(rows ?? []).map((row) => {
        const chip = document.createElement("span");
        chip.className = `key-chip ${row.set ? "is-set" : "is-unset"}`;
        chip.title = row.set ? t("{name}: key saved ({masked})", { name: row.label, masked: row.masked.join(", ") }) : t("{name}: no key yet", { name: row.label });
        const dot = document.createElement("i");
        dot.setAttribute("aria-hidden", "true");
        chip.append(dot, `${row.label} · ${row.set ? t("saved") : t("no key")}`);
        return chip;
      }),
    );
  }
  for (const row of rows ?? []) {
    const wrap = document.createElement("div");
    wrap.className = `cloud-key ${row.set ? "is-set" : "is-unset"}`;
    const name = document.createElement("div");
    name.className = "cloud-key-name";
    const status = document.createElement("span");
    status.className = `key-status ${row.set ? "is-set" : "is-unset"}`;
    status.textContent = row.set ? t("✓ Saved") : t("No key");
    name.append(document.createTextNode(row.label), status);
    const small = document.createElement("small");
    small.textContent = row.set ? t("ends in {masked}", { masked: row.masked.join(", ") }) : row.hint;
    name.append(small);
    const input = document.createElement("input");
    input.type = "password";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = row.set ? t("Paste a new key to replace it") : t("Paste your API key");
    input.setAttribute("aria-label", t("{name} API key", { name: row.label }));
    const save = document.createElement("button");
    save.type = "button";
    save.className = "mini-btn";
    save.textContent = t("Save");
    save.onclick = async () => {
      if (!input.value.trim()) return toast(t("Paste the key first."), "warn");
      try {
        await post("/api/cloud", { action: "save-key", provider: row.id, key: input.value });
        input.value = "";
        toast(t("{name} key saved. It works on your next message.", { name: row.label }), "ok");
        await loadCloud();
        void loadModels();
      } catch (err) {
        toast(err.message, "bad");
      }
    };
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "mini-btn";
    remove.textContent = t("Remove");
    remove.hidden = !row.set;
    remove.onclick = async () => {
      try {
        await post("/api/cloud", { action: "remove-key", provider: row.id });
        toast(t("{name} key removed.", { name: row.label }), "ok");
        await loadCloud();
      } catch (err) {
        toast(err.message, "bad");
      }
    };
    wrap.append(name, input, save, remove);
    host.append(wrap);
  }
}

function bindCloud() {
  el("omni-install")?.addEventListener("click", async () => {
    el("omni-install").disabled = true;
    try {
      await post("/api/cloud", { action: "omniroute-install" });
    } catch (err) {
      toast(err.message, "bad");
    }
    await loadCloud();
  });
  // Start, Run it inside, Restart and Stop are one shape: busy label, the action, re-read.
  const omniAction = (id, action, busy, done) =>
    el(id)?.addEventListener("click", async () => {
      const button = el(id);
      const label = button.textContent;
      button.disabled = true;
      button.textContent = busy;
      try {
        await post("/api/cloud", { action });
        toast(done, "ok");
        void loadModels();
      } catch (err) {
        toast(err.message, "bad");
      }
      button.disabled = false;
      button.textContent = label;
      await loadCloud();
    });
  el("omni-dashboard")?.addEventListener("click", () => {
    toggleSettings(false);
    openOmniRoute();
  });
  omniAction("omni-start", "omniroute-start", t("Starting…"), t("OmniRoute is running inside Rosalena."));
  omniAction("omni-adopt", "omniroute-adopt", t("Moving it…"), t("OmniRoute now runs inside Rosalena, with no window."));
  omniAction("omni-restart", "omniroute-restart", t("Restarting…"), t("OmniRoute restarted."));
  omniAction("omni-stop", "omniroute-stop", t("Stopping…"), t("OmniRoute stopped."));
  const savePrefs = async () => {
    try {
      await post("/api/cloud", { action: "omniroute-prefs", autostart: el("omni-autostart").checked, keepAfterQuit: el("omni-keep").checked });
      toast(t("Saved. It applies the next time OmniRoute starts."), "ok");
    } catch (err) {
      toast(err.message, "bad");
    }
  };
  el("omni-autostart")?.addEventListener("change", savePrefs);
  el("omni-keep")?.addEventListener("change", savePrefs);
  el("omni-log-toggle")?.addEventListener("click", () => {
    const pre = el("omni-log");
    pre.hidden = !pre.hidden;
    el("omni-log-toggle").textContent = pre.hidden ? t("Show log") : t("Hide log");
    el("omni-log-toggle").setAttribute("aria-expanded", String(!pre.hidden));
    if (!pre.hidden) void loadOmniLog();
  });
}

/** The last lines OmniRoute printed, from the log file it writes inside Rosalena. */
async function loadOmniLog() {
  const pre = el("omni-log");
  try {
    const out = await post("/api/cloud", { action: "omniroute-log", lines: 150 });
    pre.textContent = out.lines.length ? out.lines.join("\n") : t("Nothing logged yet. The log is {file}", { file: out.file });
    pre.scrollTop = pre.scrollHeight;
  } catch (err) {
    pre.textContent = t("Could not read the log: {error}", { error: err.message });
  }
}

// ---------------------------------------------------------------- sharing question

function paintShareAsk() {
  const card = el("share-ask");
  if (card) card.hidden = !(account.sharingOptional && account.sharingChosen === false);
}

function bindShareAsk() {
  for (const button of document.querySelectorAll("#share-ask [data-share]")) {
    button.addEventListener("click", async () => {
      const sharing = button.dataset.share;
      await saveAccount({ sharing });
      account.sharingChosen = true;
      paintShareAsk();
      const words = { full: t("Thanks. Sharing stays on."), usage: t("Only numbers will be shared."), off: t("Sharing is off. Only free-tier token counts are sent, to stop abuse.") };
      toast(`${words[sharing] ?? t("Saved.")} ${t("Change it any time in Settings > Advanced.")}`, "ok");
    });
  }
}

async function loadOrchestration({ force = false } = {}) {
  const host = el("orchestration-roles");
  if (!host) return;
  if (!force && orchestration.data && Date.now() - orchestration.at < 15000) {
    renderOrchestration(orchestration.data);
    return;
  }
  try {
    const body = await api("/api/orchestration");
    orchestration.data = body;
    orchestration.at = Date.now();
    orchestration.error = "";
    renderOrchestration(body);
  } catch (err) {
    orchestration.error = err.message;
    const source = el("orchestration-source");
    if (source) source.textContent = t("Could not read /api/orchestration: {error}", { error: err.message });
    host.textContent = "";
    host.append(emptyRow(t("The role list could not be read, so there is nothing honest to show here.")));
  }
}

/**
 * One role, read out and not editable.
 *
 * Four facts and nothing else: the title a person sees, the router class the role routes
 * to (its key in data/roles.json), the subagent target its workers start on, and whether
 * the judge pass is on. There is no control here on purpose - the harness has no HTTP
 * route that writes a role target, so an input would be a lie; the plugin command shown
 * below the list is the real write path.
 */
function roleCard(role) {
  const card = document.createElement("div");
  card.className = "role-card";
  card.dataset.role = role.id;
  card.setAttribute("role", "listitem");

  const title = document.createElement("span");
  title.className = "role-card-title";
  title.textContent = role.title || role.id;
  const id = document.createElement("span");
  id.className = "role-card-id";
  // The key of the role IS the router class it routes through; saying which class makes
  // the connection explicit instead of leaving the reader to infer it from the name.
  id.textContent = `${role.id} class`;
  id.title = `This role routes through the router's ${role.id} class`;
  card.append(title, id);

  // The chain is what the role resolves to when no model is pinned. It comes from the
  // router config; a role with no chain routes by its own name, which is what this says.
  const chain = document.createElement("span");
  chain.className = "role-card-chain";
  chain.textContent = Array.isArray(role.chain) && role.chain.length ? role.chain.join(" → ") : "no chain: routed by role id";
  card.append(chain);

  const facts = [];
  facts.push(role.subagent ? `subagent target ${role.subagent}` : "no subagent target");
  facts.push(role.judge ? "judge pass on" : "judge pass off");
  if (role.effort) facts.push(`effort ${role.effort}`);
  if (role.addendum) facts.push("has an addendum");
  const meta = document.createElement("span");
  meta.className = "role-card-meta";
  meta.textContent = facts.join(" · ");
  card.append(meta);

  return card;
}

// What each fallback list is for, in plain words (router classes by name).
const FALLBACK_PURPOSE = {
  rosalena: [t("Rosalena (the default)"), t("The free default model: Rosalena's own cloud models, then the free gateway.")],
  code: [t("Coding"), t("Writing, fixing and testing code.")],
  orchestrate: [t("Bigger tasks"), t("Planning and running long, many-step work.")],
  fast: [t("Quick jobs"), t("Short answers and the summaries Rosalena writes when a chat gets long.")],
  judge: [t("Checking answers"), t("Used when an answer is checked before it is shown (the judge pass).")],
  deepseek: ["DeepSeek", t("DeepSeek's free model, then GLM.")],
};
const PROVIDER_LABELS = { local: t("this PC"), "opencode-free": t("free cloud"), omniroute: t("OmniRoute (free)"), anthropic: "Anthropic", openai: "OpenAI", google: "Google", openrouter: "OpenRouter", deepseek: "DeepSeek", zai: "Z.AI", kimi: "Kimi" };

/** Whether one step of a list can answer now, and what fixes it when it cannot. */
function fallbackStep(target, data) {
  const text = String(target);
  const provider = text.includes("/") ? text.slice(0, text.indexOf("/")) : text;
  const models = Array.isArray(data?.models) ? data.models : [];
  const info = data?.providers?.[provider] ?? null;
  if (provider === "local") {
    const here = models.some((row) => row?.id === text);
    return here ? { state: "ready", note: t("on this PC") } : { state: "missing", note: t("not on this PC"), fix: { label: t("Get a local model"), run: () => { toggleSettings(false); openPage("/models"); } } };
  }
  if (!data?.providers) return { state: "unknown", note: t("router not answering") };
  if (!info) return { state: "missing", note: t("not set up") };
  if (!info.hasKey) return { state: "missing", note: t("no key"), fix: { label: t("Add key"), run: () => showSettingsPage("cloud") } };
  if (!info.withinBudget) return { state: "blocked", note: t("spend limit reached"), fix: { label: t("Raise limit"), run: () => showSettingsPage("spend") } };
  if (info.circuit === "open") return { state: "blocked", note: t("resting after errors, back soon") };
  return { state: "ready", note: info.free ? t("free") : t("your key") };
}

function renderOrchestration(data) {
  const roles = Array.isArray(data?.roles) ? data.roles : [];
  const errors = Array.isArray(data?.errors) ? data.errors : [];

  const source = el("orchestration-source");
  if (source) {
    const at = data?.fetchedAt ? new Date(data.fetchedAt) : null;
    source.textContent = [
      at && !Number.isNaN(at.valueOf()) ? t("Checked {time}", { time: at.toLocaleTimeString() }) : "",
      errors.length ? t("Some models could not be checked: {errors}", { errors: errors.map((item) => clip(item?.message ?? String(item), 70)).join("; ") }) : "",
    ]
      .filter(Boolean)
      .join(" · ");
  }

  const host = el("orchestration-roles");
  if (host) {
    host.textContent = "";
    if (!roles.length) host.append(emptyRow(t("No lists are set up, so each model answers on its own.")));
    // The default first, then the rest as the router lists them.
    const ordered = [...roles].sort((a, b) => (a.id === "rosalena" ? -1 : b.id === "rosalena" ? 1 : 0));
    for (const role of ordered) {
      const [title, purpose] = FALLBACK_PURPOSE[role.id] ?? [role.title || role.id, ""];
      const card = document.createElement("div");
      card.className = "fallback-card";
      const head = document.createElement("div");
      head.className = "fallback-head";
      const name = document.createElement("strong");
      name.textContent = title;
      const what = document.createElement("span");
      what.className = "fallback-purpose";
      what.textContent = purpose;
      head.append(name, what);
      const steps = document.createElement("ol");
      steps.className = "fallback-steps";
      const chain = Array.isArray(role.chain) ? role.chain : [];
      const checked = chain.map((target) => ({ target, ...fallbackStep(target, data) }));
      const firstReady = checked.findIndex((step) => step.state === "ready");
      checked.forEach((step, index) => {
        const li = document.createElement("li");
        li.className = `fallback-step is-${step.state}${index === firstReady ? " is-first" : ""}`;
        const label = document.createElement("span");
        label.className = "fallback-model";
        const provider = step.target.slice(0, step.target.indexOf("/"));
        label.textContent = modelDisplayName(step.target) || step.target;
        label.title = step.target;
        const where = document.createElement("span");
        where.className = "fallback-where";
        where.textContent = PROVIDER_LABELS[provider] ?? provider;
        const status = document.createElement("span");
        status.className = "fallback-status";
        status.textContent = index === firstReady ? t("answers now · {note}", { note: step.note }) : step.note;
        li.append(label, where, status);
        if (step.fix) {
          const fix = document.createElement("button");
          fix.type = "button";
          fix.className = "mini-btn fallback-fix";
          fix.textContent = step.fix.label;
          fix.onclick = step.fix.run;
          li.append(fix);
        }
        steps.append(li);
      });
      card.append(head, steps);
      if (firstReady < 0 && chain.length) {
        const warn = document.createElement("p");
        warn.className = "fallback-warn";
        warn.textContent = t("Nothing in this list can answer right now. Use a fix button above, or pick a model directly in the model list.");
        card.append(warn);
      }
      host.append(card);
    }
  }

  renderSubagentSettings(data);
}

function renderSubagentSettings(data) {
  const host = el("orchestration-subagents");
  const howto = el("orchestration-howto");
  if (!host) return;
  const roles = Array.isArray(data?.roles) ? data.roles : [];
  const plugin = data?.plugin ?? null;
  host.textContent = "";

  const list = document.createElement("dl");
  list.className = "orch-rows";
  const add = (name, value) => {
    const row = document.createElement("div");
    row.className = "orch-row";
    const dt = document.createElement("dt");
    dt.textContent = name;
    const dd = document.createElement("dd");
    dd.textContent = value;
    row.append(dt, dd);
    list.append(row);
  };

  const delegating = roles.filter((role) => role.subagent);
  add(
    t("Roles that hand off"),
    delegating.length ? delegating.map((role) => `${role.id} → ${role.subagent}`).join(", ") : t("none: no role names a subagent target"),
  );
  add(
    t("Judge pass"),
    roles.some((role) => role.judge)
      ? roles.filter((role) => role.judge).map((role) => role.id).join(", ")
      : t("off for every role"),
  );
  add(
    t("Effort per role"),
    roles.some((role) => role.effort)
      ? roles.filter((role) => role.effort).map((role) => `${role.id}: ${role.effort}`).join(", ")
      : t("no role pins an effort"),
  );
  add(t("Delegation depth"), t("2 levels: the harness refuses a third, so a subagent cannot start a subagent of its own"));
  add(
    t("Role target writer"),
    plugin
      ? `plugin ${plugin.id}${plugin.version ? ` v${plugin.version}` : ""} · ${plugin.enabled ? t("enabled") : t("disabled")}`
      : t("plugin subagent-model-switch is not installed, so a role target can only be changed by editing the file"),
  );
  add(t("Roles file"), plugin?.config?.rolesFile || data?.files?.roles || "data/roles.json");
  add(t("Router config"), plugin?.config?.routerFile || data?.files?.router || "router/router.config.json");
  host.append(list);

  const note = document.createElement("p");
  note.className = "row-help";
  note.textContent =
    t("The lists come from the router's settings file. Most people never need to change them: adding a key or a local model is what makes more of each list work. To change the order itself, use the commands below in a terminal.");
  host.append(note);

  if (!howto) return;
  howto.textContent = "";
  const commands = data?.commands;
  if (!commands) return;
  const head = document.createElement("h4");
  head.textContent = t("The real write path");
  howto.append(head);
  const cwd = document.createElement("p");
  cwd.className = "row-help";
  cwd.textContent = t("Run these from {folder}:", { folder: commands.cwd ?? t("the harness folder") });
  howto.append(cwd);
  for (const [label, command] of [
    [t("show what each role resolves to"), commands.show],
    [t("set a role target"), commands.set],
    [t("reset a role"), commands.reset],
  ]) {
    if (!command) continue;
    const line = document.createElement("div");
    line.className = "orch-command";
    const text = document.createElement("code");
    text.textContent = command;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "mini-btn";
    copy.textContent = t("Copy");
    copy.addEventListener("click", () => copyText(command, copy));
    line.append(text, copy);
    const caption = document.createElement("span");
    caption.className = "orch-command-label";
    caption.textContent = label;
    line.append(caption);
    howto.append(line);
  }
}

function emptyRow(text) {
  const p = document.createElement("p");
  p.className = "empty";
  p.textContent = text;
  return p;
}

// The extra chrome (activity strip, trajectory tabs, reveal button, settings pages) is
// wired in one place so the wiring list below stays readable.
function initialiseChromeExtras() {
  trailReset();
  paintReveal();
  showView("chat");
  bindSettings();
  showSettingsPage("appearance");
  // Sidebar plugins and Creator mode (plugins-ui.js). A plugin's "ask about this" lands in
  // the prompt for the person to read and send; it is never sent for them.
  initPlugins({
    toast,
    newChat,
    onCreatorChange: () => paintAccess(),
    composeIntoChat: (text) => {
      if (text) prompt.value = text;
      autosize();
      prompt.focus();
    },
  });

  el("run-pill")?.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleActivity();
  });
  el("run-refresh")?.addEventListener("click", (event) => {
    event.stopPropagation();
    void refreshActivity({ force: true });
  });
  document.addEventListener("click", (event) => {
    const panel = el("run-panel");
    if (!panel || panel.hidden) return;
    if (event.target.closest("#run-strip")) return;
    toggleActivity(false);
  });

  document.querySelectorAll(".view-tab").forEach((tab) => {
    tab.addEventListener("click", () => showView(tab.dataset.view));
  });
  document.querySelectorAll("#settings-panel [data-settings-page]").forEach((tab) => {
    tab.addEventListener("click", () => showSettingsPage(tab.dataset.settingsPage));
  });
  el("reveal-button")?.addEventListener("click", () => revealPath(""));
  el("check-updates")?.addEventListener("click", () => void checkForUpdates());

  // The poll lives exactly as long as the strip: paintActivity starts it when work
  // appears and stops it when the count reaches zero. A background tab keeps no timer.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void refreshActivity({ force: true });
    } else {
      stopActivityPoll();
    }
  });
  void refreshActivity({ force: true });
}

// ------------------------------------------------------------------ wiring

function initialiseLayout() {
  buildDockSplitters();
  document.querySelectorAll("[data-grip]").forEach(wirePanelGrip);
  document.querySelectorAll("[data-panel] .panel-head").forEach((head) => {
    head.addEventListener("dblclick", (event) => {
      if (event.target.closest("button")) return;
      const panel = head.closest("[data-panel]");
      if (panel) setPanel(panel.dataset.panel, { collapsed: !layout.panels[panel.dataset.panel].collapsed });
    });
  });
  document.querySelectorAll("[data-collapse]").forEach((button) => {
    button.addEventListener("click", () => setPanel(button.dataset.collapse, { collapsed: !layout.panels[button.dataset.collapse].collapsed }));
  });
  document.querySelectorAll("[data-close]").forEach((button) => {
    button.addEventListener("click", () => setPanel(button.dataset.close, { closed: true }));
  });
  // The hamburger's handler is wired with the rest of the top bar (see the "wiring"
  // section); this only paints its first state.
  paintMenuButton();
  paintTabOrder();
  document.querySelectorAll(".insp-tab").forEach(wireInspectorTab);
  el("view")?.addEventListener("click", (event) => {
    event.stopPropagation();
    openViewMenu(el("view"));
  });
  el("view-open")?.addEventListener("click", (event) => {
    event.stopPropagation();
    openViewMenu(el("view-open"));
  });
  document.addEventListener("click", (event) => {
    if (!el("view-menu").hidden && !event.target.closest("#view-menu, #view, #view-open")) closeViewMenu();
  });
  el("palette-open")?.addEventListener("click", () => openPalette(true));
  el("palette")?.addEventListener("click", (event) => {
    if (event.target === el("palette")) openPalette(false);
  });
  el("palette-input")?.addEventListener("input", (event) => paintPalette(event.target.value));
  el("palette-input")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      runPaletteSelection();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!el("palette").hidden) openPalette(false);
      if (!el("view-menu").hidden) closeViewMenu();
    }
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "p") {
      event.preventDefault();
      openPalette(el("palette").hidden);
    }
  });

  renderLayout();
  side.tabs = readSideTabs();
  // A tab read under a pre-rosa plugin name is saved back under its new one.
  if (JSON.stringify(side.tabs) !== (readPref(SIDE_TABS_KEY) || "[]")) saveSideTabs();
  // Each Browser tab's last address (and nothing for a tab that is gone, or an unsafe one).
  loadWebState();
  paintSideTabs();
  switchInspector(layout.tab);
  tickActivity();
  paintStatus();
  setInterval(paintStatus, 15000);
  setInterval(tickActivity, 30000);
  const refit = () => {
    for (const dock of LAYOUT_DOCKS) applyDockSize(dock);
  };
  // The docks are fitted into the row, so the row is what gets watched: a panel growing,
  // the status strip rewrapping or the window resizing all change the room they have.
  refit();
  requestAnimationFrame(refit);
  // The clamp depends on the window as well as the row, and a resize is the moment the
  // pair can stop fitting. Watching both is what makes a legal arrangement stay legal at
  // 1024px, not a one-time clamp at load.
  window.addEventListener("resize", refit, { passive: true });
  if (typeof ResizeObserver === "function" && layoutRow) {
    new ResizeObserver(refit).observe(layoutRow);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    paintStatus();
    tickActivity();
    inspector.mounted[layout.tab]?.refresh?.();
  });
}


// ------------------------------------------------------------------ page overlay
//
// Tokens, Monitor, Models, Plugins, Wi-Fi and VPN used to be full page loads: going back
// reloaded the whole app (slow) and dropped the chat on screen. They now open over the
// chat in a frame; the chat, its stream and the queue keep running underneath.

const PAGE_TITLES = { "/usage": "Tokens", "/monitor": "Monitor", "/models": t("What this PC can run"), "/plugins": "Plugins", "/network": t("Wi-Fi networks"), "/exits": t("VPN exits"), "/remote": t("Remote access") };
const PAGE_GROUPS = [
  ["/usage", "/monitor"],
  ["/network", "/exits"],
];

// The More menu's Network row folds out Wi-Fi, VPN exits and the VPN switches.
el("network-toggle")?.addEventListener("click", (event) => {
  event.stopPropagation();
  const group = el("network-group");
  if (!group) return;
  group.hidden = !group.hidden;
  event.currentTarget.setAttribute("aria-expanded", String(!group.hidden));
});

function isOverlayPage(href) {
  try {
    const url = new URL(href, location.href);
    return url.origin === location.origin && Object.hasOwn(PAGE_TITLES, url.pathname.replace(/\/+$/, ""));
  } catch {
    return false;
  }
}

function openPage(href) {
  const overlay = el("page-overlay");
  const frame = el("page-overlay-frame");
  if (!overlay || !frame) {
    location.assign(href);
    return;
  }
  const url = new URL(href, location.href);
  const path = url.pathname.replace(/\/+$/, "");
  // Pages that belong together open as tabs of one overlay: usage with the model server,
  // Wi-Fi with the VPN exits.
  const group = PAGE_GROUPS.find((members) => members.includes(path)) ?? null;
  el("page-overlay-title").textContent = group ? "" : PAGE_TITLES[path] ?? "";
  const bar = el("page-overlay-bar");
  if (bar) bar.hidden = !group;
  const tabs = el("page-overlay-tabs");
  if (tabs) {
    tabs.replaceChildren(
      ...(group ?? []).map((member) => {
        const tab = document.createElement("button");
        tab.type = "button";
        tab.className = "page-overlay-tab";
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-selected", String(member === path));
        tab.textContent = PAGE_TITLES[member];
        tab.onclick = () => openPage(member);
        return tab;
      }),
    );
  }
  overlay.hidden = false;
  if (frame.dataset.src !== url.href) {
    frame.dataset.src = url.href;
    frame.src = url.href;
  }
  // Focus goes into the page, so its own keys (and Esc, below) work at once.
  el("page-overlay-frame")?.focus();
}

function closePage() {
  const overlay = el("page-overlay");
  if (!overlay || overlay.hidden) return;
  overlay.hidden = true;
  prompt.focus();
}

el("page-overlay-frame")?.addEventListener("load", (event) => {
  const frame = event.currentTarget;
  let doc = null;
  try {
    doc = frame.contentDocument;
    // A page's own "back to chats" went to "/": that is this window, so close instead.
    if (frame.contentWindow.location.pathname === "/") {
      frame.dataset.src = "";
      frame.src = "about:blank";
      closePage();
      return;
    }
  } catch {
    return;
  }
  if (!doc) return;
  // Where the page really is now (it may have moved through its own links), so reopening the
  // same page from the menu is recognised as the page already showing.
  try {
    if (frame.contentWindow.location.href !== "about:blank") frame.dataset.src = frame.contentWindow.location.href;
  } catch {}
  // Its back links and Esc come back here without loading the app a second time.
  doc.addEventListener(
    "click",
    (click) => {
      const link = click.target?.closest?.("a[href]");
      if (!link) return;
      const target = new URL(link.getAttribute("href"), frame.contentWindow.location.href);
      if (target.origin === location.origin && target.pathname === "/") {
        click.preventDefault();
        closePage();
        // Links back into the app that ask for something: Creator mode, the MCP list.
        if (target.searchParams.get("creator") === "1") el("apps-create")?.click();
        if (target.searchParams.get("mcp") === "1") setTimeout(() => toggleMcpPanel(true), 0);
      }
    },
    true,
  );
  doc.addEventListener(
    "keydown",
    (key) => {
      if (key.key === "Escape" && !key.defaultPrevented) {
        // Esc belongs to the page first: an open dialog, a menu or a field being typed in.
        if (doc.querySelector("dialog[open], .modal.open, [role=dialog]:not([hidden])")) return;
        const typing = key.target?.closest?.("input, textarea, select, [contenteditable=''], [contenteditable=true]");
        if (typing && String(typing.value ?? typing.textContent ?? "").length) return;
        key.preventDefault();
        key.stopImmediatePropagation();
        closePage();
      }
    },
    true,
  );
});
document.addEventListener(
  "click",
  (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const link = event.target?.closest?.("a[href]");
    if (!link || link.target === "_blank" || !isOverlayPage(link.getAttribute("href"))) return;
    event.preventDefault();
    const drawer = el("more-drawer");
    if (drawer && !drawer.hidden) el("more-open")?.click();
    openPage(link.getAttribute("href"));
  },
  true,
);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && el("page-overlay") && !el("page-overlay").hidden) closePage();
});

// A reload keeps the chat that was open: the URL's ?chat first, else the last chat viewed
// (kept in localStorage, which ui-state.json carries across restarts), so coming back from
// another page or restarting the app lands on the conversation the person was in.
const LAST_CHAT_KEY = "rosalena-last-chat";
function rememberChat(id) {
  try {
    if (id) localStorage.setItem(LAST_CHAT_KEY, id);
    else localStorage.removeItem(LAST_CHAT_KEY);
  } catch {
    /* storage blocked: the URL still carries it */
  }
  const url = new URL(location.href);
  if (id) url.searchParams.set("chat", id);
  else url.searchParams.delete("chat");
  if (url.href !== location.href) history.replaceState(null, "", url);
}
function openFromUrl() {
  let id = new URL(location.href).searchParams.get("chat");
  if (!id) {
    try {
      id = localStorage.getItem(LAST_CHAT_KEY);
    } catch {
      id = null;
    }
  }
  if (id) openChat(id);
}

// Render rate: the saved value is read before the first delta can arrive, so a chat
// that starts immediately is already painted at the chosen rate.
render.rate = readRenderRate();
paintRateUI();
paintThemeButton();

// Desktop-only chrome (window buttons, the resizable switch); a no-op in a browser.
initialiseDesktop();
updateRateCounter();

try {
  const saved = localStorage.getItem("rosalena-theme");
  if (THEMES.includes(saved)) applyTheme(saved);
} catch {
  /* private mode */
}

// A small debug surface, used to measure the render rate (pump deltas through the real
// path, read the applied/received counters back). It is the same code path the stream
// uses; there is no measurement-only renderer.
window.__rosalenaDebug = {
  renderEvent,
  setRenderRate,
  rate: () => render.rate,
  stats: () => ({ rate: render.rate, applied: render.applied, received: render.received }),
  layout: () => clone(layout),
  applyPreset,
  saveLayout,
  resetLayout: () => {
    try {
      localStorage.removeItem(LAYOUT_KEY);
      localStorage.removeItem(PANEL_WIDTHS_KEY);
    } catch {
      /* private mode */
    }
    const fresh = readLayout();
    Object.assign(layout, fresh);
    renderLayout();
    switchInspector(layout.tab);
  },
  panels: () => {
    const out = {};
    for (const id of LAYOUT_PANELS) {
      const node = panelNode(id);
      const box = node?.getBoundingClientRect();
      out[id] = {
        dock: layout.panels[id].dock,
        order: layout.panels[id].order,
        closed: layout.panels[id].closed,
        collapsed: layout.panels[id].collapsed,
        w: box ? Math.round(box.width) : null,
        h: box ? Math.round(box.height) : null,
      };
    }
    return out;
  },
  overflow: () => {
    const doc = document.documentElement;
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollWidth: doc.scrollWidth,
      scrollHeight: doc.scrollHeight,
      overflowsX: doc.scrollWidth > window.innerWidth,
      overflowsY: doc.scrollHeight > window.innerHeight,
    };
  },
};

/**
 * Dictation into the prompt. The page records 16 kHz mono PCM itself (so no ffmpeg is
 * needed), the server runs one whisper.cpp process on it with the best Whisper model on
 * this PC, and the words are added to the prompt to read and fix - never sent by
 * themselves. The model is loaded for that one transcription and gone after it.
 */
function bindMic() {
  const mic = document.getElementById("mic");
  if (!mic) return;
  const RATE = 16000;
  let rec = null;

  let setup = null;
  const refresh = async () => {
    try {
      const v = await api("/api/voice");
      // Always shown: with no model yet, the first click offers to set voice typing up.
      mic.hidden = false;
      mic.dataset.ready = String(v.ok);
      setup = v.setup ?? null;
      mic.title = v.ok ? t("Voice typing with {model} (on this PC): click to start, click again to stop", { model: v.model }) : v.why;
    } catch {
      mic.hidden = true;
    }
  };

  /**
   * One-time setup from the first click: the speech model and its runner, downloaded and
   * checked by the Models page's downloader, then the button is ready.
   */
  const setUp = async () => {
    const mb = setup?.bytes ? Math.round(setup.bytes / 1024 / 1024) : 60;
    const yes = window.confirm(
      t("Turn on voice typing?\n\nRosalena downloads the {name} speech model ({mb} MB) and its runner, once. Everything you say is transcribed on this PC; no audio leaves it.", { name: setup?.name ?? "Whisper", mb }),
    );
    if (!yes) return false;
    mic.disabled = true;
    mic.classList.add("working");
    try {
      const started = await post("/api/models/download", { action: "start", kind: "voice", id: setup.id });
      if (started.ok === false) throw new Error(started.error ?? t("the download did not start"));
      toast(t("Downloading the voice model…"));
      for (;;) {
        await new Promise((r) => setTimeout(r, 1000));
        const { job } = await api("/api/models/download");
        if (!job) continue;
        const pct = job.total ? ` ${Math.round((job.received / job.total) * 100)}%` : "";
        mic.title = `${t("Setting up voice typing: {part}", { part: job.phase === "runtime" ? t("the runner") : t("the model") })}${pct}`;
        if (job.phase === "done") break;
        if (job.phase === "failed" || job.phase === "cancelled") throw new Error(job.error ?? job.phase);
      }
      await refresh();
      if (mic.dataset.ready !== "true") throw new Error(mic.title);
      toast(t("Voice typing is ready: click the mic, talk, click again."), "ok");
      return true;
    } catch (err) {
      toast(t("Voice typing could not be set up: {error}", { error: err.message }), "error");
      await refresh();
      return false;
    } finally {
      mic.disabled = false;
      mic.classList.remove("working");
    }
  };

  const resample = (samples, from) => {
    if (from === RATE) return samples;
    const ratio = from / RATE;
    const out = new Float32Array(Math.floor(samples.length / ratio));
    for (let i = 0; i < out.length; i += 1) {
      const at = i * ratio;
      const lo = Math.floor(at);
      const hi = Math.min(lo + 1, samples.length - 1);
      out[i] = samples[lo] + (samples[hi] - samples[lo]) * (at - lo);
    }
    return out;
  };

  /** 16-bit PCM WAV, base64: what whisper.cpp reads without ffmpeg. */
  const wavBase64 = (samples) => {
    const bytes = new Uint8Array(44 + samples.length * 2);
    const view = new DataView(bytes.buffer);
    const text = (at, s) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
    text(0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    text(8, "WAVEfmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, RATE, true);
    view.setUint32(28, RATE * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, "data");
    view.setUint32(40, samples.length * 2, true);
    samples.forEach((s, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true));
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  };

  const stop = async () => {
    const r = rec;
    rec = null;
    mic.setAttribute("aria-pressed", "false");
    mic.classList.remove("recording");
    r.processor.disconnect();
    r.source.disconnect();
    r.stream.getTracks().forEach((track) => track.stop());
    await r.ctx.close().catch(() => {});
    const length = r.chunks.reduce((n, c) => n + c.length, 0);
    const all = new Float32Array(length);
    let at = 0;
    for (const chunk of r.chunks) {
      all.set(chunk, at);
      at += chunk.length;
    }
    const samples = resample(all, r.rate);
    if (samples.length < RATE * 0.3) return toast(t("Nothing was recorded."));
    mic.disabled = true;
    mic.classList.add("working");
    try {
      // What is already typed before the cursor: the sentence continues in the same words.
      const out = await post("/api/voice/transcribe", { wav: wavBase64(samples), context: prompt.value.slice(0, prompt.selectionStart).slice(-400) });
      if (!out.text) return toast(t("Whisper heard no words."));
      const before = prompt.value.slice(0, prompt.selectionStart);
      const after = prompt.value.slice(prompt.selectionEnd);
      const pad = before && !/\s$/.test(before) ? " " : "";
      prompt.value = `${before}${pad}${out.text}${after}`;
      prompt.selectionStart = prompt.selectionEnd = before.length + pad.length + out.text.length;
      prompt.focus();
      autosize();
    } catch (err) {
      toast(t("Dictation failed: {error}", { error: err.message }), "error");
    } finally {
      mic.disabled = false;
      mic.classList.remove("working");
    }
  };

  mic.addEventListener("click", async () => {
    if (rec) return stop();
    if (mic.dataset.ready !== "true") {
      await refresh();
      // Not set up yet: offer it, then the next click records.
      if (mic.dataset.ready !== "true" && setup) return void setUp();
      if (mic.dataset.ready !== "true") return toast(mic.title, "error");
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      const ctx = new AudioContext({ sampleRate: RATE });
      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      const chunks = [];
      processor.onaudioprocess = (event) => chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      source.connect(processor);
      processor.connect(ctx.destination);
      const mine = { stream, ctx, source, processor, chunks, rate: ctx.sampleRate };
      rec = mine;
      mic.setAttribute("aria-pressed", "true");
      mic.classList.add("recording");
      // Five minutes is a long dictation; past that it stops and transcribes by itself.
      setTimeout(() => rec === mine && void stop(), 5 * 60 * 1000);
    } catch (err) {
      toast(t("The microphone did not open: {error}", { error: err.message }), "error");
    }
  });
  // A model downloaded in the Models page shows the button when the person comes back.
  window.addEventListener("focus", () => !rec && void refresh());
  void refresh();
}

bindStarters();
bindMic();
autosize();
// The model trigger, the menu it opens and the removal of the old effort control all
// happen before the menu arrives, so the bar is never missing a picker.
initialiseModelPicker();
initialiseChoiceMenus();
// The activity strip, the Chat/Trajectory tabs, the reveal button and the settings pages
// are wired here, after the pickers exist and before the first chat can arrive.
initialiseChromeExtras();
loadHealth();
bindStarterOffer();
bindSetup();
void loadStarter();
bindShareAsk();
bindCloud();
// Saved folds and the context window first, so the sidebar draws folded the way it was left.
bindPrefControls();
bindAccount();
void loadSlashCommands();
void loadPrefs().finally(() => loadSessions());
openFromUrl();
// The arrangement is drawn before the first paint is likely, and after the DOM exists.
initialiseLayout();

// ------------------------------------------------------------------ session rail
//
// The per-chat info panel (ui/session-rail.mjs). It owns its DOM, its placement (Docked or
// Overlay, saved under rosalena-session-rail like the rest of the window's look) and its
// keys; the hooks above feed it the events, meter, MCP list and activity this file already
// has. Everything it does to the chat goes through the same functions the page uses.
rail = createSessionRail({
  token: TOKEN,
  api,
  readPref,
  writePref,
  current: () => ({
    thread: state.current?.kind === "rosalena" ? state.current.thread ?? state.current.id : null,
    runId: state.current?.kind === "rosalena" ? state.current.id : null,
    busy: state.busy,
    external: state.current?.kind === "external",
  }),
  workspace: () => currentWorkspace(),
  isDefaultWorkspace: (path) => DEFAULT_WORKSPACE.test(path),
  // With no reading yet: the window the next message gets (Claude Code rows carry contextMax).
  idleWindow: () => railIdleWindow({ row: selectedModelRow(), menuWindow: Number(state.menu?.contextWindow) || 0 }),
  activity: () => activity.data,
  activityAt: () => activity.at,
  refreshActivity: () => void refreshActivity({ force: true }),
  openFile: (abs) => void openFileTab(abs),
  openFolderSettings: () => el("opts-btn")?.click(),
  chooseWorkspace: () => void chooseWorkspace(),
  reveal: (path) => void revealPath(path),
  openMcp: () => toggleMcpPanel(true),
  openContext: () => {
    if (!ctxMeter.hidden) toggleCtxPanel(true);
  },
});
prompt.focus();
