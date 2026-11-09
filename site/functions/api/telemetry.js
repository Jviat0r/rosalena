import { handleTelemetry } from "./_lib/telemetry.mjs";

/**
 * POST /api/telemetry - the desktop app's early-build tracking. See _lib/telemetry.mjs.
 *
 * A failure here answers 500 with no detail: the app keeps the events and tries again,
 * and nothing about the database belongs in a response a stranger can read.
 */
export async function onRequest(context) {
  try {
    const result = await handleTelemetry(context);
    return new Response(result.json ? JSON.stringify(result.json) : null, { status: result.status, headers: result.headers });
  } catch (err) {
    console.warn(`telemetry: ${err?.message ?? err}`);
    return new Response(JSON.stringify({ error: "could not store events" }), { status: 500, headers: { "content-type": "application/json; charset=utf-8" } });
  }
}
