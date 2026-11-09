/**
 * The benchmark's tasks: small, real coding jobs on a fixture repo, each judged by HIDDEN
 * tests that are copied in only after the harness has finished - so no harness can read
 * or edit what it is graded by. Every check is `node --test` on plain Node, so the same
 * task runs the same way under any harness.
 *
 * `files`: the repo the harness starts from. `hidden`: the grader's tests.
 */

const pkg = JSON.stringify({ name: "bench", version: "1.0.0", type: "module", scripts: { test: "node --test" } }, null, 2);

export const TASKS = [
  {
    id: "fix-off-by-one",
    prompt: "The sumRange function in math.js should add every integer from a to b inclusive, but the tests fail. Fix the bug.",
    files: {
      "package.json": pkg,
      "math.js": "export function sumRange(a, b) {\n  let total = 0;\n  for (let i = a; i < b; i += 1) total += i;\n  return total;\n}\n",
      "math.test.js": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { sumRange } from './math.js';\ntest('1..4', () => assert.equal(sumRange(1, 4), 10));\n",
    },
    hidden: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { sumRange } from '../math.js';\ntest('inclusive', () => { assert.equal(sumRange(1, 4), 10); assert.equal(sumRange(5, 5), 5); assert.equal(sumRange(-2, 2), 0); });\n",
  },
  {
    id: "add-slugify",
    prompt: "Add and export a function slugify(text) in utils.js: lowercase, trim, turn every run of characters that are not a-z or 0-9 into a single hyphen, and strip hyphens from both ends. Example: '  Hello, World! ' -> 'hello-world'.",
    files: { "package.json": pkg, "utils.js": "export function capitalize(s) {\n  return s.charAt(0).toUpperCase() + s.slice(1);\n}\n" },
    hidden: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { slugify, capitalize } from '../utils.js';\ntest('slugify', () => { assert.equal(slugify('  Hello, World! '), 'hello-world'); assert.equal(slugify('A--B__c'), 'a-b-c'); assert.equal(slugify('Ünïcode 2026'), 'n-code-2026'); assert.equal(capitalize('x'), 'X'); });\n",
  },
  {
    id: "rename-across-files",
    prompt: "Rename the function getUserName to getDisplayName everywhere in this project (its definition and every use). Keep everything working.",
    files: {
      "package.json": pkg,
      "user.js": "export function getUserName(user) {\n  return `${user.first} ${user.last}`;\n}\n",
      "greet.js": "import { getUserName } from './user.js';\nexport const greet = (u) => `Hi ${getUserName(u)}`;\n",
      "report.js": "import { getUserName } from './user.js';\nexport const line = (u) => `${getUserName(u)}: ok`;\n",
    },
    hidden: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\nimport * as user from '../user.js';\nimport { greet } from '../greet.js';\nimport { line } from '../report.js';\ntest('renamed', () => { assert.equal(typeof user.getDisplayName, 'function'); assert.equal(user.getUserName, undefined); for (const f of ['user.js', 'greet.js', 'report.js']) assert.doesNotMatch(readFileSync(new URL('../' + f, import.meta.url), 'utf8'), /getUserName/); assert.equal(greet({ first: 'A', last: 'B' }), 'Hi A B'); assert.equal(line({ first: 'A', last: 'B' }), 'A B: ok'); });\n",
  },
  {
    id: "missing-await",
    prompt: "loadConfig in config.js sometimes returns a Promise instead of the parsed config, so callers get undefined fields. Fix it so loadConfig resolves to the parsed object.",
    files: {
      "package.json": pkg,
      "config.js": "import { readFile } from 'node:fs/promises';\nexport async function loadConfig(path) {\n  const text = readFile(path, 'utf8');\n  return JSON.parse(text);\n}\n",
      "config.json": "{ \"port\": 8080, \"name\": \"svc\" }\n",
    },
    hidden: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { fileURLToPath } from 'node:url';\nimport { loadConfig } from '../config.js';\ntest('loads', async () => { const c = await loadConfig(fileURLToPath(new URL('../config.json', import.meta.url))); assert.equal(c.port, 8080); assert.equal(c.name, 'svc'); });\n",
  },
  {
    id: "cli-flag",
    prompt: "cli.js prints its arguments joined by spaces. Add a --upper flag: when it is present (anywhere in the arguments), print the other arguments in upper case. Without it, behave as before.",
    files: { "package.json": pkg, "cli.js": "const args = process.argv.slice(2);\nconsole.log(args.join(' '));\n" },
    hidden: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { execFileSync } from 'node:child_process';\nimport { fileURLToPath } from 'node:url';\nconst cli = fileURLToPath(new URL('../cli.js', import.meta.url));\nconst run = (...a) => execFileSync(process.execPath, [cli, ...a], { encoding: 'utf8' }).trim();\ntest('flag', () => { assert.equal(run('hi', 'there'), 'hi there'); assert.equal(run('--upper', 'hi', 'there'), 'HI THERE'); assert.equal(run('hi', '--upper'), 'HI'); });\n",
  },
  {
    id: "extract-validator",
    prompt: "signup.js and invite.js each contain the same inline email check. Extract it into a function isValidEmail(email) exported from a new file validate.js, and use it in both files. Behaviour must not change.",
    files: {
      "package.json": pkg,
      "signup.js": "export function signup(email) {\n  if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) return { ok: false };\n  return { ok: true, email };\n}\n",
      "invite.js": "export function invite(email) {\n  if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) throw new Error('bad email');\n  return `invited ${email}`;\n}\n",
    },
    hidden: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\nimport { isValidEmail } from '../validate.js';\nimport { signup } from '../signup.js';\nimport { invite } from '../invite.js';\ntest('extracted', () => { assert.equal(isValidEmail('a@b.co'), true); assert.equal(isValidEmail('nope'), false); assert.deepEqual(signup('a@b.co'), { ok: true, email: 'a@b.co' }); assert.deepEqual(signup('x'), { ok: false }); assert.equal(invite('a@b.co'), 'invited a@b.co'); assert.throws(() => invite('x')); for (const f of ['signup.js', 'invite.js']) { const t = readFileSync(new URL('../' + f, import.meta.url), 'utf8'); assert.match(t, /isValidEmail/); assert.doesNotMatch(t, /\\[\\^\\\\s@\\]/); } });\n",
  },
  {
    id: "csv-to-json",
    prompt: "Write convert.js: it reads data.csv (first line is the header), and writes data.json as an array of objects keyed by the header names, with numeric-looking values turned into numbers. Then run it so data.json exists.",
    files: { "package.json": pkg, "data.csv": "name,age,city\nAda,36,London\nLin,29,Taipei\n" },
    hidden: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\ntest('converted', () => { const data = JSON.parse(readFileSync(new URL('../data.json', import.meta.url), 'utf8')); assert.deepEqual(data, [{ name: 'Ada', age: 36, city: 'London' }, { name: 'Lin', age: 29, city: 'Taipei' }]); });\n",
  },
  {
    id: "write-tests",
    prompt: "parseDuration in duration.js has no tests and one bug. Write tests for it in duration.test.js (h, m and s units, and combinations like '1h30m'), find the bug, and fix it.",
    files: {
      "package.json": pkg,
      "duration.js": "// '1h30m' -> 5400 seconds. Units: h, m, s.\nexport function parseDuration(text) {\n  const units = { h: 3600, m: 60, s: 1 };\n  let total = 0;\n  for (const [, n, u] of text.matchAll(/(\\d+)([hms])/g)) total += Number(n) * units[u];\n  return total * 1000;\n}\n",
    },
    hidden: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { existsSync } from 'node:fs';\nimport { parseDuration } from '../duration.js';\ntest('fixed', () => { assert.equal(parseDuration('1h30m'), 5400); assert.equal(parseDuration('45s'), 45); assert.equal(parseDuration('2m5s'), 125); assert.ok(existsSync(new URL('../duration.test.js', import.meta.url)), 'tests were written'); });\n",
  },
];
