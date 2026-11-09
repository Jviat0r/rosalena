// Hashline: edits anchored by a short hash of each line's content.
//
// read_hashed shows every line as `12:a3f|    const x = 1;`: the line number, three hex
// characters of the sha1 of that line's text, then the text. edit_hashed names the lines
// to change by those anchors. If the file moved on since the model read it (another edit,
// a formatter, a line it misremembered), an anchor no longer matches and the edit is
// refused with the fresh lines, instead of landing on the wrong line. That is the failure
// small models hit most with search-and-replace: an old_text that is "almost" right.
//
// The hash ignores the line ending, so a file is the same to the model with CRLF or LF.
// Edits keep the file's own endings (per line), its trailing newline (or lack of one) and
// a UTF-8 byte order mark.

import { createHash } from "node:crypto";

export const HASH_LEN = 3;

/** The anchor hash of one line's text (no line ending). */
export function lineHash(text) {
  return createHash("sha1").update(String(text).replace(/\r$/, ""), "utf8").digest("hex").slice(0, HASH_LEN);
}

/**
 * Split a file into lines, each with its own terminator ("\r\n", "\n" or "" for a last
 * line without one). A lone "\r" stays part of the text.
 */
export function parseFile(raw) {
  let text = String(raw ?? "");
  const bom = text.startsWith("﻿");
  if (bom) text = text.slice(1);
  const lines = [];
  let at = 0;
  while (at < text.length) {
    const nl = text.indexOf("\n", at);
    if (nl === -1) {
      lines.push({ text: text.slice(at), eol: "" });
      break;
    }
    const crlf = nl > at && text[nl - 1] === "\r";
    lines.push({ text: text.slice(at, crlf ? nl - 1 : nl), eol: crlf ? "\r\n" : "\n" });
    at = nl + 1;
  }
  const crlfCount = lines.filter((l) => l.eol === "\r\n").length;
  const lfCount = lines.filter((l) => l.eol === "\n").length;
  return { bom, lines, eol: crlfCount > lfCount ? "\r\n" : "\n" };
}

export function joinFile({ bom, lines }) {
  return (bom ? "﻿" : "") + lines.map((l) => l.text + l.eol).join("");
}

const DISPLAY_MAX = 400;

/** `12:a3f|text` for lines [from, to] (1-based, inclusive). Long lines are cut for display only. */
export function renderLines(lines, from, to) {
  const out = [];
  const start = Math.max(1, from);
  const end = Math.min(lines.length, to);
  for (let n = start; n <= end; n += 1) {
    const t = lines[n - 1].text;
    const shown = t.length > DISPLAY_MAX ? `${t.slice(0, DISPLAY_MAX)}… [line cut for display, ${t.length} chars]` : t;
    out.push(`${n}:${lineHash(t)}|${shown}`);
  }
  return out.join("\n");
}

/**
 * Parse an anchor: "12:a3f", or a whole copied line "12:a3f|  code". "0" (or "0:") is the
 * spot before line 1, for inserting at the top of a file.
 */
export function parseAnchor(value, { allowZero = false } = {}) {
  const s = String(value ?? "").trim();
  if (allowZero && /^0\s*(?::\s*[0-9a-f]*)?\s*(?:\|.*)?$/is.test(s)) return { line: 0, hash: "" };
  const m = /^(\d+)\s*:\s*([0-9a-f]{3,})\b/i.exec(s);
  if (!m) {
    throw new Error(`anchor "${s.slice(0, 40)}" is not in the form LINE:HASH (for example "12:a3f"). Copy it from read_hashed output`);
  }
  return { line: Number(m[1]), hash: m[2].toLowerCase().slice(0, HASH_LEN) };
}

const HASHED_PREFIX = /^\d+:[0-9a-f]{3}\|/i;

/**
 * The replacement text as lines. One trailing newline is dropped ("a\nb\n" is two lines).
 * If the model pasted read_hashed output, with `12:a3f|` on every line, the prefixes are
 * stripped (and reported) rather than written into the file.
 */
export function newLines(newText) {
  const s = String(newText ?? "");
  if (s === "") return { lines: [], stripped: false };
  const parts = s.split(/\r?\n/);
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  const nonEmpty = parts.filter((p) => p.trim());
  const stripped = nonEmpty.length > 0 && nonEmpty.every((p) => HASHED_PREFIX.test(p));
  return { lines: stripped ? parts.map((p) => p.replace(HASHED_PREFIX, "")) : parts, stripped };
}

/** Lines whose hash is `hash`, nearest to `line` first, within `window` lines. */
function nearby(lines, line, hash, window = 40) {
  const hits = [];
  for (let n = Math.max(1, line - window); n <= Math.min(lines.length, line + window); n += 1) {
    if (n !== line && lineHash(lines[n - 1].text) === hash) hits.push(n);
  }
  return hits.sort((a, b) => Math.abs(a - line) - Math.abs(b - line));
}

class Stale extends Error {}

function check(lines, anchor, which) {
  const { line, hash } = anchor;
  if (line < 1 || line > lines.length) {
    throw new Stale(`${which} anchor ${line}:${hash} is past the end of the file (it has ${lines.length} line${lines.length === 1 ? "" : "s"})`);
  }
  const now = lineHash(lines[line - 1].text);
  if (now !== hash) {
    const moved = nearby(lines, line, hash);
    const hint = moved.length ? ` The line you meant may now be line ${moved[0]}.` : "";
    throw new Stale(`${which} anchor ${line}:${hash} does not match: line ${line} is now ${line}:${now}.${hint}`);
  }
}

/**
 * Apply one anchored edit to a file's text. Pure.
 *
 *   { start, end?, new_text }   replace lines start..end (end defaults to start);
 *                               an empty new_text deletes them
 *   { after, new_text }         insert new_text after that line ("0" = top of file)
 *
 * Returns { ok: true, text, from, to, removed, added, stripped } where from..to are the new
 * lines' numbers, or { ok: false, reason, around } with the line to show fresh context at.
 */
export function applyHashedEdit(raw, { start, end, after, new_text: newText } = {}) {
  const file = parseFile(raw);
  const { lines } = file;
  const repl = newLines(newText);
  let from;
  let to;
  let removeCount;
  try {
    if (after !== undefined && after !== null && after !== "") {
      if (start) throw new Error("give either start (to replace lines) or after (to insert), not both");
      const a = parseAnchor(after, { allowZero: true });
      if (a.line !== 0) check(lines, a, "after");
      if (!repl.lines.length) throw new Error("new_text is empty, so there is nothing to insert");
      from = a.line + 1;
      removeCount = 0;
    } else {
      if (!start) throw new Error('give start (for example "12:a3f") to replace lines, or after to insert');
      const s = parseAnchor(start);
      const e = end ? parseAnchor(end) : s;
      if (e.line < s.line) throw new Error(`end (line ${e.line}) is before start (line ${s.line})`);
      check(lines, s, "start");
      if (e !== s) check(lines, e, "end");
      from = s.line;
      removeCount = e.line - s.line + 1;
      const same = removeCount === repl.lines.length && repl.lines.every((t, i) => t === lines[from - 1 + i].text);
      if (same) throw new Error("new_text is the same as the lines it replaces, so there is nothing to change");
    }
  } catch (err) {
    if (err instanceof Stale) {
      const around = Number(/(\d+):/.exec(err.message)?.[1]) || 1;
      return { ok: false, stale: true, reason: err.message, around };
    }
    return { ok: false, stale: false, reason: err.message, around: null };
  }

  const wasLast = from - 1 + removeCount >= lines.length; // the edit reaches the end of the file
  const finalEol = lines.length ? lines[lines.length - 1].eol : file.eol;
  const inserted = repl.lines.map((text) => ({ text, eol: file.eol }));
  // An inserted line takes the ending of the line it replaces, where there is one.
  for (let i = 0; i < inserted.length && i < removeCount; i += 1) {
    const old = lines[from - 1 + i];
    if (old.eol) inserted[i].eol = old.eol;
  }
  const next = [...lines.slice(0, from - 1), ...inserted, ...lines.slice(from - 1 + removeCount)];
  // Every line but the last ends with a newline; the last keeps the file's own choice.
  for (let i = 0; i < next.length - 1; i += 1) if (!next[i].eol) next[i].eol = file.eol;
  if (next.length) next[next.length - 1].eol = wasLast || !lines.length ? finalEol : next[next.length - 1].eol;
  if (next.length && !lines.length) next[next.length - 1].eol = file.eol;

  return {
    ok: true,
    text: joinFile({ bom: file.bom, lines: next }),
    from,
    to: from + inserted.length - 1,
    removed: removeCount,
    added: inserted.length,
    stripped: repl.stripped,
    total: next.length,
  };
}
