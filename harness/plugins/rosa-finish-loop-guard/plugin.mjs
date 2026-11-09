// finish-loop-guard - stops a model from looping on its final steps.
//
// The loop ends a run only when the model answers WITHOUT a tool call. A model
// that has finished but keeps attaching one never gets there: it re-presents the
// same file, re-reads the same goal, writes the same summary again. Seen on
// 2026-10-18 with a local coder model: 80+ steps on one turn, on one "I'm done".
//
// The harness defaults to local models, which is exactly where this happens.
//
// Two moves, in order, per run:
//   1. nudge once - a note telling the model to answer with no tool call;
//   2. end the run if it keeps going, so a loop costs one warning, not the GPU.
//
// It never touches a step that is ending normally (no tool call), because that
// step ends the run by itself.

const DONE = /\b(done|finished|complete|completed|all set|that'?s everything|nothing (?:left|more|else) to do|no further (?:work|action|changes))\b/i;

/** The opening of a message, normalised - how "the same message again" is judged. */
export function opening(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

/** How many trailing entries satisfy `match`, counting back from the end. */
function trailing(list, match) {
  let n = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (!match(list[i], list[i - 1])) break;
    n += 1;
  }
  return n;
}

/**
 * Judge a run's steps. Pure, so the thresholds are testable without a model.
 *
 * `steps` is the history of steps that attached tool calls, oldest first:
 *   { step, opening, done, toolKeys: string[] }
 * Each run length below is "how many consecutive steps at the end satisfy this".
 */
export function judge(steps, { textRepeats = 3, doneStreak = 3, sameToolRepeats = 3 } = {}) {
  const textRun = trailing(steps, (s, prev) => Boolean(prev) && s.opening.length > 0 && s.opening === prev.opening) + 1;
  const doneRun = trailing(steps, (s) => s.done);
  const toolRun =
    trailing(steps, (s, prev) => Boolean(prev) && s.toolKeys.length > 0 && s.toolKeys.join("|") === prev.toolKeys.join("|")) + 1;

  if (textRun >= textRepeats) {
    return { loop: true, why: `the same message ${textRun} times in a row while still calling tools` };
  }
  if (doneRun >= doneStreak) {
    return { loop: true, why: `${doneRun} steps in a row announcing the work is finished while still calling tools` };
  }
  if (toolRun >= sameToolRepeats) {
    return { loop: true, why: `the same tool call ${toolRun} times in a row` };
  }
  return { loop: false, why: "" };
}

export default {
  id: "rosa-finish-loop-guard",
  description: "Warns once, then ends the run, when the model loops on its final steps",

  hooks(ctx) {
    const models = Array.isArray(ctx.config.models) ? ctx.config.models : [];
    const thresholds = {
      textRepeats: Math.max(2, Number(ctx.config.textRepeats) || 3),
      doneStreak: Math.max(2, Number(ctx.config.doneStreak) || 3),
      sameToolRepeats: Math.max(2, Number(ctx.config.sameToolRepeats) || 3),
    };
    const hardStop = ctx.config.hardStop !== false;

    const applies = (target) => !models.length || models.some((m) => String(target ?? "").includes(m));

    return {
      async afterStep({ run, step, target, content, toolCallKeys }) {
        if (!applies(target)) return;
        const steps = run.state.get("steps") ?? [];
        steps.push({
          step,
          opening: opening(content),
          done: DONE.test(String(content ?? "")),
          toolKeys: Array.isArray(toolCallKeys) ? toolCallKeys : [],
        });
        run.state.set("steps", steps);

        const verdict = judge(steps, thresholds);
        if (!verdict.loop) return;

        if (!run.state.get("nudged")) {
          run.state.set("nudged", true);
          ctx.log(`step ${step}: ${verdict.why} - warning the model once`);
          return {
            note:
              `You have ended the last steps saying the work is finished while still calling tools (${verdict.why}). ` +
              "Answer now with your final answer and NO tool call: the task is over. " +
              "If something really is still unfinished, say exactly what, once, and nothing else.",
          };
        }

        if (!hardStop) return;
        ctx.log(`step ${step}: still looping after the warning - ending the run`);
        return { stop: `looped on its final steps after one warning (${verdict.why})` };
      },
    };
  },

  status(ctx) {
    const models = Array.isArray(ctx.config.models) ? ctx.config.models : [];
    return `guarding ${models.length ? models.join(", ") : "every model"}`;
  },
};
