// A run that keeps working until someone cancels it, for `runs.test.mjs`.
//
// The loop below never answers on the first call, so the run stays live and keeps
// stepping while the parent process writes the cancel flag. Started as a real child
// process because cancellation is only interesting ACROSS processes: the whole point of
// the flag file is that the canceller is not the run's owner.

import { runAgent } from "../../src/agent.mjs";

const [dir, id] = process.argv.slice(2);

// Every step asks for one more tool call, so the run stays alive without a model.
const keepWorking = () => ({
  choices: [
    {
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: "list_dir", arguments: JSON.stringify({ path: "." }) } }],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: {},
});

const result = await runAgent({
  task: "keep working until cancelled",
  root: dir,
  runsDir: dir,
  runId: id,
  maxSteps: 200,
  fetchImpl: async () => new Response(JSON.stringify(keepWorking()), { status: 200, headers: { "content-type": "application/json" } }),
});
process.stdout.write(`${JSON.stringify({ stopped: result.stopped, steps: result.steps })}\n`);
