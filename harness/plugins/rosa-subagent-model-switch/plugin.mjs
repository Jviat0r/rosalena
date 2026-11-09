// subagent-model-switch - which model a worker of each role starts on, and the
// one file that decides it.
//
// WHAT THIS IS A PORT OF, AND WHERE IT COULD NOT BE ONE
//
// A sidebar version of this (DeepSeek Harness had one) opened a panel, listed the subagents
// running in the session and swapped one subagent's route through that agent's own
// request waterfall. Rosalena has no per-subagent request waterfall to hook: a
// worker's class is chosen when it is spawned, and the harness turns a role into a
// model through `data/roles.json` - the presets that also carry the role's title, its
// prompt addendum, the target its workers start on and whether it may judge. So the
// same intent - "change the model this kind of worker runs on" - is expressed against the
// file the harness actually reads, and this plugin's job is to make that edit safe:
// it validates the role, validates the target against the router, writes atomically,
// and prints the previous value so the change can be undone.
//
// THE FILE'S CONTRACT (owned by `harness/src/models.mjs::rolesFromRouter` and
// `agent.mjs`, not by this plugin; this plugin only edits it):
//
//   { "roles": { "<class>": {
//       "title":    "Orchestrator",   // what a person sees in the picker
//       "addendum": "...",            // the paragraph added to this role's prompt
//       "subagent": "code",           // the target this role's delegated workers use
//       "judge":    false,            // whether the review pass runs for this role
//       "effort":   "high"            // optional: low | medium | high, absent = no opinion
//   } } }
//
// Each key is a router class (orchestrate/code/fast/judge/deepseek/rosalena), and the role
// routes through that class's failover chain - the role id IS the model, unless the user
// picks a concrete one in the composer's model dropdown. `label` and `name` are read
// as aliases for `title`; `title` is what this plugin writes, because it is what the
// shipped code documents.
//
// `effort` is a preference, not a route: the composer's effort submenu reads it, and
// a model that has no effort levels ignores it. This plugin only keeps it honest -
// the three level names or nothing at all - and never invents a level per model; that
// capability belongs to the model menu, not to a preset file. An absent or null key
// means "no opinion", which is why the shipped presets do not carry one.
//
// `addendum` is the substance: those four names are prompts now, not just routes, so
// the shipped text says what each role does, what it refuses and how it hands work on.
//
// `subagent` holds a ROUTER TARGET, which is either one of the router's class names
// (a failover chain, resolved at request time) or a curated `provider/model` from
// `router/router.config.json` `models[]`. A class name is legal here; a string the
// router has never heard of is not, because that fails at request time inside a run,
// and the failure looks like a network problem rather than a typo in a preset.
//
// The file is meant to be edited by hand as well. Everything this plugin writes, it
// writes in the shape above, keeping the keys it does not own.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// <harness>/plugins/rosa-subagent-model-switch/plugin.mjs -> <harness>
const HARNESS_DIR = resolve(HERE, "..", "..");

/** The keys a role preset may carry. `reset` restores the ones it ships. */
export const ROLE_KEYS = ["title", "addendum", "subagent", "judge", "effort"];

/**
 * The effort levels a preset may ask for, lowest first. Anything else is refused
 * rather than passed through: a level a provider does not know is either ignored
 * silently or rejected mid-run, and both look like a bug in the harness.
 */
export const EFFORT_LEVELS = ["low", "medium", "high"];

/**
 * The shipped presets: used when `data/roles.json` is missing, restored by
 * `reset <role>`. Each key is a router class, so every preset resolves through a
 * failover chain that ships beside it, without a single external call.
 *
 * The addenda are the substance of this file. Those role ids used to be nothing
 * but model routes; now they are prompts, so each one says what the role does,
 * what it refuses, and how it hands work on.
 *
 * `subagent` is the target that role's DELEGATED workers start on - "code" for the
 * roles that hand work out, and "fast" for `fast`, which delegates only when a job
 * is genuinely mechanical. Empty would also be legal (the harness default applies),
 * but a preset that names nothing is a preset nobody can see.
 */
export const DEFAULT_ROLES = {
  orchestrate: {
    title: "Orchestrator",
    addendum:
      "Split the request into steps before touching anything, and say which file each step changes. Do a step yourself only when it is a single edit; hand every multi-step or repetitive job to a worker with an explicit brief, then check the result against the plan instead of trusting its summary. When two steps disagree, or the choice is the user's to make, stop and ask rather than choosing for them.",
    subagent: "code",
    judge: false,
  },
  code: {
    title: "Code",
    addendum:
      "Make the smallest change that satisfies the request and keep the file's existing style, even where you would write it differently. Before reporting, run the test or command that proves the change and paste its real output; if you could not run it, say which check is missing instead of implying it passed. Never widen a fix to code the request did not name.",
    subagent: "code",
    judge: false,
  },
  fast: {
    title: "Fast",
    addendum:
      "Answer in at most one short paragraph, with no preamble, no restatement of the question and no closing summary. Prefer a direct answer or one command over an explanation, and say plainly when you do not know instead of hedging. Do not start tool work unless the request needs it.",
    subagent: "fast",
    judge: false,
  },
  judge: {
    title: "Judge",
    addendum:
      "Judge only what is in front of you: quote the command output, test result or line of code that settles each claim before accepting it. Separate what you verified from what you took on trust, and refuse - naming the missing evidence - rather than approving work you did not see run.",
    subagent: "code",
    judge: true,
  },
  deepseek: {
    title: "Free tier",
    addendum:
      "This role runs on the free tier behind the router, so answer as Rosalena and stay on the question asked: say clearly when you are unsure or when the free window is spent, and never claim a capability of the harness that a single free model does not have. There is no fallback behind this role on purpose, so a refusal means the window is closed rather than that another model answered. Do not name the model, the provider or the tier behind this role.",
    subagent: "code",
    judge: false,
  },
  rosalena: {
    title: "Rosalena",
    addendum:
      "Answer as Rosalena, the assistant built into this app: lead with the concrete next step on the user's own machine, name the file or the command when there is one, and say plainly when a capability you would need is not available here. The identity is supplied by the router's own system prompt, so do not re-introduce yourself in a greeting or repeat that text - just do the work, stay inside what this app can actually run, and never claim a result you did not see.",
    subagent: "code",
    judge: false,
  },
};

const reason = (err) => (err instanceof Error ? err.message : String(err));

/** A fresh copy of the shipped presets: callers mutate the result, never the constant. */
export function defaultRoles() {
  return JSON.parse(JSON.stringify(DEFAULT_ROLES));
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The effort level, checked. Absent or null means "no opinion" and is legal; any
 * other value has to be one of EFFORT_LEVELS. A number, a boolean or a made-up level
 * ("max", "HIGH") is refused by name, with the legal values in the message, because
 * the alternative is a preset that silently does nothing.
 */
export function checkEffort(id, value) {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") {
    return { ok: false, problem: `roles.${id}.effort is not a string - use ${EFFORT_LEVELS.map((level) => `"${level}"`).join(", ")}, or remove the key for no opinion` };
  }
  const text = value.trim();
  if (!text) return { ok: false, problem: `roles.${id}.effort is empty - use ${EFFORT_LEVELS.map((level) => `"${level}"`).join(", ")}, or remove the key for no opinion` };
  if (!EFFORT_LEVELS.includes(text)) {
    return { ok: false, problem: `roles.${id}.effort is "${value}" - use ${EFFORT_LEVELS.map((level) => `"${level}"`).join(", ")}, or remove the key for no opinion` };
  }
  return { ok: true, value: text };
}

/**
 * One role preset, checked.
 *
 * `title`, `label` and `name` are three spellings of the same thing: `label` and
 * `name` are accepted because the reader tolerates them, `title` is what the shipped
 * code documents and what `reset` writes.
 *
 * `subagent` may be absent (the harness then uses its own worker class), but if it is
 * present it has to be a non-empty string: `subagent: 42` in a preset file would reach
 * the router as the model id "42", and `subagent: ""` would reach it as nothing.
 */
export function checkRole(id, role) {
  const problems = [];
  if (!isPlainObject(role)) return { ok: false, problems: [`roles.${id} is not an object`] };
  for (const key of ["title", "label", "name", "addendum"]) {
    if (role[key] !== undefined && typeof role[key] !== "string") problems.push(`roles.${id}.${key} is not a string`);
  }
  for (const key of ["subagent", "model"]) {
    if (role[key] === undefined || role[key] === null) continue;
    if (typeof role[key] !== "string") problems.push(`roles.${id}.${key} is not a string`);
    else if (!role[key].trim()) problems.push(`roles.${id}.${key} is empty - remove the key to fall back to the harness default`);
  }
  if (role.judge !== undefined && typeof role.judge !== "boolean") problems.push(`roles.${id}.judge is not true/false`);
  // `effort` is checked but reported separately: the harness reader ignores the key
  // entirely, so a level nobody can read is a problem for the composer's submenu, not
  // a reason to treat the whole preset file as unreadable.
  return { ok: problems.length === 0, problems, effort: checkEffort(id, role.effort) };
}

/** The whole document, checked. `roles` is the only key the harness reads. */
export function checkDoc(doc) {
  const problems = [];
  const effortProblems = [];
  if (!isPlainObject(doc)) return { ok: false, problems: ["the file is not a JSON object"], effortProblems };
  if (!isPlainObject(doc.roles)) {
    problems.push("the file has no `roles` object - the harness reads roles[<id>], so this file would be ignored");
    return { ok: false, problems, effortProblems };
  }
  for (const [id, role] of Object.entries(doc.roles)) {
    const checked = checkRole(id, role);
    problems.push(...checked.problems);
    if (!checked.effort.ok) effortProblems.push(checked.effort.problem);
  }
  return { ok: problems.length === 0, problems, effortProblems };
}

/** Parse without guessing: a file that does not parse is reported, never replaced. */
export function parseRoles(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `not valid JSON: ${reason(err)}` };
  }
  const checked = checkDoc(doc);
  if (!checked.ok) return { ok: false, error: `not a roles file: ${checked.problems.join("; ")}`, doc };
  return { ok: true, doc };
}

/**
 * Where the roles file is, and therefore where a write goes.
 *
 * The order is exactly the order `src/models.mjs` `readRoles(root)` uses -
 * `<root>/data/roles.json`, then `<root>/../data/roles.json` - and the fallback is
 * the first of those, created on the first write. Writing anywhere else would be a
 * preset the harness never reads, and this plugin's only promise about the file is
 * that changing it here changes what runs there.
 */
export function resolveRolesFile({ root = process.cwd(), config = {}, exists = existsSync } = {}) {
  const absolute = (p) => (isAbsolute(p) ? p : resolve(root, p));
  const configured = typeof config.rolesFile === "string" && config.rolesFile.trim() ? absolute(config.rolesFile) : null;
  if (configured) return { file: configured, source: "config.rolesFile", exists: exists(configured) };
  const candidates = [
    { file: join(root, "data", "roles.json"), source: "the harness root" },
    { file: join(root, "..", "data", "roles.json"), source: "one level above the harness root" },
  ];
  for (const candidate of candidates) {
    if (exists(candidate.file)) return { ...candidate, exists: true };
  }
  return { file: join(root, "data", "roles.json"), source: "the harness root (created on the first write)", exists: false };
}

/** The router: the file whose class names and curated targets a preset may name. */
export function resolveRouterFile({ root = process.cwd(), config = {}, harnessDir = HARNESS_DIR, exists = existsSync } = {}) {
  const absolute = (p) => (isAbsolute(p) ? p : resolve(root, p));
  const configured = typeof config.routerFile === "string" && config.routerFile.trim() ? absolute(config.routerFile) : null;
  if (configured) return { file: configured, exists: exists(configured) };
  const candidates = [
    join(root, "router", "router.config.json"),
    join(root, "..", "router", "router.config.json"),
    join(harnessDir, "..", "router", "router.config.json"),
  ];
  for (const file of candidates) {
    if (exists(file)) return { file, exists: true };
  }
  return { file: candidates[0], exists: false };
}

/**
 * What the router would accept as a target.
 *
 * `targets` is the CURATED list (`models[].target`), not every
 * `providers[].models` string: the curated list is the router's own statement that
 * this provider/model pair is worth routing to, and a switch that points a role at
 * something outside it is a typo nine times in ten. The remedy for the tenth is
 * printed with the refusal.
 */
export function routerFacts(config) {
  const classes = isPlainObject(config?.classes) ? config.classes : {};
  const targets = Array.isArray(config?.models) ? config.models.map((entry) => String(entry?.target ?? "").trim()).filter(Boolean) : [];
  return {
    classIds: Object.keys(classes),
    chains: Object.fromEntries(
      Object.entries(classes).map(([id, spec]) => [id, Array.isArray(spec?.chain) ? spec.chain.map(String) : []]),
    ),
    targets,
  };
}

/**
 * Is this a target a role may point at?
 *
 * Two legal shapes, one refusal that names the reason: a class the router defines
 * (a failover chain, resolved at request time) or a curated `provider/model`. A bare
 * `class:<name>` is accepted as an alias and stored as `<name>`, because both spellings
 * mean the same thing and refusing one of them would be a fact about this plugin
 * rather than about the router.
 */
export function targetCheck(target, facts) {
  const raw = String(target ?? "").trim();
  if (!raw) return { ok: false, why: "an empty target would leave the role with no model" };
  const text = raw.startsWith("class:") ? raw.slice(6).trim() : raw;
  if (!text) return { ok: false, why: "`class:` needs a class name, e.g. class:code" };
  if (facts.classIds.includes(text)) {
    return { ok: true, kind: "class", value: text, chain: facts.chains[text] ?? [], normalised: raw !== text };
  }
  if (facts.targets.includes(text)) return { ok: true, kind: "target", value: text };
  const slash = text.indexOf("/");
  const looksLikeTarget = slash > 0 && slash < text.length - 1;
  return {
    ok: false,
    why: looksLikeTarget
      ? `"${text}" looks like a provider/model target, but the router does not curate it`
      : `"${text}" is neither a router class nor a provider/model target`,
    hint: "add it to router/router.config.json models[] first, or pick one of these",
    targets: facts.targets,
    classes: facts.classIds,
  };
}

/** Every role preset, resolved: what the file says, where it points, and whether that is real. */
export function rolesReport({ doc, facts }) {
  const roles = isPlainObject(doc?.roles) ? doc.roles : {};
  const resolveOne = (value) => {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) return { target: null, valid: true, problem: null, kind: "none" };
    const check = targetCheck(text, facts);
    return { target: text, valid: check.ok, problem: check.ok ? null : check.why, kind: check.ok ? check.kind : "bad" };
  };
  return Object.entries(roles).map(([id, role]) => {
    const subagent = resolveOne(role?.subagent);
    const model = resolveOne(role?.model);
    const effort = checkEffort(id, role?.effort);
    return {
      id,
      // `title` is the documented spelling; the reader accepts `label` and `name` too.
      title: String(role?.title ?? role?.label ?? role?.name ?? "").trim() || id,
      addendum: String(role?.addendum ?? ""),
      model: model.target,
      modelValid: model.valid,
      modelProblem: model.problem,
      subagent: subagent.target,
      subagentKind: subagent.kind,
      subagentValid: subagent.valid,
      subagentProblem: subagent.problem,
      judge: role?.judge === true,
      // null here means the role has no opinion, which is legal: the picker then
      // offers whatever the chosen model supports. An unreadable level is shown as
      // the text that is in the file, so the table never claims there is no opinion
      // where the file clearly states one.
      effort: effort.ok ? effort.value : role?.effort === undefined ? null : String(role.effort),
      effortRaw: role?.effort,
      effortValid: effort.ok,
      effortProblem: effort.ok ? null : effort.problem,
      known: Boolean(DEFAULT_ROLES[id]),
      isRouterClass: facts.classIds.includes(id),
    };
  });
}

function table(rows) {
  if (!rows.length) return [];
  // A `model` column only exists for a file that uses the key: the shipped presets
  // derive their model from the role id, so a column of dashes would be noise.
  const withModel = rows.some((row) => row.model);
  const cells = (row) => [row.id, row.title, ...(withModel ? [row.model ?? "-"] : []), row.subagent ?? "-", row.judge ? "yes" : "-", row.effort ?? "-"];
  const head = ["role", "title", ...(withModel ? ["model"] : []), "subagent", "judge", "effort"];
  const widths = head.map((key, index) => Math.max(key.length, ...rows.map((row) => String(cells(row)[index]).length)));
  const line = (values) => `  ${values.map((value, index) => String(value).padEnd(widths[index])).join("  ").replace(/\s+$/, "")}`;
  return [line(head), ...rows.map((row) => line(cells(row)))];
}

function targetMenu(facts) {
  return [
    "  classes the router defines (failover chains):",
    ...(facts.classIds.length ? facts.classIds.map((id) => `    ${id}  ->  ${(facts.chains[id] ?? []).join(" -> ") || "(empty)"}`) : ["    (none - the router did not load)"]),
    "  curated targets (router/router.config.json models[]):",
    ...(facts.targets.length ? facts.targets.map((target) => `    ${target}`) : ["    (none)"]),
  ];
}

function formatAddenda(rows) {
  if (!rows.length) return [];
  const width = Math.max(...rows.map((row) => row.id.length));
  return [
    "  addenda - the paragraph each role adds to its prompt:",
    ...rows.map((row) => {
      const text = String(row.addendum ?? "").trim().replace(/\s+/g, " ");
      return `    ${row.id.padEnd(width)}  ${text || "(none - the role gets no extra instructions)"}`;
    }),
  ];
}

/** The `show` report: the file, the presets, the addenda, and what the router will refuse. */
export function formatShow({ resolved, doc, router, facts, parseError, routerProblem }) {
  const out = [`subagent models - ${resolved.file}`];
  out.push(`  source   ${resolved.source}${resolved.exists ? "" : " - the shipped presets are shown until a write creates it"}`);
  out.push(`  router   ${router.file}${router.exists ? "" : " - not found, so targets cannot be checked"}`);
  if (routerProblem) out.push(`           ${routerProblem}`);

  if (parseError) {
    out.push("", `  BROKEN   ${parseError}`, "  the file was not read, and this plugin will not overwrite it: fix the JSON or delete it.", "");
    out.push("  the shipped presets, for reference:", "", ...table(rolesReport({ doc: { roles: defaultRoles() }, facts })));
    out.push("", ...formatAddenda(rolesReport({ doc: { roles: defaultRoles() }, facts })));
    return out;
  }

  const rows = rolesReport({ doc, facts });
  out.push("", ...table(rows));
  out.push("", '  effort   preferred reasoning effort: low | medium | high; "-" means the role has no opinion');
  const bad = rows.filter((row) => !row.modelValid || !row.subagentValid);
  if (bad.length) {
    out.push("", "  targets the router does not have:");
    for (const row of bad) {
      if (!row.modelValid) out.push(`    ${row.id}.model = ${row.model} - ${row.modelProblem}`);
      if (!row.subagentValid) out.push(`    ${row.id}.subagent = ${row.subagent} - ${row.subagentProblem}`);
    }
    out.push("", ...targetMenu(facts));
  }
  const badEffort = rows.filter((row) => !row.effortValid);
  if (badEffort.length) {
    out.push("", "  effort levels this file asks for that are not low | medium | high:");
    for (const row of badEffort) out.push(`    ${row.effortProblem}`);
    out.push("", "  The composer's effort submenu cannot read those, and this plugin will not rewrite the file", "  until one of the three level names is there - or the key is gone.");
  }
  if (!router.exists || routerProblem) out.push("", "  targets were not checked against the router.");
  out.push(
    "",
    ...formatAddenda(rows),
    "",
    "  set <role> <target>   what this role's workers start on (writes the file)",
    "  reset <role>          restores that role's shipped preset",
    "  the role id is the router class it routes through; the composer's model dropdown overrides it",
  );
  return out;
}

/**
 * Write the file the way the rest of the harness writes: a temp file beside the
 * target, then a rename, so a crash mid-write leaves the old presets intact rather
 * than half of the new ones. A failed rename removes the temp file: a `.tmp` left in
 * `data/` would be a preset file the next reader might open by mistake.
 */
export function writeRolesFile(file, doc, { writeFile = writeFileSync, rename = renameSync, mkdir = mkdirSync, unlink = unlinkSync } = {}) {
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFile(temp, text, "utf8");
  try {
    rename(temp, file);
  } catch (err) {
    try {
      unlink(temp);
    } catch {
      // The temp file is already gone, or cannot be removed; the original error is
      // the one worth reporting.
    }
    throw err;
  }
  return { file, bytes: Buffer.byteLength(text), text };
}

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

/**
 * Everything touching the disk is injectable, so the tests can drive a temporary
 * roles file, a temporary router and a read-only directory without touching the
 * real ones.
 */
export function createSubagentSwitch(deps = {}) {
  const read = deps.readFile ?? ((file) => readFileSync(file, "utf8"));
  const exists = deps.exists ?? existsSync;
  const harnessDir = deps.harnessDir ?? HARNESS_DIR;
  const write = deps.writeFile ?? ((file, text, encoding) => writeFileSync(file, text, encoding));
  const rename = deps.rename ?? renameSync;
  const mkdir = deps.mkdir ?? mkdirSync;
  const unlink = deps.unlink ?? unlinkSync;

  const state = (ctx) => {
    const config = ctx?.config ?? {};
    const root = ctx?.root ?? process.cwd();
    const resolved = resolveRolesFile({ root, config, exists });
    const router = resolveRouterFile({ root, config, harnessDir, exists });

    let facts = routerFacts(null);
    let routerProblem = null;
    if (!router.exists) routerProblem = "there is no router.config.json at that path";
    else {
      try {
        const parsed = JSON.parse(read(router.file));
        facts = routerFacts(parsed);
        if (!facts.targets.length && !facts.classIds.length) routerProblem = "it defines neither models[] nor classes{}";
      } catch (err) {
        routerProblem = `it did not parse: ${reason(err)}`;
      }
    }

    let doc = { roles: defaultRoles() };
    let docExists = resolved.exists;
    let parseError = null;
    if (resolved.exists) {
      try {
        const parsed = parseRoles(read(resolved.file));
        if (parsed.ok) doc = parsed.doc;
        else {
          parseError = parsed.error;
          doc = null;
        }
      } catch (err) {
        parseError = `it could not be read: ${reason(err)}`;
        doc = null;
      }
    }
    return { resolved: { ...resolved, exists: docExists }, router, facts, routerProblem, doc, parseError, config, root };
  };

  /** Guards shared by every write path. */
  const blocked = (view) => {
    if (!view.parseError) return null;
    return [
      `REFUSED - ${view.resolved.file} is not a roles file this plugin can read safely.`,
      `  ${view.parseError}`,
      "",
      "  Writing now would replace whatever is in that file with something this plugin made up.",
      "  Fix the JSON (or delete the file, and the shipped presets come back), then ask again.",
    ].join("\n");
  };

  const save = (view, doc) => {
    const checked = checkDoc(doc);
    if (!checked.ok) return { ok: false, error: `refusing to write a file the harness cannot read: ${checked.problems.join("; ")}` };
    // A level the composer cannot read is refused rather than carried forward: writing
    // it back would keep a preference that silently does nothing. `reset <role>` is the
    // repair, because the shipped preset carries no effort at all.
    if (checked.effortProblems.length) {
      return {
        ok: false,
        error: `refusing to write a file the composer cannot read: ${checked.effortProblems.join("; ")} - set one of the three levels, remove the key, or run \`reset <role>\` to restore the shipped preset`,
      };
    }
    try {
      const written = writeRolesFile(view.resolved.file, doc, { writeFile: write, rename, mkdir, unlink });
      return { ok: true, written };
    } catch (err) {
      // A read-only directory or a locked file is a fact about the machine, not a
      // crash: say which file could not be written and leave the caller's text alone.
      return { ok: false, error: `the write to ${view.resolved.file} failed: ${reason(err)}` };
    }
  };

  const usageSet = (view) =>
    [
      "usage: rosa-subagent-model-switch:set <role> <target>",
      "",
      `  roles in the file: ${Object.keys(view.doc.roles).join(", ") || "(none)"}`,
      "",
      ...targetMenu(view.facts),
    ].join("\n");

  const applySet = (view, roleArg, targetArg) => {
    const refusal = blocked(view);
    if (refusal) return refusal;
    const role = String(roleArg ?? "").trim();
    const current = Object.keys(view.doc.roles);
    if (!role) return usageSet(view);
    if (!current.includes(role)) {
      return [
        `REFUSED - there is no role "${role}".`,
        "",
        `  roles in ${view.resolved.file}: ${current.join(", ") || "(none)"}`,
        `  classes the router defines: ${view.facts.classIds.join(", ") || "(none - the router did not load)"}`,
        "",
        "  This edits a preset that exists; a role no run names would be a preset nobody reads.",
        "  To add one, copy an entry in the file by hand - `title` and `addendum` are the parts",
        "  the harness cannot guess.",
      ].join("\n");
    }
    // A missing argument is a usage mistake; a present-but-empty one is a target the
    // caller chose. Both are refused, and neither writes anything.
    if (targetArg === undefined || targetArg === null) return usageSet(view);
    const check = targetCheck(targetArg, view.facts);
    if (!check.ok) {
      const out = [`REFUSED - ${check.why}`, ""];
      if (check.hint) out.push(`  ${check.hint}`, "");
      out.push(...targetMenu(view.facts), "", `  nothing was written. ${view.resolved.file} is unchanged.`);
      return out.join("\n");
    }
    const previous = isPlainObject(view.doc.roles[role]) ? view.doc.roles[role] : {};
    const next = { ...view.doc.roles, [role]: { ...previous, subagent: check.value } };
    const result = save(view, { ...view.doc, roles: next });
    if (!result.ok) return `REFUSED - ${result.error}`;
    const out = [
      `set ${role}.subagent -> ${check.value}${check.normalised ? "  (class: prefix dropped: the key stores the class name itself)" : ""}`,
      `  file     ${result.written.file} (${result.written.bytes} bytes, temp file then rename)`,
      `  previous ${typeof previous.subagent === "string" ? previous.subagent : "(none - workers used the harness default class)"}`,
      `  role     title "${String(next[role].title ?? next[role].label ?? role)}", judge ${next[role].judge === true ? "yes" : "no"}${next[role].effort ? `, effort ${next[role].effort}` : ""}`,
    ];
    if (check.kind === "class") out.push(`  chain    ${check.chain.join(" -> ") || "(empty - the class has no targets, so a worker on it would fail)"}`);
    if (!String(next[role].addendum ?? "").trim()) {
      out.push(`  note     this role has no addendum, so it gets no role instructions; \`reset ${role}\` restores the shipped text`);
    }
    out.push("", "  takes effect the next time the harness reads its roles: a run that is already going keeps the model it started on.");
    return out.join("\n");
  };

  const applyReset = (view, roleArg) => {
    const refusal = blocked(view);
    if (refusal) return refusal;
    const role = String(roleArg ?? "").trim();
    if (!role) return `usage: rosa-subagent-model-switch:reset <role>\n\n  roles with a shipped preset: ${Object.keys(DEFAULT_ROLES).join(", ")}`;
    if (!DEFAULT_ROLES[role]) {
      return [
        `REFUSED - "${role}" has no shipped preset to restore.`,
        "",
        `  roles with a preset: ${Object.keys(DEFAULT_ROLES).join(", ")}`,
        `  ${role} was added by hand, so its text is yours; \`set ${role} <target>\` still points it at a real target.`,
      ].join("\n");
    }
    const previous = isPlainObject(view.doc.roles[role]) ? view.doc.roles[role] : null;
    const result = save(view, { ...view.doc, roles: { ...view.doc.roles, [role]: defaultRoles()[role] } });
    if (!result.ok) return `REFUSED - ${result.error}`;
    return [
      `reset ${role}`,
      `  file     ${result.written.file} (${result.written.bytes} bytes, temp file then rename)`,
      `  previous ${typeof previous?.subagent === "string" ? previous.subagent : "(none)"} -> ${DEFAULT_ROLES[role].subagent}`,
      `  restored title "${DEFAULT_ROLES[role].title}", subagent ${DEFAULT_ROLES[role].subagent}, addendum and judge flag`,
      "",
      "  takes effect the next time the harness reads its roles.",
    ].join("\n");
  };

  const describe = (ctx) => formatShow(state(ctx));

  return {
    id: "rosa-subagent-model-switch",
    description:
      "Read and write the role presets in data/roles.json - which model a worker of each role starts on, its title, prompt addendum, judge flag and optional effort level - validating every target against the router",

    commands(ctx) {
      return {
        // What the presets are, where the file is, and which targets are not real.
        show: async () => describe(ctx).join("\n"),
        // Point a role's workers at a router class or a curated provider/model.
        set: async (argv) => applySet(state(ctx), Array.isArray(argv) ? argv[0] : undefined, Array.isArray(argv) ? argv[1] : undefined),
        // Restore one role's shipped preset.
        reset: async (argv) => applyReset(state(ctx), Array.isArray(argv) ? argv[0] : undefined),
      };
    },

    tools(ctx) {
      return [
        {
          name: "subagent_model_show",
          description:
            "Show the role presets in data/roles.json: for each role, the model its workers start on, the role's title, its judge flag and its prompt addendum - plus any target the router does not actually offer.",
          parameters: { type: "object", properties: {} },
          async run() {
            return describe(ctx).join("\n");
          },
        },
        {
          name: "subagent_model_set",
          description:
            "Point one role's workers at a different model and write data/roles.json. The target must be a router class (a failover chain) or a curated provider/model from router.config.json; anything else is refused and nothing is written.",
          parameters: {
            type: "object",
            properties: {
              role: { type: "string", description: "The role to change, as it appears in data/roles.json (orchestrate, code, fast, judge, deepseek, rosalena)." },
              target: { type: "string", description: "A router class name (orchestrate, code, fast, judge, deepseek, rosalena) or a curated provider/model target." },
            },
            required: ["role", "target"],
          },
          async run(args) {
            return applySet(state(ctx), args?.role, args?.target);
          },
        },
      ];
    },

    // Static and file-only on purpose: listing the plugins must not depend on the
    // router being up, and must not write anything.
    status(ctx) {
      const view = state(ctx);
      if (view.parseError) return `roles file unreadable (${view.parseError})`;
      const rows = rolesReport({ doc: view.doc, facts: view.facts });
      const worker = rows.find((row) => row.id === "code") ?? rows[0];
      const bad = rows.filter((row) => !row.modelValid || !row.subagentValid).length;
      const where = view.resolved.file.replace(/^.*[\\/]/, "");
      return `${rows.length} role(s) in ${where}${view.resolved.exists ? "" : " (not written yet)"}${
        worker?.subagent ? `, code workers -> ${worker.subagent}` : ""
      }${bad ? `, ${bad} target(s) the router does not have` : ""}`;
    },
  };
}

export default createSubagentSwitch();
