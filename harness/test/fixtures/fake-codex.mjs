// A stand-in for `codex exec --json ...` (and `codex --version`, `codex login status`): it
// prints the JSONL shapes the real CLI streams (codex-rs/exec/src/exec_events.rs at
// rust-v0.167.0: thread.started, turn.started, item.started/updated/completed for
// reasoning, agent_message, command_execution, todo_list, file_change, mcp_tool_call,
// web_search, then turn.completed with the thread's usage total), reading the prompt from
// stdin as `codex exec` does without a prompt argument, and echoing what it was asked so a
// test can check the argv and environment.
//
// FAKE_CODEX_SLEEP_MS keeps it running (for Stop). FAKE_CODEX_FAIL=stderr ends it the way
// an unsigned-in CLI does before a turn; FAKE_CODEX_FAIL=turn fails the turn with a 401.
// FAKE_CODEX_UNSIGNED makes `login status` answer "Not logged in".
const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const configs = argv.flatMap((a, i) => (a === "-c" ? [argv[i + 1]] : []));
const config = (key) => {
  const hit = configs.find((c) => c.startsWith(`${key}=`));
  return hit ? JSON.parse(hit.slice(key.length + 1)) : null;
};

// `node --test` also runs every .mjs under test/ as a file of its own: with no argv, pass.
if (!argv.length) process.exit(0);
if (argv[0] === "--version") {
  process.stdout.write("codex-cli 0.167.0\n");
  process.exit(0);
}
if (argv[0] === "login" && argv[1] === "status") {
  if (process.env.FAKE_CODEX_UNSIGNED) {
    process.stderr.write("Not logged in\n");
    process.exit(1);
  }
  process.stderr.write(process.env.FAKE_CODEX_APIKEY ? "API key configured - sk-proj-***ABCDE\nAuthentication is checked when you send a request.\n" : "Logged in using ChatGPT\n");
  process.exit(0);
}
if (argv[0] !== "exec" || !argv.includes("--json")) {
  process.stderr.write(`fake codex: unexpected argv ${JSON.stringify(argv)}\n`);
  process.exit(2);
}

const resumeAt = argv.indexOf("resume");
const resume = resumeAt >= 0 ? argv[resumeAt + 1] : null;
const thread = resume ?? "0199a213-81c0-7800-8aa1-bbab2a035a53";
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sandbox = argv.includes("--approve-for-me") ? "auto-review" : opt("--sandbox") ?? "default";

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
  if (process.env.FAKE_CODEX_FAIL === "stderr") {
    process.stderr.write("Error: Not logged in. Run `codex login` to sign in.\n");
    process.exit(1);
  }
  out({ type: "thread.started", thread_id: thread });
  out({ type: "turn.started" });
  if (process.env.FAKE_CODEX_FAIL === "turn") {
    out({ type: "error", message: "unexpected status 401 Unauthorized: Your authentication token has expired. Please try signing in again." });
    out({ type: "turn.failed", error: { message: "unexpected status 401 Unauthorized: Your authentication token has expired. Please try signing in again." } });
    process.exit(1);
  }
  out({ type: "item.completed", item: { id: "item_0", type: "reasoning", text: "**Checking the Node version**" } });
  out({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Let me check." } });
  out({ type: "item.started", item: { id: "item_2", type: "command_execution", command: "node --version", aggregated_output: "", exit_code: null, status: "in_progress" } });
  out({ type: "item.completed", item: { id: "item_2", type: "command_execution", command: "node --version", aggregated_output: "v24.18.0\n", exit_code: 0, status: "completed" } });
  out({ type: "item.started", item: { id: "item_3", type: "todo_list", items: [{ text: "Check node", completed: true }, { text: "Answer", completed: false }] } });
  out({ type: "item.updated", item: { id: "item_3", type: "todo_list", items: [{ text: "Check node", completed: true }, { text: "Answer", completed: false }] } });
  out({ type: "item.completed", item: { id: "item_4", type: "file_change", changes: [{ path: "notes.txt", kind: "update" }], status: "completed" } });
  out({ type: "item.started", item: { id: "item_5", type: "mcp_tool_call", server: "solbrowser", tool: "read_url", arguments: { url: "https://example.com" }, result: null, error: null, status: "in_progress" } });
  out({ type: "item.completed", item: { id: "item_5", type: "mcp_tool_call", server: "solbrowser", tool: "read_url", arguments: { url: "https://example.com" }, result: { content: [{ type: "text", text: "Example Domain" }], structured_content: null }, error: null, status: "completed" } });
  out({ type: "item.completed", item: { id: "item_6", type: "web_search", query: "node 24 release", action: { type: "search", query: "node 24 release" } } });
  if (sandbox === "auto-review") out({ type: "item.completed", item: { id: "item_7", type: "command_execution", command: "rm -rf build", aggregated_output: "", exit_code: null, status: "declined" } });
  out({ type: "item.completed", item: { id: "item_8", type: "error", message: "model rerouted: gpt-6.1-sol -> gpt-6-luna (HighRiskCyberActivity)" } });

  const finish = () => {
    const parts = [`sandbox ${sandbox}`];
    if (opt("-m")) parts.push(`model ${opt("-m")}`);
    if (config("model_reasoning_effort")) parts.push(`effort ${config("model_reasoning_effort")}`);
    if (config("developer_instructions")) parts.push(`role ${config("developer_instructions")}`);
    if (argv.includes("--add-dir")) parts.push(`add-dir ${opt("--add-dir")}`);
    if (argv.includes("--image")) parts.push(`image ${opt("--image")}`);
    parts.push(`cd ${opt("--cd") ? "set" : "unset"}`);
    parts.push(`env base=${process.env.OPENAI_BASE_URL ?? "none"} key=${process.env.OPENAI_API_KEY ? "yes" : "no"} sandboxvar=${process.env.CODEX_SANDBOX ?? "none"}`);
    const text = `done: ${prompt.trim()}${resume ? ` (resumed ${resume})` : ""} [${parts.join(", ")}]`;
    out({ type: "item.completed", item: { id: "item_9", type: "todo_list", items: [{ text: "Check node", completed: true }, { text: "Answer", completed: true }] } });
    out({ type: "item.completed", item: { id: "item_10", type: "agent_message", text } });
    // The thread's running total: a resumed thread's total includes the earlier run.
    const k = resume ? 2 : 1;
    out({ type: "turn.completed", usage: { input_tokens: 9000 * k, cached_input_tokens: 6000 * k, cache_write_input_tokens: 0, output_tokens: 300 * k, reasoning_output_tokens: 120 * k } });
  };
  const sleep = Number(process.env.FAKE_CODEX_SLEEP_MS) || 0;
  if (sleep) setTimeout(finish, sleep);
  else finish();
});
