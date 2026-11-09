// A small unified diff (Myers, line-based) for showing what a rewrite or rename would
// change before it is applied. No dependency, bounded: past MAX_D edits it falls back to
// one hunk that replaces the changed middle, which is still a correct diff, just a coarse one.

const MAX_D = 1500;

const splitLines = (text) => {
  const s = String(text ?? "").replace(/\r\n/g, "\n");
  const lines = s.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
};

/** Edit script between two line arrays: [{ op: " " | "-" | "+", text }]. */
export function diffLines(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre += 1;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf += 1;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const head = a.slice(0, pre).map((text) => ({ op: " ", text }));
  const tail = a.slice(a.length - suf).map((text) => ({ op: " ", text }));
  return [...head, ...middle(A, B), ...tail];
}

function middle(A, B) {
  const n = A.length;
  const m = B.length;
  if (!n) return B.map((text) => ({ op: "+", text }));
  if (!m) return A.map((text) => ({ op: "-", text }));
  const max = n + m;
  const off = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace = [];
  for (let d = 0; d <= max; d += 1) {
    if (d > MAX_D) return [...A.map((text) => ({ op: "-", text })), ...B.map((text) => ({ op: "+", text }))];
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) {
        x += 1;
        y += 1;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, A, B, off, d);
    }
  }
  return [];
}

function backtrack(trace, A, B, off, dEnd) {
  const ops = [];
  let x = A.length;
  let y = B.length;
  for (let d = dEnd; d > 0; d -= 1) {
    const v = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]);
    const pk = down ? k + 1 : k - 1;
    const px = v[off + pk];
    const py = px - pk;
    while (x > px && y > py) {
      ops.push({ op: " ", text: A[x - 1] });
      x -= 1;
      y -= 1;
    }
    if (down) ops.push({ op: "+", text: B[py] });
    else ops.push({ op: "-", text: A[px] });
    x = px;
    y = py;
  }
  while (x > 0 && y > 0) {
    ops.push({ op: " ", text: A[x - 1] });
    x -= 1;
    y -= 1;
  }
  return ops.reverse();
}

/** A unified diff of one file, `context` unchanged lines around each change. "" if equal. */
export function unifiedDiff(before, after, name = "file", context = 2) {
  const a = splitLines(before);
  const b = splitLines(after);
  const ops = diffLines(a, b);
  if (!ops.some((o) => o.op !== " ")) return "";
  const out = [`--- a/${name}`, `+++ b/${name}`];
  // Number every op with its old/new line, then group changes that are close together.
  let ai = 1;
  let bi = 1;
  const rows = ops.map((o) => {
    const row = { ...o, a: ai, b: bi };
    if (o.op !== "+") ai += 1;
    if (o.op !== "-") bi += 1;
    return row;
  });
  const changed = rows.map((r, i) => (r.op !== " " ? i : -1)).filter((i) => i >= 0);
  let h = 0;
  while (h < changed.length) {
    let start = Math.max(0, changed[h] - context);
    let endIdx = changed[h];
    while (h + 1 < changed.length && changed[h + 1] - endIdx <= context * 2 + 1) {
      h += 1;
      endIdx = changed[h];
    }
    const stop = Math.min(rows.length - 1, endIdx + context);
    const slice = rows.slice(start, stop + 1);
    const aCount = slice.filter((r) => r.op !== "+").length;
    const bCount = slice.filter((r) => r.op !== "-").length;
    const aStart = slice.find((r) => r.op !== "+")?.a ?? rows[start].a;
    const bStart = slice.find((r) => r.op !== "-")?.b ?? rows[start].b;
    out.push(`@@ -${aCount ? aStart : aStart - 1},${aCount} +${bCount ? bStart : bStart - 1},${bCount} @@`);
    for (const r of slice) out.push(`${r.op}${r.text}`);
    h += 1;
    start = stop;
  }
  return out.join("\n");
}

/** Counts of added and removed lines in a unified diff. */
export function diffStat(diff) {
  let added = 0;
  let removed = 0;
  for (const line of String(diff).split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}
