// The visual UI's server.
//
// One file, no dependencies, no build step: node:http serves three static files and a
// small JSON API, and the browser does the rest. That is a deliberate ceiling - the
// harness must run on a machine with no package manager, and an app that needs a bundler
// to show a chat log is an app that is broken on half the boxes this targets.
//
// What it exposes:
//   GET  /                    the page
//   GET  /api/health          router state, model classes, session counts
//   GET  /api/models          the picker: router models, local models, and the roles
//   GET  /api/sessions        Rosalena chats (the run store) + other harnesses' sessions
//   GET  /api/folders         the sidebar's groups, with their sessions in them
//   POST /api/folders         {name} create a folder
//   PATCH /api/folders        {id, name} rename one
//   DELETE /api/folders?id=   delete one (its sessions become ungrouped, never deleted)
//   POST /api/folders/move    {id, folderId} file a chat under a folder
//   GET  /api/chat?id=        one chat, live or finished, as events
//   GET  /api/context?id=     what that chat costs: window, used, percent, parts
//   POST /api/chat            start a run: {task, model?, role?, parentId?, attachments?}
//   GET  /api/stream?id=      Server-Sent Events for one chat
//   GET  /api/session?source=&id=   one external session's transcript
//   GET  /api/activity        what is running now: live runs, subagents, ledger processes
//   GET  /api/orchestration   roles + the subagent settings that really exist, read from disk
//   POST /api/reveal          {path} open the OS file manager there (workspace-only)
//   GET  /api/prefs           saved window preferences: context window, folded folders
//   PUT  /api/prefs           {contextWindow?, maxSteps?, collapsed?, profile?, appearance?, show?, accessMode?, toolLoading?}
//   POST /api/approve         {id, approval, decision: allow|always|deny, note?} answer an approval card
//   GET  /api/undo?id=        the steps of a run that changed files
//   GET  /api/session-rail?id=&workspace=  the session rail: folder, git branch, lines +/- (session-rail.mjs)
//   POST /api/undo            {id, step} put those files back as they were before that step
//   GET  /api/commands        the slash commands: built-in plus the person's command files
//   GET  /api/commit-mode     commit-cadence for this workspace: {available, mode, git, held}
//   PUT  /api/commit-mode     {mode: off|ask|loose|autonomous} the composer's Commits menu
//
// Security posture: loopback bind, and every mutating request has to carry the token the
// page was served with. A local page that is not ours cannot drive a shell-capable agent
// through a bare POST just because the user has this tab open.

import { createServer } from "node:http";
import { isImagePath } from "./images.mjs";
import { readFile } from "node:fs/promises";
import { closeSync, cpSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, basename, sep } from "node:path";
import { pipeline } from "node:stream";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";

import { runAgent, DEFAULT_ROUTER, routerAuthHeaders } from "./agent.mjs";
import { cancelRequested, listRuns, newRunId, readRun, requestCancel, runStatus, runsDir } from "./runs.mjs";
import { claudeCodeStatus, isClaudeCodeModel, menuRows as claudeCodeRows, runClaudeCode } from "./claude-engine.mjs";
import { codexStatus, isCodexModel, menuRows as codexRows, runCodex } from "./codex-engine.mjs";
import { runGoal } from "./goal-runner.mjs";
import { sandboxSupport } from "./sandbox.mjs";
import { dictationPrompt } from "./voice-hints.mjs";
import { listExternalSessions, readExternalSession, sessionCounts, roots } from "./sessions.mjs";
import { createTerminals, SHELLS } from "./terminal.mjs";
import { listPluginManifests, loadPlugins, pluginRoot, readHarnessConfig, renamePluginKeys } from "./plugins.mjs";
import { addMcpServer, claudeCodeServers, importClaudeCodeServers, listMcpServers, mcpFiles, probeMcpServer, removeMcpServer, setMcpEnabled } from "./mcp-panel.mjs";
import { listUiPlugins, publicView, servePluginRequest, userPluginsDir } from "./ui-plugins.mjs";
import { createCreator } from "./creator.mjs";
import { describeReport } from "./plugin-verify.mjs";
import { createFolder, deleteFolder, foldersFile, groupSessions, moveRun, readFolders, renameFolder, writeFolders } from "./folders.mjs";
import { branchesFile, collapseThreads, linkRun, readBranches, readThreads, recordBranch, rootOf, threadMembers, threadsFile } from "./threads.mjs";
import { MODEL_KINDS, createModelDownloader, downloadTarget, findDownloaded, loadMediaCatalog, scoreMedia } from "./model-downloads.mjs";
import { createMenuCache, defaultEffortOf, effortsOf, loadModelMenu } from "./models.mjs";
import { probeHardware } from "./hardware.mjs";
import { CATALOG_PATH, loadCatalog, recommend } from "./catalog.mjs";
import { createRemoteAccess } from "./remote.mjs";
import { createRemoteStore, remoteStateFile } from "./remote-store.mjs";
import { installCloudflared, locateInstalled as locateInstalledCloudflared } from "./cloudflared-install.mjs";
import { createRelayClient } from "./relay-client.mjs";
import { revealInFileManager } from "./reveal.mjs";
import { existingFolder, insideRoot, listFolder } from "./list-folder.mjs";
import { detectModelDirs } from "./local-paths.mjs";
import { KEY_PROVIDERS, cleanKey, createOmniRoute, keyRows, omnirouteRunning, saveProviderKey, studentPrograms } from "./cloud-setup.mjs";
import { createOmniRouteManager } from "./omniroute-manager.mjs";
import { readLocalPrefs, writeLocalPrefs } from "./local-fit.mjs";
import { runContextWindow } from "./context.mjs";
import { ggufShape } from "./gguf.mjs";
import { injectUiState, readUiState, writeUiState } from "./ui-state.mjs";
import { installWhisperRuntime, transcribeFile, voiceStatus } from "./voice-runner.mjs";
import { allComfyRunners, comfyRunner, findComfyInstall, runnableModels, setLocalRelease } from "./comfy-runner.mjs";
import { createStarterInstaller,findInstalledStarter, hasServerBinary, loadRuntime, pickStarter, runtimeKey, starterHome } from "./starter-model.mjs";
import { listChanges, undoFrom } from "./undo.mjs";
import { chatChanges, gitBranch } from "./session-rail.mjs";
import { loadCommands } from "./commands.mjs";
import { BUNDLED_SKILLS, listSkills, skillDirs } from "./tools-extra.mjs";
import { cloudProviderRows, deleteTemplate, localServerRows, permissionsFile, probeListening, readPermissionRules, readSkillsOff, saveTemplate, setSkillEnabled, skillSource, skillsOffFile, templatesDir, writePermissionRules } from "./settings.mjs";
import { readRouterConfig } from "./models.mjs";
import { DEFAULT_RULES } from "./permissions.mjs";
import { decideUpdate, fetchUpdateManifest, readVersionFromPackage, shouldCheck } from "./update.mjs";
import { createTelemetry, sharingLevel, SHARING_IS_OPTIONAL } from "./telemetry.mjs";
import { releaseMessageSink, setMessageSink } from "./message-log.mjs";
import { MAX_TOKENS_CHOICES, MAX_TOKENS_MAX, MAX_TOKENS_MIN, TEMPERATURE_MAX } from "./ui-prefs.mjs";
import { SHARING_CHOICES, ACCESS_CHOICES, UI_DEFAULT_ACCESS, TOOL_LOADING_CHOICES, UI_DEFAULT_TOOL_LOADING, QUEUE_CHOICES, UI_DEFAULT_QUEUE, ACCENTS, DENSITIES, TEXT_SIZES, THEMES as UI_THEMES, PALETTES, CONTEXT_WINDOW_CHOICES, MAX_MINUTES_CHOICES, MAX_STEPS_CHOICES, UI_DEFAULT_MAX_MINUTES, UI_DEFAULT_CONTEXT_WINDOW, UI_DEFAULT_MAX_STEPS, prefsFile, readPrefs, updatePrefs, writePrefs } from "./ui-prefs.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// The version this copy is running. The desktop build stamps desktop/package.json and the
// harness carries its own, so both are tried in the order the packaged layout puts them and
// a build with neither reports `null` - the update check then says it cannot tell rather
// than guessing a version it does not have.
const VERSION_FILES = [
  resolve(HERE, "..", "..", "desktop", "package.json"),
  resolve(HERE, "..", "package.json"),
  resolve(HERE, "..", "..", "package.json"),
];

function appVersion() {
  for (const file of VERSION_FILES) {
    try {
      const found = readVersionFromPackage(readFileSync(file, "utf8"));
      if (found) return found;
    } catch {
      // A missing candidate is the normal case, not an error: one of them exists.
    }
  }
  return null;
}
const UI_DIR = resolve(HERE, "..", "ui");
const DEFAULT_PORT = 8090;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const json = (res, code, body) => {
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
};

async function readBody(req, limit = 32 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Attachment names come from a browser: never let one pick the path. */
const safeName = (name) =>
  basename(String(name ?? "file"))
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "")
    .slice(0, 120) || "file";

/**
 * What Creator mode adds to the system prompt. The tools enforce the rules (a draft cannot
 * be published unless the exact files passed verification); this tells the model the
 * workflow so it does not waste the run discovering it.
 */
export const CREATOR_ADDENDUM = [
  "CREATOR MODE is on: the person wants a plugin for Rosalena's sidebar - a page such as a tool, a viewer, a game or a theme.",
  'Before anything else, call the skill tool with name "plugin-builder" and follow it.',
  "Build only through the creator tools: creator_new, then creator_write for each file, then creator_verify. Never write plugin files with write_file or the shell.",
  "Read every FAIL line creator_verify prints, fix the cause and verify again until it prints PASS. Never weaken or delete a self-test to make it pass.",
  "Then creator_publish, and tell the person: it is in the sidebar, what it does, and that its page has a Versions menu (and creator_rollback) to put the previous version back.",
  "If a tool is not attached yet, load it with load_tools first (creator_new, creator_write, creator_read, creator_files, creator_verify, creator_publish, creator_rollback, creator_status).",
].join("\n");

/** One event to everyone watching a chat, and into its replay log. */
function broadcastTo(chat, event) {
  chat.events.push(event);
  for (const send of chat.subscribers) {
    try {
      send(event);
    } catch {
      /* a subscriber that died mid-write is removed by its own close handler */
    }
  }
}

/**
 * Start a chat. The run id is chosen here, not by the agent, so the browser knows the
 * id before the first token exists - the same reason the CLI grew `--run-id`.
 */
function startChat({
  task,
  model = "orchestrate",
  // A role preset: who is answering. Its addendum is appended to the system prompt and
  // its `subagent` target decides what a delegated worker runs on. Separate from the
  // model on purpose - the role used to BE the model selection, which meant picking
  // "Fast" silently changed which model answered.
  role = null,
  parentId = null,
  // How hard the answering model should think, passed straight to the run; the router
  // keeps or drops it per provider.
  effort = "",
  ultracode = false,
  attachments = [],
  workspace,
  home,
  routerUrl,
  contextWindow,
  // A sentence for the transcript when the window this chat gets is not the one the
  // person asked for (a local server loaded at a smaller -c). Null when they agree.
  contextNotice = null,
  maxSteps,
  maxWallMs,
  // Settings > Generation: the output cap each step asks for, and the sampling temperature.
  // Null for either leaves the run's own default.
  maxTokens = null,
  temperature = null,
  accessMode = "full",
  toolLoading = "all",
  sandbox = false,
  desktop = false,
  planMode = false,
  goal = false,
  // A goal chat runs this many rounds at most (1 = one round per message, as before),
  // and stops starting new ones after this many hours. 25 since 2026-11-08: each round
  // starts with a fresh context from the goal file, so a round that fills its window or
  // its step budget hands over to the next instead of ending the goal.
  missionRounds = 25,
  missionHours = 8,
  // The window the local server is really loaded with (null for a cloud model): a live
  // change of the Context window setting is never adopted above it.
  servedWindow = null,
  onEvent,
  extraTools = [],
  extraHooks = [],
  // Early-build tracking (telemetry.mjs), or null: told about the chat once it ends.
  telemetry = null,
}) {
  const id = newRunId();
  const chat = {
    id,
    task,
    model,
    role: role?.id ?? null,
    parentId,
    accessMode,
    planMode,
    workspace,
    createdAt: new Date().toISOString(),
    events: [],
    status: "running",
    answer: null,
    error: null,
    messages: null,
    // The last reading of the context meter for THIS chat, kept so a page that joins
    // mid-stream (or asks after the run ended) has a number without replaying the log.
    // It is set from the `ui/context` events the loop emits.
    context: null,
    subscribers: new Set(),
    // Approval cards waiting for the person: id -> resolve. See approve() below.
    approvals: new Map(),
    // Goal mode, kept so a follow-up ("continue") to a goal chat stays a goal chat.
    goal: Boolean(goal),
    servedWindow: Number(servedWindow) > 0 ? Number(servedWindow) : null,
    // Set by a Context window change while the run goes (PUT /api/prefs); the loop
    // adopts it at its next step boundary.
    liveWindow: null,
    // Steer messages (POST /api/steer) waiting for the next step boundary.
    steer: [],
  };
  chats.set(id, chat);

  const broadcast = (event) => {
    // This chat's own meter, not a sub-agent's: a delegated worker's prompt is a
    // different conversation, and its numbers would make the gauge jump backwards.
    if (event.type === "ui/context" && !event.sub) {
      const { type: _type, phase: _phase, step: _step, at: _at, ...meter } = event;
      chat.context = meter;
    }
    chat.events.push(event);
    for (const send of chat.subscribers) {
      try {
        send(event);
      } catch {
        /* a subscriber that died mid-write is removed by its own close handler */
      }
    }
    if (onEvent) onEvent(event);
  };

  // An approval is an event the page draws as a card, and a promise the run waits on.
  // POST /api/approve resolves it; a cancel resolves every open one as "deny".
  let approvalSeq = 0;
  // Said once, before the first step, so the transcript explains a smaller window than
  // the one in Settings instead of leaving the person to find the server themselves.
  if (contextNotice) broadcast({ type: "notice", from: ["context"], text: contextNotice });  const approve = (request) =>
    new Promise((resolveApproval) => {
      approvalSeq += 1;
      const approvalId = `ap-${approvalSeq}`;
      chat.approvals.set(approvalId, resolveApproval);
      broadcast({ type: "approval", id: approvalId, ...request });
    });

  // Files are written into the product's own data folder, then named in the task so the
  // agent's read_file tool can open them by path. That folder is outside the workspace,
  // so the run is also told it may read it - otherwise read_file refuses the very file
  // the task just named and the model reaches for the shell instead.
  const saved = [];
  let attachmentDir = null;
  if (attachments.length) {
    const dir = join(home, "attachments", id);
    mkdirSync(dir, { recursive: true });
    attachmentDir = dir;
    for (const file of attachments) {
      if (!file?.name || typeof file?.dataBase64 !== "string") continue;
      const name = safeName(file.name);
      const path = join(dir, name);
      try {
        writeFileSync(path, Buffer.from(file.dataBase64, "base64"));
        saved.push({ name, path, bytes: Buffer.byteLength(file.dataBase64, "base64") });
      } catch (err) {
        broadcast({ type: "error", message: `could not save attachment ${name}: ${err.message}` });
      }
    }
  }

  // Pictures are shown to the model directly; every file is still named so it can be read.
  const imageFiles = saved.filter((f) => isImagePath(f.path)).map((f) => f.path);
  const withFiles = saved.length
    ? `${task}\n\nAttached files (open them with read_file):\n${saved.map((f) => `- ${f.path}`).join("\n")}`
    : task;

  // The follow-up needs the earlier turns. A chat started in this process still has
  // them in memory; one loaded from disk (a restart, yesterday's conversation) has to be
  // rebuilt from its event log, or "continue this chat" silently starts from nothing.
  let seed;
  if (parentId) {
    const live = chats.get(parentId);
    if (live?.messages?.length) seed = live.messages;
    else {
      const rebuilt = transcriptFromEvents(historicChat(parentId, home)?.events ?? []);
      if (rebuilt.length) seed = rebuilt;
    }
  }

  // A goal chat is a mission: rounds until the goal is done (goal-runner.mjs), every
  // round's events in this one chat. Each later round is its own run, linked into the
  // chat's thread so the sidebar still shows one conversation.
  const runsRoot = runsDir(home ? join(home, "runs") : undefined);

  // Another agent as the engine: the person's own Claude Code (claude-engine.mjs) or Codex
  // CLI (codex-engine.mjs) answers, and this window, the store and the queue stay
  // Rosalena's. A follow-up resumes that tool's own session (thread); a follow-up to a chat
  // another model answered gets that chat's transcript as text instead, since there is no
  // session of this tool to resume.
  const engine = isClaudeCodeModel(model)
    ? { id: "claude-code", name: "Claude Code", sessionKey: "claudeSession" }
    : isCodexModel(model)
      ? { id: "codex", name: "Codex", sessionKey: "codexSession" }
      : null;
  if (engine) {
    let session = null;
    let previousTotals = null;
    let carried = "";
    if (parentId) {
      const live = chats.get(parentId);
      const record = live?.[engine.sessionKey] ? null : readRun({ dir: runsRoot, id: parentId, maxEvents: 0 })?.record ?? null;
      session = live?.[engine.sessionKey] ?? (record?.engine === engine.id ? record.session ?? null : null);
      previousTotals = live?.engineTotals ?? (record?.engine === engine.id ? record.engineTotals ?? null : null);
      if (!session && seed?.length) {
        const text = seed.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${typeof m.content === "string" ? m.content : ""}`).join("\n\n");
        carried = `Earlier in this conversation (with another model):\n\n${text.slice(-12000)}\n\n---\n\n`;
      }
      if (!session) previousTotals = null;
    }
    if (goal) broadcast({ type: "notice", from: [engine.id], text: `Goal missions run one round at a time with ${engine.name}: send the next message to continue.` });
    const common = {
      task: `${carried}${withFiles}`,
      model,
      root: workspace,
      runId: id,
      runsDir: runsRoot,
      onEvent: broadcast,
      accessMode,
      planMode,
      session,
      appendSystemPrompt: role?.addendum ?? "",
      addDirs: attachmentDir ? [attachmentDir] : [],
      effort,
      maxWallMs: maxWallMs ?? Infinity,
    };
    const running = engine.id === "codex" ? runCodex({ ...common, previousTotals, images: imageFiles, ultracode }) : runClaudeCode({ ...common, contextWindow });
    running.then((result) => {
      chat.status = result.error ? "failed" : result.stopped ? "stopped" : "ok";
      chat.answer = result.answer ?? null;
      chat.error = result.error ?? null;
      chat.stopped = result.stopped ?? null;
      chat.steps = result.steps ?? null;
      chat.ms = result.ms ?? null;
      chat[engine.sessionKey] = result.session ?? null;
      chat.engineTotals = result.engineTotals ?? null;
      if (result.contextMeter) chat.context = result.contextMeter;
      // What a follow-up on a Rosalena model is seeded with.
      chat.messages = [...(seed ?? []), { role: "user", content: task }, ...(result.answer ? [{ role: "assistant", content: result.answer }] : [])];
      try {
        telemetry?.run(chat);
      } catch {
        /* tracking never changes how a chat ends */
      }
      // The engine keeps its own session: a goal there is one round per message, so the
      // chat is not held as an open goal forever.
      chat.goalDone = true;
      for (const send of chat.subscribers) {
        try {
          send({ type: "ui/end", status: chat.status, answer: chat.answer, error: chat.error });
        } catch {
          /* ignore */
        }
      }
    }).catch((err) => {
      // A failure here used to be an unhandled rejection and the chat stayed "running".
      chat.status = "failed";
      chat.error = String(err?.message ?? err);
      broadcast({ type: "error", message: chat.error });
      for (const send of chat.subscribers) {
        try {
          send({ type: "ui/end", status: chat.status, answer: null, error: chat.error });
        } catch {
          /* ignore */
        }
      }
    });
    return chat;
  }

  const start = goal && missionRounds > 1
    ? (options) =>
        runGoal({
          ...options,
          maxRounds: missionRounds,
          maxHours: missionHours,
          roundId: (round) => {
            const roundId = round === 1 ? id : newRunId();
            chat.roundId = roundId;
            if (round > 1) {
              try {
                if (home) linkRun(threadsFile(home), roundId, id);
              } catch {
                /* the sidebar may show the round separately; the chat still streams it */
              }
            }
            return roundId;
          },
          isCancelled: () => cancelRequested({ dir: runsRoot, id }),
        }).then((mission) => {
          // A goal that ended without being done says why (the page draws it as a card).
          if (!mission.done && ["max_rounds", "time", "cost", "failing"].includes(mission.stopped)) {
            broadcast({ type: "goal_stopped", reason: `goal_${mission.stopped}`, rounds: mission.rounds.length });
          }
          return { ...(mission.last ?? {}), mission: { done: mission.done, stopped: mission.stopped, rounds: mission.rounds.length } };
        })
    : runAgent;

  start({
    task: withFiles,
    ...(effort ? { effort } : {}),
    ...(ultracode ? { ultracode: true } : {}),
    root: workspace,
    cls: model,
    // The role's prompt and its delegation target travel with the run; the model is
    // still `cls`, so "Fast on a 27B" and "Fast on the router" are both expressible.
    ...(role ? { role } : {}),
    // The server's own router, not the built-in default: a UI pointed at another
    // router (a test stub, a second port) must send its chats there too.
    ...(routerUrl ? { routerUrl } : {}),
    runId: id,
    runsDir: runsDir(home ? join(home, "runs") : undefined),
    onEvent: broadcast,
    // The same plugin tools and hooks the CLI hands a run. Without these a chat typed
    // in the browser ran with no plugin tools and no plugin hooks at all, which is
    // precisely why nothing in the UI could see the local model before this.
    ...(extraTools.length ? { extraTools } : {}),
    ...(extraHooks.length ? { extraHooks } : {}),
    ...(attachmentDir ? { extraReadRoots: [attachmentDir] } : {}),
    ...(seed ? { messages: seed } : {}),
    // Where the meter's window comes from: the server's option (CLI flag or
    // ROSALENA_CONTEXT_WINDOW), because the router advertises no per-model window.
    ...(contextWindow ? { contextWindow } : {}),
    // How many steps one message may take; the page's setting, else the run's own default.
    ...(maxSteps ? { maxSteps } : {}),
    // The time limit: the page's setting, 0 meaning none (Infinity to the loop).
    ...(maxWallMs !== undefined ? { maxWallMs } : {}),
    // Settings > Generation; absent means the loop's own default.
    ...(Number.isFinite(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
    ...(Number.isFinite(temperature) ? { temperature } : {}),
    accessMode,
    toolLoading,
    sandbox,
    desktop,
    planMode,
    goal,
    approve,
    liveContextWindow: () => chat.liveWindow,
    takeSteer: () => chat.steer.splice(0),
    ...(imageFiles.length ? { images: imageFiles } : {}),
  })
    .then((result) => {
      chat.status = result.error ? "failed" : result.stopped ? "stopped" : "ok";
      chat.answer = result.answer ?? null;
      chat.error = result.error ?? null;
      // Keeping the transcript lets the next message continue this conversation instead
      // of starting from nothing.
      chat.messages = result.messages ?? chat.messages;
      chat.stopped = result.stopped ?? null;
      chat.steps = result.steps ?? null;
      chat.ms = result.ms ?? null;
      chat.goalDone = result.goal?.done === true || result.mission?.done === true;
      // A Steer message the run never reached (it ended first) is not lost: the page
      // gets it back to send as the next message.
      if (chat.steer.length) {
        broadcast({ type: "steer_unused", texts: chat.steer.splice(0) });
      }
      // The run's own last reading wins over the streamed one: same computation, taken
      // after the final message was appended.
      if (result.contextMeter) chat.context = result.contextMeter;
      try {
        telemetry?.run(chat);
      } catch {
        /* tracking never changes how a chat ends */
      }
      for (const send of chat.subscribers) {
        try {
          send({ type: "ui/end", status: chat.status, answer: chat.answer, error: chat.error });
        } catch {
          /* ignore */
        }
      }
    })
    .catch((err) => {
      chat.status = "failed";
      chat.error = String(err?.message ?? err);
      broadcast({ type: "error", message: chat.error });
      try {
        telemetry?.run(chat);
      } catch {
        /* tracking never changes how a chat ends */
      }
      for (const send of chat.subscribers) {
        try {
          send({ type: "ui/end", status: chat.status, error: chat.error });
        } catch {
          /* ignore */
        }
      }
    });

  return chat;
}

const chats = new Map();

/** Early-build senders by data folder (see createUiServer's `telemetry` option). */
const sharedTelemetry = new Map();

/**
 * The last hardware probe, kept for half a minute.
 *
 * `probeHardware()` shells out to nvidia-smi and a PowerShell CIM query, which costs
 * one to two seconds. The models page asks for it on every visit and the health strip
 * may ask again; a 30 s cache turns a page load into a single probe without ever
 * showing a figure older than a coffee refill. `?fresh=1` bypasses it for the case
 * where someone just closed a game and wants the new free-VRAM number.
 */
const recommendCache = { at: 0, value: null };
const RECOMMEND_TTL_MS = 30_000;
// The starter offer reads total memory, which does not change while the app is open.
const starterHardware = { at: 0, value: null };
const STARTER_HARDWARE_TTL_MS = 10 * 60_000;

/** A finished run from a previous process: rebuild a transcript from the run store. */
/**
 * Rebuild a conversation from a stored run's event log.
 *
 * Only what a follow-up needs: what the person asked and what the harness answered.
 * Tool calls, retries and notices stay in the log for the transcript view; replaying
 * them into a fresh run's context would feed the model its own machinery.
 */
export function transcriptFromEvents(events) {
  const messages = [];
  for (const event of events ?? []) {
    if (event.type === "run" && typeof event.task === "string" && event.task.trim()) {
      messages.push({ role: "user", content: event.task });
    } else if (event.type === "assistant" && typeof event.content === "string" && event.content.trim()) {
      messages.push({ role: "assistant", content: event.content });
    }
  }
  return messages;
}

function historicChat(id, home) {
  const dir = runsDir(home ? join(home, "runs") : undefined);
  const status = runStatus({ dir, id });
  if (!status) return null;
  const { record, events } = readRun({ dir, id, maxEvents: 4000 }) ?? { record: null, events: [] };
  return {
    id: status.id,
    task: status.task,
    model: null,
    createdAt: events[0]?.at ?? null,
    events,
    status: status.status,
    answer: status.answer ?? null,
    error: status.error ?? null,
    messages: null,
    // A run from a previous process has no live meter, but its record kept the last
    // reading: the gauge shows the same number after a reload.
    context: record?.contextMeter ?? null,
    subscribers: new Set(),
    historic: true,
  };
}

async function routerModels(routerUrl) {  // The harness's own default already ends in /v1 (it is an OpenAI client base), while
  // a bare origin is the other shape a caller passes. Accept both rather than 404 on
  // /v1/v1/models and then report the router as down while it is answering.
  const base = String(routerUrl).replace(/\/+$/, "").replace(/\/v1$/, "");
  try {
    // Same optional secret the agent sends: without it a token-protected router
    // answers 401 and the UI would report a healthy router as down.
    const res = await fetch(`${base}/v1/models`, {
      headers: routerAuthHeaders(),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return { up: false, error: `HTTP ${res.status}`, models: [] };
    const body = await res.json();
    return { up: true, models: body.data ?? [] };
  } catch (err) {
    return { up: false, error: String(err?.message ?? err), models: [] };
  }
}

export function createUiServer({
  port = DEFAULT_PORT,
  host = "127.0.0.1",
  routerUrl = DEFAULT_ROUTER,
  workspace = process.cwd(),
  // Where app state lives: ROSALENA_HOME if set, otherwise the same folder the run
  // store already defaults to. Deriving it instead of guessing a product path is what
  // keeps the UI, the CLI and the exe looking at one store.
  home = process.env.ROSALENA_HOME || dirname(runsDir(undefined)),
  // The window every chat on this server measures against. The router advertises no
  // per-model window, so this is configuration, not discovery: the CLI flag wins over
  // the environment, and the window defaults to 64K (UI_DEFAULT_CONTEXT_WINDOW). A window
  // the person picks in the page is saved in ui-prefs.json and wins over all of these.
  contextWindow = Number(process.env.ROSALENA_CONTEXT_WINDOW) || UI_DEFAULT_CONTEXT_WINDOW,
  token = randomBytes(16).toString("hex"),
  log = () => {},
  // Early-build tracking (telemetry.mjs): true in the desktop app and `rosalena --ui`,
  // false by default so tests and embedders never reach the network. An object is used
  // as the sender itself (tests hand in a fake).
  telemetry: telemetryOption = false,
  // Start OmniRoute with the server, as its own windowless child (omniroute-manager.mjs).
  // True in the desktop app; false by default so tests never start a 2 GB gateway.
  manageOmniRoute = false,
  // Tests hand in a manager with fakes; otherwise one is built over this server's home.
  omniManager: omniManagerOption = null,
  // Unload a local model this server loaded once it sits idle (the Models page sets how
  // long). True in the desktop app and `rosalena --ui`; off by default so tests never
  // probe a real llama.cpp on a timer.
  manageLocalModels = false,
  // The desktop window's per-launch proof (desktop/main.mjs adds it as `x-rosalena-page` to
  // every request the window makes). When it is set, a page carries the token only for a
  // request that has it: a command the agent runs could otherwise GET / like any local
  // process, read the token out of the HTML, and answer its own approval cards or switch
  // the access mode to full. Unset (`rosalena --ui` in a browser), pages carry it as before.
  pageKey = null,
  // The person's home folder, for the command (template) folders commands.mjs reads.
  // Tests hand in a scratch folder so Settings > Templates never writes the real one.
  userHome = homedir(),
  // Settings > Skills and Settings > Permissions write the files the agent reads:
  // <ROSALENA_HOME>/skills-off.json and permissions.json. Without ROSALENA_HOME the server's
  // own home is used (the desktop app sets ROSALENA_HOME to it, so the two are one folder).
  skillsOffPath = process.env.ROSALENA_HOME ? skillsOffFile() : join(home, "skills-off.json"),
  permissionsPath = process.env.ROSALENA_HOME ? permissionsFile() : join(home, "permissions.json"),
  // Phone access: start the tunnel at launch when "Keep phone access on" is set. True in the
  // desktop app and `rosalena --ui`; off by default so tests never start cloudflared.
  autoRemote = false,
  // Tests hand in fakes here (spawnImpl, fetchImpl, relay, install, env ...).
  remoteOptions = {},
} = {}) {
  const state = { port, host, routerUrl, workspace, home, token, contextWindow };

  const pageKeyBytes = pageKey ? Buffer.from(String(pageKey)) : null;
  const isPageKey = (value) => {
    const sent = Buffer.from(String(value ?? ""));
    return sent.length === pageKeyBytes.length && timingSafeEqual(sent, pageKeyBytes);
  };
  // "Open in browser": the desktop asks for a one-time code, the browser's first page load
  // spends it and gets the key back as an HttpOnly cookie, so its later pages carry it.
  const pageCodes = new Map(); // code -> expiry (ms)
  const pageCookie = (req) => /(?:^|;\s*)rosalena_page=([^;]*)/.exec(String(req.headers.cookie ?? ""))?.[1];
  const pageToken = (req) => {
    if (!pageKeyBytes) return token;
    return isPageKey(req.headers["x-rosalena-page"]) || isPageKey(pageCookie(req)) ? token : "";
  };
  // Spends `?code=` (once, within a minute). The cookie header goes on before writeHead.
  const spendPageCode = (url, res) => {
    const code = url.searchParams.get("code");
    if (!pageKeyBytes || !code || !pageCodes.has(code)) return false;
    const fresh = pageCodes.get(code) > Date.now();
    pageCodes.delete(code);
    if (fresh) res.setHeader("set-cookie", `rosalena_page=${pageKey}; HttpOnly; SameSite=Strict; Path=/`);
    return fresh;
  };
  const issuePageCode = () => {
    if (!pageKeyBytes) return null;
    const code = randomBytes(16).toString("hex");
    pageCodes.set(code, Date.now() + 60_000);
    return code;
  };

  // Kept in one place so the page and the API cannot disagree about the run folder.
  const runRoot = runsDir(join(home, "runs"));
  mkdirSync(runRoot, { recursive: true });

  // Remote access: the phone door (src/remote.mjs). Created with the server, not on the
  // first click, because the status route has to answer "off" before anything ever
  // starts. The port is read through `state` at enable() time: `ready()` is what fills
  // it in, and the tunnel must point at the port the OS actually gave us.
  //
  // Phone access keeps its pairing, its devices and its settings in <home>/remote/state.json
  // (remote-store.mjs), downloads cloudflared into <home>/remote/bin when it is not
  // installed (cloudflared-install.mjs), and keeps one stable link through the relay
  // (relay-client.mjs). None of them touches the network until the switch is turned on.
  const remote = createRemoteAccess({
    port: () => state.port,
    log,
    store: createRemoteStore({ file: remoteStateFile(home), log }),
    relay: createRelayClient({ log }),
    install: (options) => installCloudflared({ home, log, ...options }),
    locateInstalled: () => locateInstalledCloudflared(home),
    configFile: join(home, "remote", "cloudflared-empty.yml"),
    ...remoteOptions,
  });

  // The sidebar's folders, and the picker's model list. The menu is cached for ten
  // seconds because the page asks for it on every reload and a keystroke should never
  // cost two HTTP round trips; the folder file is read per request because it is small,
  // local, and a rename must be visible immediately.
  const folderFile = foldersFile(home);
  const prefsPath = prefsFile(home);
  // The window a new chat is measured against: the saved choice, else the server default.
  const effectiveWindow = () => readPrefs(prefsPath).contextWindow ?? contextWindow;
  // Steps per message: the saved choice, else ROSALENA_MAX_STEPS, else 100. The engine's
  // own default (12) suits a one-shot CLI call; a chat in the window is often a long task.
  const defaultMaxSteps = Number(process.env.ROSALENA_MAX_STEPS) || UI_DEFAULT_MAX_STEPS;
  const effectiveMaxSteps = () => readPrefs(prefsPath).maxSteps ?? defaultMaxSteps;
  // Minutes per message: the saved choice, else ROSALENA_MAX_MINUTES, else 60. 0 = no limit.
  const envMinutes = Number(process.env.ROSALENA_MAX_MINUTES);
  const defaultMaxMinutes = Number.isFinite(envMinutes) && envMinutes >= 0 && process.env.ROSALENA_MAX_MINUTES !== "" && process.env.ROSALENA_MAX_MINUTES !== undefined ? envMinutes : UI_DEFAULT_MAX_MINUTES;
  const effectiveMaxMinutes = () => readPrefs(prefsPath).maxMinutes ?? defaultMaxMinutes;
  // Whether a message starts (or carries on) a goal: the Goal button or /goal, a message
  // written as "Goal mode. Task: ..." / "Goal: ...", or a follow-up to a goal chat whose
  // goal is not recorded done. The last two used to run as plain chats, so "continue" on a
  // goal did one or two items and stopped (measured 2026-11-06: run record `goal: null`).
  const wantsGoal = (body, task) => {
    if (body.goal === true) return true;
    if (body.goal === false) return false;
    if (/^\s*goal(\s+mode)?\s*[:.]/i.test(String(task ?? ""))) return true;
    const parentId = typeof body.parentId === "string" ? body.parentId : "";
    if (!parentId) return false;
    const live = chats.get(parentId);
    // A goal someone stopped is over until they ask for it again: "thanks" after Stop must
    // not start another 25 rounds (bug hunt 2026-11-08).
    if (live) return live.goal === true && live.goalDone !== true && live.stopped !== "cancelled";
    // From the record: the conversation's LATEST run, since a mission's later rounds are
    // runs of their own and only the last one knows whether the goal got done.
    const map = readThreads(threadFile);
    const members = threadMembers(map, rootOf(map, parentId));
    const latest = members.length ? members[members.length - 1] : parentId;
    const record = readRun({ dir: runRoot, id: latest, maxEvents: 0 })?.record;
    return Boolean(record?.goal) && record.goal.done !== true && record.stopped !== "cancelled";
  };
  // What this install shares: the account panel's choice, unless ROSALENA_TELEMETRY says.
  const currentSharing = () => sharingLevel(readPrefs(prefsPath).sharing);
  let telemetry = null;
  let messageSink = null;
  if (telemetryOption && typeof telemetryOption === "object") telemetry = telemetryOption;
  else if (telemetryOption) {
    try {
      // One sender per data folder for the life of the process: the desktop app replaces
      // this server when the workspace changes, and two senders on one outbox file would
      // send the same events twice. The app-opened ping goes out once per process.
      telemetry = sharedTelemetry.get(home);
      if (!telemetry) {
        telemetry = createTelemetry({ home, version: appVersion(), level: currentSharing, log });
        sharedTelemetry.set(home, telemetry);
        telemetry.session();
      }
      // The message log's lines (every cloud model call) go to the site with the rest.
      const sender = telemetry;
      messageSink = (line) => (line?.kind === "model_error" ? sender.modelError(line) : sender.call(line));
      setMessageSink(messageSink);
    } catch (err) {
      log(`ui: tracking not started: ${err?.message ?? err}`);
      telemetry = null;
    }
  }
  const menuCache = createMenuCache();
  // The optional OmniRoute download (cloud-setup.mjs): one per server, it holds the install job.
  const omniroute = createOmniRoute({ log });
  // OmniRoute as this app's own background process: started hidden, restarted after a
  // crash, stopped with the app, its log readable in Settings > Cloud models.
  const omniManager = omniManagerOption ?? createOmniRouteManager({ home, log });
  // The local model this server loaded is watched every 30 s and unloaded after the idle
  // time in local-models.json. A Rosalena run on a local model counts as use even while it
  // is between tokens (a long tool call), so a model is never pulled out from under a run.
  let idleWatch = null;
  let idleTimer = null;
  let idleBusy = false;
  const localInUse = () => [...chats.values()].some((chat) => chat.status === "running" && String(chat.model ?? "").toLowerCase().startsWith("local/"));
  const loadMenu = () =>
    menuCache.get(() =>
      loadModelMenu({
        routerBase: routerUrl,
        routerToken: process.env.ROSALENA_ROUTER_TOKEN ?? "",
        root: workspace,
      }),
    );

  // What the sidebar lists and what a folder can hold: one shape, used by both routes so
  // a session cannot be movable and unlistable at the same time.
  // Follow-ups are runs of their own; threads.json says which conversation each belongs
  // to, so both lists show a conversation once, under its first run's id.
  const threadFile = threadsFile(home);
  // The session rail's subagent run ids per finished turn (a finished run's events no longer change).
  const railSubRuns = new Map();
  const rootTitle = (id) => runStatus({ dir: runRoot, id })?.task || null;
  const sidebarSessions = () =>
    collapseThreads(
      listRuns({ dir: runRoot, limit: 200 }).map((run) => ({
        id: run.id,
        title: run.task || "(no task)",
        at: run.startedAt ?? null,
        status: run.status,
        steps: run.steps ?? null,
        ms: run.ms ?? null,
      })),
      readThreads(threadFile),
      { titleOf: rootTitle },
    );

  // The plugin host, built on first use and then kept. A chat started from the browser
  // is a real run, so it gets the same plugin tools and hooks the CLI gives one - and
  // building it lazily keeps `createUiServer` synchronous, which its tests rely on.
  let plugins = { dir: "", plugins: [], tools: [], hooks: [], errors: [], disabled: [] };
  let pluginsLoad = null;
  // The Plugins page: tool plugins the person added live in <home>/tool-plugins, and its
  // on/off switches in <home>/plugin-switches.json ({ "tools": { "<id>": false } }).
  const userToolDir = join(home, "tool-plugins");
  const switchFile = join(home, "plugin-switches.json");
  const readToolSwitches = () => {
    try {
      const tools = JSON.parse(readFileSync(switchFile, "utf8"))?.tools;
      // Keyed by the rosa- names; a switch saved under an old name still counts.
      return tools && typeof tools === "object" ? renamePluginKeys(Object.fromEntries(Object.entries(tools).filter(([, v]) => typeof v === "boolean"))) : {};
    } catch {
      return {};
    }
  };
  const writeToolSwitch = (id, on) => {
    const tools = readToolSwitches();
    tools[id] = on;
    mkdirSync(home, { recursive: true });
    writeFileSync(switchFile, `${JSON.stringify({ v: 1, tools }, null, 2)}\n`);
  };
  // Bundled plugins marked "core" in their plugin.json (plugins.mjs readManifest): app
  // features that are written as plugins. Read once; they only change with an update.
  let coreCache = null;
  const coreManifests = () => (coreCache ??= listPluginManifests([{ dir: pluginRoot(), source: "bundled" }]).filter((m) => m.core));
  const coreIds = () => new Set(coreManifests().map((m) => m.id));
  // Sidebar-page-only core plugins (Style Lab) have no module, so the tool host never loads them.
  const uiOnlyIds = () => new Set(coreManifests().filter((m) => m.ui && !m.hasCode).map((m) => m.id));
  let coreProblems = [];
  // A switch, an add or a removal takes effect for the next chat: the host is rebuilt.
  const reloadPlugins = () => {
    pluginsLoad = null;
    return loadPluginsOnce();
  };
  // The last update-check answer, kept in-process. A restart may check once more; that is
  // politeness to the site, not honesty, so it is not written to disk.
  let lastUpdateCheck = { at: null, verdict: null };
  const loadPluginsOnce = () => {
    pluginsLoad ??= (async () => {
      let config = {};
      try {
        config = readHarnessConfig();
      } catch (err) {
        // A malformed harness.config.json must not leave the window unable to answer:
        // say so in the log the CLI would have printed, and use plugin defaults.
        log(`ui: harness.config.json ignored: ${err?.message ?? err}`);
      }
      // Creator mode's tools must build in this server's home, the same one the sidebar
      // lists from, or a plugin the agent installs would land somewhere the window never looks.
      const creatorEntry = config.plugins?.["rosa-creator-mode"] ?? {};
      config = { ...config, plugins: { ...(config.plugins ?? {}), "rosa-creator-mode": { ...creatorEntry, config: { ...(creatorEntry.config ?? {}), home } } } };
      // The Plugins page's switches are the person's latest word, so they win over the
      // shipped config; they live in this server's home, never in harness.config.json.
      // Core plugins can be switched off too (a plugin you made may replace one); only a core
      // plugin that should be on and did not load is reported below.
      const core = coreIds();
      for (const [id, on] of Object.entries(readToolSwitches())) {
        config.plugins[id] = { ...(config.plugins[id] ?? {}), enabled: on };
      }
      const host = await loadPlugins({ root: workspace, extraDirs: [userToolDir], config, log, harness: { routerUrl, workspace } });
      plugins = host;
      for (const failure of host.errors) log(`ui: plugin ${failure.id}: ${failure.reason}`);
      // A core feature that did not load is not a quiet log line: the page shows it.
      // A core plugin someone switched off is their choice, not a problem.
      coreProblems = [...core]
        .filter((id) => !host.plugins.some((p) => p.id === id) && !host.disabled.includes(id))
        .map((id) => ({ id, reason: host.errors.find((e) => e.id === id)?.reason ?? "did not load" }))
        .filter((problem) => !uiOnlyIds().has(problem.id));
      for (const problem of coreProblems) log(`ui: CORE plugin ${problem.id} is missing: ${problem.reason}`);
      return host;
    })().catch((err) => {
      // Retry on the next chat: a plugin folder caught mid-write must not poison the
      // rest of this server's life.
      pluginsLoad = null;
      log(`ui: plugins could not be loaded: ${err?.message ?? err}`);
      return null;
    });
    return pluginsLoad;
  };

  // Sidebar plugins (ui-plugins.mjs): the bundled ones plus what Creator mode installed in
  // <home>/plugins. Listed fresh on every request, so a publish, a rollback or an off
  // switch shows up on the next load without restarting anything.
  const creator = createCreator({ home });
  const uiPlugins = () => listUiPlugins({ userDir: userPluginsDir(home), state: creator.switches() });

  /**
   * Add a plugin the person made, from a folder on this PC. A sidebar page goes the Creator
   * way: copied into a draft, verified in the sandbox, installed only on a pass. A tool
   * plugin is code the agent runs with this app's own access, so it needs `trust` (the page
   * asks), is copied into <home>/tool-plugins, and is taken back out if it fails to load.
   */
  const importPlugin = async (folder, { trust = false } = {}) => {
    const source = folder.trim().replace(/^"(.*)"$/, "$1");
    if (!source || !existsSync(join(source, "plugin.json"))) throw new Error("that folder has no plugin.json; pick the folder that holds the plugin's plugin.json");
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(source, "plugin.json"), "utf8"));
    } catch (err) {
      throw new Error(`plugin.json is not valid JSON: ${err?.message ?? err}`);
    }
    const hasCode = existsSync(join(source, String(manifest?.entry ?? "plugin.mjs")));
    if (manifest?.ui && !hasCode) {
      const draft = creator.importFolder(source, { replace: true });
      const report = await creator.verify(draft.id);
      if (!report.ok) return { ok: false, kind: "page", id: draft.id, error: "it did not pass verification, so it was not installed (it is kept as a draft)", report: describeReport(report) };
      creator.publish(draft.id);
      log(`ui: page plugin ${draft.id} added from ${source}`);
      return { ok: true, kind: "page", id: draft.id, report: describeReport(report) };
    }
    if (!hasCode) throw new Error('plugin.json has neither a "ui" block (a sidebar page) nor a plugin.mjs (a tool plugin)');
    const id = String(manifest.id ?? "").trim();
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id)) throw new Error(`"${id}" is not a usable id: lowercase letters, digits and dashes`);
    if (existsSync(join(pluginRoot(), id))) throw new Error(`"${id}" is the id of a plugin that ships with the app; change the id in plugin.json`);
    if (!trust) return { ok: false, kind: "tool", id, needsTrust: true, error: "a tool plugin runs its own code with this app's access; confirm you trust it" };
    const dest = join(userToolDir, id);
    let previous = null;
    if (existsSync(dest)) {
      previous = join(home, "tool-plugins-removed", `${id}-${Date.now()}`);
      mkdirSync(dirname(previous), { recursive: true });
      renameSync(dest, previous);
    }
    mkdirSync(userToolDir, { recursive: true });
    cpSync(source, dest, { recursive: true, filter: (from) => !/[\\/]\.git([\\/]|$)/.test(from) });
    const host = await reloadPlugins();
    const live = host?.plugins.find((p) => p.id === id);
    const problems = (host?.errors ?? []).filter((e) => e.id === id).map((e) => e.reason);
    if (!live) {
      rmSync(dest, { recursive: true, force: true });
      if (previous) renameSync(previous, dest);
      await reloadPlugins();
      return { ok: false, kind: "tool", id, error: `it did not load, so it was taken back out: ${problems.join("; ") || "no plugin was registered"}` };
    }
    log(`ui: tool plugin ${id} added from ${source}`);
    return { ok: true, kind: "tool", id, tools: live.tools, hooks: live.hooks, warnings: problems, replaced: previous };
  };

  // The local model host, reached the way the monitor page reaches its plugin: the module
  // the plugin host already imported, plus the config it was built with, so the state file
  // this reads is the one a load wrote. `home` is this server's, so the page, the CLI and a
  // bare tool call all agree on which server this harness started.
  let localHost = null;
  // Built on the first /api/starter call: it holds the one setup job this process runs.
  let starterInstaller = null;
  // Built on the first /api/models/download call: the Models page's one download job.
  let modelDownloader = null;
  // Where a chat GGUF counts as already downloaded: the app's own folder and the shelf's.
  const chatModelDirs = () => {
    try {
      return [join(starterHome(), "models"), ...detectModelDirs()];
    } catch {
      return [join(starterHome(), "models")];
    }
  };
  const loadLocalHost = async () => {
    localHost ??= await import("../plugins/rosa-local-model-host/plugin.mjs");
    return localHost;
  };
  const localHostConfig = async () => {
    const host = await loadPluginsOnce();
    const config = host?.plugins.find((entry) => entry.id === "rosa-local-model-host")?.config;
    if (!config) return null;
    const mod = await loadLocalHost();
    // The window the person chose in Settings → General is the window the model is LOADED
    // at, not merely the window a run is measured against. The plugin's own default is
    // 16384 (so a 32768 aim), and the packaged build ships a neutral harness.config.json
    // with no planContext of its own - measured 2026-11-07: the person set 131,072 in the
    // UI, the host started qwen at 32,768 anyway, and every long chat compacted down to a
    // third of what the card can hold. planLoad still steps down when the card cannot hold
    // the aim, so choosing a big window is safe.
    const chosen = Number(readPrefs(prefsPath).contextWindow);
    return mod.hostConfigOf({ ...config, home, ...(Number.isFinite(chosen) && chosen > 0 ? { planContext: chosen } : {}) });
  };
  const localStatus = async () => {
    const config = await localHostConfig();
    if (!config) return { enabled: false, error: "the local-model-host plugin is not installed or is disabled" };
    const mod = await loadLocalHost();
    return { enabled: true, ...(await mod.serverStatus(config)) };
  };
  /**
   * What the local server on :8080 really has, as far as this chat is concerned.
   *
   * A chat on `local/...` is answered by the llama-server, and that server's `-c` is the
   * real ceiling - not the preference. They really do disagree: measured 2026-11-06 a
   * 65,536 preference over a 32,768 server refused a 32,811-token request 43 tokens past
   * the limit, and the person saw an error instead of a compacted chat. Asking the server
   * first costs one local GET, and a server that is down or still loading answers null
   * (the refusal path in agent.mjs then adopts the real number from the server itself).
   *
   * `ours` says whether THIS app started it, which decides whether the person can reload
   * it from the status bar or has to go back to whatever else started it.
   */
  const localServedWindow = async (modelId) => {
    if (!/^local\//i.test(String(modelId ?? ""))) return null;
    try {
      const config = await localHostConfig();
      if (!config) return null;
      const mod = await loadLocalHost();
      const status = await mod.serverStatus(config, { scan: () => [] });
      const ctx = Number(status?.ctx);
      if (!Number.isInteger(ctx) || ctx <= 0) return null;
      return { ctx, ours: Boolean(status.ours), baseUrl: config.baseUrl, loaded: status.loaded ?? null };
    } catch {
      return null;
    }
  };
  // A render asks for the card: our own chat model goes, but only when it is idle and no
  // Rosalena run is using it (a chat that asked for the picture is still mid-run).
  const releaseLocal = async () => {
    const config = await localHostConfig();
    if (!config) return { ok: true, code: "no-host" };
    const mod = await loadLocalHost();
    const status = await mod.serverStatus(config);
    if (!(status.up || status.loading)) return { ok: true, code: "idle" };
    if (!status.ours) return { ok: false, code: "not-ours", holder: status.loaded ?? "a model" };
    if (localInUse()) return { ok: false, code: "in-use", holder: status.loaded ?? "the chat model" };
    const out = await mod.stopServer({ config, status });
    if (out.ok) menuCache.clear();
    return out;
  };
  if (manageLocalModels) setLocalRelease(releaseLocal);
  // The ComfyUI this app talks to: the comfyui plugin's address and install folder.
  const comfyConfig = async () => (await loadPluginsOnce())?.plugins.find((entry) => entry.id === "rosa-comfyui")?.config ?? null;
  const comfyFor = (config) => comfyRunner({ baseUrl: config?.baseUrl ?? "http://127.0.0.1:8188", root: typeof config?.root === "string" && config.root.trim() ? config.root.trim() : null, log });
  const idleTick = async () => {
    if (idleBusy) return; // a stop can take 20 s; never two at once
    idleBusy = true;
    try {
      const idleMs = readLocalPrefs(home).idleUnloadMinutes * 60_000;
      // A ComfyUI this app started stops after the same idle time as a chat model.
      for (const runner of allComfyRunners()) {
        const out = await runner.tick(idleMs);
        if (out.action === "stopped") log("comfy: stopped ComfyUI after it sat idle");
      }
      const config = await localHostConfig();
      if (!config) return;
      const mod = await loadLocalHost();
      idleWatch ??= mod.createIdleWatch({ config, idleMs: () => readLocalPrefs(home).idleUnloadMinutes * 60_000, inUse: localInUse, log });
      const out = await idleWatch.tick();
      if (out.action === "unloaded") menuCache.clear();
    } catch (err) {
      log(`ui: the idle check failed: ${err?.message ?? err}`);
    } finally {
      idleBusy = false;
    }
  };

  /**
   * The picker's list, plus every GGUF that is installed on this PC.
   *
   * The router can only advertise what is already loaded, so without this a model sitting
   * on the disk is invisible until somebody starts it by hand - which is the exact gap the
   * local shelf fills. A router row that already names the same target wins: it carries the
   * curated label, and two rows for one model is a bug people click on. Nothing here can
   * fail the list: a disabled plugin or an unreadable folder leaves the router's own rows.
   */
  // The context a local model was trained for, read once per file from its GGUF header:
  // the model menu caps its context slider there, so a 128K model is not offered 1M.
  const trainedContext = new Map();
  const trainContextOf = (path) => {
    if (!path) return null;
    if (!trainedContext.has(path)) {
      let value = null;
      try {
        value = ggufShape(path)?.trainContext ?? null;
      } catch {
        value = null;
      }
      trainedContext.set(path, value);
    }
    return trainedContext.get(path);
  };
  const withInstalled = async (models, localSpec = null) => {
    const effortInfo = localSpec ? { efforts: effortsOf(localSpec), defaultEffort: defaultEffortOf(null, localSpec) } : {};
    try {
      const config = await localHostConfig();
      if (!config) return models;
      const mod = await loadLocalHost();
      const status = await mod.serverStatus(config);
      const known = new Set(models.map((model) => String(model.id ?? "").toLowerCase()));
      const rows = status.models
        .filter((entry) => !known.has(entry.target.toLowerCase()))
        .map((entry) => {
          const loaded = status.loaded === entry.alias;
          return {
            id: entry.target,
            provider: "local",
            model: entry.alias,
            label: `${entry.alias} · ${entry.gb.toFixed(1)} GB`,
            cost: "free",
            note: [
              `${entry.gb.toFixed(1)} GB ${entry.quant ?? ""}`.trim(),
              entry.params ? `${entry.params}B` : null,
              entry.kind === "other" ? "not a chat model" : null,
              loaded ? (status.busy ? "loaded, generating" : "loaded") : "not loaded",
              "on this PC",
            ]
              .filter(Boolean)
              .join(", "),
            loaded,
            kind: entry.kind,
            contextMax: trainContextOf(entry.path),
            ...effortInfo,
          };
        });
      return [...models, ...rows];
    } catch (err) {
      log(`ui: the installed models could not be listed: ${err?.message ?? err}`);
      return models;
    }
  };

  /**
   * Point the local server at the model a run is about to use, and let the run fail if it
   * could not be pointed there. Answering with a different model than the one that was
   * selected is worse than answering with an error: the transcript would look like the
   * choice was honoured.
   */
  const ensureLocalReady = async (target) => {
    if (!String(target ?? "").toLowerCase().startsWith("local/")) return { ok: true, skipped: true };
    try {
      const config = await localHostConfig();
      if (!config) return { ok: false, code: "no-host", error: "the local-model-host plugin is not installed or is disabled" };
      const mod = await loadLocalHost();
      // A model this harness did not start belongs to another program (ContentFarm's
      // writer, the person's own llama.cpp window). Sending a chat never unloads it: an
      // idle model can still be someone's, and swapping it out from under them is a choice
      // only the person makes, with the Switch button beside the picker.
      const wanted = String(target).slice("local/".length);
      const now = await mod.serverStatus(config);
      if ((now.up || now.loading) && now.ours === false && now.loaded !== wanted) {
        const holder = now.loaded ?? "another model";
        return {
          ok: false,
          code: "foreign-model",
          error: `${holder} is loaded on the local server by another program, so Rosalena did not unload it. Press Switch next to the model picker to replace it with ${wanted}, or pick a cloud model.`,
          status: { loaded: now.loaded ?? null, available: null },
        };
      }
      // A ComfyUI this app started gives its models back first if nothing is rendering, so
      // the chat model is fitted to the whole card rather than to what a past render left.
      for (const runner of allComfyRunners()) await runner.releaseIfIdle();
      const result = await mod.ensureLocalModel({ config, target });
      if (result.ok) {
        idleWatch?.touch();
        if (result.swapped) log(`ui: local model ${result.previous ?? "nothing"} -> ${result.model} for the next run`);
        if (result.contextStale) log(`ui: ${target} is loaded smaller than the window in Settings and is generating now, so it reloads at the next message`);
        return { ok: true, ...result };
      }
      log(`ui: ${target} is not ready: ${result.error}`);
      // `loaded` is what the server is holding (null when nothing answered), and
      // `available` is the shelf, so the refusal can say what could be loaded instead.
      return { ok: false, code: result.code, error: result.error, status: { loaded: result.loaded ?? null, available: result.available ?? null } };
    } catch (err) {
      log(`ui: the local model host failed: ${err?.stack ?? err}`);
      return { ok: false, code: "host-failed", error: `the local model host failed: ${err?.message ?? err}` };
    }
  };

  // The Terminal tab's shells (src/terminal.mjs). They die with the server.
  const terminals = createTerminals({ workspace });

  // Each conversation's own folder, by thread root. The launch folder is only the default:
  // a chat that was given another folder keeps it, and its follow-ups run there too.
  const chatWorkspaceFile = join(home, "chat-workspaces.json");
  // A run's recorded folder never changes, so it is read from its record once (a record
  // not readable yet is not cached, so it is asked again next time).
  const runRootCache = new Map();
  // The file viewer's one-file links (/api/file/ticket) and the folders it may read from:
  // the app's folder and every chat's, checked at most every 30 s (an offline network
  // folder would otherwise stall every request).
  const fileTickets = new Map();
  let fileRootsAt = 0;
  let fileRootsList = [];
  const fileRoots = () => {
    if (Date.now() - fileRootsAt > 30_000) {
      fileRootsList = [workspace, ...Object.values(readChatWorkspaces())].map((r) => existingDir(r)).filter(Boolean);
      fileRootsAt = Date.now();
    }
    return fileRootsList;
  };
  const readChatWorkspaces = () => {
    try {
      const value = JSON.parse(readFileSync(chatWorkspaceFile, "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  };
  const existingDir = (value) => {
    const text = String(value ?? "").trim();
    if (!text) return null;
    const full = resolve(text);
    try {
      return statSync(full).isDirectory() ? full : null;
    } catch {
      return null;
    }
  };
  const threadRootOf = (id) => {
    try {
      return rootOf(readThreads(threadFile), String(id)) || String(id);
    } catch {
      return String(id);
    }
  };
  /** The folder a chat works in: its own pick, else the folder its first run recorded, else the launch folder. */
  const chatWorkspace = (id) => {
    if (!id) return workspace;
    const root = threadRootOf(id);
    const own = existingDir(readChatWorkspaces()[root]);
    if (own) return own;
    try {
      const recorded = existingDir(readRun({ dir: runRoot, id: root, maxEvents: 0 })?.record?.root);
      if (recorded) return recorded;
    } catch {
      /* an unreadable record falls back to the launch folder */
    }
    return workspace;
  };
  const setChatWorkspace = (id, folder) => {
    const map = readChatWorkspaces();
    map[threadRootOf(id)] = folder;
    mkdirSync(dirname(chatWorkspaceFile), { recursive: true });
    writeFileSync(chatWorkspaceFile, JSON.stringify(map, null, 2));
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {      log(`ui error: ${err?.stack ?? err}`);
      if (!res.headersSent) json(res, 500, { error: String(err?.message ?? err) });
      else res.end();
    });
  });
  // A browser holds the SSE connection open; a dead socket must not become a crash.
  server.on("clientError", (err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);
    const path = url.pathname;
    // Marks an answer as this app's own, so the phone relay can tell an app error (a 502
    // from a model route) from cloudflared saying the app is gone (site/relay/worker.mjs).
    res.setHeader("x-rosalena-app", "1");

    // The tunnel door, before anything else reads the request. A request that came
    // through the public URL must carry the pairing token (query, header or cookie);
    // a loopback request is never gated, so the window on this machine behaves exactly
    // as it did before remote access existed. `gate` returns nothing to send when the
    // request may proceed, and the shape to send when it may not.
    const refusal = remote.gate(req, res);
    if (refusal) {
      if (refusal.status === 302) {
        res.writeHead(302, refusal.headers);
        return res.end();
      }
      // A phone gets a page it can read; an API call gets JSON it can act on.
      if (refusal.html && !path.startsWith("/api/")) {
        res.writeHead(refusal.status, { ...(refusal.headers ?? {}), "content-type": MIME[".html"], "cache-control": "no-store" });
        return res.end(refusal.html);
      }
      for (const [name, value] of Object.entries(refusal.headers ?? {})) {
        if (name === "set-cookie" || name === "retry-after") res.setHeader(name, value);
      }
      return json(res, refusal.status, { error: refusal.error, paired: false });
    }
    // Through the tunnel and past the gate: a paired device, or a probe that carried the
    // pairing code in a header.
    const viaTunnel = remote.tunnelRequest(req);

    // Same-origin only for the API: a page on another site must not read this API, let
    // alone post to it. The page itself is exempt on purpose - the HTML and its assets
    // carry nothing a cross-site document could read (SOP blocks reading a navigation's
    // body), and a person who opens the UI from a link or a bookmark sends
    // `sec-fetch-site: cross-site` on that very first request.
    //
    // A tunneled request is exempt for the same reason from the other side: its Origin is
    // the trycloudflare hostname, which this allowlist exists to refuse, and it has
    // already been authenticated by the pairing token above - which is a stronger claim
    // than "the browser says this came from loopback".
    //
    // Through the tunnel the API still answers the page itself only: every relayed phone
    // link is a sibling subdomain of rosalena.dev, and a sibling is "same-site" to the
    // browser (so a Lax cookie would ride along), but never "same-origin".
    if (path.startsWith("/api/") && viaTunnel) {
      const site = req.headers["sec-fetch-site"];
      if (site && site !== "same-origin" && site !== "none") return json(res, 403, { error: "cross-origin request refused" });
    }
    if (path.startsWith("/api/") && !viaTunnel) {
      const site = req.headers["sec-fetch-site"];
      if (site && site !== "same-origin" && site !== "none") return json(res, 403, { error: "cross-origin request refused" });
      const origin = req.headers.origin;
      if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) {
        return json(res, 403, { error: "cross-origin request refused" });
      }
    }

    if (path === "/" || path === "/index.html") {
      const html = await readFile(join(UI_DIR, "index.html"), "utf8");
      // A paired phone is an operator (remote.mjs, "a paired device is an operator"): it gets
      // the write token so it can start runs and answer approvals. The terminal and the
      // phone-access controls still refuse it (they answer this machine only).
      const pageTok = viaTunnel ? token : spendPageCode(url, res) ? token : pageToken(req);
      res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store", ...(viaTunnel ? { "referrer-policy": "no-referrer" } : {}) });
      // The saved look (ui-state.mjs) rides in the page, so it is back before any code runs.
      // `data-remote` tells the page it was opened through phone access (phone.js, phone.css).
      const page = injectUiState(html.replace("__ROSALENA_TOKEN__", pageTok), home);
      return res.end(viaTunnel ? page.replace(/<html\b/, '<html data-remote="1"') : page);
    }

    // The window's saved look: theme, UI style, layout, plugin themes and plugin data.
    // ui/persist.js sends each change here, so it survives the new port the next launch gets.
    if (path === "/api/ui-state") {
      if (req.method === "GET") return json(res, 200, { ok: true, ...readUiState(home) });
      if (req.method !== "POST" && req.method !== "PUT") return json(res, 405, { error: `no route for ${req.method} ${path}` });
      if (req.headers["x-rosalena-token"] !== token) return json(res, 403, { error: "bad token" });
      try {
        const body = await readBody(req, 16 * 1024 * 1024);
        return json(res, 200, { ok: true, ...writeUiState(home, { set: body.set, remove: body.remove }) });
      } catch (err) {
        return json(res, 400, { ok: false, error: String(err?.message ?? err) });
      }
    }

    // A second page, not a second application: one self-contained file that talks to one
    // API route. It needs no token because it only ever reads, and no build step because
    // there is no bundler in this project to run.
    if (path === "/monitor" || path === "/monitor.html") {
      const html = await readFile(join(UI_DIR, "monitor.html"), "utf8");
      res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
      return res.end(html);
    }

    // The Wi-Fi page. It carries the token because joining a network is a write, and a
    // page that could list networks but never join one would be a worse answer than the
    // one field it has to hold.
    if (path === "/network" || path === "/network.html") {
      const html = await readFile(join(UI_DIR, "network.html"), "utf8");
      res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
      return res.end(html.replace("__ROSALENA_TOKEN__", pageToken(req)));
    }

    // The VPN exits page. It carries the token because turning a client on or off is a
    // write, and a page that could only read would be a worse answer than the two
    // switches it holds.
    if (path === "/exits" || path === "/exits.html") {
      const html = await readFile(join(UI_DIR, "exits.html"), "utf8");
      res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
      return res.end(html.replace("__ROSALENA_TOKEN__", pageToken(req)));
    }

    // What the tokens actually cost. It carries the token for the same reason the Wi-Fi
    // page does: the usage ledger sits behind the gate, and a page that could not read it
    // would have nothing to show.
    if (path === "/usage" || path === "/usage.html") {
      const html = await readFile(join(UI_DIR, "usage.html"), "utf8");
      res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
      return res.end(html.replace("__ROSALENA_TOKEN__", pageToken(req)));
    }

    // What will run on this machine. Self-contained like the exits page: it reads one
    // read-only route, so shipping the token in it costs nothing.
    if (path === "/models" || path === "/models.html") {
      const html = await readFile(join(UI_DIR, "models.html"), "utf8");
      res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
      return res.end(html.replace("__ROSALENA_TOKEN__", pageToken(req)));
    }

    // The plugin manager: every plugin, its switch, adding your own. Same pattern.
    if (path === "/plugins" || path === "/plugins.html") {
      const html = await readFile(join(UI_DIR, "plugins.html"), "utf8");
      res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
      return res.end(html.replace("__ROSALENA_TOKEN__", pageToken(req)));
    }

    // The phone page. Same self-contained pattern as the others, with one difference
    // that matters: the harness token is only written into it for a caller on this
    // machine. The phone must never be handed it - a paired phone is already an operator
    // by virtue of the pairing token, and the app's write token is a strictly larger
    // credential (it bypasses the tunnel gate for everything else). The page reads
    // `window.__ROSALENA_TOKEN__` and hides its controls when it is empty.
    if (path === "/remote" || path === "/remote.html") {
      const html = await readFile(join(UI_DIR, "remote.html"), "utf8");
      res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
      return res.end(html.replace("__ROSALENA_TOKEN__", remote.isLocal(req) ? pageToken(req) : ""));
    }

    // The page imports ./format.mjs, so the renderer ships next to the app rather than
    // being duplicated in it - and one whitelist, not a path join, decides what is
    // readable over HTTP. app.js also imports ./panels.js lazily for the inspector tabs
    // and adds /panels.css once that module resolves, so both have to be on the list:
    // without them the import fails with a 404 and the inspector can only draw its
    // "could not load" placeholder.
    // Plugin pages, the libraries they may load and the SDK. Each response carries the
    // plugin's own CSP (ui-plugins.mjs); a switched-off or broken plugin is not served.
    if (path === "/plugin-sdk.js" || path.startsWith("/plugin-lib/") || path.startsWith("/plugin-app/")) {
      if (await servePluginRequest(req, res, path, { plugins: uiPlugins() })) return;
    }

    if (
      path === "/app.js" ||
      path === "/format.mjs" ||
      path === "/session-rail.mjs" ||
      path === "/session-rail.css" ||
      path === "/styles.css" ||
      path === "/panels.js" ||
      path === "/panels.css" ||
      path === "/remote.js" ||
      path === "/remote.css" ||
      path === "/phone.js" ||
      path === "/phone.css" ||
      path === "/plugin-host.js" ||
      path === "/plugins-ui.js" ||
      path === "/plugins-ui.css" ||
      path === "/ui-styles.js" ||
      path === "/ui-styles.css" ||
      path === "/themes.css" ||
      path === "/refine.css" ||
      path === "/persist.js" ||
      path === "/web-tab.mjs" ||
      path === "/i18n.mjs" ||
      path === "/locales/en.mjs" ||
      path === "/locales/es.mjs" ||
      path === "/rosalena-icon.svg"
    ) {
      // The language tables are the one subfolder (ui/locales/, see i18n.mjs).
      const file = path.startsWith("/locales/") ? join(UI_DIR, "locales", basename(path)) : join(UI_DIR, basename(path));
      const body = await readFile(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
      return res.end(body);
    }

    // The monitor page's only data route, and the reason the UI knows about plugins at
    // all. Importing a path does not re-run it: this resolves to the module instance the
    // plugin host already imported, so the harness-call ledger its `llm/stream` hook fills
    // is the very array read here. Read-only by construction - four GETs to llama.cpp,
    // each on the plugin's own timeout, and nothing that could start or stop a server.
    if (path === "/api/local-model") {
      // Same shape the plugin's own probe returns, so a failed import is still a page
      // that renders and says what went wrong instead of a blank screen.
      const empty = {
        at: Date.now(),
        up: false,
        loading: false,
        model: null,
        ctx: null,
        slots: [],
        slotsAvailable: false,
        busy: null,
        queued: null,
        queuedSource: null,
        queuedNote: null,
        lastEnded: [],
        requests: [],
        harnessCalls: [],
      };
      try {
        const mod = await import("../plugins/rosa-local-model-monitor/plugin.mjs");
        const config = plugins.plugins.find((p) => p.id === "rosa-local-model-monitor")?.config ?? {};
        // The UI's own runs fill this ledger, so the same person who opened the page saw
        // the calls: it is a view of this process, not of every process on the machine.
        const probe = await mod.probeLocalModel({
          baseUrl: mod.baseUrlOf(config),
          timeoutMs: mod.timeoutOf(config),
          recentLimit: config.recentLimit,
          logFiles: mod.logFilesOf(config),
        });
        return json(res, 200, probe);
      } catch (err) {
        log(`ui: local model probe failed: ${err?.message ?? err}`);
        return json(res, 200, {
          ...empty,
          error: `the local-model-monitor plugin could not be used: ${err?.message ?? err}`,
        });
      }
    }

    /*
     * Wi-Fi: the one place the app can take the machine off its own network, so the
     * shape is deliberately narrow.
     *
     * Reading is read-only - four `netsh` queries and nothing that could connect,
     * disconnect or change a setting - so it sits outside the token check with the
     * monitor. Writing is a join request, which is the only thing here that can cost a
     * person their link, and that is behind the token.
     */
    if (path === "/api/wifi") {
      try {
        const mod = await import("../plugins/rosa-wifi-switcher/plugin.mjs");
        const config = plugins.plugins.find((p) => p.id === "rosa-wifi-switcher")?.config ?? {};
        return json(res, 200, await mod.probeWifi({ timeoutMs: config.timeoutMs }));
      } catch (err) {
        // A page that renders the reason is worth more than a 500 it cannot read: the
        // list is empty either way, and "the plugin is missing" is an answer.
        log(`ui: wifi probe failed: ${err?.message ?? err}`);
        return json(res, 200, {
          at: Date.now(),
          platform: process.platform,
          supported: process.platform === "win32",
          available: false,
          note: `the wifi-switcher plugin could not be used: ${err?.message ?? err}`,
          interface: null,
          networks: [],
          saved: [],
          errors: [String(err?.message ?? err)],
        });
      }
    }

    if (path === "/api/wifi/connect" && req.method === "POST") {
      if (req.headers["x-rosalena-token"] !== token) return json(res, 403, { error: "bad token" });
      const body = await readBody(req);
      try {
        const mod = await import("../plugins/rosa-wifi-switcher/plugin.mjs");
        const config = plugins.plugins.find((p) => p.id === "rosa-wifi-switcher")?.config ?? {};
        // No timeout here on purpose: the plugin verifies by polling the driver, which is
        // three samples at 1.5 s, and cutting it short would report a join that worked as
        // a failure. The password is never logged - `connectWifi` only ever returns a
        // sentence.
        const outcome = await mod.connectWifi({
          ssid: String(body.ssid ?? ""),
          password: body.password == null ? null : String(body.password),
          timeoutMs: config.timeoutMs,
          attempts: config.verifyAttempts,
          intervalMs: config.verifyIntervalMs,
        });
        log(`ui: wifi connect ${outcome.ok ? "ok" : "refused"} (${outcome.ssid ?? "no ssid"})`);
        // `ok: false` is the plugin's answer, not a transport error: the page shows the
        // sentence and keeps the password field open.
        return json(res, 200, outcome);
      } catch (err) {
        log(`ui: wifi connect failed: ${err?.message ?? err}`);
        return json(res, 500, { ok: false, error: String(err?.message ?? err), message: String(err?.message ?? err) });
      }
    }

    /*
     * VPN exits: the same shape as Wi-Fi, for the same reason. Reading is read-only - two
     * filtered `tasklist` calls and two file checks, nothing that starts or stops a client
     * - so it sits outside the token check with /api/wifi. That also makes it cheap enough
     * for the sidebar to poll (~190 ms against ~370 ms for one full process list).
     */
    if (path === "/api/exits") {
      try {
        const mod = await import("../plugins/rosa-vpn-exit-rotator/plugin.mjs");
        const config = plugins.plugins.find((p) => p.id === "rosa-vpn-exit-rotator")?.config ?? {};
        return json(res, 200, await mod.probeExits({ config }));
      } catch (err) {
        // A page that draws "unknown" is worth more than a 500 it cannot read. Two
        // providers, both unknown, and a note that says why: never an empty page, and
        // never a claim that nothing is running.
        log(`ui: exits probe failed: ${err?.message ?? err}`);
        return json(res, 200, {
          at: Date.now(),
          platform: process.platform,
          supported: process.platform === "win32",
          providers: [
            { id: "outline", label: "Outline", image: "Outline.exe", installed: null, running: null, pids: [], path: "", searched: [], size: null, how: "not checked", error: null },
            { id: "express", label: "ExpressVPN", image: "ExpressVPN.exe", installed: null, running: null, pids: [], path: "", searched: [], size: null, how: "not checked", error: null },
          ],
          active: null,
          activeCount: 0,
          conflict: false,
          unknown: true,
          how: "nothing checked",
          note: `the vpn-exit-rotator plugin could not be used: ${err?.message ?? err}`,
          errors: [String(err?.message ?? err)],
        });
      }
    }

    if (path === "/api/exits/toggle" && req.method === "POST") {
      if (req.headers["x-rosalena-token"] !== token) return json(res, 403, { error: "bad token" });
      const body = await readBody(req);
      try {
        const mod = await import("../plugins/rosa-vpn-exit-rotator/plugin.mjs");
        const config = plugins.plugins.find((p) => p.id === "rosa-vpn-exit-rotator")?.config ?? {};
        // No timeout here on purpose: a start polls tasklist for up to 4 x 700 ms and a
        // stop for 3 x 300 ms, and cutting that short would report a change that happened
        // as one that did not. Nothing secret travels through here - no password, no key,
        // only "which client" and "on or off".
        const outcome =
          body.rotate === true
            ? await mod.rotateExits({ config })
            : await mod.toggleExit({ provider: String(body.provider ?? ""), on: body.on === true, config });
        log(`ui: exits ${outcome.ok ? "ok" : "refused"} (${body.rotate === true ? "rotate" : (outcome.provider ?? "unknown")})`);
        // `ok: false` is the plugin's answer, not a transport error: the page shows the
        // sentence it returned and then re-reads the state, which is the only thing drawn.
        return json(res, 200, outcome);
      } catch (err) {
        log(`ui: exits toggle failed: ${err?.message ?? err}`);
        return json(res, 500, {
          ok: false,
          error: String(err?.message ?? err),
          message: `the exit rotator could not run: ${err?.message ?? err}`,
        });
      }
    }

    /*
     * The session graph. A run already knows its parent and its depth, so the whole shape
     * is one pass over the store: no second query, and nothing inferred.
     *
     * A parent that has scrolled out of the window is not invented as a node - the child
     * is reported as a root with `orphan: true`, because drawing a fake parent is the one
     * thing a graph must never do.
     */
    if (path === "/api/graph") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 120) || 120, 400);
      const runs = listRuns({ dir: runRoot, limit });
      const ids = new Set(runs.map((r) => r.id));
      const nodes = runs.map((r) => ({
        id: r.id,
        label: r.task ? String(r.task).replace(/\s+/g, " ").slice(0, 90) : "(no task)",
        status: r.status ?? "unknown",
        cls: r.cls ?? null,
        model: r.model ?? null,
        depth: Number.isFinite(r.depth) ? r.depth : 0,
        steps: r.steps ?? null,
        ms: r.ms ?? null,
        at: r.at ?? r.startedAt ?? null,
        parent: r.parent ?? null,
      }));
      const edges = nodes.filter((n) => n.parent && ids.has(n.parent)).map((n) => ({ from: n.parent, to: n.id }));
      const linked = new Set(edges.map((e) => e.to));
      return json(res, 200, {
        at: Date.now(),
        nodes,
        edges,
        roots: nodes.filter((n) => !linked.has(n.id)).map((n) => n.id),
        orphans: nodes.filter((n) => n.parent && !ids.has(n.parent)).map((n) => n.id),
        counts: {
          total: nodes.length,
          running: nodes.filter((n) => n.status === "running").length,
          failed: nodes.filter((n) => n.status === "failed").length,
          deepest: nodes.reduce((max, n) => Math.max(max, n.depth), 0),
        },
        truncated: runs.length >= limit,
      });
    }

    /*
     * One directory of the workspace, for the file panel. Read-only and outside the token
     * check, like the other probes: listing a directory is not a write.
     *
     * It refuses to leave the workspace - `relative()` plus a `..` test, not a string
     * prefix, because `D:\work\app2` starts with `D:\work\app` and a prefix test would let
     * it through. Symlinked directories are reported but never followed, so a link cannot
     * turn one listing into a walk of the whole disk.
     */
    // The sidebar's file viewer (file-preview.mjs): a workspace file's kind, its bytes for an
    // <img>/<iframe>/<video> (token as `t`, since those cannot send headers), an Office file's
    // slides/pages/sheets, and a picture inside one. Only files inside the app's workspace or
    // a chat's own folder; an HTML file is served sandboxed so its scripts get no origin.
    if (path === "/api/file" || path.startsWith("/api/file/")) {
      // The page asks with its token in the header. An <img>/<iframe>/<video> cannot send
      // one, so it gets a ticket instead (`k`): good for one file, for 30 minutes. The page's
      // own token is never put in a URL, where a sandboxed HTML file could read it.
      const ticket = url.searchParams.get("k") ?? "";
      const viaTicket = ticket && fileTickets.get(ticket);
      if (req.headers["x-rosalena-token"] !== token && !viaTicket) return json(res, 403, { error: "bad token" });
      let target;
      if (viaTicket) {
        if (viaTicket.expires < Date.now()) {
          fileTickets.delete(ticket);
          return json(res, 403, { error: "this file link expired; open the file again" });
        }
        target = viaTicket.abs;
      } else {
        const askedChat = url.searchParams.get("chat") ?? "";
        const askedRoot = existingDir(url.searchParams.get("root") ?? "");
        const base = askedRoot || (askedChat ? chatWorkspace(askedChat) : workspace);
        const asked = url.searchParams.get("abs") ? resolve(url.searchParams.get("abs")) : resolve(base, url.searchParams.get("path") ?? "");
        // Compared for real (links followed on both sides), against the app's folder, every
        // chat's folder and the folder the request names.
        const real = (p) => {
          try {
            return realpathSync.native(p);
          } catch {
            return null;
          }
        };
        const roots = [...fileRoots(), base].map(real).filter(Boolean);
        // Below a root, never the root itself (that is a folder, not a file to show). ".."
        // counts only as a whole segment, so a file under "..cache" is still inside.
        const inside = (p) => roots.some((r) => relative(r, p) !== "" && insideRoot(r, p));
        target = real(asked);
        // A path outside answers 403 whether or not it exists, so the route never tells
        // anyone what is on the disk outside the workspace.
        if (!target) return json(res, inside(asked) ? 404 : 403, { error: inside(asked) ? "no such file" : "outside the workspace" });
        if (!inside(target)) return json(res, 403, { error: "outside the workspace" });
      }
      let stat;
      try {
        stat = statSync(target);
      } catch {
        return json(res, 404, { error: "no such file" });
      }
      if (!stat.isFile()) return json(res, 400, { error: "not a file" });
      if (path === "/api/file/ticket") {
        const id = randomBytes(18).toString("base64url");
        fileTickets.set(id, { abs: target, expires: Date.now() + 30 * 60_000 });
        // Old tickets go, so the map cannot grow without end in a long session.
        if (fileTickets.size > 500) for (const [k, v] of fileTickets) if (v.expires < Date.now() || fileTickets.size > 400) fileTickets.delete(k);
        return json(res, 200, { ticket: id, abs: target });
      }
      const { fileKind, mimeOf, officePart, officePreview, PREVIEW_LIMIT } = await import("./file-preview.mjs");
      let sample = null;
      try {
        const fd = openSync(target, "r");
        sample = Buffer.alloc(Math.min(4096, stat.size));
        readSync(fd, sample, 0, sample.length, 0);
        closeSync(fd);
      } catch {
        sample = null;
      }
      const kind = fileKind(target, sample);
      if (path === "/api/file/info") return json(res, 200, { abs: target, name: basename(target), size: stat.size, at: stat.mtime.toISOString(), kind });
      try {
        if (path === "/api/file/office") return json(res, 200, officePreview(target));
        if (path === "/api/file/part") {
          const entry = String(url.searchParams.get("entry") ?? "");
          // Pictures only: a .html or .svg packed into an Office file must never come back
          // as a page on this origin.
          if (!/\.(png|jpe?g|gif|webp|bmp)$/i.test(entry)) return json(res, 415, { error: "only pictures are shown from inside an Office file" });
          const bytes = officePart(target, entry);
          res.writeHead(200, {
            "content-type": mimeOf(entry, "binary"),
            "content-length": bytes.length,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "content-security-policy": "sandbox; default-src 'none'",
          });
          return res.end(bytes);
        }
      } catch (err) {
        return json(res, 400, { error: String(err?.message ?? err) });
      }
      if (path !== "/api/file") return json(res, 404, { error: `no route ${path}` });
      if ((kind === "text" || kind === "markdown") && stat.size > PREVIEW_LIMIT) return json(res, 413, { error: "too big to show here" });
      const headers = { "content-type": mimeOf(target, kind), "content-length": stat.size, "cache-control": "no-store", "x-content-type-options": "nosniff" };
      // A page or an SVG from the workspace runs sandboxed (no origin) and offline: its
      // scripts run, but it cannot reach this server or send anything anywhere.
      if (kind === "html" || /\.svg$/i.test(target)) {
        headers["content-security-policy"] =
          "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:";
      }
      res.writeHead(200, headers);
      // pipeline, not pipe: a file that is locked, unreadable or deleted between the stat and
      // the read used to throw an unhandled stream error and take the whole app down.
      return pipeline(createReadStream(target), res, () => {});
    }

    if (path === "/api/files") {
      const requested = url.searchParams.get("path") ?? "";
      // A chat's own folder (by id), or a folder picked for a chat not sent yet (by path,
      // which needs the page token, and must be a folder that exists).
      const askedRoot = url.searchParams.get("root") ?? "";
      const askedChat = url.searchParams.get("chat") ?? "";
      let root = workspace;
      if (askedRoot) {
        if (req.headers["x-rosalena-token"] !== token) return json(res, 403, { error: "bad token" });
        // Asynchronous: a folder tab on a network share that went offline must not stall
        // the whole server while Windows waits out the share.
        root = await existingFolder(askedRoot);
        if (!root) return json(res, 400, { error: `not a folder: ${askedRoot}`, root: null, path: null, dirs: [], files: [] });
      } else if (askedChat) {
        root = chatWorkspace(askedChat);
      }
      const listed = await listFolder(root, requested);
      return json(res, listed.status, listed.body);
    }

    /*
     * What will run on this machine, and at which quantisation.
     *
     * The arithmetic is `recommend()` from the catalog module, unchanged: this route
     * only measures, projects and labels. It never re-decides fit, because two copies
     * of that rule would drift and the page would start recommending a model the CLI
     * says does not fit.
     *
     * Read-only and outside the token check. `hostname` is dropped from the probe so
     * the payload carries hardware facts only - if this page ever grows a "share my
     * result" button, nothing identifying is in the body it would share.
     */
    if (path === "/api/recommend") {
      const fresh = url.searchParams.get("fresh") === "1";
      const startedAt = Date.now();
      let cached = true;
      if (fresh || recommendCache.value === null || Date.now() - recommendCache.at > RECOMMEND_TTL_MS) {
        cached = false;
        try {
          // The models folder decides which drive's free space matters, and it is the
          // local-llm plugin that owns that setting - asked of the same config the CLI
          // reads, so the page and `rosalena hardware` report the same disk.
          let modelsDir = null;
          try {
            const configured = readHarnessConfig()?.plugins?.["rosa-local-llm"]?.config?.modelDirs;
            if (Array.isArray(configured)) modelsDir = configured.find((dir) => typeof dir === "string" && dir.trim()) ?? null;
            // Nothing configured: measure the first model folder that exists on this PC.
            if (!modelsDir) modelsDir = detectModelDirs()[0] ?? null;
          } catch {
            // A broken config is not a reason to refuse to measure the graphics card.
          }
          const hardware = probeHardware({ modelsDir });
          const catalog = loadCatalog();
          recommendCache.value = { hardware, catalog };
          recommendCache.at = Date.now();
        } catch (err) {
          recommendCache.value = null;
          recommendCache.at = 0;
          return json(res, 503, {
            ok: false,
            error: `cannot measure this machine: ${err?.message ?? err}`,
            hardware: null,
            rows: { fits: [], tight: [], tooBig: [], unknown: [] },
          });
        }
      }
      const { hardware, catalog } = recommendCache.value;
      let buckets;
      try {
        buckets = recommend({ hardware, catalog });
      } catch (err) {
        return json(res, 500, {
          ok: false,
          error: `the catalog and this machine's numbers do not agree: ${err?.message ?? err}`,
          hardware: null,
          rows: { fits: [], tight: [], tooBig: [], unknown: [] },
        });
      }
      const shape = (row) => ({
        id: row.entry.id,
        name: row.entry.name,
        params: row.entry.params ?? null,
        use: row.entry.use ?? null,
        license: row.entry.license ?? null,
        url: row.entry.url ?? null,
        notes: row.entry.notes ?? null,
        quant: row.quant,
        file: row.quantSpec?.file ?? null,
        downloadUrl: row.quantSpec?.url ?? null,
        needBytes: row.needBytes,
        weightsBytes: row.weightsBytes ?? null,
        kvCacheBytes: row.kvCacheBytes ?? null,
        context: row.context,
        verdict: row.verdict,
        idleVerdict: row.idleVerdict ?? null,
        device: row.device ?? null,
        headroomBytes: row.headroomBytes ?? null,
        reason: row.reason ?? null,
        quants: (row.quants ?? []).map((q) => {
          const target = downloadTarget({ kind: "chat", id: row.entry.id, quant: q.quant, chatCatalog: catalog });
          const path = findDownloaded(target, chatModelDirs());
          return {
            quant: q.quant,
            file: q.file ?? null,
            url: q.url ?? null,
            needBytes: q.needBytes,
            verdict: q.verdict,
            idleVerdict: q.idleVerdict ?? null,
            context: q.context ?? null,
            // Whether the page's Download button can fetch it as one checked file.
            split: target?.split ?? false,
            downloaded: Boolean(path),
          };
        }),
        downloaded: Boolean(findDownloaded(downloadTarget({ kind: "chat", id: row.entry.id, quant: row.quant, chatCatalog: catalog }), chatModelDirs())),
      });
      const models = buckets.fits.length + buckets.tight.length + buckets.tooBig.length + buckets.unknown.length;
      // Image, video and voice: the same machine, scored with media-models.json.
      let media = null;
      try {
        const mediaCatalog = loadMediaCatalog();
        media = scoreMedia({
          hardware,
          catalog: mediaCatalog,
          isDownloaded: (entry) => findDownloaded(downloadTarget({ kind: entry.kind, id: entry.id, mediaCatalog })),
        });
      } catch (err) {
        log(`ui: media catalog: ${err?.message ?? err}`);
      }
      return json(res, 200, {
        ok: true,
        at: new Date().toISOString(),
        tookMs: Date.now() - startedAt,
        cached,
        cacheTtlMs: RECOMMEND_TTL_MS,
        hardware: {
          platform: hardware.platform ?? null,
          arch: hardware.arch ?? null,
          cpu: hardware.cpu ?? null,
          ram: hardware.ram ?? null,
          gpu: hardware.gpu ?? null,
          disk: hardware.disk ?? null,
          notes: hardware.notes ?? [],
          unknown: hardware.unknown ?? [],
        },
        catalog: { path: CATALOG_PATH, models },
        rows: {
          fits: buckets.fits.map(shape),
          tight: buckets.tight.map(shape),
          tooBig: buckets.tooBig.map(shape),
          unknown: buckets.unknown.map(shape),
        },
        counts: {
          fits: buckets.fits.length,
          tight: buckets.tight.length,
          tooBig: buckets.tooBig.length,
          unknown: buckets.unknown.length,
        },
        media,
        modelsHome: join(starterHome(), "models"),
        download: modelDownloader?.job() ?? null,
      });
    }

    /*
     * Downloads from the Models page: GET is the current job, POST (token) is
     * { action: "start", kind, id, quant? } or { action: "cancel" }. The page asks the
     * person first; this route is what runs once they said yes.
     */
    if (path === "/api/models/download") {
      modelDownloader ??= createModelDownloader({
        log,
        runtimeKeyName: (() => {
          const hw = starterHardware.value ?? recommendCache.value?.hardware ?? null;
          return runtimeKey({ platform: hw?.platform, arch: hw?.arch, gpu: hw?.gpu });
        })(),
      });
      if (req.method === "GET") return json(res, 200, { ok: true, job: modelDownloader.job() });
      if (req.method !== "POST") return json(res, 405, { error: "GET or POST" });
      if (req.headers["x-rosalena-token"] !== token) return json(res, 403, { error: "bad token" });
      const body = await readBody(req);
      const action = String(body.action ?? "");
      if (action === "cancel") return json(res, 200, modelDownloader.cancel());
      if (action !== "start") return json(res, 400, { ok: false, error: `unknown action "${action}" - use start or cancel` });
      const kind = String(body.kind ?? "");
      if (!MODEL_KINDS.includes(kind)) return json(res, 400, { ok: false, error: `kind must be one of ${MODEL_KINDS.join(", ")}` });
      const target = downloadTarget({
        kind,
        id: String(body.id ?? ""),
        quant: body.quant ? String(body.quant) : null,
        chatCatalog: kind === "chat" ? loadCatalog() : null,
        mediaCatalog: kind === "chat" ? null : loadMediaCatalog(),
      });
      const started = modelDownloader.start(target);
      log(`ui: model download ${kind}/${body.id ?? ""} -> ${started.ok ? "started" : started.error}`);
      return json(res, started.ok ? 202 : started.code === "busy" ? 409 : 400, started);
    }

    /*
     * Cloud models the person brings (cloud-setup.mjs): their own provider keys and the
     * optional OmniRoute download. GET never returns a key, only the router's masked tail.
     * POST (token) takes save-key, remove-key, omniroute-install and omniroute-start.
     */
    if (path === "/api/cloud") {
      const adminBase = String(routerUrl).replace(/\/+$/, "").replace(/\/v1$/i, "");
      const routerHeaders = process.env.ROSALENA_ROUTER_TOKEN ? { "x-rosalena-token": process.env.ROSALENA_ROUTER_TOKEN } : {};
      const readStatus = async () => {
        try {
          const res = await fetch(`${adminBase}/admin/status`, { headers: routerHeaders, signal: AbortSignal.timeout(3000) });
          return res.ok ? await res.json() : null;
        } catch {
          return null;
        }
      };
      if (req.method === "POST") {
        if (req.headers["x-rosalena-token"] !== token) return json(res, 403, { error: "bad token" });
        const body = await readBody(req);
        const action = String(body.action ?? "").trim();
        try {
          if (action === "save-key" || action === "remove-key") {
            const status = await readStatus();
            if (!status) return json(res, 503, { ok: false, error: "the router is not answering, so its key file could not be found" });
            const provider = String(body.provider ?? "");
            const key = action === "remove-key" ? null : cleanKey(body.key);
            if (action === "save-key" && !key) return json(res, 400, { ok: false, error: "that does not look like an API key (one piece of text, no spaces)" });
            saveProviderKey({ keyFile: status.keyFile, provider, key });
            menuCache.clear();
            log(`ui: ${action === "save-key" ? "saved" : "removed"} the ${provider} key`);
            return json(res, 200, { ok: true });
          }
          if (action === "omniroute-install") {
            const started = omniroute.install();
            return json(res, started.ok ? 202 : started.code === "busy" ? 409 : 400, started);
          }
          // OmniRoute runs inside Rosalena now (omniroute-manager.mjs): start, stop, restart,
          // take over one running outside, the two switches, and its log.
          if (action === "omniroute-start" || action === "omniroute-restart" || action === "omniroute-adopt") {
            const out = action === "omniroute-start" ? await omniManager.start() : action === "omniroute-restart" ? await omniManager.restart() : await omniManager.adopt();
            menuCache.clear();
            return json(res, out.ok ? 200 : 409, out);
          }
          if (action === "omniroute-stop") {
            const out = await omniManager.stop();
            menuCache.clear();
            return json(res, 200, out);
          }
          if (action === "omniroute-prefs") {
            return json(res, 200, { ok: true, prefs: omniManager.setPrefs({ autostart: body.autostart, keepAfterQuit: body.keepAfterQuit }) });
          }
          if (action === "omniroute-log") {
            return json(res, 200, { ok: true, lines: omniManager.tail(Math.min(Number(body.lines) || 120, 400)), file: omniManager.logFile });
          }
          return json(res, 400, { ok: false, error: `unknown action "${action}"` });
        } catch (err) {
          return json(res, 400, { ok: false, error: String(err?.message ?? err) });
        }
      }
      const status = await readStatus();
      return json(res, 200, {
        ok: true,
        router: Boolean(status),
        keys: status ? keyRows(status) : KEY_PROVIDERS.map((p) => ({ ...p, set: null, masked: [] })),
        // Where a student (or anyone) gets a free key: the cards above the key list.
        programs: studentPrograms(),
        omniroute: await (async () => {
          const base = await omniroute.status();
          const manager = await omniManager.status();
          // An install anywhere the manager looks counts, not only the one Settings made.
          return { ...base, installed: base.installed || manager.installed, running: base.running || manager.running, manager };
        })(),
      });
    }

    /*
     * The starter model: the welcome screen's "this PC can run X, set it up?" offer.
     *
     * GET says what would be offered and why, whether a starter is already on disk, whether
     * the person said "Not now", and how far a running setup is. POST (token, like
     * /api/local, because it downloads gigabytes and writes into the home folder) takes
     * install, cancel or dismiss. Installing only puts files where the local shelf looks;
     * the picker then lists the model and choosing it starts llama.cpp the usual way.
     */
    if (path === "/api/starter") {
      starterInstaller ??= createStarterInstaller({ log });
      if (!starterHardware.value || Date.now() - starterHardware.at > STARTER_HARDWARE_TTL_MS) {
        starterHardware.value = probeHardware({ modelsDir: starterHome() });
        starterHardware.at = Date.now();
      }
      const hardware = starterHardware.value;
      const catalog = loadCatalog();
      const pick = pickStarter({ hardware, catalog });
      const runtimeKeyName = runtimeKey({ platform: hardware.platform, arch: hardware.arch, gpu: hardware.gpu });

      if (req.method === "POST") {
        if (req.headers["x-rosalena-token"] !== token) return json(res, 403, { error: "bad token" });
        const body = await readBody(req);
        const action = String(body.action ?? "").trim().toLowerCase();
        if (action === "dismiss") {
          starterInstaller.dismiss();
          return json(res, 200, { ok: true });
        }
        if (action === "cancel") {
          starterInstaller.cancel();
          return json(res, 200, { ok: true });
        }
        if (action !== "install") return json(res, 400, { ok: false, error: `unknown action "${action}" - use install, cancel or dismiss` });
        const started = starterInstaller.start({ pick, runtimeKeyName });
        log(`ui: starter install ${pick.entry?.id ?? "(none)"} -> ${started.ok ? "started" : started.error}`);
        return json(res, started.ok ? 202 : started.code === "busy" ? 409 : 400, started);
      }

      const job = starterInstaller.job();
      const installed = findInstalledStarter({ catalog, dirs: [join(starterHome(), "models"), ...detectModelDirs()] });
      // The picker id the installed file will have, so the page can select it when the
      // setup finishes: the local shelf's own alias, not one derived a second time here.
      let target = null;
      if (installed) {
        try {
          const config = await localHostConfig();
          if (config) {
            const mod = await loadLocalHost();
            const status = await mod.serverStatus(config);
            target = status.models.find((entry) => String(entry.path ?? "").toLowerCase() === installed.path.toLowerCase())?.target ?? null;
          }
        } catch (err) {
          log(`ui: starter target lookup failed: ${err?.message ?? err}`);
        }
      }
      const runtimeNeeded = !hasServerBinary();
      let runtimeBytes = null;
      try {
        runtimeBytes = runtimeNeeded && runtimeKeyName ? loadRuntime().assets?.[runtimeKeyName]?.bytes ?? null : null;
      } catch {
        runtimeBytes = null;
      }
      const saved = starterInstaller.saved();
      const gpu = hardware.gpu ?? {};
      return json(res, 200, {
        ok: true,
        offer: pick.entry
          ? {
              id: pick.entry.id,
              name: pick.entry.name,
              quant: pick.file.quant,
              bytes: pick.file.bytes,
              fileName: pick.file.fileName,
              license: pick.entry.license ?? null,
              reason: pick.reason,
              runtimeNeeded,
              runtimeBytes,
            }
          : null,
        reason: pick.reason,
        machine: {
          gpu: gpu.name ?? null,
          vramGiB: gpu.vramTotalBytes ? Math.round(gpu.vramTotalBytes / 2 ** 30) : null,
          ramGiB: hardware.ram?.totalBytes ? Math.round((hardware.ram.windowsTotalBytes ?? hardware.ram.totalBytes) / 2 ** 30) : null,
        },
        installed: installed ? { ...installed, target } : null,
        dismissed: Boolean(saved.dismissedAt),
        job,
      });
    }

    if (path === "/api/health") {
      const [router, counts] = await Promise.all([routerModels(routerUrl), sessionCounts({ max: 500 })]);      // One card, one model: the page can only offer "load", "switch" and "unload" if it
      // knows whether the local server is up, which model it serves and whether that model
      // is generating. A probe that fails reports itself, so a down server is a state here
      // and never a failed page.
      let local = { enabled: false };
      try {
        const status = await localStatus();
        local = status.enabled
          ? {
              enabled: true,
              up: status.up,
              loading: status.loading,
              busy: status.busy,
              loaded: status.loaded,
              pid: status.pid,
              ours: status.ours,
              context: status.ctx,
              // The window the NEXT load would use: the person's setting in Settings, or
              // the install's planContext. The page compares it with `context` so a model
              // loaded before the setting changed can say so instead of just looking wrong.
              planContext: (await localHostConfig())?.planContext ?? null,
              count: status.models.length,
              error: status.error ?? null,
            }
          : status;
      } catch (err) {
        local = { enabled: false, error: String(err?.message ?? err) };
      }
      return json(res, 200, {
        ok: true,
        router,
        // The address chats go to (Settings > Advanced shows it).
        routerUrl,
        local,
        workspace,
        home,
        runsDir: runRoot,
        sessionCounts: counts,
        roots: roots(),
        // `loaded: false` before the first chat is the honest state: the host is built on
        // demand, so the page can say "not built yet" instead of guessing at a count.
        plugins: {
          loaded: pluginsLoad !== null,
          count: plugins.plugins.length,
          names: plugins.plugins.map((p) => p.id),
          errors: plugins.errors,
        },
      });
    }

    if (path === "/api/models") {
      const menu = await loadMenu();
      // Claude Code's rows, last, only when it is installed and signed in: a row that can
      // only fail is worse than no row. Rosalena never signs anyone in to it.
      // Codex's rows after them, on the same rule.
      const [claude, codex] = await Promise.all([claudeCodeStatus().catch(() => null), codexStatus().catch(() => null)]);
      const extra = [...(claude?.found && claude.loggedIn ? claudeCodeRows() : []), ...(codex?.found && codex.loggedIn ? codexRows() : [])];
      // Which API-key providers have a key saved, so the menu can say "key saved" or "no
      // key yet" under those headings. Null when the router did not answer: unknown, not no.
      const status = await (async () => {
        try {
          const adminBase = String(routerUrl).replace(/\/+$/, "").replace(/\/v1$/i, "");
          const headers = process.env.ROSALENA_ROUTER_TOKEN ? { "x-rosalena-token": process.env.ROSALENA_ROUTER_TOKEN } : {};
          const res = await fetch(`${adminBase}/admin/status`, { headers, signal: AbortSignal.timeout(3000) });
          return res.ok ? await res.json() : null;
        } catch {
          return null;
        }
      })();
      const keys = status ? Object.fromEntries(keyRows(status).map((row) => [row.id, row.set])) : null;
      // The models on this PC answer through the router's "local" provider, so they take its
      // effort words (low/medium/high, Default = thinking off) rather than every level.
      const installed = await withInstalled(menu.models ?? [], status?.providers?.local ?? null);
      return json(res, 200, { ...menu, models: [...installed, ...extra], keys, claudeCode: claude ? { found: claude.found, version: claude.version, loggedIn: claude.loggedIn, authMethod: claude.authMethod } : null, codex: codex ? { found: codex.found, version: codex.version, loggedIn: codex.loggedIn, authMethod: codex.authMethod } : null });
    }

    // Settings > Spend limits: each paid provider's spend this month and its monthly cap,
    // changed here and applied by the router to the next request (router/src/budgets.mjs).
    if (path === "/api/budgets" && (req.method === "GET" || req.method === "PUT")) {
      const adminBase = String(routerUrl).replace(/\/+$/, "").replace(/\/v1$/i, "");
      const headers = { "content-type": "application/json", ...(process.env.ROSALENA_ROUTER_TOKEN ? { "x-rosalena-token": process.env.ROSALENA_ROUTER_TOKEN } : {}) };
      try {
        if (req.method === "PUT") {
          if (req.headers["x-rosalena-token"] !== token) return json(res, 403, { error: "bad token" });
          const body = await readBody(req);
          // A missing or non-numeric amount is refused here: NaN went out as null, and the
          // router read null as 0, which means NO limit (bug hunt 2026-11-08).
          const usd = typeof body.monthlyUsd === "number" ? body.monthlyUsd : typeof body.monthlyUsd === "string" && body.monthlyUsd.trim() ? Number(body.monthlyUsd) : NaN;
          if (!Number.isFinite(usd) || usd < 0) return json(res, 400, { error: "monthlyUsd must be a number of dollars, 0 for no limit" });
          const put = await fetch(`${adminBase}/admin/budgets`, {
            method: "PUT",
            headers,
            body: JSON.stringify({ provider: String(body.provider ?? ""), monthlyUsd: usd }),
            signal: AbortSignal.timeout(5000),
          });
          const answer = await put.json().catch(() => ({}));
          if (!put.ok) return json(res, put.status, { error: answer?.error?.message ?? answer?.error ?? `the router answered ${put.status}` });
          log(`ui: spend limit for ${body.provider} -> $${answer.capUsd}`);
          menuCache.clear();
        }
        const status = await fetch(`${adminBase}/admin/status`, { headers, signal: AbortSignal.timeout(3000) });
        if (!status.ok) return json(res, 502, { error: `the router answered ${status.status}` });
        const report = await status.json();
        // Only providers that cost money: a free or local route has nothing to cap.
        const providers = Object.entries(report.providers ?? {})
          .filter(([, p]) => p.prices && (Number(p.prices.in) > 0 || Number(p.prices.out) > 0))
          .map(([id, p]) => ({ id, label: { anthropic: "Anthropic (Claude, your API key)", openai: "OpenAI", google: "Google Gemini", openrouter: "OpenRouter", deepseek: "DeepSeek", zai: "Z.AI (GLM)", kimi: "Kimi (Moonshot)" }[id] ?? id, spentUsd: p.spentUsd ?? 0, capUsd: p.capUsd ?? null, remainingUsd: p.remainingUsd ?? null, withinBudget: p.withinBudget !== false, hasKey: Boolean(p.hasKey), calls: p.calls ?? 0 }));
        return json(res, 200, { month: report.month ?? null, providers });
      } catch (err) {
        return json(res, 502, { error: `the router did not answer: ${err?.message ?? err}` });
      }
    }

    // Claude Code as an engine: is it here, which build, is it signed in. `?fresh=1` after
    // the person signs in, so the picker does not wait out the cache.
    if (path === "/api/claude-code" && req.method === "GET") {
      const claude = await claudeCodeStatus({ fresh: url.searchParams.get("fresh") === "1" });
      return json(res, 200, { found: claude.found, version: claude.version, loggedIn: claude.loggedIn, authMethod: claude.authMethod });
    }

    // Codex as an engine, the same question: here, which build, signed in (and how).
    if (path === "/api/codex" && req.method === "GET") {
      const codex = await codexStatus({ fresh: url.searchParams.get("fresh") === "1" });
      return json(res, 200, { found: codex.found, version: codex.version, loggedIn: codex.loggedIn, authMethod: codex.authMethod });
    }

    // Check for updates: one small static JSON file on the site, compared with the version
    // this copy is running. The server keeps the last answer for the life of the process so
    // a page left open cannot turn into a poll; `?fresh=1` is the person pressing the
    // button, and a person asking is not a timer, so it skips the floor.
    //
    // It reports three states and never a fourth: `current`, `available` (only when the feed
    // carries a release page the button can actually open) and `unknown` with a reason. It
    // never downloads, installs or restarts anything, and it never says "available" about an
    // update it cannot point at - that would be a promise the app cannot keep.
    if (path === "/api/update") {
      const forced = url.searchParams.get("fresh") === "1";
      if (!forced && lastUpdateCheck.verdict && !shouldCheck({ lastCheckedAt: lastUpdateCheck.at, now: Date.now() })) {
        return json(res, 200, { ...lastUpdateCheck.verdict, cached: true, checkedAt: lastUpdateCheck.at });
      }
      const current = appVersion();
      // ROSALENA_UPDATE_FEED exists so a locally served copy of the site can be checked
      // without publishing anything. It only changes *where the feed is read from*; the
      // version comparison and the release-page rules are the same code either way.
      const feedUrl = process.env.ROSALENA_UPDATE_FEED?.trim();
      const fetched = current
        ? await fetchUpdateManifest(feedUrl ? { url: feedUrl } : {})
        : { ok: false, reason: "this build carries no version file" };
      const verdict = fetched.ok
        ? decideUpdate({ current, manifest: fetched.manifest })
        : { state: "unknown", current, latest: null, url: "", notes: "", releasedAt: null, reason: fetched.reason };
      lastUpdateCheck = { at: Date.now(), verdict };
      return json(res, 200, { ...verdict, cached: false, checkedAt: lastUpdateCheck.at });
    }

    // What is running right now, for the strip in the top bar: live runs from the run
    // store, split into the chats this page could be watching and the subagents they
    // started, plus the processes the process-tracker ledger still records as alive.
    //
    // Every row is read from disk on the request - no cached counts, because a cached
    // "2 running" is indistinguishable from a lie. A run with no record whose log has
    // stopped growing is reported `stale` by the store and is *not* counted as running.
    if (path === "/api/activity") {
      const live = listRuns({ dir: runRoot, limit: 80, status: "running" });
      const shape = (run) => ({
        id: run.id,
        task: run.task ?? null,
        cls: run.cls ?? null,
        model: run.model ?? null,
        depth: run.depth ?? 0,
        parent: run.parent ?? null,
        startedAt: run.startedAt ?? null,
        status: run.status,
        idleMs: run.idleMs ?? null,
        steps: run.steps ?? null,
        tools: run.tools ?? null,
        lastTool: run.lastTool ?? null,
        lastEvent: run.lastEvent ?? null,
      });
      const runs = live.map(shape);
      const subagents = runs.filter((run) => Number(run.depth) > 0);
      const top = runs.filter((run) => !(Number(run.depth) > 0));
      // The ledger is the only place a process the harness started (and lost track of)
      // is written down. `keep` entries are ones the user asked to survive a run, and
      // `ended` ones are already gone; neither belongs in a "running now" count.
      let processes = [];
      try {
        const parsed = JSON.parse(await readFile(join(home, "process-ledger.json"), "utf8"));
        processes = (Array.isArray(parsed?.entries) ? parsed.entries : [])
          .filter((entry) => entry && !entry.ended && !entry.keep)
          .map((entry) => {
            // Which chat started it, by name, so the list says what the job is for.
            const record = entry.runId ? readRun({ dir: runRoot, id: entry.runId, maxEvents: 0 })?.record ?? null : null;
            const thread = entry.runId ? rootOf(readThreads(threadFile), entry.runId) : null;
            return {
              pid: entry.pid ?? null,
              name: entry.name ?? null,
              cmd: entry.cmd ?? null,
              runId: entry.runId ?? null,
              chat: entry.runId ? { id: thread ?? entry.runId, title: record?.task ? String(record.task).slice(0, 160) : null } : null,
              // The model that was driving the chat that started it.
              model: record?.model ?? record?.cls ?? null,
              firstSeen: entry.firstSeen ?? null,
              lastSeen: entry.lastSeen ?? null,
            };
          });
      } catch {
        processes = [];
      }
      return json(res, 200, {
        at: new Date().toISOString(),
        runs: top,
        subagents,
        processes,
        counts: { runs: top.length, subagents: subagents.length, processes: processes.length },
        sources: { runsDir: runRoot, ledger: join(home, "process-ledger.json") },
      });
    }

    // The orchestration page's data: the role presets exactly as the picker sees them,
    // the two files a role target can live in, and the plugin that is the real write
    // path. Nothing here is a guess: a missing file is `null`, a missing plugin is
    // `null`, and the page says which of the two it got.
    if (path === "/api/orchestration") {
      const menu = await loadMenu();
      const firstExisting = (candidates) => candidates.find((file) => existsSync(file)) ?? null;
      const roleFile = firstExisting([join(workspace, "data", "roles.json"), join(workspace, "..", "data", "roles.json")]);
      const routerFile = firstExisting([
        join(workspace, "router", "router.config.json"),
        join(workspace, "..", "router", "router.config.json"),
      ]);
      // The plugin host is built on demand; asking here builds it the same way a chat
      // would, so the page cannot report a plugin state the first run will not use.
      const host = pluginsLoad ? plugins : await loadPluginsOnce();
      const entry = (host?.plugins ?? []).find((item) => item.id === "rosa-subagent-model-switch") ?? null;
      // Whether each provider in a chain can answer right now: a key saved, inside its spend
      // limit, not resting after errors. Null when the router did not answer.
      const providers = await (async () => {
        try {
          const adminBase = String(routerUrl).replace(/\/+$/, "").replace(/\/v1$/i, "");
          const headers = process.env.ROSALENA_ROUTER_TOKEN ? { "x-rosalena-token": process.env.ROSALENA_ROUTER_TOKEN } : {};
          const res = await fetch(`${adminBase}/admin/status`, { headers, signal: AbortSignal.timeout(3000) });
          if (!res.ok) return null;
          const report = await res.json();
          return Object.fromEntries(
            Object.entries(report.providers ?? {}).map(([name, p]) => [
              name,
              { hasKey: p.hasKey !== false, withinBudget: p.withinBudget !== false, circuit: p.circuit?.state ?? "closed", free: !(p.prices && (Number(p.prices.in) > 0 || Number(p.prices.out) > 0)) },
            ]),
          );
        } catch {
          return null;
        }
      })();
      return json(res, 200, {
        providers,
        roles: menu.roles ?? [],
        models: menu.models ?? [],
        errors: menu.errors ?? [],
        fetchedAt: menu.fetchedAt ?? null,
        files: { roles: roleFile, router: routerFile },
        workspace,
        plugin: entry
          ? {
              id: entry.id,
              version: entry.version ?? null,
              description: entry.description ?? null,
              enabled: entry.enabled !== false,
              folder: entry.folder ?? null,
              config: entry.config ?? {},
            }
          : null,
        // The documented, real write path for a role target. The page prints these as
        // text; it does not pretend to run them.
        commands: {
          cwd: workspace,
          show: "node src/cli.mjs --plugin rosa-subagent-model-switch:show",
          set: "node src/cli.mjs --plugin rosa-subagent-model-switch:set <role> <target>",
          reset: "node src/cli.mjs --plugin rosa-subagent-model-switch:reset <role>",
        },
      });
    }

    // "Show in File Explorer": the OS file manager, opened at a path inside the
    // workspace. The refusal rules live in src/reveal.mjs and are tested there; this
    // route only carries the path, the token and the answer.
    if (path === "/api/reveal" && req.method === "POST") {
      if (req.headers["x-rosalena-token"] !== token) return json(res, 403, { error: "bad token" });
      const body = await readBody(req);
      const result = await revealInFileManager({
        path: body.path,
        workspace: body.root ? existingDir(body.root) ?? workspace : body.chat ? chatWorkspace(body.chat) : workspace,
        open: body.open === true,
      });
      return json(res, result.ok ? 200 : 400, result);
    }

    // The router's own token/cost ledger, relayed through this server.
    //
    // The page is served from here, so a same-origin fetch is the only one that needs no
    // CORS story - and the router's admin routes sit behind *its* token, which the page
    // must never hold. So this endpoint asks with the server's credentials and answers
    // with the numbers plus the prices it can see, which is what the cost column needs.
    // A router that is down is reported as such, not as a zero: "no usage" and "cannot
    // ask" are different facts and the page says which one it got.
    if (path === "/api/usage") {
      const days = String(url.searchParams.get("days") ?? "1") === "30" ? 30 : 1;
      const base = String(routerUrl).replace(/\/+$/, "").replace(/\/v1$/i, "");
      const headers = {};
      const routerToken = process.env.ROSALENA_ROUTER_TOKEN ?? "";
      if (routerToken) headers.authorization = `Bearer ${routerToken}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const res2 = await fetch(`${base}/admin/usage?days=${days}`, { headers, signal: controller.signal });
        if (!res2.ok) {
          const text = (await res2.text().catch(() => "")).slice(0, 200);
          return json(res, 502, { error: `router ${base}/admin/usage: HTTP ${res2.status}`, detail: text || null });
        }
        const usage = await res2.json();
        // Prices come from the same config the router routes with, so the cost column is
        // what this installation charges rather than a number baked into the page.
        let prices = {};
        try {
          const status = await fetch(`${base}/admin/status`, { headers, signal: controller.signal });
          if (status.ok) {
            const body = await status.json();
            prices = Object.fromEntries(
              Object.entries(body.providers ?? {}).map(([name, spec]) => [name, spec.prices ?? null]),
            );
          }
        } catch {
          prices = {};
        }
        return json(res, 200, { ...usage, prices });
      } catch (err) {
        return json(res, 502, { error: `router ${base} unreachable: ${String(err?.message ?? err)}` });
      } finally {
        clearTimeout(timer);
      }
    }

    // Dictation with a downloaded Whisper model (src/voice-runner.mjs). GET says whether it
    // can run and with which model; POST /api/voice installs the runner; POST
    // /api/voice/transcribe takes a 16 kHz WAV from the composer's mic button and returns
    // the text. Each transcription is one whisper.cpp process: loaded, used, gone.
    if (path === "/api/voice" || path === "/api/voice/transcribe") {
      const status = () => {
        const s = voiceStatus(starterHome());
        // What the mic's first click downloads: the catalog's dictation default.
        let setup = null;
        if (!s.ok) {
          try {
            const entry = loadMediaCatalog().models?.find((m) => m.kind === "voice" && m.dictationDefault);
            if (entry) setup = { id: entry.id, name: entry.name, bytes: entry.file?.bytes ?? null };
          } catch {
            /* no catalog: the Models page is the way */
          }
        }
        return { ok: s.ok, code: s.code ?? null, why: s.why ?? null, model: s.model?.name ?? null, models: s.models.map((m) => m.name), setup };
      };
      if (req.method === "GET" && path === "/api/voice") return json(res, 200, status());
      if (req.method !== "POST") return json(res, 405, { error: `no route for ${req.method} ${path}` });
      if (req.headers["x-rosalena-token"] !== token) return json(res, 403, { error: "bad token" });
      const body = await readBody(req);
      if (path === "/api/voice") {
        if (body.action !== "install") return json(res, 400, { ok: false, error: 'use { "action": "install" }' });
        try {
          await installWhisperRuntime({ home: starterHome(), log: (line) => log(`voice: ${line}`) });
          return json(res, 200, status());
        } catch (err) {
          return json(res, 500, { ok: false, error: String(err?.message ?? err) });
        }
      }
      const wav = Buffer.from(String(body.wav ?? ""), "base64");
      if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF") return json(res, 400, { ok: false, error: "no WAV audio in the request" });
      const file = join(tmpdir(), `rosalena-voice-${process.pid}-${Date.now()}.wav`);
      try {
        writeFileSync(file, wav);
        // The project's own words, so code names come out spelled the way the code does.
        const prompt = dictationPrompt({ root: workspace, context: typeof body.context === "string" ? body.context : "" });
        const out = await transcribeFile({ wavPath: file, home: starterHome(), model: body.model ?? null, prompt });
        log(`voice: ${out.model} transcribed ${(wav.length / 32000).toFixed(1)} s in ${out.ms} ms`);
        return json(res, 200, { ok: true, ...out });
      } catch (err) {
        return json(res, err?.code ? 409 : 500, { ok: false, code: err?.code ?? "failed", error: String(err?.message ?? err) });
      } finally {
        rmSync(file, { force: true });
      }
    }

    // What runs the image, video and voice models on this PC, for the Models page's tabs:
    // the ComfyUI install and whether it is up (and whose it is), the downloaded models it
    // can run, and the Whisper runner. Read-only.
    if (path === "/api/media/runners" && req.method === "GET") {
      try {
        const config = await comfyConfig();
        const runner = comfyFor(config);
        const status = await runner.status();
        const install = status.install ?? findComfyInstall({ root: config?.root ?? null });
        const voice = voiceStatus(starterHome());
        return json(res, 200, {
          ok: true,
          comfy: {
            baseUrl: status.baseUrl,
            up: status.up,
            ours: status.ours,
            pid: status.pid,
            install: install ? { root: install.root } : null,
            generate: config?.allowGenerate === true,
            models: runnableModels().map((m) => ({ id: m.id, kind: m.kind, name: m.name, needGiB: m.needGiB })),
          },
          voice: { ok: voice.ok, code: voice.code ?? null, why: voice.why ?? null, model: voice.model?.name ?? null, models: voice.models.map((m) => m.name) },
        });
      } catch (err) {
        return json(res, 500, { ok: false, error: String(err?.message ?? err) });
      }
    }

    // How local models load: idle unload, unload on quit, the VRAM reserve, the auto
    // context cap, RAM offload, and per-model manual settings (src/local-fit.mjs). Reading is
    // open; a change needs the token like every other write.
    if (path === "/api/local/settings") {
      if (req.method === "GET") return json(res, 200, { ok: true, prefs: readLocalPrefs(home) });
      if (req.method !== "POST") return json(res, 405, { error: `no route for ${req.method} ${path}` });
      if (req.headers["x-rosalena-token"] !== token) return json(res, 403, { error: "bad token" });
      const body = await readBody(req);
      const patch = {};
      for (const key of ["idleUnloadMinutes", "unloadOnQuit", "reserveGiB", "maxContext", "offload"]) if (Object.hasOwn(body, key)) patch[key] = body[key];
      if (body.models && typeof body.models === "object") patch.models = body.models;
      try {
        const prefs = writeLocalPrefs(home, patch);
        log(`ui: local model settings saved (${Object.keys(patch).join(", ") || "nothing"})`);
        return json(res, 200, { ok: true, prefs });
      } catch (err) {
        return json(res, 500, { ok: false, error: String(err?.message ?? err) });
      }
    }

    // What loading one installed model would do right now: context, GPU layers, cache type,
    // and the VRAM it would use - or why it would be refused.
    if (path === "/api/local/plan" && req.method === "GET") {
      const wanted = String(url.searchParams.get("model") ?? "").trim();
      try {
        const config = await localHostConfig();
        if (!config) return json(res, 503, { ok: false, code: "no-host", error: "the local-model-host plugin is not installed or is disabled" });
        const mod = await loadLocalHost();
        // No model: every installed chat model at once (the Models page's list).
        if (!wanted) return json(res, 200, await mod.planAll({ config }));
        const preview = await mod.planPreview({ config, target: wanted });
        return json(res, preview.ok ? 200 : 404, preview);
      } catch (err) {
        return json(res, 500, { ok: false, error: String(err?.message ?? err) });
      }
    }

    // The local shelf: what is installed, what is loaded, and the three manual actions.
    // Reading is open like /api/health; a load or an unload needs the token, because it
    // starts or stops a process that owns the card.
    if (path === "/api/local") {
      if (req.method === "GET") {
        try {
          const status = await localStatus();
          if (!status.enabled) return json(res, 200, status);
          return json(res, 200, {
            ok: true,
            enabled: true,
            server: {
              up: status.up,
              loading: status.loading,
              busy: status.busy,
              busySlots: status.busySlots,
              loaded: status.loaded,
              pid: status.pid,
              ours: status.ours,
              context: status.ctx,
              baseUrl: status.baseUrl,
              error: status.error ?? null,
            },
            models: status.models.map((entry) => ({ ...entry, loaded: status.loaded === entry.alias })),
          });
        } catch (err) {
          return json(res, 500, { ok: false, error: String(err?.message ?? err) });
        }
      }

      if (req.method !== "POST") return json(res, 405, { error: `no route for ${req.method} /api/local` });
      if (req.headers["x-rosalena-token"] !== token) return json(res, 403, { error: "bad token" });
      const body = await readBody(req);
      const action = String(body.action ?? "").trim().toLowerCase();
      const wanted = String(body.model ?? "").trim();
      const force = body.force === true;
      // A refusal is a message for the person, not a crash: the code says which refusal and
      // the status says whether trying again could help. 409 is "not now", 400 is "not this".
      const statusOf = { busy: 409, "busy-unknown": 409, "no-pid": 409, "still-up": 409, "not-installed": 404, "no-model": 400, "unknown-action": 400 };

      try {
        const config = await localHostConfig();
        if (!config) return json(res, 503, { ok: false, code: "no-host", error: "the local-model-host plugin is not installed or is disabled" });
        const mod = await loadLocalHost();
        let result;

        if (action === "load") {
          const status = await mod.serverStatus(config);
          const model = mod.matchModel(status.models, wanted);
          if (!model) {
            return json(res, 404, { ok: false, code: "not-installed", error: `no GGUF file matches "${wanted}"`, available: status.models.map((entry) => entry.alias) });
          }
          if (status.up || status.loading) {
            const same = status.loaded === model.alias;
            // A server's `-c` is fixed at launch, so a new window only takes effect by
            // stopping and starting it. `reload` is that one click: the window in Settings
            // changed, and the model is already loaded at the old one.
            if (same && body.reload === true) {
              const stopped = await mod.stopServer({ config, force: false });
              if (!stopped.ok) {
                return json(res, 409, {
                  ok: false,
                  code: stopped.code ?? "busy",
                  error: stopped.error ?? `could not stop ${model.alias} to reload it`,
                  loaded: status.loaded,
                });
              }
              result = await mod.startModel({ config, model });
              return json(res, result.ok ? 200 : 500, {
                ok: result.ok,
                code: result.ok ? "reloaded" : result.code,
                message: result.ok ? `reloaded ${model.alias} at ${config.planContext ?? "the planned" } tokens` : null,
                error: result.error ?? null,
                model: result.model ?? model.alias,
                previous: null,
                pid: result.pid ?? null,
                tail: result.tail ?? null,
              });
            }
            return json(res, same ? 200 : 409, {
              ok: same,
              code: same ? "already-loaded" : "another-loaded",
              error: same ? null : `${status.loaded ?? "another model"} is already loaded - switch to ${model.alias} to swap it`,
              loaded: status.loaded,
            });
          }
          result = await mod.startModel({ config, model });
        } else if (action === "unload") {
          result = await mod.stopServer({ config, force });
        } else if (action === "switch") {
          result = await mod.switchModel({ config, target: wanted, force });
        } else {
          return json(res, 400, { ok: false, code: "unknown-action", error: `unknown action "${action}" - use load, unload or switch` });
        }

        log(`ui: local ${action} ${wanted || "(current)"} -> ${result.code}${result.error ? `: ${result.error}` : ""}`);
        const status = result.ok ? 200 : statusOf[result.code] ?? 500;
        return json(res, status, {
          ok: result.ok,
          code: result.code,
          message: result.ok ? null : result.error,
          error: result.error ?? null,
          model: result.model ?? null,
          previous: result.previous ?? null,
          pid: result.pid ?? null,
          tail: result.tail ?? null,
        });
      } catch (err) {
        log(`ui: local ${action} failed: ${err?.stack ?? err}`);
        return json(res, 500, { ok: false, error: String(err?.message ?? err) });
      }
    }

    if (path === "/api/prefs") {
      const saved = readPrefs(prefsPath);
      const answer = (prefs) => ({
        contextWindow: prefs.contextWindow ?? contextWindow,
        contextWindowSaved: prefs.contextWindow !== null,
        contextWindowDefault: contextWindow,
        contextWindowChoices: CONTEXT_WINDOW_CHOICES,
        maxSteps: prefs.maxSteps ?? defaultMaxSteps,
        maxStepsSaved: prefs.maxSteps !== null,
        maxStepsDefault: defaultMaxSteps,
        maxStepsChoices: MAX_STEPS_CHOICES,
        maxMinutes: prefs.maxMinutes ?? defaultMaxMinutes,
        maxMinutesSaved: prefs.maxMinutes !== null,
        maxMinutesDefault: defaultMaxMinutes,
        maxMinutesChoices: MAX_MINUTES_CHOICES,
        accessMode: prefs.accessMode ?? UI_DEFAULT_ACCESS,
        accessChoices: ACCESS_CHOICES,
        toolLoading: prefs.toolLoading ?? UI_DEFAULT_TOOL_LOADING,
        toolLoadingChoices: TOOL_LOADING_CHOICES,
        queueMode: prefs.queueMode ?? UI_DEFAULT_QUEUE,
        queueChoices: QUEUE_CHOICES,
        setup: prefs.setup ?? null,
        sandbox: prefs.sandbox === true,
        sandboxSupport: sandboxSupport(),
        desktop: prefs.desktop === true,
        desktopSupport: process.platform === "win32",
        sharing: currentSharing(),
        sharingChoices: SHARING_CHOICES,
        sharingOptional: SHARING_IS_OPTIONAL,
        // False until the person answers the welcome screen's question (or picks in Account).
        sharingChosen: prefs.sharing !== null,
        installId: telemetry?.install?.id ?? null,
        profile: prefs.profile,
        appearance: prefs.appearance,
        show: prefs.show,
        notify: prefs.notify,
        generation: prefs.generation,
        generationLimits: { maxTokensMin: MAX_TOKENS_MIN, maxTokensMax: MAX_TOKENS_MAX, maxTokensChoices: MAX_TOKENS_CHOICES, temperatureMax: TEMPERATURE_MAX, maxTokensDefault: 4096 },
        choices: { accents: ACCENTS, textSizes: TEXT_SIZES, densities: DENSITIES, themes: UI_THEMES, palettes: PALETTES },
        collapsed: prefs.collapsed,
        pinned: prefs.pinned ?? [],
      });
      if (req.method === "GET") return json(res, 200, answer(saved));
      if (req.method !== "PUT" && req.method !== "POST") return json(res, 405, { error: `no route for ${req.method} /api/prefs` });
      if (req.headers["x-rosalena-token"] !== token) return json(res, 403, { error: "bad token" });
      try {
        const patch = await readBody(req, 64 * 1024);
        const next = updatePrefs(saved, patch);
        writePrefs(prefsPath, next);
        // A new Context window applies to the chats that are running too, at their next
        // step, not only to the next message (never above what a local server is loaded with).
        if (patch && typeof patch === "object" && "contextWindow" in patch) {
          const wanted = next.contextWindow ?? contextWindow;
          for (const chat of chats.values()) {
            if (chat.status !== "running") continue;
            chat.liveWindow = runContextWindow(wanted, chat.servedWindow);
            broadcastTo(chat, { type: "notice", from: ["context"], text: `Context window changed to ${chat.liveWindow.toLocaleString()} tokens: this chat uses it from its next step.` });
          }
        }
        return json(res, 200, answer(next));
      } catch (err) {
        return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
      }
    }

    if (path === "/api/folders") {
      // The sidebar in one request: the folders, the chats inside each, and whether the
      // file had to be repaired - a corrupt `folders.json` costs the organisation, never
      // the chats, and the page should say which of those happened.
      const folders = readFolders(folderFile);
      const sessions = sidebarSessions();

      if (req.method === "GET") {
        return json(res, 200, { groups: groupSessions(folders, sessions), repaired: Boolean(folders.repaired), file: folderFile });
      }

      if (req.headers["x-rosalena-token"] !== token) return json(res, 403, { error: "bad token" });
      const body = req.method === "DELETE" ? {} : await readBody(req);

      try {
        const name = String(body.name ?? "").trim();
        let result;
        if (req.method === "POST") result = createFolder(folders, name);
        else if (req.method === "PATCH") result = renameFolder(folders, String(body.id ?? ""), name);
        else if (req.method === "DELETE") result = deleteFolder(folders, String(url.searchParams.get("id") ?? ""));
        else return json(res, 405, { error: `no route for ${req.method} /api/folders` });
        writeFolders(folderFile, result.state);
        log(`ui: folders ${req.method} ok (${result.state.folders.length} folder(s))`);
        return json(res, 200, { groups: groupSessions(result.state, sessions), folder: result.folder ?? null });
      } catch (err) {
        // `FolderError` carries the status the answer should use; anything else is a bug
        // worth a 500 rather than a silently empty sidebar.
        return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
      }
    }

    if (path === "/api/folders/move" && req.method === "POST") {
      if (req.headers["x-rosalena-token"] !== token) return json(res, 403, { error: "bad token" });
      const body = await readBody(req);
      const runId = String(body.id ?? "").trim();
      const folders = readFolders(folderFile);
      // Only a chat this server can see may be filed: an id from a stale page would
      // otherwise store an assignment nothing ever renders.
      if (!runStatus({ dir: runRoot, id: runId })) return json(res, 404, { error: `no chat "${runId}"` });
      try {
        const { state } = moveRun(folders, runId, body.folderId ?? null);
        writeFolders(folderFile, state);
        log(`ui: folder move ${runId} -> ${String(body.folderId ?? "ungrouped")}`);
        return json(res, 200, { groups: groupSessions(state, sidebarSessions()) });
      } catch (err) {
        return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
      }
    }

    if (path === "/api/sessions") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 40) || 40, 200);
      // `limit` is conversations, but the store lists runs: every follow-up turn and every
      // subagent is a run of its own, so reading only `limit` runs let one busy chat push
      // the others (yours included) off the list. Read several runs per conversation, then
      // keep `limit` conversations below.
      const rows = listRuns({ dir: runRoot, limit: Math.min(limit * 6, 1200) }).map((run) => ({
        kind: "rosalena",
        source: "rosalena",
        id: run.id,
        title: run.task || "(no task)",
        at: run.startedAt ?? null,
        status: run.status,
        steps: run.steps ?? null,
        ms: run.ms ?? null,
        // The graph and the flat list read the same rows: a panel that shows a tree must
        // not need a second request for the link it already has.
        parent: run.parent ?? null,
        depth: Number.isFinite(run.depth) ? run.depth : 0,
        cls: run.cls ?? null,
        model: run.model ?? null,
      }));
      // One row per conversation: `id` is its first run, `latest` the turn to continue.
      const collapsed = collapseThreads(rows, readThreads(threadFile), { titleOf: rootTitle });
      // Pinned chats are always listed, however long ago they last moved.
      const pinned = new Set(readPrefs(prefsPath).pinned ?? []);
      const tops = new Set(collapsed.filter((row) => !(row.depth > 0)).slice(0, limit).map((row) => row.id));
      for (const row of collapsed) if (pinned.has(row.id)) tops.add(row.id);
      // The folder each chat works in, for "Group by workspace" in the sidebar: the folder
      // picked for the chat, else the one its run recorded.
      const picked = readChatWorkspaces();
      const rootOf = (id) => {
        if (runRootCache.has(id)) return runRootCache.get(id);
        const found = readRun({ dir: runRoot, id, maxEvents: 0 })?.record?.root ?? null;
        if (found) runRootCache.set(id, found);
        return found;
      };
      const runs = collapsed
        .filter((row) => tops.has(row.id) || (row.depth > 0 && tops.has(row.parent)))
        .map((row) => (row.depth > 0 ? row : { ...row, workspace: picked[row.id] ?? rootOf(row.id) ?? workspace }));
      const external = await listExternalSessions({ max: limit });
      return json(res, 200, {
        chats: runs,
        external: external.sessions.map((s) => ({
          kind: "external",
          source: s.source,
          id: s.id,
          title: s.title,
          at: s.at ? new Date(s.at).toISOString() : null,
          project: s.project ?? null,
        })),
        notes: external.notes,
      });
    }

    if (path === "/api/session") {
      const source = url.searchParams.get("source");
      const id = url.searchParams.get("id");
      const full = url.searchParams.get("full") === "1";
      const session = await readExternalSession({ source, id, max: 400, full });
      if (!session) return json(res, 404, { error: `no ${source} session "${id}"` });
      return json(res, 200, session);
    }

    if (path === "/api/chat/workspace" && req.method === "PUT") {
      if (req.headers["x-rosalena-token"] !== token) return json(res, 403, { error: "bad token" });
      const body = await readBody(req);
      const chatId = String(body.chat ?? "").trim();
      if (!chatId) return json(res, 400, { error: "chat is required" });
      const folder = existingDir(body.path);
      if (!folder) return json(res, 400, { error: `not a folder: ${body.path ?? ""}` });
      setChatWorkspace(chatId, folder);
      log(`ui: chat ${threadRootOf(chatId)} now works in ${folder}`);
      return json(res, 200, { ok: true, chat: threadRootOf(chatId), workspace: folder });
    }

    if (path === "/api/chat" && req.method === "GET") {
      const id = url.searchParams.get("id");
      if (!id) return json(res, 400, { error: "id is required" });
      // `thread=1` is the window's view: every turn of the conversation `id` belongs to,
      // oldest first, with the newest turn's status and id (the one a follow-up continues).
      if (url.searchParams.get("thread") === "1") {
        const map = readThreads(threadFile);
        const root = rootOf(map, id);
        const turns = threadMembers(map, root)
          .map((member) => chats.get(member) ?? historicChat(member, home))
          .filter(Boolean);
        if (!turns.length) return json(res, 404, { error: `no chat "${id}"` });
        const first = turns[0];
        const last = turns[turns.length - 1];
        // `events=0`: status only (the page's background queue check every few seconds).
        if (url.searchParams.get("events") === "0") {
          return json(res, 200, { id: last.id, thread: root, task: first.task, model: last.model, status: last.status });
        }
        return json(res, 200, {
          id: last.id,
          thread: root,
          turns: turns.map((t) => t.id),
          branchOf: readBranches(branchesFile(home))[root] ?? null,
          task: first.task,
          model: last.model,
          role: last.role ?? null,
          status: last.status,
          answer: last.answer,
          error: last.error,
          historic: Boolean(last.historic),
          events: turns.flatMap((t) => t.events),
          workspace: chatWorkspace(root),
          // A goal chat whose goal is still open: its next message carries on the goal.
          goal: wantsGoal({ parentId: last.id }, ""),
        });
      }
      const chat = chats.get(id) ?? historicChat(id, home);
      if (!chat) return json(res, 404, { error: `no chat "${id}"` });
      return json(res, 200, {
        id: chat.id,
        task: chat.task,
        model: chat.model,
        role: chat.role ?? null,
        status: chat.status,
        answer: chat.answer,
        error: chat.error,
        historic: Boolean(chat.historic),
        events: chat.events,
      });
    }

    // What the conversation costs, in the shape the gauge needs and nothing more:
    // `{ window, used, percent, parts: { system, tools, messages } }`, plus the two
    // extras the page shows rather than computes (`source`, `threshold`).
    //
    // A live chat answers from the last `ui/context` the loop emitted. A chat whose
    // process is gone answers from the record that run wrote. A chat that never ran
    // (an id that is not in the store) is a 404, not zeros: a meter that silently
    // reads 0% for a mistyped id is a lie the page cannot detect.
    if (path === "/api/context") {
      const id = url.searchParams.get("id");
      if (!id) return json(res, 400, { error: "id is required" });
      const live = chats.get(id);
      const chat = live ?? historicChat(id, home);
      if (!chat) return json(res, 404, { error: `no chat "${id}"` });
      const meter = chat.context ?? null;
      if (!meter) {
        // Nothing measured yet: the run exists and has not taken its first step. Say so
        // rather than inventing a window the provider never named.
        return json(res, 200, { window: null, used: 0, percent: 0, parts: { system: 0, tools: 0, messages: 0 }, measured: false });
      }
      // A chat that is not running is measured against the window its NEXT message will
      // get, so a change of the setting shows on the gauge at once instead of after a send.
      // With no window chosen in the slider, the record's own figures stand as they were.
      let window = meter.window;
      let threshold = meter.threshold ?? null;
      const chosen = readPrefs(prefsPath).contextWindow;
      if (chat.status !== "running" && chosen != null) {
        const wanted = runContextWindow(chosen, chat.servedWindow ?? null);
        if (wanted && wanted !== window) {
          if (threshold && window) threshold = Math.round((threshold / window) * wanted);
          window = wanted;
        }
      }
      return json(res, 200, {
        window,
        used: meter.used,
        percent: window ? Math.round((Number(meter.used) / window) * 100) : meter.percent,
        parts: {
          system: meter.parts?.system ?? 0,
          tools: meter.parts?.tools ?? 0,
          messages: meter.parts?.messages ?? 0,
        },
        // Not required by the contract, but the page would otherwise have to guess
        // whether the messages row came from the provider or from the estimator.
        source: meter.source ?? "estimate",
        threshold,
        measured: true,
      });
    }

    // The sidebar's plugin list: every UI plugin (bundled and installed by Creator mode),
    // with the versions Creator mode kept for the ones it installed, plus drafts and the
    // plugins that were removed but can still be rolled back in.
    // Settings' "Reviewer on every step": the advisor plugin's mode (plugins/rosa-advisor).
    if (path === "/api/advisor" && (req.method === "GET" || req.method === "PUT")) {
      const host = await loadPluginsOnce();
      const entry = host?.plugins.find((p) => p.id === "rosa-advisor");
      if (!entry) return json(res, 200, { available: false, mode: "off" });
      const mod = await import("../plugins/rosa-advisor/plugin.mjs");
      if (req.method === "PUT") {
        if (req.headers["x-rosalena-token"] !== token) return json(res, 403, { error: "bad token" });
        const body = await readBody(req);
        if (!mod.MODES.includes(body.mode)) return json(res, 400, { error: `mode must be one of ${mod.MODES.join(", ")}` });
        await host.commands.get("rosa-advisor:mode")([body.mode]);
        log(`ui: advisor mode -> ${body.mode}`);
      }
      return json(res, 200, { available: true, mode: mod.readMode(entry.config?.mode) });
    }

    // Settings > Your browser: SolBrowser (plugins/rosa-solbrowser). GET says what ships and
    // whether the extension folder is ready; POST setup copies the extension to a stable
    // folder and opens it; POST check asks the server whether the browser is connected.
    if (path === "/api/solbrowser" || path === "/api/solbrowser/setup" || path === "/api/solbrowser/check") {
      const host = await loadPluginsOnce();
      const entry = host?.plugins.find((p) => p.id === "rosa-solbrowser");
      if (!entry) return json(res, 200, { available: false });
      const mod = await import("../plugins/rosa-solbrowser/plugin.mjs");
      const src = mod.source();
      const folder = mod.extensionHome(home);
      const base = { available: true, version: src?.version ?? null, commit: src?.commit?.slice(0, 7) ?? null, folder, prepared: existsSync(join(folder, "manifest.json")) };
      if (path === "/api/solbrowser" && req.method === "GET") return json(res, 200, base);
      if (req.method !== "POST") return json(res, 405, { error: `no route for ${req.method} ${path}` });
      if (req.headers["x-rosalena-token"] !== token) return json(res, 403, { error: "bad token" });
      if (path === "/api/solbrowser/setup") {
        const out = mod.prepareExtension({ home });
        await revealInFileManager({ path: out.folder, workspace: home }).catch(() => {});
        log(`ui: SolBrowser extension copied to ${out.folder}`);
        return json(res, 200, { ...base, prepared: true, steps: out.steps });
      }
      const text = await mod.call("status", {});
      return json(res, 200, { ...base, connected: !/^error:|not connected|NO_EXTENSION/i.test(text), text: text.slice(0, 600) });
    }

    // The composer's Commits menu: commit-cadence's mode for this server's workspace, the
    // same setting `/plugin rosa-commit-cadence:mode` writes. Unavailable when the plugin is off.
    if (path === "/api/commit-mode" && (req.method === "GET" || req.method === "PUT")) {
      const host = await loadPluginsOnce();
      const entry = host?.plugins.find((p) => p.id === "rosa-commit-cadence");
      if (!entry) return json(res, 200, { available: false });
      const mod = await import("../plugins/rosa-commit-cadence/plugin.mjs");
      const fallback = mod.MODES.includes(entry.config?.mode) ? entry.config.mode : mod.DEFAULT_MODE;
      // The chat's own folder (the page sends it): the run reads the mode from the folder it
      // works in, so a menu that wrote the app's default folder changed nothing for the chat.
      const folder = existingDir(url.searchParams.get("workspace") ?? "") || workspace;
      if (req.method === "PUT") {
        if (req.headers["x-rosalena-token"] !== token) return json(res, 403, { error: "bad token" });
        const body = await readBody(req);
        if (!mod.MODES.includes(body.mode)) return json(res, 400, { error: `mode must be one of ${mod.MODES.join(", ")}` });
        mod.writeMode(folder, body.mode);
        log(`ui: commit mode for ${folder} -> ${body.mode}`);
      }
      return json(res, 200, { available: true, folder, ...mod.commitStatus(folder, fallback) });
    }

    // The plugin manager. GET lists both kinds: sidebar pages (ui-plugins.mjs, switched by
    // Creator's switches) and tool plugins (agent code: tools, hooks, commands, switched in
    // plugin-switches.json). POST (token) is { action, id?, folder?, trust? }.
    // Core features that did not load (a broken update, a missing file): the page says so
    // once at start instead of a feature silently vanishing.
    if (path === "/api/plugins/core" && req.method === "GET") {
      await loadPluginsOnce();
      return json(res, 200, { core: [...coreIds()], problems: coreProblems });
    }

    if (path === "/api/plugins/manage" && req.method === "GET") {
      const host = await loadPluginsOnce();
      const loaded = new Map((host?.plugins ?? []).map((p) => [p.id, p]));
      const failures = new Map();
      for (const e of host?.errors ?? []) failures.set(e.id, [...(failures.get(e.id) ?? []), e.reason]);
      const off = new Set(host?.disabled ?? []);
      const manifests = listPluginManifests([
        { dir: pluginRoot(), source: "bundled" },
        { dir: userToolDir, source: "user" },
      ]);
      const tools = manifests
        .filter((m) => m.error || m.hasCode)
        .map((m) => {
          const live = loaded.get(m.id);
          return {
            id: m.id,
            version: m.version ?? null,
            description: live?.description || m.description || "",
            source: m.source,
            core: Boolean(m.core),
            enabled: !off.has(m.id) && !m.error,
            loaded: Boolean(live),
            status: live?.status ?? null,
            tools: live?.tools ?? [],
            hooks: live?.hooks ?? [],
            commands: live?.commands ?? [],
            problems: [...(m.error ? [m.error] : []), ...(failures.get(m.id) ?? [])],
          };
        });
      const core = coreIds();
      const pages = uiPlugins().map((p) => ({ ...publicView(p), core: core.has(p.id), history: p.source === "user" ? creator.history(p.id).length : 0 }));
      return json(res, 200, {
        ok: true,
        coreProblems,
        tools,
        pages,
        drafts: creator.listDrafts(),
        folders: { tools: userToolDir, pages: userPluginsDir(home) },
      });
    }

    if (path === "/api/plugins/manage" && req.method === "POST") {
      if (req.headers["x-rosalena-token"] !== token) return json(res, 403, { error: "bad token" });
      const body = await readBody(req);
      const action = String(body.action ?? "");
      const id = String(body.id ?? "");
      try {
        // A built-in feature can be switched off (the page asks first), never removed: it
        // ships with the app, and switching it back on must always be possible.
        if (coreIds().has(id) && (action === "tool-remove" || action === "page-remove")) {
          return json(res, 409, { ok: false, error: `${id} ships with Rosalena, so it can be switched off but not removed` });
        }
        if (action === "tool-on" || action === "tool-off") {
          const known = listPluginManifests([{ dir: pluginRoot(), source: "bundled" }, { dir: userToolDir, source: "user" }]).some((m) => m.id === id);
          if (!known) return json(res, 404, { ok: false, error: `no tool plugin "${id}"` });
          writeToolSwitch(id, action === "tool-on");
          await reloadPlugins();
          log(`ui: tool plugin ${id} switched ${action === "tool-on" ? "on" : "off"}`);
          return json(res, 200, { ok: true });
        }
        if (action === "page-on" || action === "page-off") return json(res, 200, { ok: true, ...creator.setEnabled(id, action === "page-on") });
        if (action === "page-remove") return json(res, 200, { ok: true, ...creator.remove(id) });
        if (action === "tool-remove") {
          // Only what the person added, and moved aside rather than deleted: an undo is a move back.
          const folder = join(userToolDir, id);
          if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id) || !existsSync(join(folder, "plugin.json"))) return json(res, 404, { ok: false, error: `"${id}" is not a tool plugin you added` });
          const kept = join(home, "tool-plugins-removed", `${id}-${Date.now()}`);
          mkdirSync(dirname(kept), { recursive: true });
          renameSync(folder, kept);
          await reloadPlugins();
          log(`ui: tool plugin ${id} removed (kept in ${kept})`);
          return json(res, 200, { ok: true, keptIn: kept });
        }
        if (action === "import") return json(res, 200, await importPlugin(String(body.folder ?? ""), { trust: body.trust === true }));
        return json(res, 400, { ok: false, error: `unknown action "${action}"`, actions: ["tool-on", "tool-off", "tool-remove", "page-on", "page-off", "page-remove", "import"] });
      } catch (err) {
        return json(res, 409, { ok: false, error: String(err?.message ?? err) });
      }
    }

    if (path === "/api/plugins/ui" && req.method === "GET") {
      const list = uiPlugins();
      const installed = new Set(list.filter((p) => p.source === "user").map((p) => p.id));
      const removed = [];
      try {
        for (const entry of existsSync(creator.paths.history) ? readdirSync(creator.paths.history, { withFileTypes: true }) : []) {
          if (entry.isDirectory() && !installed.has(entry.name)) {
            const kept = creator.history(entry.name);
            if (kept.length) removed.push({ id: entry.name, history: kept.map((h) => ({ stamp: h.stamp, version: h.version })) });
          }
        }
      } catch (err) {
        log(`ui: could not read plugin history: ${err?.message ?? err}`);
      }
      return json(res, 200, {
        plugins: list.map((p) => ({
          ...publicView(p),
          history: p.source === "user" ? creator.history(p.id).map((h) => ({ stamp: h.stamp, version: h.version, keptAt: h.keptAt, reason: h.reason })) : [],
        })),
        drafts: creator.listDrafts(),
        removed,
      });
    }

    // What the person can do to a plugin from its page: verify it again, switch it off or
    // on, roll it back, remove it (kept in history). Bundled plugins can be verified and
    // switched off; the rest only applies to what Creator mode installed.
    if (path === "/api/plugins/ui/action" && req.method === "POST") {
      if (req.headers["x-rosalena-token"] !== token) return json(res, 403, { error: "bad token" });
      const body = await readBody(req);
      const id = String(body.id ?? "");
      const action = String(body.action ?? "");
      try {
        if (coreIds().has(id) && action === "remove") {
          return json(res, 409, { error: `${id} ships with Rosalena, so it can be switched off but not removed` });
        }
        if (action === "enable" || action === "disable") return json(res, 200, creator.setEnabled(id, action === "enable"));
        if (action === "rollback") return json(res, 200, creator.rollback(id, { to: body.to ? String(body.to) : null }));
        if (action === "remove") return json(res, 200, creator.remove(id));
        if (action === "verify") {
          const plugin = uiPlugins().find((p) => p.id === id);
          if (!plugin) return json(res, 404, { error: `no plugin "${id}"` });
          const { verifyPlugin } = await import("./plugin-verify.mjs");
          const report = await verifyPlugin(plugin.folder, { reportDir: creator.paths.reports });
          return json(res, 200, { ok: report.ok, text: describeReport(report), report });
        }
        return json(res, 400, { error: `unknown action "${action}"`, actions: ["verify", "enable", "disable", "rollback", "remove"] });
      } catch (err) {
        return json(res, 409, { error: String(err?.message ?? err) });
      }
    }

    // The composer's MCP button (mcp-panel.mjs): the registered MCP servers with a switch
    // each, a check, add/remove, and an import of the servers Claude Code already has.
    if (path === "/api/mcp" && (req.method === "GET" || req.method === "POST")) {
      const host = await loadPluginsOnce();
      const pluginEntry = host?.plugins.find((p) => p.id === "rosa-mcp-manager") ?? null;
      let pluginConfig = {};
      try {
        pluginConfig = readHarnessConfig()?.plugins?.["rosa-mcp-manager"]?.config ?? {};
      } catch {
        /* a broken harness.config.json: the plugin's own defaults */
      }
      const files = mcpFiles(pluginConfig);
      const folder = existingDir(url.searchParams.get("workspace") ?? "") || workspace;
      const answer = () => {
        const servers = listMcpServers(files);
        const known = new Set(servers.map((s) => s.name));
        return {
          // The tools that reach these servers come from the mcp-manager plugin: with it
          // off, a switch here changes nothing a model can use.
          available: Boolean(pluginEntry),
          registry: files.registry,
          servers,
          claudeCode: claudeCodeServers({ workspace: folder }).map(({ spec: _spec, ...row }) => ({ ...row, added: known.has(row.name) })),
        };
      };
      if (req.method === "GET") return json(res, 200, answer());
      if (req.headers["x-rosalena-token"] !== token) return json(res, 403, { error: "bad token" });
      const body = await readBody(req, 64 * 1024);
      const name = String(body.name ?? "").trim();
      try {
        if (body.action === "toggle") {
          setMcpEnabled(files, name, body.enabled === true);
          log(`ui: MCP server ${name} ${body.enabled === true ? "on" : "off"}`);
        } else if (body.action === "probe") {
          const result = await probeMcpServer(files, name, { timeoutMs: Number(pluginConfig.timeoutMs) || 20000, log });
          return json(res, 200, { ...answer(), probe: { name, ...result } });
        } else if (body.action === "add") {
          const parts = String(body.command ?? "").match(/"[^"]*"|\S+/g)?.map((p) => p.replace(/^"(.*)"$/, "$1")) ?? [];
          addMcpServer(files, { name, command: parts[0], args: parts.slice(1), cwd: body.cwd ? String(body.cwd) : null });
          log(`ui: MCP server ${name} added`);
        } else if (body.action === "remove") {
          removeMcpServer(files, name);
          log(`ui: MCP server ${name} removed`);
        } else if (body.action === "import") {
          const result = importClaudeCodeServers(files, Array.isArray(body.names) ? body.names : [name], { workspace: folder });
          log(`ui: MCP import from Claude Code: ${result.added.length} added`);
          return json(res, 200, { ...answer(), imported: result });
        } else {
          return json(res, 400, { error: `unknown action "${body.action}"` });
        }
        return json(res, 200, answer());
      } catch (err) {
        return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
      }
    }

    // Steer: a message for the run that is going, taken in at its next step boundary
    // instead of waiting in the queue until the run ends (the queue's Steer button).
    if (path === "/api/steer" && req.method === "POST") {
      if (req.headers["x-rosalena-token"] !== token) return json(res, 403, { error: "bad token" });
      const body = await readBody(req, 256 * 1024);
      const text = String(body.text ?? "").trim();
      if (!text) return json(res, 400, { error: "text is required" });
      const chat = chats.get(String(body.id ?? ""));
      if (!chat || chat.status !== "running") return json(res, 409, { error: "that chat is not running; send it as a normal message" });
      // Claude Code runs as its own program and cannot take a message mid-run: refused here
      // rather than accepted and silently dropped.
      if (isClaudeCodeModel(chat.model)) return json(res, 409, { error: "Claude Code chats take your next message when this one finishes; keep it in the queue" });
      if (isCodexModel(chat.model)) return json(res, 409, { error: "Codex chats take your next message when this one finishes; keep it in the queue" });
      chat.steer.push(text.slice(0, 20_000));
      broadcastTo(chat, { type: "steer_queued", text: text.slice(0, 20_000) });
      return json(res, 200, { ok: true, waiting: chat.steer.length });
    }

    if (path === "/api/chat" && req.method === "POST") {
      if (req.headers["x-rosalena-token"] !== token) return json(res, 403, { error: "bad token" });
      const body = await readBody(req);
      const task = String(body.task ?? "").trim();
      if (!task) return json(res, 400, { error: "task is required" });
      // A role is resolved here rather than in the page, so the addendum the model sees
      // is the one in `data\roles.json` right now, not whatever a stale tab loaded. An
      // unknown name is a 400: silently falling back to the default would answer with a
      // different assistant than the one the user selected.
      const roleId = String(body.role ?? "").trim();
      let role = null;
      if (roleId) {
        const menu = await loadMenu();
        role = menu.roles.find((r) => r.id === roleId) ?? null;
        if (!role) {
          return json(res, 400, {
            error: `no role "${roleId}"`,
            roles: menu.roles.map((r) => r.id),
          });
        }
      }
      // Built before the chat, not during it: a run that starts while the host is still
      // loading would silently go out with no plugin tools.
      await loadPluginsOnce();
      // Reasoning effort, when the page sent one. Only the router decides whether the
      // provider that ends up answering can honour it (it drops the field otherwise),
      // but a value outside the vocabulary is refused here so a typo is a 400 rather
      // than a preference that quietly does nothing.
      const effort = String(body.effort ?? "").trim();
      if (effort && !["low", "medium", "high", "xhigh", "max"].includes(effort)) {
        return json(res, 400, { error: `unknown effort "${effort}"`, efforts: ["low", "medium", "high", "xhigh", "max"] });
      }
      // And the model is chosen before the first token, not during the run: a load takes up
      // to three minutes, and a run that started first would either fail or answer with
      // whatever model happened to be resident.
      const model = String(body.model ?? "").trim() || role?.id || "orchestrate";
      const ready = await ensureLocalReady(model);
      if (!ready.ok) {
        return json(res, 409, { error: ready.error, code: ready.code, local: ready.status ?? null });
      }
      // OmniRoute installed but not running (after a restart): start it, inside Rosalena and
      // without a window, rather than let the first message fail over to another model.
      if (model.toLowerCase().startsWith("omniroute/") && omniManager.installed() && !(await omnirouteRunning())) {
        const started = await omniManager.start();
        if (!started.ok) return json(res, 409, { error: started.error, code: started.code });
        menuCache.clear();
      }
      // Creator mode is a role addendum on top of whatever role answers: the same model and
      // the same tools, told to build a sidebar plugin through the creator_* tools and the
      // plugin-builder skill. The gate itself is in creator.mjs, not in this sentence.
      if (body.creator === true) {
        role = {
          ...(role ?? {}),
          name: role?.name ?? "",
          addendum: [role?.addendum, CREATOR_ADDENDUM].filter(Boolean).join("\n\n"),
        };
      }
      // The folder this run works in: the one sent for a new chat, else the conversation's.
      let chatFolder = workspace;
      if (typeof body.workspace === "string" && body.workspace.trim()) {
        chatFolder = existingDir(body.workspace);
        if (!chatFolder) return json(res, 400, { error: `not a folder: ${body.workspace}` });
      } else if (typeof body.parentId === "string" && body.parentId) {
        chatFolder = chatWorkspace(body.parentId);
      }
      // What this chat is actually measured against. A local model is answered by the
      // llama-server on :8080, whose `-c` is the real ceiling, so the server is asked
      // before the run starts (context.mjs, runContextWindow). The run-first ensure above
      // already reloaded the server at this setting when it could, so when the two still
      // disagree it is for one of three reasons, each said to the person: the server is
      // generating (the reload waits for the next message), the card does not fit the
      // setting, or another program started the server. A silently lower number looks
      // exactly like a broken setting, which is what "it is stuck at 32k even when I
      // change it in the UI" was (2026-11-07).
      const wantedWindow = effectiveWindow();
      const servedLocal = await localServedWindow(model);
      const windowNotice =
        servedLocal?.ctx && wantedWindow > servedLocal.ctx
          ? `This chat is using ${servedLocal.ctx.toLocaleString()} tokens, not the ${wantedWindow.toLocaleString()} set in Settings: the local server on ${servedLocal.baseUrl ?? ":8080"} is loaded with -c ${servedLocal.ctx.toLocaleString()}. ` +
            (ready.contextStale
              ? "It is generating right now, so it could not be reloaded at your setting yet; it reloads itself at the next message once it is idle."
              : servedLocal.ours
                ? `It could not be reloaded at your setting because the card only fits ${servedLocal.ctx.toLocaleString()} tokens with its current settings; this chat runs at that, and it reloads itself at the next message if the card fits your setting by then.`
                : "Another launcher started that server, so it has to be restarted from there; D:\\llama.cpp\\start-qwen.ps1 loads it at -c 131072.")
          : null;
      const chat = startChat({
        task,
        // A role's id is also a router class, so "role only" keeps working exactly as
        // the old dropdown did; an explicit model overrides it for this chat. An empty
        // model is the page's "Role default" option, not a model called "".
        model,        role,
        parentId: body.parentId ?? null,
        // Ultracode lifts effort to xhigh unless max was asked for (the router still drops it for a model that cannot take it).
        effort: body.ultracode === true && effort !== "max" ? "xhigh" : effort,
        ultracode: body.ultracode === true,
        attachments: Array.isArray(body.attachments) ? body.attachments : [],
        workspace: chatFolder,
        home,
        routerUrl,
        // For a local model: the preference, but never more than the server really has.
        contextWindow: runContextWindow(wantedWindow, servedLocal?.ctx ?? null),
        contextNotice: windowNotice,
        maxSteps: effectiveMaxSteps(),
        maxTokens: readPrefs(prefsPath).generation?.maxTokens ?? null,
        temperature: readPrefs(prefsPath).generation?.temperature ?? null,
        accessMode: ACCESS_CHOICES.includes(body.accessMode) ? body.accessMode : readPrefs(prefsPath).accessMode ?? UI_DEFAULT_ACCESS,
        toolLoading: readPrefs(prefsPath).toolLoading ?? UI_DEFAULT_TOOL_LOADING,
        sandbox: readPrefs(prefsPath).sandbox === true,
        desktop: readPrefs(prefsPath).desktop === true,
        planMode: body.plan === true,
        goal: wantsGoal(body, task),
        servedWindow: servedLocal?.ctx ?? null,
        maxWallMs: effectiveMaxMinutes() > 0 ? effectiveMaxMinutes() * 60_000 : Infinity,
        log,
        extraTools: plugins.tools,
        extraHooks: plugins.hooks,
        telemetry,
      });
      // A follow-up joins its conversation, so the sidebar keeps showing one chat. Only a
      // run this server knows can be continued; a stale id still runs, as a new chat.
      let thread = chat.id;
      const parentId = typeof body.parentId === "string" ? body.parentId : "";
      // A branch (Branch on any of your messages) continues from that point but is a new
      // conversation: it is not linked into the old thread, so both stay readable as they
      // were. Where it came from is kept for the title.
      const branch = body.branch && typeof body.branch === "object" ? { from: String(body.branch.from ?? ""), at: String(body.branch.at ?? "") } : null;
      if (branch?.from) {
        try {
          recordBranch(branchesFile(home), chat.id, { ...branch, parent: parentId || null });
        } catch (err) {
          log(`ui: could not record ${chat.id} as a branch of ${branch.from}: ${err?.message ?? err}`);
        }
      } else if (parentId && (chats.has(parentId) || runStatus({ dir: runRoot, id: parentId }))) {
        try {
          thread = linkRun(threadFile, chat.id, parentId);
        } catch (err) {
          log(`ui: could not record ${chat.id} as a follow-up of ${parentId}: ${err?.message ?? err}`);
        }
      }
      try {
        if (chatFolder !== workspace || readChatWorkspaces()[threadRootOf(thread)]) setChatWorkspace(thread, chatFolder);
      } catch (err) {
        log(`ui: could not record the folder of ${thread}: ${err?.message ?? err}`);
      }
      log(`ui: chat ${chat.id} started (${chat.model}${chat.role ? `, role ${chat.role}` : ""})${thread !== chat.id ? ` in ${thread}` : ""}`);
      return json(res, 200, { id: chat.id, thread, model: chat.model, role: chat.role, workspace: chatFolder, goal: chat.goal === true, ...(branch?.from ? { branchOf: branch } : {}) });
    }

    // Stopping a chat is the same request the CLI and the MCP tool make: a flag in the
    // store that the run's own loop honours at its next step. It deliberately cannot be
    // a `kill` â€” the server does not own every run it can list, and a killed process
    // leaves a record that says nothing.
    // "This answer was bad" (or good), from the button under an answer. It goes to the site
    // with the rest of the tracking. The person's note travels at "usage" too, because they
    // wrote it to be sent; the task and the answer only travel at "full", cloud models only.
    if (path === "/api/feedback" && req.method === "POST") {
      if (req.headers["x-rosalena-token"] !== token) return json(res, 403, { error: "bad token" });
      const body = await readBody(req, 64 * 1024);
      const id = String(body.id ?? "");
      const chat = chats.get(id) ?? historicChat(id, home);
      if (!chat) return json(res, 404, { error: "no chat with that id" });
      const rating = body.rating === "good" ? "good" : "bad";
      const sharing = currentSharing();
      const sent = telemetry ? telemetry.feedback({ chat, rating, note: String(body.note ?? "").slice(0, 1000) }) : false;
      if (sent) void telemetry.flush();
      return json(res, 200, { ok: true, sent: Boolean(sent), sharing });
    }

    if (path === "/api/approve" && req.method === "POST") {
      if (req.headers["x-rosalena-token"] !== token) return json(res, 403, { error: "bad token" });
      const body = await readBody(req);
      const chat = chats.get(String(body.id ?? ""));
      const resolveApproval = chat?.approvals.get(String(body.approval ?? ""));
      if (!resolveApproval) return json(res, 404, { error: "no approval is waiting with that id (already answered, or the chat ended)" });
      const decision = ["allow", "always", "deny"].includes(body.decision) ? body.decision : "deny";
      const note = String(body.note ?? "").slice(0, 2000);
      chat.approvals.delete(String(body.approval));
      resolveApproval({ decision, note });
      for (const send of chat.subscribers) {
        try {
          send({ type: "approval_done", id: String(body.approval), decision });
        } catch {
          /* a dead subscriber is removed by its own close handler */
        }
      }
      chat.events.push({ type: "approval_done", id: String(body.approval), decision });
      return json(res, 200, { ok: true, decision });
    }

    if (path === "/api/undo") {
      const id = String(url.searchParams.get("id") ?? "").trim();
      if (req.method === "GET") {
        if (!id) return json(res, 400, { error: "id is required" });
        return json(res, 200, listChanges(id));
      }
      if (req.method !== "POST") return json(res, 405, { error: `no route for ${req.method} /api/undo` });
      if (req.headers["x-rosalena-token"] !== token) return json(res, 403, { error: "bad token" });
      const body = await readBody(req);
      const runId = String(body.id ?? "").trim();
      const step = Number(body.step);
      if (!runId || !Number.isInteger(step) || step < 1) return json(res, 400, { error: "id and a step number are required" });
      if (chats.get(runId)?.status === "running") return json(res, 409, { error: "that chat is still running; stop it first" });
      const outcome = undoFrom(runId, step);
      log(`ui: undo ${runId} from step ${step}: ${outcome.restored.length} restored, ${outcome.removed.length} removed`);
      return json(res, 200, outcome);
    }

    // ------------------------------------------------------------ session rail
    //
    // The rail's server half (session-rail.mjs): the chat's folder, its git branch, and
    // the lines the chat added and removed, counted from the undo journals of every run in
    // it (each turn and the subagents it started). Read on demand when the page sees a
    // file change in the stream; nothing here is cached or polled. Behind the token: it
    // names files on this disk.
    if (path === "/api/session-rail") {
      if (req.headers["x-rosalena-token"] !== token) return json(res, 403, { error: "bad token" });
      const id = String(url.searchParams.get("id") ?? "").trim();
      const runIds = [];
      let thread = null;
      if (id) {
        const map = readThreads(threadFile);
        thread = rootOf(map, id);
        for (const member of threadMembers(map, thread)) {
          runIds.push(member);
          const live = chats.get(member);
          let subs = live ? null : railSubRuns.get(member);
          if (!subs) {
            const chat = live ?? historicChat(member, home);
            subs = (chat?.events ?? []).filter((e) => e?.type === "run" && e.sub && e.id).map((e) => String(e.id));
            if (chat && chat.status !== "running") railSubRuns.set(member, subs);
          }
          runIds.push(...subs);
        }
      }
      const folder = (thread ? chatWorkspace(thread) : null) || existingDir(url.searchParams.get("workspace")) || workspace;
      return json(res, 200, { thread, workspace: folder, branch: gitBranch(folder), changes: chatChanges({ runIds }) });
    }

    // ------------------------------------------------------------ Settings pages
    //
    // Skills (switch one off: the `skill` tool and skill-autoload stop offering it),
    // Templates (the person's own slash-command files), Providers (local servers and
    // whether anything listens there, cloud keys, sign-ins) and Permissions (the approval
    // rules permissions.mjs reads on every tool call). Every write needs the token.

    if (path === "/api/skills") {
      const answer = () => {
        const dirs = skillDirs();
        const off = readSkillsOff(skillsOffPath);
        return {
          file: skillsOffPath,
          // Where a new skill goes: the first of the person's own folders.
          addTo: dirs.find((dir) => dir !== BUNDLED_SKILLS) ?? null,
          folders: dirs.map((dir) => ({ path: dir, exists: existsSync(dir), bundled: dir === BUNDLED_SKILLS })),
          skills: listSkills(dirs, { includeOff: true, off }).map((skill) => ({
            name: skill.name,
            description: skill.description,
            enabled: skill.enabled,
            file: skill.file,
            folder: dirname(skill.file),
            source: skillSource(skill.root, { bundled: BUNDLED_SKILLS, home: userHome }),
            bundled: skill.root === BUNDLED_SKILLS,
          })),
        };
      };
      if (req.method === "GET") return json(res, 200, answer());
      if (req.method !== "PUT") return json(res, 405, { error: `no route for ${req.method} /api/skills` });
      if (req.headers["x-rosalena-token"] !== token) return json(res, 403, { error: "bad token" });
      try {
        const body = await readBody(req, 16 * 1024);
        setSkillEnabled(skillsOffPath, body.name, body.enabled);
        log(`ui: skill ${body.name} switched ${body.enabled ? "on" : "off"}`);
        return json(res, 200, answer());
      } catch (err) {
        return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
      }
    }

    if (path === "/api/templates") {
      const dir = templatesDir(userHome);
      const sameDir = (a, b) => String(a).replace(/[\\/]+$/, "").toLowerCase() === String(b).replace(/[\\/]+$/, "").toLowerCase();
      const answer = () => ({
        dir,
        templates: loadCommands(workspace, { home: userHome })
          .filter((command) => !command.action)
          .map((command) => ({
            name: command.name,
            description: command.description ?? "",
            body: command.template ?? "",
            mode: command.goal ? "goal" : command.plan ? "plan" : "",
            needsArgs: Boolean(command.needsArgs),
            source: command.source,
            // Only the files in the Templates folder are edited here; the built-ins and the
            // files other tools own (Claude Code's, OpenCode's, the project's) are read-only.
            editable: command.source !== "built-in" && sameDir(dirname(command.source), dir),
          })),
      });
      if (req.method === "GET") return json(res, 200, answer());
      if (req.headers["x-rosalena-token"] !== token) return json(res, 403, { error: "bad token" });
      try {
        if (req.method === "POST" || req.method === "PUT") {
          const body = await readBody(req, 64 * 1024);
          const saved = saveTemplate(dir, { name: body.name, description: body.description, mode: body.mode ?? "", body: body.body });
          // A rename: the old file goes once the new one is written.
          const previous = String(body.previous ?? "").trim().toLowerCase();
          if (previous && previous !== saved.name) deleteTemplate(dir, previous);
          log(`ui: template /${saved.name} saved`);
          return json(res, 200, { ...answer(), saved: saved.name });
        }
        if (req.method === "DELETE") {
          const name = url.searchParams.get("name") ?? "";
          const removed = deleteTemplate(dir, name);
          if (!removed) return json(res, 404, { error: `no template /${name} in ${dir}` });
          log(`ui: template /${name} deleted`);
          return json(res, 200, answer());
        }
        return json(res, 405, { error: `no route for ${req.method} /api/templates` });
      } catch (err) {
        return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
      }
    }

    if (path === "/api/providers" && req.method === "GET") {
      const adminBase = String(routerUrl).replace(/\/+$/, "").replace(/\/v1$/i, "");
      const headers = process.env.ROSALENA_ROUTER_TOKEN ? { "x-rosalena-token": process.env.ROSALENA_ROUTER_TOKEN } : {};
      // Asking Claude Code runs two short commands; started first so it overlaps the probes.
      // `?fresh=1` (Settings' Check again) skips the 5-minute cache.
      const fresh = url.searchParams.get("fresh") === "1";
      const claudeAsk = claudeCodeStatus({ fresh }).catch(() => null);
      const codexAsk = codexStatus({ fresh }).catch(() => null);
      let status = null;
      try {
        const res2 = await fetch(`${adminBase}/admin/status`, { headers, signal: AbortSignal.timeout(3000) });
        status = res2.ok ? await res2.json() : null;
      } catch {
        status = null;
      }
      // The live list when the router answers; its config file when it does not, so the page
      // can still name the addresses (and say the router itself is down).
      let providers = status?.providers ?? null;
      let source = status ? "router" : null;
      if (!providers) {
        const harnessDir = fileURLToPath(new URL("..", import.meta.url));
        const disk = [readRouterConfig(workspace), readRouterConfig(harnessDir)].find((found) => found.config);
        providers = disk?.config?.providers ?? {};
        source = disk?.file ?? null;
      }
      const local = await Promise.all(
        localServerRows(providers).map(async (row) => ({ ...row, ...(await probeListening(row.baseUrl, { timeoutMs: 700 })) })),
      );
      const [claude, codex] = await Promise.all([claudeAsk, codexAsk]);
      return json(res, 200, {
        router: { up: Boolean(status), url: adminBase, source },
        local,
        cloud: cloudProviderRows(providers),
        subscriptions: [
          {
            id: "claude-code",
            label: "Claude Code",
            what: "Your own Claude Code sign-in (a Claude plan) answers inside Rosalena.",
            found: Boolean(claude?.found),
            version: claude?.version ?? null,
            loggedIn: Boolean(claude?.loggedIn),
            authMethod: claude?.authMethod ?? null,
            pick: 'Pick "Claude Code (your sign-in)" in the model list.',
            setup: "Install Claude Code and sign in once (run claude in a terminal), then press Check again.",
            signIn: "run claude in a terminal once and sign in.",
          },
          {
            id: "codex",
            label: "Codex",
            what: "Your own Codex CLI sign-in (a ChatGPT plan: Plus, Pro, Business) answers inside Rosalena.",
            found: Boolean(codex?.found),
            version: codex?.version ?? null,
            loggedIn: Boolean(codex?.loggedIn),
            authMethod: codex?.authMethod ?? null,
            pick: 'Pick a row under "Codex · your ChatGPT plan" in the model list.',
            setup: "How to set it up: install it with npm install -g @openai/codex, then run codex login in a terminal (it opens a ChatGPT sign-in), then press Check again.",
            signIn: "run codex login in a terminal and sign in with ChatGPT.",
          },
        ],
      });
    }

    if (path === "/api/permissions") {
      const answer = () => {
        const saved = readPermissionRules(permissionsPath);
        return {
          file: permissionsPath,
          rules: saved.rules,
          broken: saved.broken,
          actions: ["allow", "ask", "deny"],
          // The rules that ship with the app, checked after the person's own (read-only here).
          builtIn: DEFAULT_RULES.map(({ tool, pattern, action, why }) => ({ tool: tool ?? "*", pattern, action, why: why ?? "" })),
        };
      };
      if (req.method === "GET") return json(res, 200, answer());
      if (req.method !== "PUT") return json(res, 405, { error: `no route for ${req.method} /api/permissions` });
      if (req.headers["x-rosalena-token"] !== token) return json(res, 403, { error: "bad token" });
      try {
        const body = await readBody(req, 64 * 1024);
        writePermissionRules(permissionsPath, body.rules);
        log(`ui: ${Array.isArray(body.rules) ? body.rules.length : 0} approval rule(s) saved`);
        return json(res, 200, answer());
      } catch (err) {
        return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
      }
    }

    if (path === "/api/commands") {
      return json(res, 200, {
        commands: loadCommands(workspace, { home: userHome }).map(({ name, description, template, plan, goal, action, needsArgs, source }) => ({
          name,
          description,
          template: template ?? "",
          plan: Boolean(plan),
          goal: Boolean(goal),
          action: action ?? null,
          needsArgs: Boolean(needsArgs),
          source,
        })),
      });
    }

    if (path === "/api/cancel" && req.method === "POST") {
      if (req.headers["x-rosalena-token"] !== token) return json(res, 403, { error: "bad token" });
      const body = await readBody(req);
      const id = String(body.id ?? "").trim();
      if (!id) return json(res, 400, { error: "id is required" });
      // `runRoot`, not `runsDir()`: the server's store is derived from its own `home`
      // (the CLI and the tests pass one), not from whatever the environment says.
      const out = requestCancel({ dir: runRoot, id });
      // A mission's later rounds are runs of their own: stop the one in flight too.
      const round = chats.get(id)?.roundId;
      if (round && round !== id) requestCancel({ dir: runRoot, id: round });
      const waiting = chats.get(id)?.approvals;
      if (waiting) {
        for (const [approvalId, resolveApproval] of waiting) {
          resolveApproval({ decision: "deny", note: "the chat was stopped" });
          waiting.delete(approvalId);
        }
      }
      log(`ui: cancel ${out.ok ? "requested" : "refused"} for ${id} (${out.reason})`);
      // 409 carries the reason in `error` too: the page shows whatever it is told, and
      // "already finished; nothing to cancel" is a normal answer to a Stop click.
      return json(res, out.ok ? 200 : 409, out.ok ? out : { ...out, error: out.reason });
    }

    if (path === "/api/stream") {
      const id = url.searchParams.get("id");
      const live = chats.get(id);
      const chat = live ?? historicChat(id, home);
      if (!chat) return json(res, 404, { error: `no chat "${id}"` });

      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      const send = (event) => {
        if (res.writableEnded) return;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      // Replay first, then follow. A reconnect therefore repairs itself instead of
      // leaving a hole in the transcript.
      for (const event of chat.events) send(event);
      if (chat.status !== "running" || chat.historic) {
        send({ type: "ui/end", status: chat.status, answer: chat.answer ?? null, error: chat.error ?? null });
        return res.end();
      }
      const ping = setInterval(() => {
        if (!res.writableEnded) res.write(": ping\n\n");
      }, 15000);
      chat.subscribers.add(send);
      const done = () => {
        clearInterval(ping);
        chat.subscribers.delete(send);
      };
      req.on("close", done);
      res.on("error", done);
      return undefined;
    }

    // The Terminal tab. A shell is the whole machine, so it answers only a caller on this
    // machine (never a paired phone through the tunnel), and every call carries the token.
    if (path.startsWith("/api/terminal")) {
      if (!remote.isLocal(req)) return json(res, 403, { error: "the terminal is only available on the machine running the app" });
      if (path === "/api/terminal/stream" && req.method === "GET") {
        // EventSource cannot send headers, so the stream checks the token in the query.
        if (url.searchParams.get("token") !== token) return json(res, 403, { error: "bad token" });
        const id = url.searchParams.get("id");
        if (!terminals.get(id)) return json(res, 404, { error: `no terminal "${id}"` });
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
        const send = (event) => {
          if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
        };
        const stop = terminals.subscribe(id, send);
        const ping = setInterval(() => !res.writableEnded && res.write(": ping\n\n"), 15000);
        const done = () => {
          clearInterval(ping);
          stop?.();
        };
        req.on("close", done);
        res.on("error", done);
        return undefined;
      }
      if (req.headers["x-rosalena-token"] !== token) return json(res, 403, { error: "bad token" });
      try {
        if (path === "/api/terminal" && req.method === "GET") return json(res, 200, { terminals: terminals.list(), shells: SHELLS, workspace });
        const body = req.method === "POST" ? await readBody(req, 128 * 1024) : {};
        if (path === "/api/terminal/open" && req.method === "POST") return json(res, 200, terminals.open({ shell: body.shell, cwd: body.cwd || (body.chat ? chatWorkspace(body.chat) : ""), tag: body.tag ?? null }));
        if (path === "/api/terminal/tag" && req.method === "POST") return json(res, 200, { ok: terminals.retag(body.id, body.tag) });
        if (path === "/api/terminal/input" && req.method === "POST") return json(res, 200, { ok: terminals.write(body.id, body.data) });
        if (path === "/api/terminal/close" && req.method === "POST") return json(res, 200, { ok: terminals.close(body.id) });
      } catch (err) {
        return json(res, 400, { error: String(err?.message ?? err) });
      }
      return json(res, 404, { error: `no route for ${req.method} ${path}` });
    }

    // Remote access. `status` and `unpair` answer a paired phone; the three controls
    // that change the machine answer only a caller on this machine, because the tunnel
    // one phone is looking at is the tunnel every other phone is using.
    if (path.startsWith("/api/remote/")) {
      const action = path.slice("/api/remote/".length);

      // Pairing, from the blocking page's form (urlencoded `code=`) or a script ({ code }).
      // It reaches here past the gate on purpose: the device has no cookie yet.
      if (action === "pair" && req.method === "POST") {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 4096) return json(res, 413, { error: "request body too large" });
          chunks.push(chunk);
        }
        const raw = Buffer.concat(chunks).toString("utf8");
        const asJson = String(req.headers["content-type"] ?? "").includes("json");
        let code = "";
        try {
          code = asJson ? String(JSON.parse(raw || "{}").code ?? "") : new URLSearchParams(raw).get("code") ?? "";
        } catch {
          code = "";
        }
        const out = remote.pair(req, code);
        if (out.status === 303) {
          if (asJson) {
            if (out.headers["set-cookie"]) res.setHeader("set-cookie", out.headers["set-cookie"]);
            return json(res, 200, { ok: true, paired: true });
          }
          res.writeHead(303, out.headers);
          return res.end();
        }
        if (out.html && !asJson) {
          res.writeHead(out.status, { ...(out.headers ?? {}), "content-type": MIME[".html"], "cache-control": "no-store" });
          return res.end(out.html);
        }
        if (out.headers?.["retry-after"]) res.setHeader("retry-after", out.headers["retry-after"]);
        return json(res, out.status, { ok: false, error: out.error });
      }

      const view = remote.statusFor(req);
      if (action === "status" && req.method === "GET") return json(res, 200, { remote: view });

      // Forgetting this device: the cookie goes, the token stays valid for everyone
      // else. Safe for a phone to call about itself, which is why it is not gated on
      // `canControl`.
      if (action === "unpair" && req.method === "POST") {
        remote.unpair(req, res);
        return json(res, 200, { ok: true, remote: remote.statusFor(req) });
      }

      if (!view.canControl) {
        return json(res, 403, { error: "a paired phone may not start, stop or re-key the tunnel; do it on the machine running the app" });
      }
      if (req.headers["x-rosalena-token"] !== token) return json(res, 403, { error: "bad token" });

      if (action === "enable" && req.method === "POST") {
        const started = remote.enable();
        log(`ui: remote access ${started.state} (${started.reason})`);
        return json(res, 200, { ok: started.state !== "failed", remote: remote.statusFor(req) });
      }
      if (action === "disable" && req.method === "POST") {
        const stopped = await remote.disable();
        log(`ui: remote access ${stopped.state} (${stopped.reason})`);
        return json(res, 200, { ok: true, remote: remote.statusFor(req) });
      }
      // "New QR code": a new pairing code; devices already paired stay paired.
      if (action === "revoke" && req.method === "POST") {
        const out = remote.revoke();
        log("ui: phone access has a new pairing code; links shared before now no longer pair a device");
        return json(res, 200, { ok: out.ok, remote: remote.statusFor(req) });
      }
      // "Unpair all": every device, the pairing code and the stable phone link are replaced.
      if (action === "unpair-all" && req.method === "POST") {
        const out = await remote.unpairAll();
        return json(res, 200, { ok: true, removed: out.removed, remote: remote.statusFor(req) });
      }
      if (action === "devices/remove" && req.method === "POST") {
        const body = await readBody(req, 4 * 1024).catch(() => ({}));
        const out = remote.removeDevice(body?.id);
        return json(res, out.ok ? 200 : 404, { ok: out.ok, error: out.ok ? null : "no paired device with that id", remote: remote.statusFor(req) });
      }
      if (action === "settings" && req.method === "POST") {
        let body;
        try {
          body = await readBody(req, 16 * 1024);
        } catch (err) {
          return json(res, 400, { ok: false, error: String(err?.message ?? err) });
        }
        try {
          await remote.updateSettings(body ?? {});
        } catch (err) {
          return json(res, 400, { ok: false, error: String(err?.message ?? err), remote: remote.statusFor(req) });
        }
        return json(res, 200, { ok: true, remote: remote.statusFor(req) });
      }
      // The only check that proves the tunnel is reachable rather than merely named:
      // it asks the public URL for this app's own status, through Cloudflare.
      if (action === "check" && req.method === "POST") {
        const out = await remote.check();
        return json(res, 200, { ok: out.ok, check: out, remote: remote.statusFor(req) });
      }
      return json(res, 404, { error: `no route for ${req.method} ${path}` });
    }

    return json(res, 404, { error: `no route for ${req.method} ${path}` });
  }

  const ready = () =>
    new Promise((resolveReady, rejectReady) => {
      server.once("error", rejectReady);
      server.listen(port, host, () => {
        state.port = server.address().port;
        // The app starts OmniRoute as its own windowless child when it is installed and the
        // person left "Start with Rosalena" on. In the background: a slow start must not
        // hold up the window, and one already running outside is left alone.
        if (manageOmniRoute && omniManager.prefs().autostart && omniManager.installed()) {
          void omniManager.start().then((out) => {
            if (!out.ok && out.code !== "external") log(`ui: OmniRoute did not start: ${out.error}`);
            menuCache.clear();
          });
        }
        if (manageLocalModels) {
          idleTimer = setInterval(() => void idleTick(), 30_000);
          idleTimer.unref?.();
        }
        // "Keep phone access on": the tunnel comes back with the app (it registers with the
        // relay again once live, so the phone's link is the same one as yesterday).
        if (autoRemote) remote.autoStart();
        resolveReady(state);
      });
    });

  return {
    server,
    ready,
    state,
    remote,
    telemetry,
    loadPlugins: loadPluginsOnce,
    // A one-time `/?code=` for opening this server in a real browser (null without pageKey).
    issuePageCode,
    // The app is quitting (not a workspace switch, which also closes this server): stop the
    // local model this server's harness loaded, if "Unload when Rosalena closes" is on.
    shutdownLocal: async () => {
      clearInterval(idleTimer);
      // A ComfyUI this app started ends with it either way (it is a child in the app's job
      // object); stopping it here just does it before the window closes.
      for (const runner of allComfyRunners()) if (runner.ours()) await runner.stop();
      const config = await localHostConfig();
      if (!config) return { ok: true, code: "no-host" };
      const mod = await loadLocalHost();
      return mod.unloadOnQuit({ config, log });
    },
    close: async () => {
      clearInterval(idleTimer);
      // Whatever is still queued gets one short chance to go out; the outbox file keeps
      // it for the next launch if the site is slow.
      if (telemetry) {
        if (messageSink) releaseMessageSink(messageSink);
        await Promise.race([telemetry.flush().catch(() => null), new Promise((done) => setTimeout(done, 2000).unref?.())]);
      }
      // OmniRoute goes with the server unless the person asked it to keep running. A manager
      // handed in belongs to the caller (the desktop app keeps one across workspace switches
      // and stops it on quit), so only one built here is shut down here.
      if (!omniManagerOption) await omniManager.shutdown().catch((err) => log(`ui: OmniRoute shutdown: ${err?.message ?? err}`));
      terminals.closeAll();
      // The tunnel points at this server's port, so it goes with the server. The switch is
      // remembered: a workspace switch starts the next server, and autoStart brings it back.
      await remote.shutdown().catch((err) => log(`ui: phone access shutdown: ${err?.message ?? err}`));
      await new Promise((done) => server.close(done));
    },
  };
}

/** `rosalena --ui [port]` lands here. */
export async function serveUi({ port = DEFAULT_PORT, host = "127.0.0.1", routerUrl = DEFAULT_ROUTER, workspace, home, bridge = true, out = console.log } = {}) {
  const ui = createUiServer({
    port,
    host,
    routerUrl,
    workspace: workspace ? resolve(workspace) : process.cwd(),
    home,
    log: (m) => out(m),
    telemetry: true,
    manageLocalModels: true,
    autoRemote: true,
  });
  const state = await ui.ready();
  const url = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${state.port}/`;
  out(`Rosalena UI on ${url}`);
  out(`  workspace : ${state.workspace}`);
  out(`  runs      : ${runsDir(join(state.home, "runs"))}`);
  out(`  router    : ${state.routerUrl}`);
  const router = await routerModels(routerUrl);
  out(router.up ? `  models    : ${router.models.map((m) => m.id).join(", ")}` : `  router down: ${router.error}`);
  // Built here rather than at the first chat, so the banner is true and the first
  // message does not pay for discovering eleven plugin folders.
  const pluginHost = await ui.loadPlugins();
  if (pluginHost) {
    out(`  plugins   : ${pluginHost.plugins.length} loaded, ${pluginHost.tools.length} tools, ${pluginHost.hooks.length} hooks`);
    for (const failure of pluginHost.errors) out(`    ${failure.id}: FAILED: ${failure.reason}`);
    if (pluginHost.plugins.some((p) => p.id === "rosa-local-model-monitor")) out(`  monitor   : ${url}monitor`);
  } else {
    out("  plugins   : could not be loaded (see the log above)");
  }
  // The site's demo answers from this machine, so the page needs a door into the app.
  // The bridge is that door: loopback only, an origin allowlist, and a pairing token that
  // rides in the URL's fragment. A second instance cannot take the fixed port, and says
  // so rather than failing to start - the first one is already answering.
  if (bridge) {
    try {
      const { createBridge, pairingUrl } = await import("./bridge.mjs");
      const door = createBridge({
        home: state.home,
        routerUrl,
        routerHeaders: typeof routerAuthHeaders === "function" ? routerAuthHeaders() : {},
        log: (line) => out(`  ${line.replace(/^bridge: /, "bridge    : ")}`),
      });
      const settled = await door.ready();
      ui.bridge = door;
      out(`  bridge    : ${settled.url} (answers the site's try-it page)`);
      out(`  pair link : ${pairingUrl(door.token)}`);
    } catch (err) {
      out(`  bridge    : not started (${err?.message ?? err})`);
    }
  }
  out("Ctrl+C to stop.");
  return ui;
}
