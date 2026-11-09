/**
 * A class-owned system prompt ("persona").
 *
 * A class is normally just a failover chain: the caller asks for "code" and does not
 * care which model answers. `rosalena` is the opposite kind of class - it is a NAME a
 * person picks in the app, so the name has to mean one consistent assistant rather than
 * whatever model happened to be free. The identity therefore cannot be a client concern:
 * any client could omit it, replace it, or read it back out of its own request. It lives
 * in a prompt file the router owns, is read once at startup, and is prepended to every
 * request that leaves under that class, whatever the client sent.
 *
 * Two rules are deliberate and documented where they are implemented:
 *
 *   1. The prompt is read ONCE, at startup, and an absent or empty file THROWS. A class
 *      that silently loses its system prompt is worse than a class that refuses to
 *      start: the first answers as an unnamed model while still being advertised as
 *      Rosalena, and nothing downstream can tell the difference.
 *   2. Rosalena's system message goes FIRST and the client's own system message stays
 *      as a second system message after it. Merging them into one string would let a
 *      client's text sit inside Rosalena's instructions; dropping the client's would
 *      silently discard the user's own rules. Two messages keep both, in a defined
 *      order, with the identity unambiguous.
 *
 * Nothing here ever writes prompt text to a log, a response body or a status endpoint.
 * The only place the text exists outside this file is the upstream request body.
 */

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

/** A class's prompt could not be loaded. This is a startup failure, not a skip. */
export class PersonaError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = "PersonaError";
    this.meta = meta;
  }
}

const reason = (err) => (err instanceof Error ? err.message : String(err));

/**
 * Where a class's prompt file is: relative paths are read from the directory the router
 * CONFIG lives in, never from the process's working directory. The router can be started
 * from anywhere (a service manager, the desktop app, a shell in another folder), and a
 * prompt that depends on `cwd` would vanish exactly when nobody is watching.
 */
export function resolvePersonaFile(file, baseDir = process.cwd()) {
  const text = String(file ?? "").trim();
  if (!text) return null;
  return isAbsolute(text) ? text : resolve(baseDir, text);
}

/**
 * Load every class persona declared by the config.
 *
 * Shape read: `classes.<name>.systemPromptFile`. A class without the key is left alone -
 * this is opt-in per class on purpose, because a prompt quietly attached to a failover
 * chain that was meant to be a plain utility class is a surprise nobody asked for.
 *
 * Returns a Map of class name -> { file, text }. `text` is the file's content with
 * leading and trailing whitespace removed; that is exactly what is sent upstream.
 */
export function loadClassPersonas(config, { readFile = readFileSync, baseDir } = {}) {
  const base = baseDir ?? (config?.configPath ? dirname(resolve(config.configPath)) : process.cwd());
  const personas = new Map();
  for (const [cls, entry] of Object.entries(config?.classes ?? {})) {
    const declared = entry?.systemPromptFile;
    if (declared === undefined || declared === null) continue;
    const file = resolvePersonaFile(declared, base);
    if (!file) {
      throw new PersonaError(
        `class "${cls}" declares systemPromptFile but it is empty - give it a path, or remove the key so the class runs without an identity prompt`,
        { cls },
      );
    }
    let raw;
    try {
      raw = readFile(file, { encoding: "utf8" });
    } catch (err) {
      throw new PersonaError(
        `class "${cls}" cannot read its system prompt at ${file} (${reason(err)}). The router refuses to start: serving "${cls}" without that prompt would answer under the name with a different assistant's rules.`,
        { cls, file },
      );
    }
    const text = String(raw ?? "").trim();
    if (!text) {
      throw new PersonaError(
        `class "${cls}" has an EMPTY system prompt at ${file}. An empty persona is not "no opinion" - it is the identity being lost silently, so the router refuses to start until the file has content.`,
        { cls, file },
      );
    }
    personas.set(cls, { file, text });
  }
  return personas;
}

/**
 * The prompt for a class, or null.
 *
 * Accepts the Map from `loadClassPersonas` and also a plain object, because the server
 * context is assembled by hand in a few places (tests, embedded use) and a Map is easy to
 * turn into `{}` by accident. Both spellings mean the same thing.
 */
export function personaFor(personas, cls) {
  if (!personas || !cls) return null;
  const entry = typeof personas.get === "function" ? personas.get(cls) : personas[cls];
  if (!entry) return null;
  const text = typeof entry === "string" ? entry : entry.text;
  return typeof text === "string" && text.trim() ? text : null;
}

/**
 * Prepend the persona to a request body, keeping every message the client sent.
 *
 * Rule, and it is the one this file's header promises: the persona is messages[0] and the
 * client's messages follow unchanged, so a client that sent its own system message gets
 * TWO system messages - Rosalena's first, the client's second. OpenAI-compatible
 * providers accept that order and honour both. The client's array is never mutated, so a
 * caller that reuses its body object (the router does, per attempt) sees no change.
 */
export function withSystemPersona(body, personaText) {
  if (!personaText) return body;
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return { ...body, messages: [{ role: "system", content: personaText }, ...messages] };
}

/**
 * Refuse tool calls on a request that declares no tools.
 *
 * Measured, not theoretical: asked to read a file, the free tier behind this class returned a
 * `read` tool call even though the request carried no `tools` array at all - its own harness
 * tools leak into the completion. A persona class hands the caller nothing to execute that
 * call with, so the call would surface as an EMPTY answer: the assistant silently "answers"
 * with a tool nobody can run. `tool_choice: "none"` makes the model say what it cannot do in
 * words instead (verified against the live provider: empty content + finish_reason
 * "tool_calls" before, a full honest answer with finish_reason "stop" after).
 *
 * Applied ONLY to persona classes, and only when no `tools` were declared - a caller that
 * brings its own tools keeps them and keeps its tool_choice.
 */
export function withNoTools(body) {
  if (!body || typeof body !== "object") return body;
  const declared = Array.isArray(body.tools) ? body.tools : [];
  if (declared.length > 0) return body;
  if (body.tool_choice === "none") return body;
  return { ...body, tool_choice: "none" };
}
