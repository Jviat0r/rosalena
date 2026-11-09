# Interop: driving Rosalena Harness from another harness

The goal: another agent host â€” Claude Code Desktop, Cursor, DSH, or anything that
speaks MCP â€” should be able to **read files and sessions, start tasks, and spawn
subagents** in Rosalena Harness, within permissions you grant.

Three of those halves exist today: a run store another process can poll, a read-only
reader for the other harnesses' own session stores, and a local HTTP surface (the visual
UI) that starts and streams runs. Starting runs *over MCP*, and per-token permissions,
are specified here but not built.

| Capability | State |
|---|---|
| MCP stdio server, `initialize` / `tools/list` / `tools/call` | **works, verified** â€” Â§1 |
| Read a workspace through MCP (`read_file`, `list_dir`, `search`) | **works, verified** â€” Â§1 |
| Opt-in `write_file` / `run_command` through MCP | **works** (plugin config, off by default) â€” Â§1 |
| Persistent runs with ids, readable while running and after | **built** â€” Â§2 |
| MCP tools over that store (`list_runs`, `run_status`, `read_run`) | **built, verified over stdio** â€” Â§2.4 |
| `cancel_run` (`--cancel <id>` and MCP), honoured across processes | **built, verified** â€” Â§2.5 |
| MCP `run_task` / `spawn_subagent` | **built, opt-in** (`allowTasks`) â€” Â§2.4 |
| Reading the other harnesses' sessions (Claude Code, opencode, DSH) | **built**, read-only â€” Â§3 |
| Visual UI + its HTTP API (start a run, stream it, list sessions) | **built** â€” Â§4 |
| `list_plugins` (module inventory over MCP) | **built, verified over stdio** — §2.6 |
| Per-token budgets | not built — §2.6 |
| Shared secret on the router (`/v1/*`, `/admin/status`) | **built, verified live** — §5 |
| Per-token auth and scopes | not built — §5 |

## 1. Today: read a workspace over MCP

The harness ships an MCP server plugin that serves its own tool registry on stdio.
stdout carries the protocol; every diagnostic goes to stderr, so a client can pipe
both without corrupting JSON-RPC.

**Claude Code Desktop / Claude Code CLI** â€” add to `.mcp.json` in the project that
should be allowed to read (or to `~/.claude.json` for every project):

```json
{
  "mcpServers": {
    "rosalena": {
      "command": "node",
      "args": [
        "D:\\AppDev\\Rosalena Harness\\harness\\src\\cli.mjs",
        "--plugin",
        "rosa-mcp-server:serve"
      ]
    }
  }
}
```

The equivalent one-liner:

```powershell
claude mcp add-json rosalena '{"command":"node","args":["D:\\AppDev\\Rosalena Harness\\harness\\src\\cli.mjs","--plugin","rosa-mcp-server:serve"]}'
```

The server's workspace is the **client's working directory**: start the command in the
folder you want exposed.

Verified transcript (three requests in, three replies out):

```
{"jsonrpc":"2.0","id":1,"method":"initialize", ...}
  -> {"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},
       "serverInfo":{"name":"rosalena-harness","version":"0.1.0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
  -> read_file, list_dir, search
{"jsonrpc":"2.0","id":3,"method":"tools/call",
 "params":{"name":"read_file","arguments":{"path":"numbers.txt"}}}
  -> {"result":{"content":[{"type":"text","text":"7\n5\n9\n"}]}}
```

### Widening what the client may do

The exposed tool list is an **allow-list** and defaults to `read_file`, `list_dir`,
`search`. Add to `harness\harness.config.json` (next to `package.json`):

```json
{
  "plugins": {
    "rosa-mcp-server": {
      "config": { "tools": ["read_file", "list_dir", "search", "write_file", "run_command"] }
    }
  }
}
```

**`run_command` is a real shell, not a sandboxed one.** The harness's path checks are
not a security boundary â€” an MCP client that can call `run_command` can do anything
your user can do, from any directory, via `cmd /c` or a script. Keep it off unless the
client is trusted and the machine is disposable.

## 2. Today: the run store

Every run the harness executes â€” interactive, one-shot, subagent, or started from the
UI â€” writes the same three files, so any other process can watch it:

```
<ROSALENA_HOME>\runs\<runId>.jsonl    one line per event, append-only
<ROSALENA_HOME>\runs\<runId>.json     final record (task, status, ok, steps, tools, ms, answer, error)
<ROSALENA_HOME>\runs\index.jsonl      one summary line per finished run
```

`runId` = `r-<yyyymmdd-hhmmss>-<4 hex>`. The record is written **last**, so a `.jsonl`
with no matching `.json` means the run has not finished â€” that is how "running" is
detected without a lock or a status call. An empty `index.jsonl` is normal on a fresh
install.

Two guards keep that from becoming a lie:

- **A killed process closes its own record.** `runAgent` installs an `exit` hook (plus
  SIGINT/SIGTERM) that writes `{status:"failed", stopped:"killed", error:"the process
  ended before the run finished"}` and removes itself the moment the run finishes
  normally, so a long-lived host (the UI server) does not accumulate handlers.
- **A log that stops growing is `stale`.** If no record arrives and the `.jsonl` has not
  been touched for `ROSALENA_RUN_STALE_MS` (default 30 minutes), the run is reported as
  status `stale` with `running:false` and `idleMs`. Both were written for a real orphan
  in `data\runs` that had claimed "running" for three days.

Reading it from a script (`harness\src\runs.mjs`):

```js
import { listRuns, readRun, runStatus } from "./src/runs.mjs";
listRuns({ limit: 20 });            // newest first: id, task, status, steps, ms
readRun({ id: "r-20261020-000251-8743" });   // { record, events, truncated }
runStatus({ id: "r-2026..." });     // { status, ok, running, steps, tools, lastEvent, answer }
```

From the shell (`node src\cli.mjs â€¦`):

```
--runs [n]              the last n runs (default 20): status, steps, time, task
--run <id>              one run's status, progress, last tool/event and answer (prefix ok)
--run-events <id>       its event log, one JSON object per line
--run-record <id>       its final record (the embedded events are omitted)
--run-id <id>           use this id for the run being started (a spawner picks it)
--parent-run-id <id>    record this run as a child of another one
--runs-dir <path>       where the runs live (default: <ROSALENA_HOME>/runs)
--no-runs               do not record this run at all
--json                  with --runs or --run: machine-readable output
```

The reason `--run-id` exists: a spawner must know the id **before** the run ends to
poll it. Every rule below assumes that.

### Event shapes a poller will see

`run` (id, depth, cls, parent, root, task) Â· `assistant` (step, target, content,
toolCalls, streamed, ttftMs, ms) Â· `delta` (streamed text) Â· `tool` (step, name, args,
ok, ms, preview) Â· `retry` / `retry_ok` Â· `judge` / `fix` Â· `goal_*` Â· `context_cache` Â·
`compact*` Â· `notice` Â· `watchdog` Â· `error` Â· `stopped` (reason) Â· `run_end`.

A subagent is a **separate run** with `parentRunId` set, not merged into its parent, so
one poller can follow the tree.

### 2.4 Built: the MCP tools over this store

| Tool | Arguments | Returns |
|---|---|---|
| `list_runs` | `limit?`, `status?` | one line per run: id, status, steps, time, task |
| `run_status` | `id` (prefix ok) | JSON: `{status, ok, running, stale, idleMs, steps, tools, answer, error, lastEvent}` |
| `read_run` | `id`, `limit?` | JSON: `{record, events}` â€” the run's own log |
| `cancel_run` | `id` (prefix ok) | `{ok, reason}` â€” asks the run to stop at its next step |
| `run_task` | `task`, `model?` | `{runId, status:"running"}` â€” returns immediately (opt-in) |
| `spawn_subagent` | `task`, `model?`, `parentRunId?`, `wait?` | `{runId}` or, with `wait`, the finished status (opt-in) |

Inspection is on **by default** and is read-only; a client that can start work but not see
what happened is worse than one that cannot start work. Starting work is opt-in, because
it spends tokens and GPU time:

```json
{ "plugins": { "rosa-mcp-server": { "config": { "allowTasks": true } } } }
```

A configured `tools` list widens or narrows the *file* tools only â€” it never removes run
inspection (pass `allowRuns: false` if you really want the file surface alone).

Verified over real stdio (`node src\cli.mjs --plugin rosa-mcp-server:serve`, four requests in,
four replies out, stdout carrying only JSON):

```
tools/list   -> read_file, list_dir, search, list_runs, run_status, read_run, cancel_run,
                list_plugins
list_runs    -> r-20261020-000251-8743 ok       1  89686ms   Reply with exactly: harness online
                r-20261019-234209-35a8 ok       1  111535ms  Reply with exactly the single word: pong
                r-20261019-234320-95c2 stale    0  -         (the process died before its record)
run_status r-20261019-234320
             -> {"status":"stale","running":false,"stale":true,"idleMs":8918528,...}
list_plugins -> 10 module(s) in ...\harness\plugins   (id, version, bundled/installed,
                tools, commands, hooks, disabled, load errors)
```

Two rules the implementation keeps:

- **`run_task` returns an id, not an outcome.** An agent host that blocks for minutes on a
  tool call loses its own turn; `spawn_subagent` takes `wait: true` when the caller really
  does want to block.
- **A tool failure is a result** (`isError: true` with text), so the caller's model can read
  it and recover. `no such run: <id>` is a normal result, not a protocol error.

### 2.5 Cancellation is a shared file, not a signal

A run may be owned by a process the canceller does not control â€” the UI starts one, a
shell starts another, a parent harness delegates to a third. `process.kill` would need the
owner's permission to exist, and on Windows it would happily kill a process in the middle
of a write. So `cancel_run` (and `--cancel <id>`) writes `<runId>.cancel` into the run
store and the **run's own loop checks it at every step boundary**:

```
--cancel <id>  ->  r-...-95c2 will stop at its next step
                   the loop emits {"type":"stopped","reason":"cancelled"}
                   the record closes {status:"stopped", stopped:"cancelled", ok:false}
```

Three behaviours that make it trustworthy:

- **The flag is a request.** The run stops where it is safe to stop (a step boundary) and
  keeps its last assistant text as `answer`. Nothing is killed, nothing is torn.
- **Finished is not failed.** Cancelling an already-finished run returns
  `{ok:false, reason:"â€¦ already finished; nothing to cancel"}` â€” an answer, not an error.
- **A stale run is refused.** No process is left to read the flag, so `cancel_run` on a
  run whose log stopped growing says so instead of promising a stop.

Proven across processes in `test/runs.test.mjs`: a child process runs a 200-step loop, the
parent plants the flag, the child exits with `stopped: "cancelled"` and a closed record.

### 2.6 Not built

`list_plugins` shipped after all: the MCP server reaches the registry the same way the CLI
does, by loading the plugin directory through the shared loader (`loadPlugins`) with the
install's real override layer, and reports each module's id, version, origin
(`bundled` / `installed`), the tools, commands and hooks it adds, what is disabled, and
anything that failed to load. It loads rather than guessing from manifests because "which
tools does this module add" is the useful half of the answer, and a plugin's import is
contractually free of side effects. Still unbuilt: per-token budgets for `spawn_subagent`
(Â§5), and a canceller that interrupts an in-flight provider call (cancellation is honoured
between steps, which is bounded by `--step-timeout`).

### Design rules this surface must keep

- **stdout is protocol.** Logs, progress and streamed prose go to stderr; a stray
  `console.log` breaks the client's parser.
- **A tool failure is a result, not a protocol error** (`isError: true` with text), so
  the caller's model can read the failure and recover.
- **Runs outlive the connection.** A run started over MCP keeps going if the client
  disconnects, and its events stay readable from `runs\`.
- **The harness decides.** A spawned subagent is a normal delegated session with the
  same watchdog, context and plugin rules as an interactive one â€” interop adds a
  doorway, not a second execution path.

## 3. Today (read-only): the other harnesses' sessions

Rosalena reads the conversations the other tools on this machine already recorded, so
one sidebar can hold all of them. It never writes into those stores â€” they belong to
other products, they change shape between versions, and a harness that edits a
competitor's data is a harness nobody should install.

```
--ext-sessions              what is on this machine, one line per session
--ext-session <src:id>      one session, as text
```

| Source | Where | Shape |
|---|---|---|
| `claude` | `~\.claude\projects\<project>\<session>.jsonl` | JSONL: `custom-title` / `ai-title` / `user` / `assistant` |
| `codex` | `~\.codex\sessions\**\rollout-*.jsonl` | JSONL: `session_meta`, `event_msg`, `response_item` |
| `opencode` | `~\.local\share\opencode\opencode.db` | SQLite; v1 `session`/`message`/`part`, v2 `session_v2`/`session_message` |
| `dsh` | `~\.dsh\sessions\<project>\<session>\session.v4.jsonl.zstd` | a **chain of independent zstd frames**, one per write |

Each root can be redirected for tests or a moved install:
`ROSALENA_CLAUDE_DIR`, `ROSALENA_CODEX_DIR`, `ROSALENA_OPENCODE_DB`, `ROSALENA_DSH_DIR`.

Three facts learned from those files, kept here because they are the whole difficulty:

1. **A DSH log is not one zstd stream.** Appending writes a new independent frame, so
   decompressing from the file start yields frame 0 only â€” a header and a title, zero
   messages. The reader scans for the frame magic (`28 b5 2f fd`) and decompresses from
   each offset.
2. **Claude Code creates session files the moment a project opens**, before any
   message exists. Filtered out, or the sidebar's top rows are empty shells forever
   (their mtime keeps moving).
3. **A missing table is not an empty store.** opencode's v2 schema has no `message`
   table; a v1-only query throws "no such table", which used to be reported as "0
   sessions" on a machine that had 69 of them. The adapter now detects which tables
   exist before querying.

Everything is defensive by design: a source that is missing, empty or corrupt produces
a `note` ("not installed", "no sessions found", "unreadable: â€¦") next to the rows it
could read, never an exception â€” a UI listing four sources at once must not go blank
because one of them is mid-write.

## 4. Today: the visual UI and its HTTP API

```powershell
cd "D:\AppDev\Rosalena Harness\harness"
$env:ROSALENA_HOME = "D:\AppDev\Rosalena Harness\data"
node src\cli.mjs --ui 8090            # or --ui with no port for the default
```

<http://127.0.0.1:8090/>. The page is three files served from `harness\ui\`
(`index.html`, `app.js`, `styles.css`), no build step and no framework.

| Route | Method | Purpose |
|---|---|---|
| `/` | GET | the page, with the launch token injected into `<meta name="rosalena-token">` |
| `/app.js`, `/styles.css` | GET | the two assets (`cache-control: no-store`, so an edit shows on reload) |
| `/api/health` | GET | `{ok, router:{up,models}, workspace, home, runsDir, sessionCounts, roots}` |
| `/api/sessions` | GET | `{chats, external, notes}` â€” both sidebar lists in one call (`limit` â‰¤ 200) |
| `/api/session?source=&id=` | GET | one external session: `{meta, messages, truncated}` |
| `/api/chat?id=` | GET | one run: `{id, task, model, status, answer, error, events}` |
| `/api/chat` | POST | start a run â€” **needs `x-rosalena-token`**; body `{task, model, parentId?, attachments:[{name, dataBase64}]}` â†’ `{id}` |
| `/api/stream?id=` | GET | Server-Sent Events: every event replayed from the start, then live ones, ending with `{type:"ui/end", status, answer, error}` |
| `/api/cancel` | POST | ask a run to stop â€” **needs `x-rosalena-token`**; body `{id}` â†’ `200 {ok,reason}`, or `409 {ok:false,error}` when it already finished or is stale. This is the Stop button, and the same flag `--cancel` writes (Â§2.5) |

Two properties make the page feel instant and survive a refresh:

- **The id comes back before the first token.** `POST /api/chat` chooses the run id
  (and records the run under it) before starting the model, so the browser can open
  `/api/stream?id=` immediately.
- **The stream is a replay, not a tail.** A reconnecting `EventSource` re-receives
  everything, so a dropped connection repairs itself instead of leaving a hole. A
  finished run replays and then ends; a live one keeps the socket open with a `: ping`
  comment every 15 s.

Attachments are written to `<ROSALENA_HOME>\attachments\<runId>\` and named in the task
text, so the agent opens them with its ordinary `read_file` tool â€” no new tool, no new
failure mode.

**The guard.** The server binds `127.0.0.1` only (override with `--ui-host`, at your own
risk). It refuses any request whose `Origin` is not loopback and any whose
`sec-fetch-site` is not `same-origin`/`none`, and it refuses `POST /api/chat` without the
per-launch token. That stops another web page in the same browser from driving your
agent; it is not a substitute for authenticating a remote client (Â§5).

`node probe-ui.mjs http://127.0.0.1:8090` exercises all of it against a running server
(and `--chat` sends one real prompt through the router). `node check-ui-wiring.mjs`
cross-checks that every element `app.js` reaches for exists in `index.html`.

## 5. Not built: permissions and tokens

"When allowed" has to be enforceable, so interop gets its own permission layer rather
than inheriting "the client can do whatever it asks".

```
data\interop.json      { "tokens": [ { "name": "claude-desktop", "hash": "...",
                                        "scopes": ["read"], "roots": ["D:\\work"] } ] }
```

- **Scopes:** `read` (files), `task` (start runs), `spawn` (subagents), `write` (files
  and commands). `read` alone is the default for a new token.
- **Roots:** every filesystem path a tool touches must sit under one of the token's
  roots, checked against the resolved real path, not the string the caller sent.
- **Tokens:** 32 random bytes, stored hashed; the HTTP surface takes
  `Authorization: Bearer <token>`, the stdio surface takes the token from its own
  config (there is no ambient identity in a pipe). No token, no tools.
- **Audit:** each run records which token asked for it, so `list_runs` can answer
  "what did Claude Code do here?".

The UI's per-launch token is a different thing: it stops other *pages* in your browser
from posting to the server, and it is regenerated on every launch. It is not a user
identity and it is not persisted.

**Built since: the router's shared secret.** The router (port 8077) now takes an optional
token covering `/v1/*` and `/admin/status`; `/health` stays open. Configure it with
`auth.tokenEnv` (default suggestion `ROSALENA_ROUTER_TOKEN`) and export that variable, or
`auth.token` inline. Clients present `Authorization: Bearer <token>` or `x-router-token`.
This is one shared secret for a money-spending endpoint, not the per-client identity above
— a client that holds it can spend the whole budget and see the ledger. Treat it as "not
every process on the machine", and keep the scoped-token design for the MCP/HTTP task
surface.

## 6. Open decisions

1. **Transport for task control:** the same stdio server (simplest, one client per
   process) versus an HTTP surface on the router port (several clients, needs tokens).
   stdio first is the smaller correct step.
2. **Whether a remote client may spawn subagents at all** â€” that is a real cost (tokens
   and GPU time) and probably wants a per-token budget, not just a scope.
3. **Whether reading should ever become writing.** Reading another harness's sessions is
   deliberately one-way today. Importing a transcript *into Rosalena's own store* is the
   safe way to continue someone else's conversation; editing their file is not.

## 7. Where this product lives

The intended install location is `D:\AppDev\Rosalena Harness` â€” a sibling of
`D:\AppDev\Ai Ecosystem`, not a folder inside it. The reason is a Windows integrity
label, not taste: `D:\AppDev\Ai Ecosystem` is Low-labeled, and Windows runs an `.exe`
whose image lives there at Low integrity, so its writes to `%USERPROFILE%` fail `EPERM`.
The full explanation, and why the product keeps all of its state in its own `data\`
folder meanwhile, is in `..\README.md` under "Where this folder belongs, and why".
