/**
 * Tool calls for a provider that only speaks text.
 *
 * OmniRoute's keyless `auto` lands on the Cloudflare AI Playground bridge, which keeps only
 * user and assistant turns: system messages, `tools` and `role: "tool"` results are dropped
 * before the model sees them (open-sse/executors/cloudflare-playground.ts, toCfMessages).
 * Measured 2026-11-06 on OmniRoute 3.8.52: the model behind it (GLM 5.2) still writes tool
 * calls when it is told what the tools are, just as text. So a target marked
 * `"tools": "emulated"` gets the whole request rewritten as plain turns:
 *
 *   - every system message (the class persona, the agent's own rules) is folded into the top
 *     of the first user turn, the one place that is sure to arrive;
 *   - the tools are described in that same block, with one exact way to call them:
 *     <tool>{"name": "...", "arguments": {...}}</tool>;
 *   - earlier tool calls are written back in that form and tool results become user turns,
 *     so a long agent run reads as one consistent conversation;
 *
 * and the reply is parsed back into OpenAI `tool_calls`, so the caller never knows the
 * difference. Besides the contract's own tag this accepts the shapes the model was seen to
 * fall back to (`<tool_call>`, and a bare `mcp_<name>` or `<name>` line followed by a JSON
 * object), but only for names the request actually offered.
 */

const TOOL_TAG = /<(tool|tool_call)(?:\s[^<>]*)?>([\s\S]*?)<\/\1>/g;

/** `write_file(path: string, content: string)`: a tool's parameters on one line. */
function signature(fn) {
  const props = fn.parameters?.properties ?? {};
  const required = new Set(fn.parameters?.required ?? []);
  const args = Object.entries(props).map(([name, schema]) => `${name}${required.has(name) ? "" : "?"}: ${schema?.type ?? "any"}`);
  return `${fn.name}(${args.join(", ")})`;
}

/**
 * The short form, for a target with a prompt cap: one line per tool, the description cut to
 * its first sentence. The playground refuses anything over 6000 characters, and the agent's
 * full tool list alone is about 48000.
 */
export function compactContract(tools = []) {
  const lines = [
    'Tools: to use one, reply with <tool>{"name": "TOOL", "arguments": {...}}</tool> and nothing after it. Its result comes in the next message. When done, answer normally. Never tell the user to run what a tool can do.',
  ];
  for (const tool of tools) {
    const fn = tool?.function ?? tool;
    if (!fn?.name) continue;
    const about = String(fn.description ?? "").split(/(?<=\.)\s/)[0].slice(0, 90);
    lines.push(`- ${signature(fn)}${about ? `: ${about}` : ""}`);
  }
  return lines.join("\n");
}

/** The instructions block that replaces the system messages and the tools array. */
export function toolContract(tools = []) {
  const lines = [
    "You can use tools. To use one, reply with one or more blocks in exactly this form, and nothing else after them:",
    '<tool>{"name": "TOOL_NAME", "arguments": {...}}</tool>',
    "The arguments must be valid JSON that matches the tool's parameters. After you call a tool, stop and wait: its result arrives in the next message. When the task is done, answer normally with no <tool> block. Never tell the user to run something you can run with a tool.",
    "",
    "Tools:",
  ];
  for (const tool of tools) {
    const fn = tool?.function ?? tool;
    if (!fn?.name) continue;
    const params = fn.parameters ? JSON.stringify(fn.parameters) : "{}";
    lines.push(`- ${fn.name}: ${String(fn.description ?? "").trim()}`.trimEnd(), `  parameters: ${params}`);
  }
  return lines.join("\n");
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.type === "text" || typeof part?.text === "string" ? part.text ?? "" : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function argumentsObject(raw) {
  if (raw && typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(String(raw ?? "{}"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The request as plain user and assistant turns, with the instructions and the tool contract
 * (when there are tools) at the top of the first user turn. `tools` and `tool_choice` are
 * removed.
 */
export function emulateToolsBody(body, { maxChars = 0, keepTools = null, shortSystem = "" } = {}) {
  const { tools: allTools = [], tool_choice: _choice, ...rest } = body ?? {};
  const messages = Array.isArray(rest.messages) ? rest.messages : [];
  if (maxChars > 0) return fitToBudget({ rest, messages, allTools, maxChars, keepTools, shortSystem });
  const tools = allTools;
  const system = messages.filter((m) => m?.role === "system").map((m) => textOf(m.content)).filter(Boolean);
  const names = new Map(); // tool_call_id -> tool name, for the results that answer them
  const turns = [];
  for (const m of messages) {
    if (!m || m.role === "system") continue;
    if (m.role === "assistant") {
      const calls = (m.tool_calls ?? []).map((call) => {
        if (call?.id) names.set(call.id, call.function?.name ?? "tool");
        return `<tool>${JSON.stringify({ name: call.function?.name, arguments: argumentsObject(call.function?.arguments) })}</tool>`;
      });
      const text = [textOf(m.content), ...calls].filter(Boolean).join("\n");
      if (text) turns.push({ role: "assistant", content: text });
      continue;
    }
    if (m.role === "tool") {
      const name = names.get(m.tool_call_id) ?? m.name ?? "tool";
      turns.push({ role: "user", content: `Result of ${name}:\n${textOf(m.content) || "(empty)"}` });
      continue;
    }
    turns.push({ role: "user", content: m.content });
  }
  const preface = [...system, ...(tools.length ? [toolContract(tools)] : [])].join("\n\n");
  if (!preface) return { ...rest, messages: turns };
  const first = turns.findIndex((t) => t.role === "user");
  const header = `${preface}\n\n---\n\n`;
  if (first === -1) turns.unshift({ role: "user", content: preface });
  else {
    const user = turns[first];
    turns[first] = {
      ...user,
      content: typeof user.content === "string" ? `${header}${user.content}` : [{ type: "text", text: header }, ...(Array.isArray(user.content) ? user.content : [])],
    };
  }
  return { ...rest, messages: turns };
}

const CUT = "\n[…cut to fit this model's limit…]\n";

/** Middle of `text` removed so it is at most `max` characters. */
function squeeze(text, max) {
  if (text.length <= max) return text;
  if (max <= CUT.length + 20) return text.slice(0, Math.max(0, max));
  const half = Math.floor((max - CUT.length) / 2);
  return `${text.slice(0, half)}${CUT}${text.slice(text.length - half)}`;
}

/**
 * The same rewrite, inside a hard character cap (the Cloudflare playground refuses a prompt
 * over 6000 characters, counted over every turn). In order:
 *
 *   - only the tools named in `keepTools` are offered, in the one-line form;
 *   - the system messages are replaced by `shortSystem` when they would take more than a
 *     third of the cap (the Rosalena persona alone is 6504 characters);
 *   - the task (the first user turn) and the newest turns are kept, older turns are dropped,
 *     and any turn still too long has its middle cut out, marked as cut.
 *
 * Returns `null` when even the preface and the task cannot fit, so the caller can move on.
 */
function fitToBudget({ rest, messages, allTools, maxChars, keepTools, shortSystem }) {
  const wanted = keepTools ? new Set(keepTools) : null;
  const tools = wanted ? allTools.filter((t) => wanted.has(t?.function?.name ?? t?.name)) : allTools;
  const system = messages.filter((m) => m?.role === "system").map((m) => textOf(m.content)).filter(Boolean).join("\n\n");
  const contract = tools.length ? compactContract(tools) : "";
  const roomForSystem = Math.floor(maxChars / 3) - contract.length;
  const instructions = system.length <= Math.max(0, roomForSystem) ? system : shortSystem;
  const preface = [instructions, contract].filter(Boolean).join("\n\n");

  const names = new Map();
  const turns = [];
  for (const m of messages) {
    if (!m || m.role === "system") continue;
    if (m.role === "assistant") {
      const calls = (m.tool_calls ?? []).map((call) => {
        if (call?.id) names.set(call.id, call.function?.name ?? "tool");
        return `<tool>${JSON.stringify({ name: call.function?.name, arguments: argumentsObject(call.function?.arguments) })}</tool>`;
      });
      const text = [textOf(m.content), ...calls].filter(Boolean).join("\n");
      if (text) turns.push({ role: "assistant", content: text });
    } else if (m.role === "tool") {
      turns.push({ role: "user", content: `Result of ${names.get(m.tool_call_id) ?? m.name ?? "tool"}:\n${textOf(m.content) || "(empty)"}` });
    } else {
      turns.push({ role: "user", content: textOf(m.content) });
    }
  }

  const firstUser = turns.findIndex((t) => t.role === "user");
  const task = firstUser === -1 ? "" : turns[firstUser].content;
  const header = preface ? `${preface}\n\n---\n\n` : "";
  // The task may be long (a pasted file); it gets at most half of what the preface leaves.
  const taskText = squeeze(task, Math.max(200, Math.floor((maxChars - header.length) / 2)));
  const head = { role: "user", content: `${header}${taskText}` };
  if (head.content.length > maxChars) return null;

  const NOTE = "[earlier steps were left out to fit this model's limit]";
  let room = maxChars - head.content.length - NOTE.length;
  const tail = [];
  for (let i = turns.length - 1; i > firstUser; i -= 1) {
    if (room < 120) break;
    const turn = turns[i];
    const content = squeeze(turn.content, room);
    tail.unshift({ ...turn, content });
    room -= content.length;
  }
  if (tail.length < turns.length - firstUser - 1) tail.unshift({ role: "user", content: NOTE });
  return { ...rest, messages: [head, ...tail] };
}

/** The first balanced JSON object in `text` at or after `from`, with where it ended. */
function jsonObjectAt(text, from) {
  const start = text.indexOf("{", from);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return { value: JSON.parse(text.slice(start, i + 1)), start, end: i + 1 };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

let counter = 0;
const callId = () => `call_emu_${Date.now().toString(36)}_${(counter += 1)}`;

function toCall(name, args) {
  return { id: callId(), type: "function", function: { name, arguments: JSON.stringify(args ?? {}) } };
}

/**
 * Tool calls written as text, back into OpenAI `tool_calls`. Returns the text with the call
 * blocks removed, and the calls in the order written. Unknown tool names are left as text.
 */
export function parseEmulatedToolCalls(text, toolNames = []) {
  const offered = new Set(toolNames);
  const source = String(text ?? "");
  const calls = [];
  const cut = [];

  for (const match of source.matchAll(TOOL_TAG)) {
    const parsed = jsonObjectAt(match[2], 0)?.value;
    const name = parsed?.name ?? parsed?.tool ?? parsed?.function;
    if (typeof name !== "string" || !offered.has(name)) continue;
    calls.push(toCall(name, parsed.arguments ?? parsed.args ?? parsed.parameters ?? {}));
    cut.push([match.index, match.index + match[0].length]);
  }

  if (!calls.length) {
    // The fallback shape seen from the playground: a line holding only the tool's name
    // (often with an `mcp_` prefix), then its arguments as one JSON object.
    const line = /^[ \t]*`?(?:mcp_)?([A-Za-z_][\w.-]*)`?[ \t]*:?[ \t]*$/gm;
    for (const match of source.matchAll(line)) {
      const name = match[1];
      if (!offered.has(name)) continue;
      const json = jsonObjectAt(source, match.index + match[0].length);
      if (!json || source.slice(match.index + match[0].length, json.start).trim().replace(/^```(json)?$/, "") !== "") continue;
      calls.push(toCall(name, json.value));
      let end = json.end;
      const fence = /^\s*```/.exec(source.slice(end));
      if (fence) end += fence[0].length;
      cut.push([match.index, end]);
    }
  }

  let rest = source;
  for (const [start, end] of cut.sort((a, b) => b[0] - a[0])) rest = rest.slice(0, start) + rest.slice(end);
  rest = rest.replace(/```(?:json)?\s*```/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return { text: rest, toolCalls: calls };
}

/** One finished completion as an OpenAI stream, for a caller that asked to stream. */
export function completionToSse(completion) {
  const base = { id: completion.id, object: "chat.completion.chunk", created: completion.created, model: completion.model };
  const choice = completion.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const frames = [];
  const delta = { role: "assistant" };
  if (message.reasoning_content) delta.reasoning_content = message.reasoning_content;
  if (message.content) delta.content = message.content;
  frames.push({ ...base, choices: [{ index: 0, delta, finish_reason: null }] });
  for (const [index, call] of (message.tool_calls ?? []).entries()) {
    frames.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index, ...call }] }, finish_reason: null }] });
  }
  frames.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason ?? "stop" }], usage: completion.usage });
  const text = `${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}
