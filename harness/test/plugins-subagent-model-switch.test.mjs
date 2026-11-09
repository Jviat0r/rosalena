// The subagent-model-switch plugin: the role presets file, read and written safely.
//
// Every test drives a temporary root. That is not tidiness - the plugin's one promise
// is that a write lands in the file the harness reads and nowhere else, and the way to
// test that promise is to point it at a directory and check the real presets are
// untouched afterwards.
//
// No network, no router process, no model call: the router is a two-target fixture on
// disk and every target check is arithmetic on JSON.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import plugin, {
  DEFAULT_ROLES,
  EFFORT_LEVELS,
  checkDoc,
  checkEffort,
  checkRole,
  createSubagentSwitch,
  defaultRoles,
  formatShow,
  parseRoles,
  resolveRolesFile,
  resolveRouterFile,
  rolesReport,
  routerFacts,
  targetCheck,
  writeRolesFile,
} from "../plugins/rosa-subagent-model-switch/plugin.mjs";
import { readRoles, readRouterConfig, rolesFromRouter } from "../src/models.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
// <harness> - where the shipped copy of data/roles.json and the real router live.
const HARNESS = join(HERE, "..");

// The shape of the real router, trimmed to what a target check can see: four classes
// with failover chains, and the curated list those chains point into.
const ROUTER = {
  classes: {
    orchestrate: { chain: ["local/qwen3.8-27b", "anthropic/claude-sonnet-4-5"] },
    code: { chain: ["local/qwen3.8-27b"] },
    fast: { chain: ["local/qwen3.8-27b", "google/gemini-2.5-flash"] },
    judge: { chain: ["anthropic/claude-sonnet-4-5"] },
  },
  models: [
    { target: "local/qwen3.8-27b" },
    { target: "anthropic/claude-sonnet-4-5" },
    { target: "google/gemini-2.5-flash" },
  ],
};

const tempRoots = [];
/** A throwaway harness root: start empty, or with a roles file and/or a router. */
function makeRoot({ roles = null, router = ROUTER, rawRoles = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "sms-"));
  tempRoots.push(root);
  mkdirSync(join(root, "data"), { recursive: true });
  if (rawRoles !== null) writeFileSync(join(root, "data", "roles.json"), rawRoles, "utf8");
  else if (roles) writeFileSync(join(root, "data", "roles.json"), `${JSON.stringify(roles, null, 2)}\n`, "utf8");
  if (router) {
    mkdirSync(join(root, "router"), { recursive: true });
    writeFileSync(join(root, "router", "router.config.json"), JSON.stringify(router), "utf8");
  }
  return root;
}

const ctxFor = (root, extra = {}) => ({ root, config: {}, harness: {}, builtinTools: {}, createTools: () => ({}), log: {}, ...extra });
const rolesIn = (root) => JSON.parse(readFileSync(join(root, "data", "roles.json"), "utf8"));
const dataDir = (root) => readdirSync(join(root, "data")).sort();

test.after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The shipped presets and the validator
// ---------------------------------------------------------------------------

test("the shipped presets are the router classes, each with an addendum that changes behaviour", () => {
  assert.deepEqual(Object.keys(DEFAULT_ROLES).sort(), ["code", "deepseek", "fast", "judge", "orchestrate", "rosalena"]);
  for (const [id, role] of Object.entries(DEFAULT_ROLES)) {
    assert.deepEqual(Object.keys(role).sort(), ["addendum", "judge", "subagent", "title"], `${id} has exactly the documented keys`);
    assert.equal(typeof role.title, "string");
    assert.ok(role.title.length > 2, `${id}.title is a label`);
    // The addendum is the substance of the file: a restatement of the name is not one.
    assert.ok(role.addendum.length > 120, `${id}.addendum is a paragraph, not a label (${role.addendum.length} chars)`);
    assert.notEqual(role.addendum, role.title, `${id}.addendum is not just the label`);
    assert.ok(role.addendum.split(/\s+/).length > 20, `${id}.addendum says what the role does`);
    assert.ok(role.addendum.includes("."), `${id}.addendum is prose`);
  }
  assert.equal(DEFAULT_ROLES.judge.judge, true);
  assert.equal(DEFAULT_ROLES.orchestrate.judge, false);
  assert.notEqual(DEFAULT_ROLES.fast.addendum, DEFAULT_ROLES.code.addendum);
});

test("defaultRoles hands out a copy: a caller cannot edit the shipped presets", () => {
  const first = defaultRoles();
  first.code.subagent = "something/else";
  first.code.note = "extra";
  assert.equal(defaultRoles().code.subagent, "code");
  assert.equal(defaultRoles().code.note, undefined);
  assert.equal(DEFAULT_ROLES.code.subagent, "code");
});

test("checkRole: accepts the documented keys and the aliases, rejects the wrong types", () => {
  assert.equal(checkRole("code", DEFAULT_ROLES.code).ok, true);
  // `label` and `name` are read as aliases for `title` by the shipped reader.
  assert.equal(checkRole("code", { label: "Worker", addendum: "x", subagent: "code", judge: false }).ok, true);
  assert.equal(checkRole("code", { name: "Worker" }).ok, true);
  // Absent subagent is legal: the harness default worker class applies.
  assert.equal(checkRole("code", { title: "Code" }).ok, true);

  assert.equal(checkRole("code", { title: 5 }).ok, false);
  assert.equal(checkRole("code", { addendum: [] }).ok, false);
  assert.equal(checkRole("code", { judge: "yes" }).ok, false);
  assert.equal(checkRole("code", { subagent: 42 }).ok, false);
  assert.equal(checkRole("code", { subagent: "" }).ok, false, "an empty target is a typo, not a default");
  assert.equal(checkRole("code", { subagent: "   " }).ok, false);
  assert.equal(checkRole("code", null).ok, false);

  const empty = checkRole("code", { subagent: "" }).problems.join(" ");
  assert.match(empty, /roles\.code\.subagent is empty/);
  assert.match(empty, /remove the key to fall back/);
});

test("checkDoc: a file without a roles object would be ignored by the harness, so it is refused", () => {
  assert.equal(checkDoc({ roles: { code: DEFAULT_ROLES.code } }).ok, true);
  assert.equal(checkDoc(null).ok, false);
  assert.equal(checkDoc([]).ok, false);
  const noRoles = checkDoc({ presets: {} });
  assert.equal(noRoles.ok, false);
  assert.match(noRoles.problems.join(" "), /no `roles` object/);
  assert.match(checkDoc({ roles: { code: { judge: 1 } } }).problems.join(" "), /roles\.code\.judge/);
});

test("parseRoles: valid JSON that is not a roles file is reported as such, not as a parse error", () => {
  assert.equal(parseRoles(JSON.stringify({ roles: { fast: DEFAULT_ROLES.fast } })).ok, true);
  const broken = parseRoles("{ nope");
  assert.equal(broken.ok, false);
  assert.match(broken.error, /not valid JSON/);
  const wrongShape = parseRoles(JSON.stringify({ subagents: [] }));
  assert.equal(wrongShape.ok, false);
  assert.match(wrongShape.error, /not a roles file/);
});

// ---------------------------------------------------------------------------
// Where the file is
// ---------------------------------------------------------------------------

test("resolveRolesFile: config, then the harness root, then one level above, then a path created on the first write", () => {
  const root = makeRoot({ router: null });
  const exists = (file) => existsSync(file);

  // Nothing on disk yet: the write target is <root>/data/roles.json, and it says so.
  const fresh = resolveRolesFile({ root, config: {}, exists });
  assert.equal(fresh.file, join(root, "data", "roles.json"));
  assert.equal(fresh.exists, false);
  assert.match(fresh.source, /created on the first write/);

  // A file one level up is what models.mjs would read, so it is what this writes.
  const above = mkdtempSync(join(tmpdir(), "sms-above-"));
  tempRoots.push(above);
  mkdirSync(join(above, "data"), { recursive: true });
  writeFileSync(join(above, "data", "roles.json"), JSON.stringify({ roles: {} }), "utf8");
  const harness = join(above, "harness");
  mkdirSync(harness, { recursive: true });
  const inherited = resolveRolesFile({ root: harness, config: {}, exists });
  assert.equal(inherited.file, join(above, "data", "roles.json"));
  assert.equal(inherited.exists, true);

  // An explicit config wins over both.
  const configured = resolveRolesFile({ root, config: { rolesFile: "config/roles.json" }, exists });
  assert.equal(configured.file, join(root, "config", "roles.json"));
  assert.equal(configured.source, "config.rolesFile");
});

test("resolveRouterFile: the sibling router, then one level up, then the copy beside the harness", () => {
  const root = makeRoot();
  assert.equal(resolveRouterFile({ root, config: {}, exists: existsSync }).file, join(root, "router", "router.config.json"));

  const bare = mkdtempSync(join(tmpdir(), "sms-norouter-"));
  tempRoots.push(bare);
  const missing = resolveRouterFile({ root: bare, config: {}, harnessDir: join(bare, "nowhere"), exists: existsSync });
  assert.equal(missing.exists, false);

  const configured = resolveRouterFile({ root, config: { routerFile: "custom.json" }, exists: existsSync });
  assert.equal(configured.file, join(root, "custom.json"));
});

// ---------------------------------------------------------------------------
// Target checks: the rule the plugin exists for
// ---------------------------------------------------------------------------

test("targetCheck: a router class or a curated target is legal, and nothing else is", () => {
  const facts = routerFacts(ROUTER);
  assert.deepEqual(facts.classIds, ["orchestrate", "code", "fast", "judge"]);
  assert.equal(facts.targets.length, 3);

  const cls = targetCheck("code", facts);
  assert.equal(cls.ok, true);
  assert.equal(cls.kind, "class");
  assert.deepEqual(cls.chain, ["local/qwen3.8-27b"]);

  const target = targetCheck("google/gemini-2.5-flash", facts);
  assert.equal(target.ok, true);
  assert.equal(target.kind, "target");

  // A bare class name is what the harness resolves; the `class:` spelling means the
  // same thing and is stored as the bare name.
  const alias = targetCheck("class:fast", facts);
  assert.equal(alias.ok, true);
  assert.equal(alias.value, "fast");
  assert.equal(alias.normalised, true);
});

test("targetCheck: refusals name the reason and list what would have worked", () => {
  const facts = routerFacts(ROUTER);

  const uncurated = targetCheck("openai/gpt-4o", facts);
  assert.equal(uncurated.ok, false);
  assert.match(uncurated.why, /looks like a provider\/model target, but the router does not curate it/);
  assert.deepEqual(uncurated.targets, facts.targets);
  assert.deepEqual(uncurated.classes, facts.classIds);
  assert.match(uncurated.hint, /add it to router\/router.config.json models\[\] first/);

  const nonsense = targetCheck("qwen9", facts);
  assert.equal(nonsense.ok, false);
  assert.match(nonsense.why, /neither a router class nor a provider\/model target/);

  assert.match(targetCheck("", facts).why, /empty target/);
  assert.match(targetCheck("   ", facts).why, /empty target/);
  assert.match(targetCheck("class:", facts).why, /`class:` needs a class name/);
  assert.match(targetCheck(undefined, facts).why, /empty target/);

  // With no router at all, nothing is a valid target - and the refusal still lists.
  const nothing = routerFacts(null);
  assert.deepEqual(nothing.classIds, []);
  assert.equal(targetCheck("code", nothing).ok, false);
  assert.equal(targetCheck("local/qwen3.8-27b", nothing).ok, false);
});

test("rolesReport: title aliases, the judge flag, and each target marked valid or not", () => {
  const facts = routerFacts(ROUTER);
  const rows = rolesReport({
    doc: {
      roles: {
        code: { title: "Code", addendum: "a", subagent: "code", judge: false },
        fast: { label: "Fast", subagent: "nowhere/nothing" },
        judge: { name: "Judge", judge: true },
        odd: { subagent: "openai/gpt-4o", model: "code" },
      },
    },
    facts,
  });
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  assert.equal(byId.code.title, "Code");
  assert.equal(byId.fast.title, "Fast", "label is an alias for title");
  assert.equal(byId.judge.title, "Judge", "name is an alias for title");
  assert.equal(byId.judge.judge, true);
  assert.equal(byId.odd.title, "odd", "no title falls back to the id");
  assert.equal(byId.code.subagentValid, true);
  assert.equal(byId.code.isRouterClass, true);
  assert.equal(byId.fast.subagentValid, false);
  assert.match(byId.fast.subagentProblem, /does not curate it/);
  assert.equal(byId.odd.modelValid, true, "a file that uses model still gets it checked");
  assert.equal(byId.odd.known, false);
});

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

test("show: with no file yet it reports the shipped presets, the paths, and how to write", async () => {
  const root = makeRoot();
  const commands = createSubagentSwitch().commands(ctxFor(root));
  const out = await commands.show([]);

  assert.ok(out.includes(`subagent models - ${join(root, "data", "roles.json")}`));
  assert.match(out, /source\s+the harness root \(created on the first write\) - the shipped presets are shown until a write creates it/);
  assert.ok(out.includes(join(root, "router", "router.config.json")));
  assert.match(out, /role\s+title\s+subagent\s+judge/);
  assert.match(out, /orchestrate\s+Orchestrator\s+code\s+-/);
  assert.match(out, /judge\s+Judge\s+code\s+yes/);
  assert.match(out, /addenda - the paragraph each role adds to its prompt:/);
  for (const role of Object.values(DEFAULT_ROLES)) assert.ok(out.includes(role.addendum), "each addendum is printed in full");
  assert.match(out, /set <role> <target>/);
  assert.match(out, /reset <role>/);
  // Reading must not create the file.
  assert.equal(existsSync(join(root, "data", "roles.json")), false);
});

test("show: a file that uses `model` gets a model column, and an uncurated target is named with the menu", async () => {
  const root = makeRoot({
    roles: { roles: { code: { title: "Code", subagent: "openai/gpt-4o", model: "code" }, fast: { title: "Fast", subagent: "fast" } } },
  });
  const out = await createSubagentSwitch().commands(ctxFor(root)).show([]);
  assert.match(out, /role\s+title\s+model\s+subagent\s+judge/);
  assert.match(out, /code\s+Code\s+code\s+openai\/gpt-4o\s+-/);
  assert.match(out, /targets the router does not have:/);
  assert.ok(out.includes("code.subagent = openai/gpt-4o"));
  assert.match(out, /curated targets \(router\/router.config.json models\[\]\)/);
});

// ---------------------------------------------------------------------------
// set
// ---------------------------------------------------------------------------

test("set: writes the file under the root it was given, keeps the keys it does not own, and reports the previous value", async () => {
  const root = makeRoot({
    roles: { $note: "hand written", roles: { code: { ...DEFAULT_ROLES.code, extra: "kept" }, fast: DEFAULT_ROLES.fast } },
  });
  const out = await createSubagentSwitch().commands(ctxFor(root)).set(["code", "google/gemini-2.5-flash"]);

  assert.match(out, /set code\.subagent -> google\/gemini-2\.5-flash/);
  assert.match(out, /previous code/);
  assert.match(out, /role\s+title "Code", judge no/);
  assert.match(out, /temp file then rename/);
  assert.match(out, /takes effect the next time the harness reads its roles/);

  const written = rolesIn(root);
  assert.equal(written.roles.code.subagent, "google/gemini-2.5-flash");
  assert.equal(written.roles.code.title, "Code", "the rest of the preset is untouched");
  assert.equal(written.roles.code.addendum, DEFAULT_ROLES.code.addendum);
  assert.equal(written.roles.code.extra, "kept", "a key this plugin does not know survives");
  assert.equal(written.$note, "hand written", "top-level keys survive");
  assert.equal(written.roles.fast.subagent, "fast", "the other roles are untouched");
  assert.deepEqual(dataDir(root), ["roles.json"], "no .tmp left beside the file");
});

test("set: a class name is stored as the class, and the chain it will fail over through is printed", async () => {
  const root = makeRoot({ roles: { roles: defaultRoles() } });
  const out = await createSubagentSwitch().commands(ctxFor(root)).set(["orchestrate", "class:fast"]);
  assert.match(out, /set orchestrate\.subagent -> fast/);
  assert.match(out, /\(class: prefix dropped: the key stores the class name itself\)/);
  assert.match(out, /chain\s+local\/qwen3\.8-27b -> google\/gemini-2\.5-flash/);
  assert.equal(rolesIn(root).roles.orchestrate.subagent, "fast");
});

test("set: an unknown role is refused with the roles it does have, and nothing is written", async () => {
  const root = makeRoot({ roles: { roles: defaultRoles() } });
  const before = readFileSync(join(root, "data", "roles.json"), "utf8");
  const out = await createSubagentSwitch().commands(ctxFor(root)).set(["worker", "code"]);

  assert.match(out, /REFUSED - there is no role "worker"\./);
  assert.match(out, /roles in .*roles\.json: orchestrate, code, fast, judge/);
  assert.match(out, /editor|copy an entry in the file by hand/);
  assert.equal(readFileSync(join(root, "data", "roles.json"), "utf8"), before);
});

test("set: an uncurated target is refused, listed against what exists, and nothing is written", async () => {
  const root = makeRoot({ roles: { roles: defaultRoles() } });
  const before = readFileSync(join(root, "data", "roles.json"), "utf8");
  const commands = createSubagentSwitch().commands(ctxFor(root));

  const out = await commands.set(["judge", "openai/gpt-4o"]);
  assert.match(out, /REFUSED - "openai\/gpt-4o" looks like a provider\/model target/);
  assert.match(out, /classes the router defines \(failover chains\):/);
  assert.match(out, /judge\s+->\s+anthropic\/claude-sonnet-4-5/);
  assert.match(out, /google\/gemini-2\.5-flash/);
  assert.match(out, /nothing was written\./);
  assert.equal(readFileSync(join(root, "data", "roles.json"), "utf8"), before);

  const empty = await commands.set(["judge"]);
  assert.match(empty, /usage: rosa-subagent-model-switch:set <role> <target>/);
  assert.match(empty, /roles in the file: orchestrate, code, fast, judge/);

  // A present-but-empty target is a target the caller chose: refused as such, and the
  // refusal has to read as a sentence (no `hint: undefined` leaking into the text).
  const blank = await commands.set(["judge", "   "]);
  assert.match(blank, /REFUSED - an empty target/);
  assert.doesNotMatch(blank, /undefined/);
  assert.match(blank, /nothing was written\./);
  assert.equal(readFileSync(join(root, "data", "roles.json"), "utf8"), before);
});

test("set: warns when the role it just pointed has no addendum, and says the reset puts the text back", async () => {
  const root = makeRoot({ roles: { roles: { code: { title: "Code", subagent: "code", addendum: "" } } } });
  const out = await createSubagentSwitch().commands(ctxFor(root)).set(["code", "fast"]);
  assert.match(out, /note\s+this role has no addendum/);
  assert.match(out, /`reset code` restores the shipped text/);
});

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

test("reset: restores a shipped preset exactly, and reports the target it replaced", async () => {
  const root = makeRoot({ roles: { roles: { code: { title: "Mine", addendum: "mine", subagent: "google/gemini-2.5-flash" } } } });
  const out = await createSubagentSwitch().commands(ctxFor(root)).reset(["code"]);

  assert.match(out, /reset code/);
  assert.match(out, /previous google\/gemini-2\.5-flash -> code/);
  assert.match(out, /restored title "Code", subagent code, addendum and judge flag/);
  assert.deepEqual(rolesIn(root).roles.code, DEFAULT_ROLES.code);
  assert.deepEqual(dataDir(root), ["roles.json"]);
});

test("reset: a role with no shipped preset is refused rather than invented", async () => {
  const root = makeRoot({ roles: { roles: { ...defaultRoles(), reviewer: { title: "Reviewer", subagent: "judge" } } } });
  const before = readFileSync(join(root, "data", "roles.json"), "utf8");
  const commands = createSubagentSwitch().commands(ctxFor(root));

  const out = await commands.reset(["reviewer"]);
  assert.match(out, /REFUSED - "reviewer" has no shipped preset to restore\./);
  assert.match(out, /roles with a preset: orchestrate, code, fast, judge/);
  assert.equal(readFileSync(join(root, "data", "roles.json"), "utf8"), before);

  assert.match(await commands.reset([]), /usage: rosa-subagent-model-switch:reset <role>/);
});

// ---------------------------------------------------------------------------
// The refusals that protect a hand-edited file
// ---------------------------------------------------------------------------

test("a corrupt file is shown as broken, refused for writing, and left byte-identical", async () => {
  const broken = '{ "roles": { "code": ';
  const root = makeRoot({ rawRoles: broken });
  const commands = createSubagentSwitch().commands(ctxFor(root));

  const out = await commands.show([]);
  assert.match(out, /BROKEN\s+not valid JSON/);
  assert.match(out, /this plugin will not overwrite it/);
  assert.match(out, /the shipped presets, for reference:/);
  assert.match(out, /orchestrate\s+Orchestrator\s+code\s+-/, "the shipped presets are shown for reference");

  const set = await commands.set(["code", "fast"]);
  assert.match(set, /REFUSED - .* is not a roles file this plugin can read safely/);
  assert.match(set, /Writing now would replace whatever is in that file/);
  const reset = await commands.reset(["code"]);
  assert.match(reset, /REFUSED/);

  assert.equal(readFileSync(join(root, "data", "roles.json"), "utf8"), broken, "the operator's file is untouched");
  assert.deepEqual(dataDir(root), ["roles.json"], "no .tmp left behind");
});

test("a roles file that parses but is the wrong shape is also refused, not rewritten", async () => {
  const root = makeRoot({ rawRoles: JSON.stringify({ subagents: { code: { model: "x" } } }) });
  const commands = createSubagentSwitch().commands(ctxFor(root));
  const out = await commands.set(["code", "fast"]);
  assert.match(out, /REFUSED/);
  assert.match(out, /no `roles` object|not a roles file/);
  assert.match(readFileSync(join(root, "data", "roles.json"), "utf8"), /"subagents"/);
});

test("a write that fails reports the file and the reason instead of throwing", async () => {
  const root = makeRoot({ roles: { roles: defaultRoles() } });
  const plugin = createSubagentSwitch({
    writeFile: () => {
      throw new Error("EPERM: operation not permitted");
    },
  });
  const out = await plugin.commands(ctxFor(root)).set(["code", "fast"]);
  assert.match(out, /REFUSED - the write to .*roles\.json failed: EPERM/);
  assert.equal(rolesIn(root).roles.code.subagent, "code", "the old presets survive a failed write");
});

test("writeRolesFile: a failed rename removes the temp file and keeps the old contents", () => {
  const root = makeRoot({ roles: { roles: defaultRoles() } });
  const file = join(root, "data", "roles.json");
  const before = readFileSync(file, "utf8");
  assert.throws(
    () =>
      writeRolesFile(file, { roles: { code: { title: "New" } } }, {
        rename: () => {
          throw new Error("EBUSY: resource busy or locked");
        },
      }),
    /EBUSY/,
  );
  assert.equal(readFileSync(file, "utf8"), before);
  assert.deepEqual(dataDir(root), ["roles.json"], "the .tmp was cleaned up");
});

// ---------------------------------------------------------------------------
// The tools, the status line, and the promise about the real file
// ---------------------------------------------------------------------------

test("the tools do what the commands do, including the refusals", async () => {
  const root = makeRoot({ roles: { roles: defaultRoles() } });
  const plugin = createSubagentSwitch();
  const tools = plugin.tools(ctxFor(root));
  assert.deepEqual(tools.map((tool) => tool.name), ["subagent_model_show", "subagent_model_set"]);

  const shown = await tools[0].run({});
  assert.equal(shown, await plugin.commands(ctxFor(root)).show([]));

  const set = await tools[1].run({ role: "fast", target: "anthropic/claude-sonnet-4-5" });
  assert.match(set, /set fast\.subagent -> anthropic\/claude-sonnet-4-5/);
  assert.equal(rolesIn(root).roles.fast.subagent, "anthropic/claude-sonnet-4-5");

  const refused = await tools[1].run({ role: "fast", target: "not/a/target" });
  assert.match(refused, /REFUSED/);
  assert.equal(rolesIn(root).roles.fast.subagent, "anthropic/claude-sonnet-4-5", "a refused tool call writes nothing");

  // The tool's declared parameters are the two it reads.
  assert.deepEqual(tools[1].parameters.required, ["role", "target"]);
  assert.deepEqual(Object.keys(tools[1].parameters.properties).sort(), ["role", "target"]);
});

test("status is file-only: it reads the presets, names the worker target, and writes nothing", () => {
  const root = makeRoot({ roles: { roles: { ...defaultRoles(), code: { ...DEFAULT_ROLES.code, subagent: "google/gemini-2.5-flash" } } } });
  const before = readFileSync(join(root, "data", "roles.json"), "utf8");
  const status = plugin.status(ctxFor(root));
  assert.match(status, /^6 role\(s\) in roles\.json/);
  assert.match(status, /code workers -> google\/gemini-2\.5-flash$/);
  assert.equal(readFileSync(join(root, "data", "roles.json"), "utf8"), before);
});

test("status: names an unwritten file, a broken file, and a target the router does not have", () => {
  const fresh = makeRoot();
  assert.match(plugin.status(ctxFor(fresh)), /6 role\(s\) in roles\.json \(not written yet\)/);

  const broken = makeRoot({ rawRoles: "nope" });
  assert.match(plugin.status(ctxFor(broken)), /^roles file unreadable \(not valid JSON/);

  const bad = makeRoot({ roles: { roles: { code: { ...DEFAULT_ROLES.code, subagent: "openai/gpt-4o" } } } });
  assert.match(plugin.status(ctxFor(bad)), /1 target\(s\) the router does not have/);
});

test("a write under a temporary root never touches the presets that ship beside the plugin", async () => {
  const real = join(HARNESS, "..", "data", "roles.json");
  const shipped = join(HARNESS, "data", "roles.json");
  const snapshot = (file) => (existsSync(file) ? readFileSync(file, "utf8") : null);
  const before = { real: snapshot(real), shipped: snapshot(shipped) };

  const root = makeRoot();
  const commands = createSubagentSwitch().commands(ctxFor(root));
  await commands.set(["code", "google/gemini-2.5-flash"]);
  await commands.reset(["code"]);

  assert.ok(existsSync(join(root, "data", "roles.json")), "the write landed in the temporary root");
  assert.equal(snapshot(real), before.real, `${real} is unchanged`);
  assert.equal(snapshot(shipped), before.shipped, `${shipped} is unchanged`);
});

test("formatShow is the same report the command prints, and survives a router that does not load", () => {
  // A root with no router of its own still finds the copy beside the harness - which
  // is the point of that third candidate - so a missing router is forced with config.
  const root = makeRoot({ router: null, roles: { roles: defaultRoles() } });
  const missing = { ...ctxFor(root), config: { routerFile: "nothing/here.json" } };
  const commands = createSubagentSwitch().commands(missing);
  return commands.show([]).then((out) => {
    assert.match(out, /not found, so targets cannot be checked/);
    assert.match(out, /targets were not checked against the router\./);
    // The presets are still printed: a missing router is not a broken roles file.
    assert.match(out, /fast\s+Fast\s+fast\s+-/);

    const direct = formatShow({
      resolved: { file: join(root, "data", "roles.json"), source: "the harness root", exists: true },
      doc: { roles: defaultRoles() },
      router: { file: join(root, "router", "router.config.json"), exists: false },
      facts: routerFacts(null),
      parseError: null,
      routerProblem: "there is no router.config.json at that path",
    });
    assert.ok(Array.isArray(direct));
    assert.ok(direct.join("\n").includes("there is no router.config.json at that path"));
  });
});

// ---------------------------------------------------------------------------
// effort: an optional preference, not a route
// ---------------------------------------------------------------------------
//
// `effort` is additive and optional: a preset file written before the key existed has
// to keep working, and a file that asks for a level the composer cannot read stays
// readable - the level is reported, and refused on write, but the presets still load.

test("effort is optional: the shipped presets carry none, and a file without the key keeps working", async () => {
  for (const [id, role] of Object.entries(DEFAULT_ROLES)) {
    assert.equal(role.effort, undefined, `${id} asks for no effort: absent means no opinion`);
  }
  assert.deepEqual(EFFORT_LEVELS, ["low", "medium", "high"]);

  // A file written before the key existed - the shipped shape, nothing added.
  const root = makeRoot({ roles: { roles: defaultRoles() } });
  const commands = createSubagentSwitch().commands(ctxFor(root));
  const out = await commands.show([]);
  assert.doesNotMatch(out, /BROKEN/);
  assert.match(out, /effort\s+preferred reasoning effort: low \| medium \| high; "-" means the role has no opinion/);
  assert.match(out, /role\s+title\s+subagent\s+judge\s+effort/);
  for (const row of rolesReport({ doc: rolesIn(root), facts: routerFacts(ROUTER) })) {
    assert.equal(row.effort, null, `${row.id} has no opinion, so the column is a dash`);
    assert.equal(row.effortValid, true);
  }
  // `set` on such a file writes it back unchanged in shape: no effort key appears.
  await commands.set(["code", "fast"]);
  assert.equal(rolesIn(root).roles.code.effort, undefined);
});

test("checkEffort: three levels, null or absent, and a refusal that names the legal values", () => {
  for (const level of EFFORT_LEVELS) assert.deepEqual(checkEffort("code", level), { ok: true, value: level });
  assert.deepEqual(checkEffort("code", "  high  "), { ok: true, value: "high" });
  assert.deepEqual(checkEffort("code", undefined), { ok: true, value: null });
  assert.deepEqual(checkEffort("code", null), { ok: true, value: null });

  for (const bad of ["max", "HIGH", "extra-high", ""]) {
    const checked = checkEffort("code", bad);
    assert.equal(checked.ok, false, `${JSON.stringify(bad)} is not a level`);
    assert.match(checked.problem, /roles\.code\.effort is/);
    assert.match(checked.problem, /"low", "medium", "high"/);
    assert.match(checked.problem, /remove the key for no opinion/);
  }
  const notAString = checkEffort("code", 2);
  assert.equal(notAString.ok, false);
  assert.match(notAString.problem, /roles\.code\.effort is not a string/);
});

test("checkRole and checkDoc report a bad effort separately, so the file is still readable", () => {
  const role = { ...DEFAULT_ROLES.code, effort: "max" };
  const one = checkRole("code", role);
  assert.equal(one.ok, true, "a bad effort does not make the role invalid for the harness");
  assert.deepEqual(one.problems, []);
  assert.equal(one.effort.ok, false);

  const doc = checkDoc({ roles: { code: role } });
  assert.equal(doc.ok, true, "the harness reader ignores the key, so the file is readable");
  assert.deepEqual(doc.problems, []);
  assert.equal(doc.effortProblems.length, 1);
  assert.match(doc.effortProblems[0], /roles\.code\.effort is "max"/);

  // The file still parses, which is what makes it repairable instead of BROKEN.
  assert.equal(parseRoles(JSON.stringify({ roles: { code: role } })).ok, true);
});

test("show prints the effort each role asks for, and flags one it cannot use", async () => {
  const roles = defaultRoles();
  roles.code.effort = "high";
  roles.fast.effort = "max";
  const root = makeRoot({ roles: { roles } });
  const out = await createSubagentSwitch().commands(ctxFor(root)).show([]);

  assert.doesNotMatch(out, /BROKEN/, "an unreadable level is reported, not treated as a broken file");
  assert.match(out, /^  code\s+Code\s+code\s+-\s+high$/m, "the level a role asks for is shown");
  assert.match(out, /^  fast\s+Fast\s+fast\s+-\s+max$/m, "the table shows what the file says, not a dash");
  assert.match(out, /effort levels this file asks for that are not low \| medium \| high:/);
  assert.match(out, /roles\.fast\.effort is "max"/);
  assert.match(out, /The composer's effort submenu cannot read those/);
  // The presets are still printed, so the rest of the file is visible while it waits.
  assert.match(out, /orchestrate\s+Orchestrator/);
  assert.match(out, /addenda - the paragraph each role adds to its prompt:/);
});

test("set preserves an effort it does not own, and names it in the summary", async () => {
  const roles = defaultRoles();
  roles.code.effort = "high";
  const root = makeRoot({ roles: { roles } });
  const out = await createSubagentSwitch().commands(ctxFor(root)).set(["code", "fast"]);

  assert.match(out, /set code\.subagent -> fast/);
  assert.match(out, /role\s+title "Code", judge no, effort high/);
  const written = rolesIn(root);
  assert.equal(written.roles.code.subagent, "fast", "the target changed");
  assert.equal(written.roles.code.effort, "high", "the effort survived the write untouched");
  assert.equal(written.roles.orchestrate.effort, undefined, "no effort was invented for the other roles");
});

test("set refuses to write a file that carries a level the composer cannot read, and points at reset", async () => {
  const roles = defaultRoles();
  roles.code.effort = "max";
  const root = makeRoot({ roles: { roles } });
  const before = readFileSync(join(root, "data", "roles.json"), "utf8");
  const out = await createSubagentSwitch().commands(ctxFor(root)).set(["code", "fast"]);

  assert.match(out, /REFUSED - refusing to write a file the composer cannot read/);
  assert.match(out, /roles\.code\.effort is "max"/);
  assert.match(out, /run `reset <role>` to restore the shipped preset/);
  assert.equal(readFileSync(join(root, "data", "roles.json"), "utf8"), before, "nothing was written");
});

test("reset repairs an effort level that is not one of the three", async () => {
  const roles = defaultRoles();
  roles.code.effort = "max";
  const root = makeRoot({ roles: { roles } });
  const out = await createSubagentSwitch().commands(ctxFor(root)).reset(["code"]);

  assert.match(out, /^reset code$/m);
  assert.match(out, /file\s+.*roles\.json \(\d+ bytes, temp file then rename\)/);
  const written = rolesIn(root);
  assert.equal(written.roles.code.effort, undefined, "the shipped preset carries no effort, so the bad level is gone");
  assert.deepEqual(Object.keys(written.roles.code).sort(), ["addendum", "judge", "subagent", "title"]);
  assert.equal(written.roles.code.addendum, DEFAULT_ROLES.code.addendum);
});

// The two below cross the module boundary on purpose. Everything else in this file
// proves the plugin is internally consistent; these prove the file it writes is the
// file the composer actually reads, and that the optional effort key stays a
// preference rather than becoming a second, silent way to break the role menu.

/** Only the fields the reader promises, so a later addition of its own cannot fail this. */
const readable = (rows) =>
  rows.map((r) => ({ id: r.id, title: r.title, addendum: r.addendum, subagent: r.subagent, judge: r.judge }));

test("the shipped data/roles.json is what the reader that ships reads", () => {
  const { config: router, file } = readRouterConfig(HARNESS);
  assert.ok(router?.classes, `no router config found beside the harness (${file})`);
  const rows = readable(rolesFromRouter(router, readRoles(HARNESS)));

  assert.deepEqual(rows.map((r) => r.id).sort(), ["code", "deepseek", "fast", "judge", "orchestrate", "rosalena"]);
  assert.deepEqual(
    rows.map((r) => r.title).sort(),
    ["Code", "Fast", "Free tier", "Judge", "Orchestrator", "Rosalena"],
    "every role is named in the picker",
  );
  for (const row of rows) {
    assert.ok(row.addendum.length > 100, `${row.id} has a real addendum, not an empty string`);
    assert.ok(
      row.addendum.trim().split(/\s+/).length > 15,
      `${row.id}'s addendum is a paragraph of instructions, not a label`,
    );
  }
  assert.deepEqual(
    rows.filter((r) => r.judge).map((r) => r.id),
    ["judge"],
    "the review pass is on for the judge only",
  );
  assert.deepEqual(
    rows.map((r) => `${r.id}=${r.subagent}`).sort(),
    ["code=code", "deepseek=code", "fast=fast", "judge=code", "orchestrate=code", "rosalena=code"],
  );
});

test("an effort level, good or bad, changes nothing the reader returns", () => {
  const { config: router } = readRouterConfig(HARNESS);
  const baseline = readable(rolesFromRouter(router, readRoles(HARNESS)));
  assert.equal(baseline.length, 6, "the baseline must have roles, or the comparison proves nothing");

  const shipped = readRoles(HARNESS);
  const variant = (mutate) => {
    const doc = { roles: JSON.parse(JSON.stringify(shipped)) };
    mutate(doc.roles);
    const dir = mkdtempSync(join(tmpdir(), "harness-roles-reader-"));
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "data", "roles.json"), JSON.stringify(doc), "utf8");
    return readable(rolesFromRouter(router, readRoles(dir)));
  };

  const legal = variant((roles) => {
    roles.code.effort = "high";
    roles.fast.effort = "low";
    roles.judge.effort = null;
  });
  assert.deepEqual(legal, baseline, "a legal level is a preference the presets reader ignores");

  const illegal = variant((roles) => {
    roles.code.effort = "max";
    roles.fast.effort = 2;
    roles.judge.effort = "";
  });
  assert.deepEqual(illegal, baseline, "an illegal level is reported by this plugin, never by breaking the presets");
});
