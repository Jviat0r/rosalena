// A run that is interrupted by its process ending, for the store's kill-time close.
//
// Started by `runs.test.mjs` as a real child process: the run begins, the model call
// never answers, and the process exits without the agent ever reaching `finish`. What
// the test then reads is whether the store still told the truth about the run.
//
// `process.exit()` is used rather than a signal because Windows cannot deliver SIGTERM
// to a child (`child.kill()` there is a terminate, no handler runs); the `exit` hook
// this exercises is the same one every abrupt end goes through.

import { runAgent } from "../../src/agent.mjs";

const [dir, id] = process.argv.slice(2);

const never = () => new Promise(() => {});
setTimeout(() => process.exit(0), 400);

await runAgent({ task: "this run will be interrupted", root: dir, runsDir: dir, runId: id, fetchImpl: never });
process.exit(0);
