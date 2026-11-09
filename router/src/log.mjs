/**
 * One JSONL file per day, plus an in-memory ring of recent events for /admin/status.
 *
 * The T0.1 acceptance test is "the logs show the fallback path", so an attempt is
 * logged for every target the router tried - including the ones it skipped and why.
 * A log that only records successes cannot show a fallback.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export function createLogger({ logDir = "logs", echo = true, ringSize = 200 } = {}) {
  const ring = [];
  let file = null;

  function fileFor(d = new Date()) {
    const day = d.toISOString().slice(0, 10);
    return join(logDir, `router-${day}.jsonl`);
  }

  function log(event, fields = {}) {
    const entry = { ts: new Date().toISOString(), event, ...fields };
    ring.push(entry);
    if (ring.length > ringSize) ring.shift();
    try {
      mkdirSync(logDir, { recursive: true });
      file = fileFor();
      appendFileSync(file, `${JSON.stringify(entry)}\n`);
    } catch {
      // Logging must never be the reason a request fails.
    }
    if (echo) {
      const bits = [entry.ts.slice(11, 19), event];
      if (fields.requestId) bits.push(`req=${fields.requestId}`);
      if (fields.cls) bits.push(`class=${fields.cls}`);
      if (fields.target) bits.push(fields.target);
      if (fields.reason) bits.push(`reason=${fields.reason}`);
      if (fields.ms !== undefined) bits.push(`${fields.ms}ms`);
      if (fields.usd !== undefined) bits.push(`$${fields.usd}`);
      process.stdout.write(`${bits.join(" ")}\n`);
    }
  }

  return {
    log,
    /** Newest last. Used by /admin/status so fallbacks are visible without tailing a file. */
    recent: (n = 50) => ring.slice(-n),
    ringSize: () => ring.length,
    file: () => file,
  };
}
