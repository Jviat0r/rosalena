/**
 * Durable goal mode: the run stops being the unit of work.
 *
 * The file tests hold the two promises the durability story is made of:
 *   - APPEND-ONLY: nothing here rewrites a byte that is already on disk, so a
 *     file shared with another lane keeps its whole history byte-for-byte;
 *   - NUMBERED BY THE FILE: the next round comes out of the file, so rounds stay
 *     consecutive across processes and runs.
 *
 * The two runAgent tests hold the behavioural ones: a run that never calls
 * `goal_update` still leaves a round behind (the harness writes it), and a run
 * that does call it is recorded ONCE, with the model's own words, and its
 * `done: true` is what lets the goal be declared complete.
 *
 *   node --test
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { runAgent } from "../src/agent.mjs";
import {
  DEFAULT_GOAL_FILE,
  appendGoalEntry,
  formatGoalEntry,
  goalFile,
  goalPrompt,
  goalTools,
  nextRound,
  readGoalState,
} from "../src/goal.mjs";

const WS = mkdtempSync(join(tmpdir(), "harness-goal-"));
writeFileSync(join(WS, "hello.txt"), "line one\nline two\n", "utf8");
const goalFileAt = (name) => join(mkdtempSync(join(tmpdir(), "harness-goal-file-")), name);

const say = (content) => ({
  choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});

const useTool = (name, args, id = "call_1") => ({
  choices: [
    {
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: {},
});

function scripted(script) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    const entry = script[Math.min(calls.length - 1, script.length - 1)];
    if (entry instanceof Response) return entry;
    return new Response(JSON.stringify(entry), {
      status: 200,
      headers: { "content-type": "application/json", "x-router-target": "local/test-model" },
    });
  };
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------- goalFile

test("goalFile: the default name, resolved against the run's root", () => {
  const root = join("root", "dir");
  assert.equal(goalFile(null, root), resolve(root, DEFAULT_GOAL_FILE));
  assert.equal(goalFile("my-goal.md", root), resolve(root, "my-goal.md"));
  assert.equal(goalFile("", root), resolve(root, DEFAULT_GOAL_FILE));
  assert.ok(goalFile(null, root).endsWith(join("dir", DEFAULT_GOAL_FILE)));
});

// ---------------------------------------------------------------- readGoalState

test("readGoalState: a missing file is a clean start, not an error", () => {
  const s = readGoalState({ file: goalFileAt("missing.md") });
  assert.equal(s.exists, false);
  assert.equal(s.bytes, 0);
  assert.equal(s.lastRound, 0);
  assert.equal(s.rounds, 0);
  assert.equal(s.headings.length, 0);
  assert.equal(s.lastHeading, null);
  assert.equal(s.head, "");
  assert.equal(s.tail, "");
});

test("readGoalState: rounds are found in every shape the file uses, and clipped sensibly", () => {
  const f = goalFileAt("state.md");
  const objective = "# Goal state\n\nBuild the thing.\n\n";
  const entry1 =
    "**Round-1 update (2026-10-18T09:00:00.000Z): did the start**\n\n- started\n\n**Next:** continue.\n**Goal status:** still active.\n\n";
  const entry26 =
    "**Round-26 update (2026-10-19T09:00:00.000Z): rolling summary landed**\n\n- compacted\n\n**Next:** goal mode.\n**Goal status:** still active.\n\n";
  const prose = "Round 30 mentioned in prose only.\n\n";
  writeFileSync(f, objective + entry1 + entry26 + prose, "utf8");

  const s = readGoalState({ file: f, tailChars: 200, headChars: 40 });
  assert.equal(s.exists, true);
  assert.equal(s.lastRound, 30); // `Round 30` without a dash counts too
  assert.equal(s.rounds, 3);
  assert.equal(s.lastHeading, "Round-26 update (2026-10-19T09:00:00.000Z): rolling summary landed");
  assert.match(s.head, /…$/); // the objective was clipped
  assert.ok(s.head.startsWith("# Goal state"));
  assert.ok(s.tail.startsWith("…(earlier state omitted)"));
  assert.ok(s.tail.endsWith(prose));
});

test("nextRound: the file decides the number, not the run", () => {
  assert.equal(nextRound({ lastRound: 0 }), 1);
  assert.equal(nextRound({ lastRound: 26 }), 27);
  assert.equal(nextRound(null), 1);
});

// ---------------------------------------------------------------- goalPrompt

test("goalPrompt: a missing file says this run starts the goal", () => {
  const s = readGoalState({ file: goalFileAt("none.md") });
  const p = goalPrompt(s);
  assert.match(p, /^## Durable goal/);
  assert.match(p, /does not exist yet/);
  assert.match(p, /APPEND-ONLY/);
  assert.ok(!p.includes("Objective (the head of the file):"));
});

test("goalPrompt: an existing file carries the head, the tail and the rules, within bounds", () => {
  const f = goalFileAt("prompt.md");
  writeFileSync(f, `# Goal state\n\n${"objective ".repeat(100)}\n\n**Round-9 update (x): something**\n\n- done thing\n\n`, "utf8");
  const p = goalPrompt(readGoalState({ file: f }), { maxChars: 2200, file: f });
  assert.ok(p.includes("Objective (the head of the file):"));
  assert.ok(p.includes("Latest recorded state:"));
  assert.ok(p.includes("something"));
  assert.ok(p.includes(f));
  assert.ok(p.length <= 2200 + 600);
  assert.equal(goalPrompt(null), "");
});

// ---------------------------------------------------------------- formatGoalEntry

test("formatGoalEntry: the shape the file already uses", () => {
  const e = formatGoalEntry({
    round: 7,
    at: "2026-10-19T12:00:00.000Z",
    summary: "Did the work.\nSecond sentence of the record.",
    evidence: "suite green: 175/175",
    next: "cache work",
    files: ["src/a.mjs", "test/b.test.mjs"],
    by: "model",
  });
  assert.match(e, /^\*\*Round-7 update \(2026-10-19T12:00:00.000Z\): Did the work\.\*\*\n\nDid the work\.\nSecond sentence of the record\./m);
  assert.ok(e.includes("Files: `src/a.mjs`, `test/b.test.mjs`"));
  assert.ok(e.includes("**Evidence:** suite green: 175/175"));
  assert.ok(e.includes("**Next:** cache work"));
  assert.ok(e.includes("**Goal status:** still active."));
  assert.ok(!e.includes("recorded by the harness"));
});

test("formatGoalEntry: done and harness are both marked", () => {
  const e = formatGoalEntry({ round: 8, at: "2026-10-19T12:00:00.000Z", summary: "the last one", done: true, by: "harness" });
  assert.ok(e.includes("**Goal status:** **done** _(recorded by the harness)_"));
  assert.ok(e.includes("**Next:** (goal complete)"));
});

test("formatGoalEntry: an entry without a summary is refused", () => {
  assert.throws(() => formatGoalEntry({ round: 1, summary: "   " }), /summary/);
  assert.throws(() => formatGoalEntry({ round: 1 }), /summary/);
});

// ---------------------------------------------------------------- appendGoalEntry

test("appendGoalEntry: creates the file with a header, then appends without rewriting", () => {
  const f = goalFileAt("append.md");
  const e1 = formatGoalEntry({ round: 1, at: "2026-10-19T12:00:00.000Z", summary: "first entry", by: "model" });
  const r1 = appendGoalEntry(e1, { file: f });
  const text1 = readFileSync(f, "utf8");
  assert.match(text1, /^# Goal state\n\n_Append-only\./);
  assert.ok(text1.includes("first entry"));
  assert.ok(r1.bytes > 0);

  // A second entry: every previous byte is still there, in order.
  const e2 = formatGoalEntry({ round: 2, at: "2026-10-19T13:00:00.000Z", summary: "second entry", by: "harness" });
  const r2 = appendGoalEntry(e2, { file: f });
  const text2 = readFileSync(f, "utf8");
  assert.ok(text2.startsWith(text1));
  assert.ok(r2.bytes > r1.bytes);
  assert.ok(text2.includes("second entry"));
  assert.ok(text2.trimEnd().endsWith("_(recorded by the harness)_"));

  // And the file now parses back to the new round.
  const s = readGoalState({ file: f });
  assert.equal(s.lastRound, 2);
  assert.equal(s.rounds, 2);
});

test("appendGoalEntry: a file without a trailing newline gets a separator", () => {
  const f = goalFileAt("notrail.md");
  writeFileSync(f, "no trailing newline", "utf8");
  appendGoalEntry("entry", { file: f });
  assert.ok(readFileSync(f, "utf8").startsWith("no trailing newline\n\nentry\n"));
});

test("appendGoalEntry: an empty entry is refused without touching the file", () => {
  const f = goalFileAt("empty.md");
  assert.throws(() => appendGoalEntry("", { file: f }), /empty goal entry/);
  assert.throws(() => appendGoalEntry(null, { file: f }), /empty goal entry/);
  assert.equal(existsSync(f), false);
});

// ---------------------------------------------------------------- goalTools

test("goalTools: the model reads the state and appends its own round", async () => {
  const f = goalFileAt("tools.md");
  const ctx = { file: f, round: () => 4, wrote: false, done: false, next: null };
  const [stateTool, updateTool] = goalTools(ctx);
  assert.equal(stateTool.name, "goal_state");
  assert.equal(updateTool.name, "goal_update");
  assert.ok(Object.keys(updateTool.parameters.properties).includes("done"));

  const none = await stateTool.run();
  assert.match(none, /no goal state file yet/);
  assert.equal(existsSync(f), false);

  const refused = await updateTool.run({});
  assert.match(refused, /required/);
  assert.equal(ctx.wrote, false);

  const ok = await updateTool.run({ summary: "recorded the work", evidence: "suite green", next: "more", done: true });
  assert.match(ok, /appended round 4/);
  assert.match(ok, /goal marked done/);
  assert.equal(ctx.wrote, true);
  assert.equal(ctx.done, true);
  const text = readFileSync(f, "utf8");
  assert.ok(text.includes("recorded the work"));
  assert.ok(text.includes("Round-4"));

  const again = await stateTool.run();
  assert.match(again, /last round 4/);
  assert.ok(again.includes("recorded the work"));
});

// ---------------------------------------------------------------- the live loop

test("goal mode: a run that never updates the file still records its round", async () => {
  const gfile = goalFileAt("run-a.md");
  // Another lane owns the beginning of this file; the harness must not touch it.
  const prior =
    "# Goal state\n\n**Round-5 update (2026-10-18T08:00:00.000Z): earlier work**\n\n- old\n\n**Next:** more.\n**Goal status:** still active.\n\n";
  writeFileSync(gfile, prior, "utf8");

  const fn = scripted([say("all done here")]);
  const events = [];
  const result = await runAgent({
    root: WS,
    task: "finish the thing",
    fetchImpl: fn,
    memory: false,
    useJudge: false,
    stream: false,
    maxSteps: 3,
    goal: true,
    goalFile: gfile,
    onEvent: (e) => events.push(e),
  });

  assert.equal(result.answer, "all done here");
  assert.equal(result.goal.round, 6); // the file, not the run, decided the number
  assert.equal(result.goal.wrote, true);
  assert.equal(result.goal.done, false);
  assert.equal(result.goalDone, false);

  const text = readFileSync(gfile, "utf8");
  assert.ok(text.startsWith(prior)); // append-only: the other lane's bytes are untouched
  assert.ok(text.includes("**Round-6 update"));
  assert.ok(text.includes("_(recorded by the harness)_"));
  assert.ok(text.includes("**Goal status:** still active."));
  assert.ok(text.includes("Answer: all done here"));

  const goalEv = events.find((e) => e.type === "goal");
  assert.equal(goalEv.round, 6);
  assert.equal(goalEv.exists, true);
  const writtenEv = events.find((e) => e.type === "goal_written");
  assert.equal(writtenEv.by, "harness");
  assert.equal(writtenEv.round, 6);

  // The objective and the latest state reached the model, and the tools are offered.
  const sys = fn.calls[0].body.messages[0].content;
  assert.match(sys, /Durable goal/);
  assert.ok(sys.includes("Objective (the head of the file):"));
  assert.ok(sys.includes("earlier work"));
  assert.ok(JSON.stringify(fn.calls[0].body).includes("goal_update"));
});

test("goal mode: the model's own record stands, and done:true carries through", async () => {
  const gfile = goalFileAt("run-b.md");
  const fn = scripted([
    useTool("goal_update", { summary: "Did the thing.", evidence: "175/175 green", next: "cache work", done: true }),
    say("complete"),
  ]);
  const events = [];
  const result = await runAgent({
    root: WS,
    task: "do the thing and record it",
    fetchImpl: fn,
    memory: false,
    useJudge: false,
    stream: false,
    maxSteps: 4,
    goal: true,
    goalFile: gfile,
    onEvent: (e) => events.push(e),
  });

  assert.equal(result.answer, "complete");
  assert.equal(result.goalDone, true);
  assert.equal(result.goal.wrote, true);
  assert.equal(result.goal.done, true);
  assert.equal(result.goal.round, 1);

  const text = readFileSync(gfile, "utf8");
  // Exactly one entry for the round: the model's, not a second harness one.
  assert.equal((text.match(/\*\*Round-1 update/g) ?? []).length, 1);
  assert.ok(text.includes("Did the thing."));
  assert.ok(text.includes("**Goal status:** **done**"));
  assert.ok(!text.includes("recorded by the harness"));

  assert.ok(events.some((e) => e.type === "goal_done_requested"));
  assert.ok(!events.some((e) => e.type === "goal_written")); // the harness did not double-record
  const goalEv = events.find((e) => e.type === "goal");
  assert.equal(goalEv.round, 1);
  assert.equal(goalEv.exists, false);
});
