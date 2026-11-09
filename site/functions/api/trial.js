import { failureResult, handleTrial, toResponse } from "./_lib/trial.mjs";

/**
 * POST /api/trial - one anonymous message, streamed back as SSE.
 *
 * Everything that can be wrong is decided in `_lib/trial.mjs`, which the unit tests
 * call directly with a fake env. This file only adapts a Pages Function context to
 * that call, so there is nothing here a test has to reach into Cloudflare to check.
 */
export async function onRequestPost(context) {
  try {
    return toResponse(await handleTrial(context));
  } catch (err) {
    // handleTrial throws TrialError for every refusal it makes; anything else is a
    // bug, and failureResult renders it as provider/502 with a sentence, not a stack.
    return toResponse(failureResult(err));
  }
}
