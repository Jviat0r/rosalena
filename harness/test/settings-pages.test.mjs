/**
 * The Settings pages' server side (2026-11-09 settings sidebar):
 *
 *   - Notifications and Generation are saved with the other prefs, validated, and the
 *     generation defaults reach the request the router gets (max_tokens, temperature)
 *   - Skills: a skill switched off is left out of listSkills (so the `skill` tool and
 *     skill-autoload stop offering it) and listed as off on the page
 *   - Templates: create, rename, delete the person's own slash-command files; the built-ins
 *     stay read-only, and the composer's /api/commands sees a new one at once
 *   - Providers: local addresses are told apart from cloud ones and probed for a listener
 *   - Permissions: approval rules are validated and written where permissions.mjs reads them
 *
 *   node --test
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { createUiServer } from "../src/ui.mjs";
import { listSkills } from "../src/tools-extra.mjs";
import { cleanRule, cloudProviderRows, hostKind, localServerRows, probeListening, readSkillsOff, setSkillEnabled, skillSource, templateFileText } from "../src/settings.mjs";
import { parseCommandFile } from "../src/commands.mjs";
import { decide, userRules } from "../src/permissions.mjs";

const TOKEN = "settings-token-0123456789abcdef";

// A router stub: records each chat request, and answers /admin/status with providers that
// point at itself (listening) and at a closed port (not listening).
const seen = [];
let closedPort = 0;
const router = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (req.url.startsWith("/admin/status")) {
    const self = `http://127.0.0.1:${router.address().port}/v1`;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      providers: {
        local: { baseUrl: self, label: "Local (this PC)" },
        gone: { baseUrl: `http://127.0.0.1:${closedPort}/v1`, label: "Stopped server" },
        lanbox: { baseUrl: "http://192.168.1.50:8080/v1", label: "LAN box" },
        anthropic: { baseUrl: "https://api.anthropic.com/v1", label: "Anthropic", hasKey: true },
      },
    }));
    return;
  }
  if (raw) seen.push(JSON.parse(raw));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "pong" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
});
await new Promise((done) => router.listen(0, "127.0.0.1", done));
after(() => new Promise((done) => router.close(done)));
{
  // A port that was open a moment ago and is closed now: nothing listens there.
  const probe = createServer();
  await new Promise((done) => probe.listen(0, "127.0.0.1", done));
  closedPort = probe.address().port;
  await new Promise((done) => probe.close(done));
}
const ROUTER = `http://127.0.0.1:${router.address().port}/v1`;

async function start() {
  const ws = mkdtempSync(join(tmpdir(), "harness-settings-"));
  const home = join(ws, "home");
  const userHome = join(ws, "user");
  mkdirSync(userHome, { recursive: true });
  const ui = createUiServer({
    port: 0,
    home,
    workspace: ws,
    routerUrl: ROUTER,
    token: TOKEN,
    userHome,
    skillsOffPath: join(home, "skills-off.json"),
    permissionsPath: join(home, "permissions.json"),
  });
  const { port } = await ui.ready();
  after(() => ui.close());
  const base = `http://127.0.0.1:${port}`;
  const send = async (method, path, body, token = TOKEN) => {
    const res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { "x-rosalena-token": token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return { ws, home, userHome, get: async (path) => (await fetch(base + path)).json(), send };
}

test("notifications and generation defaults save, and nonsense is refused", async () => {
  const { get, send } = await start();
  const first = await get("/api/prefs");
  assert.deepEqual(first.notify, { done: true, failed: true, approval: true });
  assert.deepEqual(first.generation, { maxTokens: null, temperature: null });
  assert.equal(first.generationLimits.maxTokensMax, 131072);

  assert.equal((await send("PUT", "/api/prefs", { notify: { done: false } }, "")).status, 403);
  const saved = await send("PUT", "/api/prefs", { notify: { done: false }, generation: { maxTokens: 8192, temperature: 0.35 } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.notify, { done: false, failed: true, approval: true }, "one switch changes, the others stay");
  assert.deepEqual(saved.body.generation, { maxTokens: 8192, temperature: 0.35 });

  assert.equal((await send("PUT", "/api/prefs", { notify: { everything: true } })).status, 400);
  assert.equal((await send("PUT", "/api/prefs", { notify: { done: "yes" } })).status, 400);
  assert.equal((await send("PUT", "/api/prefs", { generation: { maxTokens: 12 } })).status, 400);
  assert.equal((await send("PUT", "/api/prefs", { generation: { temperature: 3 } })).status, 400);
  assert.equal((await send("PUT", "/api/prefs", { generation: { topK: 4 } })).status, 400);

  const cleared = await send("PUT", "/api/prefs", { generation: { temperature: null } });
  assert.deepEqual(cleared.body.generation, { maxTokens: 8192, temperature: null }, "null goes back to the model's own");
});

test("the generation defaults reach the router's request", async () => {
  const { get, send } = await start();
  await send("PUT", "/api/prefs", { generation: { maxTokens: 6000, temperature: 0.2 } });
  seen.length = 0;
  const started = await send("POST", "/api/chat", { task: "ping" });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  for (let i = 0; i < 100; i += 1) {
    const chat = await get(`/api/chat?id=${encodeURIComponent(started.body.id)}`);
    if (chat.status && chat.status !== "running") break;
    await new Promise((done) => setTimeout(done, 50));
  }
  const request = seen.find((body) => Array.isArray(body.messages));
  assert.ok(request, "the router got a chat request");
  assert.equal(request.max_tokens, 6000);
  assert.equal(request.temperature, 0.2);

  await send("PUT", "/api/prefs", { generation: { maxTokens: null, temperature: null } });
  seen.length = 0;
  const plain = await send("POST", "/api/chat", { task: "ping again" });
  for (let i = 0; i < 100; i += 1) {
    const chat = await get(`/api/chat?id=${encodeURIComponent(plain.body.id)}`);
    if (chat.status && chat.status !== "running") break;
    await new Promise((done) => setTimeout(done, 50));
  }
  const second = seen.find((body) => Array.isArray(body.messages));
  assert.equal(second.max_tokens, 4096, "the run's own default");
  assert.ok(!("temperature" in second), "no temperature is sent unless one is set");
});

test("a skill switched off leaves listSkills, and the page lists it as off", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-skills-"));
  for (const name of ["alpha", "beta"]) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: the ${name} skill\n---\nbody`);
  }
  const offFile = join(dir, "off.json");
  assert.deepEqual(setSkillEnabled(offFile, "beta", false), ["beta"]);
  const off = readSkillsOff(offFile);
  assert.deepEqual(listSkills([dir], { off }).map((s) => s.name), ["alpha"], "the skill tool no longer sees it");
  const all = listSkills([dir], { off, includeOff: true });
  assert.deepEqual(all.map((s) => [s.name, s.enabled]), [["alpha", true], ["beta", false]]);
  assert.deepEqual(setSkillEnabled(offFile, "beta", true), []);
  assert.throws(() => setSkillEnabled(offFile, "../x", false), /not a skill name/);

  const { send, get } = await start();
  const page = await get("/api/skills");
  assert.ok(page.skills.length > 0, "the bundled skills are listed");
  const cadence = page.skills.find((s) => s.name === "commit-cadence");
  assert.ok(cadence?.bundled, "commit-cadence ships with the app");
  assert.equal(cadence.source, "ships with Rosalena");
  assert.equal((await send("PUT", "/api/skills", { name: "commit-cadence", enabled: false }, "")).status, 403);
  const switched = await send("PUT", "/api/skills", { name: "commit-cadence", enabled: false });
  assert.equal(switched.body.skills.find((s) => s.name === "commit-cadence").enabled, false);
  assert.equal((await send("PUT", "/api/skills", { name: "commit-cadence", enabled: "no" })).status, 400);
});

test("skill sources read as words", () => {
  assert.equal(skillSource("C:/app/skills/", { bundled: "C:/app/skills" }), "ships with Rosalena");
  assert.equal(skillSource("C:/Users/me/.claude/skills", { bundled: "C:/app/skills", home: "C:/Users/me" }), "~/.claude/skills");
});

test("templates: create, rename and delete your own; built-ins stay read-only", async () => {
  const { send, get, userHome } = await start();
  const before = await get("/api/templates");
  const review = before.templates.find((t) => t.name === "review");
  assert.equal(review.editable, false, "a built-in cannot be edited here");
  assert.ok(!before.templates.some((t) => t.name === "clear"), "page actions are not templates");

  assert.equal((await send("POST", "/api/templates", { name: "standup", body: "x" }, "")).status, 403);
  assert.equal((await send("POST", "/api/templates", { name: "Bad Name!", body: "x" })).status, 400);
  assert.equal((await send("POST", "/api/templates", { name: "standup", body: "   " })).status, 400);

  const made = await send("POST", "/api/templates", { name: "standup", description: "Daily notes", mode: "plan", body: "Summarise yesterday: $ARGUMENTS" });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const file = join(userHome, ".rosalena", "commands", "standup.md");
  assert.ok(existsSync(file));
  const parsed = parseCommandFile(readFileSync(file, "utf8"));
  assert.equal(parsed.meta.description, "Daily notes");
  assert.equal(parsed.meta.agent, "plan");
  const listed = made.body.templates.find((t) => t.name === "standup");
  assert.equal(listed.editable, true);
  assert.equal(listed.mode, "plan");

  const commands = await get("/api/commands");
  assert.ok(commands.commands.some((c) => c.name === "standup"), "the composer's slash menu has it at once");

  const renamed = await send("PUT", "/api/templates", { previous: "standup", name: "daily", body: "Summarise yesterday" });
  assert.ok(renamed.body.templates.some((t) => t.name === "daily"));
  assert.ok(!renamed.body.templates.some((t) => t.name === "standup"), "the old name is gone");
  assert.ok(!existsSync(file));

  assert.equal((await send("DELETE", "/api/templates?name=daily")).status, 200);
  assert.equal((await send("DELETE", "/api/templates?name=daily")).status, 404);
});

test("template files keep their front matter", () => {
  const text = templateFileText({ description: "two\nlines", mode: "goal", body: "do it\r\nnow" });
  assert.equal(text, "---\ndescription: two lines\nmode: goal\n---\ndo it\nnow\n");
  assert.deepEqual(parseCommandFile(text), { meta: { description: "two lines", mode: "goal" }, body: "do it\nnow" });
});

test("provider addresses are sorted into this PC, the LAN and the cloud", () => {
  assert.equal(hostKind("http://127.0.0.1:8080/v1"), "this-pc");
  assert.equal(hostKind("http://localhost:11434"), "this-pc");
  assert.equal(hostKind("http://[::1]:1234"), "this-pc");
  assert.equal(hostKind("http://192.168.1.4:8080"), "lan");
  assert.equal(hostKind("http://172.20.0.2:8080"), "lan");
  assert.equal(hostKind("http://172.40.0.2:8080"), "cloud");
  assert.equal(hostKind("http://gpu-box:8080"), "lan");
  assert.equal(hostKind("http://nas.local:8080"), "lan");
  assert.equal(hostKind("https://api.openai.com/v1"), "cloud");
  assert.equal(hostKind("not a url"), null);

  const rows = localServerRows({ local: { baseUrl: "http://127.0.0.1:11434/v1", label: "Mine" }, openai: { baseUrl: "https://api.openai.com/v1" } });
  assert.deepEqual(rows.map((r) => [r.id, r.inRouter]), [["local", true], ["lmstudio", false], ["comfyui", false]], "a well-known server the router already points at is not listed twice");
  assert.deepEqual(cloudProviderRows({ openai: { baseUrl: "https://api.openai.com/v1", label: "OpenAI" } }).map((r) => r.id), ["openai"]);
});

test("the providers route probes each local address", async () => {
  const { get } = await start();
  const body = await get("/api/providers");
  assert.equal(body.router.up, true);
  const byId = Object.fromEntries(body.local.map((row) => [row.id, row]));
  assert.equal(byId.local.listening, true, "the stub router answers on its own port");
  assert.equal(byId.gone.listening, false);
  assert.equal(byId.lanbox.kind, "lan");
  assert.deepEqual(body.cloud.map((row) => row.id), ["anthropic"]);
  assert.equal(body.subscriptions[0].id, "claude-code");
  assert.equal(body.subscriptions[1].id, "codex");
  assert.match(body.subscriptions[1].setup, /npm install -g @openai\/codex, then run codex login/);
  assert.equal((await probeListening("nonsense")).listening, false);
});

test("the desktop shell's notification: text only, clipped, and a refusal is reported", async () => {
  const { cleanNotice, showNotice } = await import("../../desktop/notify.mjs");
  assert.deepEqual(cleanNotice({ title: "Done\u0007!", body: "line one\nline two\u0000" }), { title: "Done !", body: "line one\nline two" });
  assert.equal(cleanNotice({}).title, "Rosalena");
  assert.equal(cleanNotice({ body: "x".repeat(1000) }).body.length, 400);

  const made = [];
  class Fake {
    static isSupported() {
      return true;
    }
    constructor(options) {
      this.options = options;
      this.handlers = {};
      made.push(this);
    }
    on(name, fn) {
      this.handlers[name] = fn;
    }
    once(name, fn) {
      this.handlers[name] = fn;
    }
    show() {
      if (Fake.refuse) setTimeout(() => this.handlers.failed?.({}, "Notification failed - Settings prevent the notification type from being delivered."), 5);
    }
  }
  assert.deepEqual(await showNotice(Fake, { title: "Answer ready", body: "pong" }, { settleMs: 30 }), { shown: true });
  assert.equal(made[0].options.title, "Answer ready");
  Fake.refuse = true;
  const refused = await showNotice(Fake, { title: "x" }, { settleMs: 200 });
  assert.equal(refused.shown, false);
  assert.match(refused.reason, /Settings prevent/);
  assert.deepEqual(await showNotice({ isSupported: () => false }, {}), { shown: false, reason: "this system has no notifications" });
});

test("approval rules are checked, saved where permissions.mjs reads them, and used", async () => {
  assert.deepEqual(cleanRule({ pattern: "*npm publish*", action: "deny" }), { tool: "*", pattern: "*npm publish*", action: "deny" });
  assert.equal(cleanRule({ pattern: "", action: "deny" }), null);
  assert.equal(cleanRule({ pattern: "x", action: "maybe" }), null);
  assert.equal(cleanRule({ pattern: "x", action: "ask", tool: "rm -rf" }), null);

  const { send, get, home } = await start();
  const first = await get("/api/permissions");
  assert.deepEqual(first.rules, []);
  assert.ok(first.builtIn.some((rule) => rule.pattern === "*git push*"), "the shipped rules are shown");
  assert.equal((await send("PUT", "/api/permissions", { rules: [] }, "")).status, 403);
  assert.equal((await send("PUT", "/api/permissions", { rules: [{ pattern: "x", action: "nope" }] })).status, 400);
  const saved = await send("PUT", "/api/permissions", { rules: [{ tool: "run_command", pattern: "*npm publish*", action: "deny" }] });
  assert.equal(saved.status, 200);
  const file = join(home, "permissions.json");
  const rules = userRules(file);
  assert.deepEqual(rules, [{ tool: "run_command", pattern: "*npm publish*", action: "deny" }]);
  const verdict = decide({ call: { function: { name: "run_command", arguments: JSON.stringify({ command: "npm publish" }) } }, mode: "full", root: home, rules });
  assert.equal(verdict.action, "deny", "the agent's own check honours the saved rule");

  writeFileSync(file, "{ not json");
  assert.equal((await send("PUT", "/api/permissions", { rules: [] })).status, 409, "a broken file is not overwritten");
});
