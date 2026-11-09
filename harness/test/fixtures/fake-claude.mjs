// A stand-in for `claude -p ... --output-format stream-json`: prints the message shapes the
// real CLI streams (system init, partial text, a tool call and its result, the final
// result with usage and cost), echoing what it was asked so a test can check the argv.
// FAKE_CLAUDE_SLEEP_MS keeps it running (for Stop); FAKE_CLAUDE_FAIL makes it end unsigned-in.
const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const task = argv[argv.indexOf("-p") + 1] ?? "";
const resume = opt("--resume");
const session = resume ?? "sess-new-1";
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

if (process.env.FAKE_CLAUDE_FAIL) {
  process.stderr.write("Invalid API key · Please run /login\n");
  process.exit(1);
}
out({ type: "system", subtype: "init", session_id: session, model: "claude-opus-5-5", permissionMode: opt("--permission-mode"), claude_code_version: "2.1.309", tools: ["Bash", "Read"] });
out({ type: "stream_event", session_id: session, parent_tool_use_id: null, event: { type: "message_start", message: { id: "m1" } } });
out({ type: "stream_event", session_id: session, parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me check." } } });
out({ type: "assistant", session_id: session, parent_tool_use_id: null, message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Let me check." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "node --version" } }] } });
out({ type: "user", session_id: session, parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "v24.18.0", is_error: false }] } });
const finish = () => {
  out({ type: "stream_event", session_id: session, parent_tool_use_id: null, event: { type: "message_start", message: { id: "m2" } } });
  const text = `done: ${task}${resume ? ` (resumed ${resume})` : ""} [mode ${opt("--permission-mode")}${opt("--model") ? `, model ${opt("--model")}` : ""}]`;
  out({ type: "assistant", session_id: session, parent_tool_use_id: null, message: { id: "m2", role: "assistant", content: [{ type: "text", text }] } });
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    session_id: session,
    num_turns: 2,
    duration_ms: 1200,
    duration_api_ms: 900,
    total_cost_usd: 0.0123,
    usage: { input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 2000, output_tokens: 40 },
    modelUsage: { "claude-opus-5-5": { costUSD: 0.0123 } },
    permission_denials: argv.includes("acceptEdits") ? [{ tool_name: "Bash", tool_use_id: "t9", tool_input: { command: "npm test" } }] : [],
  });
};
const sleep = Number(process.env.FAKE_CLAUDE_SLEEP_MS) || 0;
if (sleep) setTimeout(finish, sleep);
else finish();
