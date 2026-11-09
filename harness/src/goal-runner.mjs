/**
 * Missions: a goal that runs round after round until it is done.
 *
 * Goal mode (goal.mjs) makes one run one round of a goal that outlives it: the objective
 * and the latest state live in `.goal-state.md`, and every round reads them back. What
 * was missing is the thing that starts the next round. Factory's Missions run for days
 * and Codex/Claude Code have `/goal`; without a driver, Rosalena's goal still needed a
 * person to type "continue" after every round.
 *
 * Each round is a fresh run with a fresh context - the state file is the memory, not a
 * transcript that keeps growing - so a mission can outlast any context window. It stops
 * when:
 *   - the goal is recorded as done (goal_update done: true, and the judge agreed if on)
 *   - the round says it is blocked on the person
 *   - the round, time or spend budget runs out
 *   - two rounds in a row fail (a broken model or router should not burn the budget)
 *   - it is cancelled (`isCancelled()`, checked between rounds; a round in flight is
 *     cancelled through the run store like any run)
 */

import { DEFAULT_ROUTER, readSpend as readRouterSpend, runAgent, saysBlocked } from "./agent.mjs";

const readSpend = (routerUrl, fetchImpl) => readRouterSpend(routerUrl ?? DEFAULT_ROUTER, fetchImpl ?? fetch);

/** The task a round after the first one is given: continue, from the recorded state. */
export function continuationTask(request, round) {
  return [
    `Round ${round} of an ongoing goal. The goal and what the earlier rounds did are in the goal state above (call goal_state for the full file).`,
    "Pick the next unfinished step and do it, verifying as you go. Record what this round did with goal_update before you finish,",
    "and mark the goal done only when all of it is finished and checked.",
    "",
    `The original request: ${String(request ?? "").slice(0, 2000)}`,
  ].join("\n");
}

/**
 * @returns {Promise<{ done: boolean, stopped: string, rounds: object[], last: object|null, ms: number }>}
 */
export async function runGoal({
  maxRounds = 20,
  maxHours = 8,
  maxUsd = null,
  isCancelled = () => false,
  onRound = () => {},
  // The run id for each round (so a host can cancel the one in flight); null = generated.
  roundId = null,
  runAgentImpl = runAgent,
  ...agent
}) {
  const started = Date.now();
  const spendStart = maxUsd ? await readSpend(agent.routerUrl, agent.fetchImpl).catch(() => 0) : 0;
  const rounds = [];
  let failures = 0;
  let last = null;
  const end = (stopped) => ({ done: stopped === "done", stopped, rounds, last, ms: Date.now() - started });

  for (let round = 1; round <= Math.max(1, Number(maxRounds) || 1); round += 1) {
    if (isCancelled()) return end("cancelled");
    if (Number(maxHours) > 0 && Date.now() - started > Number(maxHours) * 3_600_000) return end("time");
    if (maxUsd) {
      const spent = (await readSpend(agent.routerUrl, agent.fetchImpl).catch(() => spendStart)) - spendStart;
      if (spent > maxUsd) return end("cost");
    }
    agent.onEvent?.({ type: "mission_round", round, of: maxRounds });
    const result = await runAgentImpl({
      ...agent,
      task: round === 1 ? agent.task : continuationTask(agent.task, round),
      goal: true,
      // Every round starts clean: the goal file carries the state, not the transcript.
      messages: null,
      runId: typeof roundId === "function" ? roundId(round) : round === 1 ? agent.runId ?? null : null,
    });
    last = result;
    const entry = {
      round,
      steps: result.steps ?? 0,
      stopped: result.stopped ?? null,
      error: result.error ?? null,
      done: result.goal?.done === true,
      answer: String(result.answer ?? "").slice(0, 300),
      run: result.run ?? null,
    };
    rounds.push(entry);
    onRound(entry);
    if (entry.done) return end("done");
    if (result.stopped === "cancelled") return end("cancelled");
    if (saysBlocked(result.answer)) return end("blocked");
    failures = result.error ? failures + 1 : 0;
    if (failures >= 2) return end("failing");
  }
  return end("max_rounds");
}
