// The pieces behind the Settings pages that are more than a saved preference:
//
//   skills       which skills are switched off (skills-off.json), read by listSkills, so the
//                `skill` tool and the skill-autoload plugin both stop offering a skill that
//                is off
//   templates    the person's prompt templates: slash-command files in
//                ~/.rosalena/commands/<name>.md, the same files commands.mjs already loads
//   providers    the servers on this PC or the LAN a model can be answered by, and whether
//                anything is listening at each address
//   permissions  the approval rules in permissions.json that permissions.mjs reads for
//                every tool call (allow / ask / deny by tool and pattern)
//
// Everything here is plain files and one TCP probe; no dependency, no network beyond the
// addresses the person's own router config names.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { connect } from "node:net";

const rosalenaHome = (env = process.env) => env.ROSALENA_HOME || join(homedir(), ".rosalena");

// ------------------------------------------------------------------------- skills

/** Where the off-list lives: <ROSALENA_HOME>/skills-off.json, beside permissions.json. */
export const skillsOffFile = (env = process.env) => join(rosalenaHome(env), "skills-off.json");

/** The names of the skills switched off. A missing or broken file means none are. */
export function readSkillsOff(file = skillsOffFile()) {
  if (!file || !existsSync(file)) return new Set();
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const list = Array.isArray(raw?.off) ? raw.off : [];
    return new Set(list.filter((name) => typeof name === "string" && SKILL_NAME.test(name)));
  } catch {
    return new Set();
  }
}

const SKILL_NAME = /^[A-Za-z0-9][\w.-]{0,80}$/;

/** Switch one skill on or off; returns the new off-list (sorted). */
export function setSkillEnabled(file, name, enabled) {
  const skill = String(name ?? "");
  if (!SKILL_NAME.test(skill)) throw Object.assign(new Error(`"${skill}" is not a skill name`), { status: 400 });
  if (typeof enabled !== "boolean") throw Object.assign(new Error("enabled must be true or false"), { status: 400 });
  const off = readSkillsOff(file);
  if (enabled) off.delete(skill);
  else off.add(skill);
  const list = [...off].sort();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ off: list }, null, 2)}\n`, "utf8");
  return list;
}

/**
 * Where a skill folder comes from, in words: "ships with Rosalena" for the bundled folder,
 * otherwise the folder it was found in, with the home directory shortened to ~.
 */
export function skillSource(root, { bundled, home = homedir() } = {}) {
  const clean = (p) => String(p ?? "").replace(/[\\/]+$/, "");
  if (bundled && clean(root).toLowerCase() === clean(bundled).toLowerCase()) return "ships with Rosalena";
  const h = clean(home);
  const r = clean(root);
  return h && r.toLowerCase().startsWith(h.toLowerCase()) ? `~${r.slice(h.length).replace(/\\/g, "/")}` : r;
}

// ---------------------------------------------------------------------- templates

/** The folder Settings > Templates writes: the first user folder commands.mjs reads. */
export const templatesDir = (home = homedir()) => join(home, ".rosalena", "commands");

const TEMPLATE_NAME = /^[a-z0-9][a-z0-9_-]{0,47}$/;
export const TEMPLATE_MODES = Object.freeze(["", "plan", "goal"]);
const MAX_TEMPLATE = 20_000;

/** A template name the command loader keeps as-is, or null. */
export function cleanTemplateName(value) {
  const name = String(value ?? "").trim().toLowerCase();
  return TEMPLATE_NAME.test(name) ? name : null;
}

/** The .md text for a template: front matter (description, mode) and the body. */
export function templateFileText({ description = "", mode = "", body = "" } = {}) {
  const lines = ["---"];
  const desc = String(description ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 200);
  if (desc) lines.push(`description: ${desc}`);
  if (mode === "plan") lines.push("agent: plan");
  if (mode === "goal") lines.push("mode: goal");
  lines.push("---", "");
  return `${lines.join("\n")}${String(body ?? "").replace(/\r\n/g, "\n").trim()}\n`;
}

/** Write one template; refuses a bad name, an empty body or one that is too long. */
export function saveTemplate(dir, { name, description = "", mode = "", body = "" } = {}) {
  const clean = cleanTemplateName(name);
  if (!clean) throw Object.assign(new Error("a template name is 1 to 48 lowercase letters, digits, - or _, starting with a letter or digit"), { status: 400 });
  const text = String(body ?? "").trim();
  if (!text) throw Object.assign(new Error("the template is empty: write what it should send"), { status: 400 });
  if (text.length > MAX_TEMPLATE) throw Object.assign(new Error(`a template can be at most ${MAX_TEMPLATE.toLocaleString("en-US")} characters`), { status: 400 });
  if (!TEMPLATE_MODES.includes(mode ?? "")) throw Object.assign(new Error(`mode must be one of: none, plan, goal`), { status: 400 });
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${clean}.md`);
  writeFileSync(file, templateFileText({ description, mode, body: text }), "utf8");
  return { name: clean, file };
}

/** Delete one of the person's templates. Only files in `dir`; false when there was none. */
export function deleteTemplate(dir, name) {
  const clean = cleanTemplateName(name);
  if (!clean) throw Object.assign(new Error("not a template name"), { status: 400 });
  const file = join(dir, `${clean}.md`);
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}

// ---------------------------------------------------------------------- providers

/**
 * Where an address points: "this-pc" (loopback), "lan" (a private network address or a
 * bare host name), "cloud" (anything else), or null when it does not parse.
 */
export function hostKind(baseUrl) {
  let host;
  try {
    host = new URL(String(baseUrl)).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
  if (!host) return null;
  if (host === "localhost" || host === "::1" || host === "0.0.0.0" || /^127\./.test(host) || host.endsWith(".localhost")) return "this-pc";
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return "lan";
  const m = /^172\.(\d+)\./.exec(host);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return "lan";
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return "lan";
  if (host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".home.arpa") || !host.includes(".")) return "lan";
  return "cloud";
}

/**
 * Common local servers people run next to Rosalena. Listed even when the router does not
 * use them, marked so: "something answers on :11434, but no model in the list goes there"
 * is worth knowing, and it is never presented as set up.
 */
export const WELL_KNOWN_LOCAL = Object.freeze([
  { id: "ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1" },
  { id: "lmstudio", label: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1" },
  { id: "comfyui", label: "ComfyUI (pictures and video)", baseUrl: "http://127.0.0.1:8188" },
]);

const originOf = (url) => {
  try {
    const u = new URL(String(url));
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const same = host === "localhost" || host === "::1" || host === "0.0.0.0" ? "127.0.0.1" : host;
    return `${same}:${port}`;
  } catch {
    return null;
  }
};

/**
 * The local rows: every router provider whose address is on this PC or the LAN, then the
 * well-known servers the router does not already point at. Pure.
 */
export function localServerRows(providers = {}, extra = WELL_KNOWN_LOCAL) {
  const rows = [];
  const seen = new Set();
  for (const [id, spec] of Object.entries(providers ?? {})) {
    const kind = hostKind(spec?.baseUrl);
    if (kind !== "this-pc" && kind !== "lan") continue;
    const origin = originOf(spec.baseUrl);
    if (origin) seen.add(origin);
    rows.push({ id, label: String(spec?.label ?? id), baseUrl: String(spec.baseUrl), kind, inRouter: true });
  }
  for (const server of extra) {
    const origin = originOf(server.baseUrl);
    if (origin && seen.has(origin)) continue;
    if (origin) seen.add(origin);
    rows.push({ ...server, kind: hostKind(server.baseUrl), inRouter: false });
  }
  return rows;
}

/** The cloud rows: router providers whose address is on the internet. Pure. */
export function cloudProviderRows(providers = {}) {
  return Object.entries(providers ?? {})
    .filter(([, spec]) => hostKind(spec?.baseUrl) === "cloud")
    .map(([id, spec]) => ({ id, label: String(spec?.label ?? id), baseUrl: String(spec.baseUrl), hasKey: spec?.hasKey ?? null }));
}

/**
 * Is anything listening at this address? A TCP connect, nothing sent: an answer of any kind
 * (a 401, a page that is not an API) still means a server is there.
 */
export function probeListening(baseUrl, { timeoutMs = 700 } = {}) {
  const started = Date.now();
  let host;
  let port;
  try {
    const u = new URL(String(baseUrl));
    host = u.hostname.replace(/^\[|\]$/g, "");
    port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  } catch {
    return Promise.resolve({ listening: false, ms: 0, error: "not an address" });
  }
  if (host === "0.0.0.0") host = "127.0.0.1";
  return new Promise((resolveProbe) => {
    const socket = connect({ host, port });
    const done = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveProbe({ ...result, ms: Date.now() - started });
    };
    socket.setTimeout(timeoutMs, () => done({ listening: false, error: `nothing answered in ${timeoutMs} ms` }));
    socket.once("connect", () => done({ listening: true }));
    socket.once("error", (err) => done({ listening: false, error: err?.code === "ECONNREFUSED" ? "nothing is listening" : String(err?.code ?? err?.message ?? err) }));
  });
}

// -------------------------------------------------------------------- permissions

/** The file permissions.mjs reads: <ROSALENA_HOME>/permissions.json. */
export const permissionsFile = (env = process.env) => join(rosalenaHome(env), "permissions.json");

export const RULE_ACTIONS = Object.freeze(["allow", "ask", "deny"]);
const MAX_RULES = 200;

/** One rule as permissions.mjs reads it, or null. */
export function cleanRule(value) {
  if (!value || typeof value !== "object") return null;
  const pattern = String(value.pattern ?? "").replace(/[\r\n]+/g, " ").trim();
  if (!pattern || pattern.length > 400) return null;
  if (!RULE_ACTIONS.includes(value.action)) return null;
  const tool = String(value.tool ?? "*").trim() || "*";
  if (!/^(\*|[A-Za-z0-9_:.-]{1,80})$/.test(tool)) return null;
  return { tool, pattern, action: value.action };
}

/** The saved rules, cleaned, plus anything else the file held (kept on write). */
export function readPermissionRules(file = permissionsFile()) {
  if (!file || !existsSync(file)) return { rules: [], other: {}, broken: false };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const { rules, ...other } = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    return { rules: (Array.isArray(rules) ? rules : []).map(cleanRule).filter(Boolean), other, broken: false };
  } catch {
    return { rules: [], other: {}, broken: true };
  }
}

/** Replace the rules; refuses a rule permissions.mjs would ignore, so nothing is silently dropped. */
export function writePermissionRules(file, rules) {
  if (!Array.isArray(rules)) throw Object.assign(new Error("rules must be a list"), { status: 400 });
  if (rules.length > MAX_RULES) throw Object.assign(new Error(`at most ${MAX_RULES} rules`), { status: 400 });
  const cleaned = rules.map((rule, index) => {
    const ok = cleanRule(rule);
    if (!ok) throw Object.assign(new Error(`rule ${index + 1} needs a pattern (up to 400 characters), an action (allow, ask or deny) and a tool name or *`), { status: 400 });
    return ok;
  });
  const { other, broken } = readPermissionRules(file);
  if (broken) throw Object.assign(new Error(`${file} is not valid JSON; fix or delete it first so nothing in it is lost`), { status: 409 });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...other, rules: cleaned }, null, 2)}\n`, "utf8");
  return cleaned;
}
