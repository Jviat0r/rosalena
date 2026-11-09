import { failureResult, handleQuota, toResponse } from "./_lib/trial.mjs";

/**
 * GET /api/quota - what the page shows before the first message.
 *
 * Read-only: it reports today's count and the reset instant and never reserves a
 * slot, so a page reload cannot spend a message.
 */
export async function onRequestGet(context) {
  try {
    return toResponse(await handleQuota(context));
  } catch (err) {
    return toResponse(failureResult(err));
  }
}
