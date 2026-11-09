// A real, tiny decoder-only transformer, computed live.
//
//   vocab 16 words, d_model 8, 2 attention heads (d_head 4), 1 block, causal mask,
//   residual connections, a ReLU feed-forward layer (8 units), tied unembedding.
//
// The weights are hand-designed so every dimension and unit means something you can
// name (see DIMS and NEURONS), then jittered with a seeded generator so nothing is a
// suspiciously round number. No number on screen is faked: everything the scene draws
// and the inspector explains comes out of forward() below.

export const VOCAB = ["the", "a", "cat", "dog", "sat", "ran", "slept", "on", "under", "mat", "floor", "table", "sofa", "big", "and", "."];
export const DIMS = ["det", "animal", "verb", "prep", "place", "rest", "ctx-prep", "end"];
export const DIM_HELP = [
  "determiner-ness (the, a)",
  "animal noun (cat, dog)",
  "verb (sat, ran, slept)",
  "preposition (on, under)",
  "place noun (mat, floor, table, sofa)",
  "resting (+) vs moving / below (-)",
  "a preposition was seen earlier (written by head 1)",
  "sentence break (., and)",
];
export const NEURONS = ["next:place", "next:animal", "next:verb", "next:prep", "next:det", "next:end", "soft place", "hard place"];
export const NEURON_HELP = [
  "fires on a determiner after a preposition: a place noun comes next",
  "fires on a determiner with no preposition before it: an animal comes next",
  "fires on an animal: a verb comes next",
  "fires on a verb: a preposition comes next",
  "fires on a preposition or a break: a determiner comes next",
  "fires on a place noun: the sentence can end",
  "place context that feels resting (sat, on): pushes toward mat, sofa",
  "place context that feels moving or below (ran, under): pushes toward table, floor",
];
export const HEADS = [
  { name: "Head 1", role: "preposition finder", help: "Looks back for on / under and copies that a preposition was seen (ctx-prep) plus a little of its rest value." },
  { name: "Head 2", role: "verb finder", help: "Looks back for the verb and copies its rest value (sat is resting, ran is moving)." },
];
export const D = 8;
export const H = 2;
export const DH = 4;
export const FF = 8;
export const MAX_T = 8;
export const DEFAULT_PROMPT = "the cat sat on the";

// ------------------------------------------------------------------ weights

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20261103);
const jitter = (amp) => (rand() * 2 - 1) * amp;
const round4 = (v) => Math.round(v * 10000) / 10000;
const matrix = (rows, cols, amp) => Array.from({ length: rows }, () => Array.from({ length: cols }, () => round4(jitter(amp))));
const vector = (n, amp) => Array.from({ length: n }, () => round4(jitter(amp)));
const add = (m, r, c, v) => (m[r][c] = round4(m[r][c] + v));

const W = (() => {
  // Token embeddings E[word][dim]
  const E = matrix(VOCAB.length, D, 0.03);
  const set = (word, dims) => {
    const r = VOCAB.indexOf(word);
    for (const [d, v] of Object.entries(dims)) add(E, r, Number(d), v);
  };
  set("the", { 0: 1.0 });
  set("a", { 0: 0.9 });
  set("cat", { 1: 1.0, 5: 0.2 });
  set("dog", { 1: 1.0, 5: -0.2 });
  set("sat", { 2: 1.0, 5: 0.9 });
  set("ran", { 2: 1.0, 5: -0.9 });
  set("slept", { 2: 1.0, 5: 0.7 });
  set("on", { 3: 1.0, 5: 0.6 });
  set("under", { 3: 1.0, 5: -1.0 });
  set("mat", { 4: 1.0, 5: 0.9 });
  set("floor", { 4: 1.0, 5: -0.3 });
  set("table", { 4: 1.0, 5: -0.9 });
  set("sofa", { 4: 1.0, 5: 0.5 });
  set("big", { 0: 0.8, 1: 0.25 });
  set("and", { 3: 0.3, 7: 0.6 });
  set(".", { 7: 1.0 });

  // Sinusoidal positions, kept small: P[pos][i]
  const P = Array.from({ length: MAX_T }, (_, pos) =>
    Array.from({ length: D }, (_, i) => {
      const k = i - (i % 2);
      const angle = pos / Math.pow(10000, k / D);
      return round4(0.08 * (i % 2 === 0 ? Math.sin(angle) : Math.cos(angle)));
    }),
  );

  const typeDims = [0, 1, 2, 3, 4, 7];
  const Wq = [matrix(D, DH, 0.05), matrix(D, DH, 0.05)];
  const Wk = [matrix(D, DH, 0.05), matrix(D, DH, 0.05)];
  const Wv = [matrix(D, DH, 0.04), matrix(D, DH, 0.04)];
  // Head 1: every token asks "where is a preposition?"
  for (const d of typeDims) add(Wq[0], d, 0, 2.0);
  for (const d of typeDims) add(Wk[0], d, 0, d === 3 ? 2.6 : -0.6);
  add(Wv[0], 3, 0, 1.0);
  add(Wv[0], 5, 1, 1.0);
  // Head 2: every token asks "where is the verb?"
  for (const d of typeDims) add(Wq[1], d, 0, 2.0);
  for (const d of typeDims) add(Wk[1], d, 0, d === 2 ? 2.6 : -0.6);
  add(Wv[1], 5, 0, 1.0);
  add(Wv[1], 2, 1, 1.0);

  // Output projection: concat(head1, head2) (8) -> d_model (8)
  const Wo = matrix(H * DH, D, 0.04);
  add(Wo, 0, 6, 1.0); // head 1 prep-ness -> ctx-prep
  add(Wo, 1, 5, 0.4); // head 1 rest value -> rest
  add(Wo, 4, 5, 0.7); // head 2 rest value -> rest

  // Feed-forward: W1 (d_model x FF), b1, W2 (FF x d_model), b2
  const W1 = matrix(D, FF, 0.04);
  const b1 = vector(FF, 0.03);
  const unit = (n, weights, bias) => {
    for (const [d, v] of Object.entries(weights)) add(W1, Number(d), n, v);
    b1[n] = round4(b1[n] + bias);
  };
  unit(0, { 0: 1.2, 6: 1.0 }, -1.3);
  unit(1, { 0: 1.2, 6: -1.5 }, -0.4);
  unit(2, { 1: 1.5 }, -0.5);
  unit(3, { 2: 1.5 }, -0.5);
  unit(4, { 3: 1.5, 7: 1.5 }, -0.4);
  unit(5, { 4: 1.5 }, -0.5);
  unit(6, { 0: 0.8, 6: 0.8, 5: 1.0 }, -1.4);
  unit(7, { 0: 0.8, 6: 0.8, 5: -1.0 }, -1.4);

  const W2 = matrix(FF, D, 0.04);
  const b2 = vector(D, 0.03);
  const write = (n, dims) => {
    for (const [d, v] of Object.entries(dims)) add(W2, n, Number(d), v);
  };
  write(0, { 4: 4.2, 0: -1.2 });
  write(1, { 1: 3.0, 0: -1.2 });
  write(2, { 2: 3.0, 1: -1.2 });
  write(3, { 3: 4.0, 2: -1.2 });
  write(4, { 0: 4.0, 3: -1.2, 7: -1.0 });
  write(5, { 7: 4.5, 4: -1.2 });
  write(6, { 5: 1.3 });
  write(7, { 5: -1.3 });

  return { E, P, Wq, Wk, Wv, Wo, W1, b1, W2, b2 };
})();

export const WEIGHTS = W;

// ------------------------------------------------------------------ math

export function softmax(values) {
  let max = -Infinity;
  for (const v of values) if (v > max) max = v;
  const exps = values.map((v) => (v === -Infinity ? 0 : Math.exp(v - max)));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const matVec = (x, M) => M[0].map((_, j) => x.reduce((s, v, i) => s + v * M[i][j], 0));
const relu = (v) => (v > 0 ? v : 0);

/** Split a sentence into vocabulary ids. Returns { ok, words, ids } or { ok:false, error }. */
export function tokenize(text) {
  const words = String(text ?? "")
    .toLowerCase()
    .replace(/\./g, " . ")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return { ok: false, error: "Type a few words first, for example: the cat sat on the" };
  const unknown = words.filter((w) => !VOCAB.includes(w));
  if (unknown.length) {
    const list = [...new Set(unknown)].map((w) => `"${w}"`).join(", ");
    return { ok: false, error: `${list} ${unknown.length === 1 ? "is" : "are"} not in this model's 16-word vocabulary. Click a word chip to add one it knows.` };
  }
  if (words.length > MAX_T) return { ok: false, error: `Keep it to ${MAX_T} words or fewer (this model has ${MAX_T} positions); you typed ${words.length}.` };
  return { ok: true, words, ids: words.map((w) => VOCAB.indexOf(w)) };
}

/** Run the whole network on token ids. Every intermediate is kept for the scene. */
export function forward(ids) {
  const T = ids.length;
  const words = ids.map((id) => VOCAB[id]);
  const emb = ids.map((id) => W.E[id].slice());
  const pos = ids.map((_, t) => W.P[t].slice());
  const x0 = emb.map((e, t) => e.map((v, d) => v + pos[t][d]));

  const scale = 1 / Math.sqrt(DH);
  const heads = [];
  for (let h = 0; h < H; h++) {
    const q = x0.map((x) => matVec(x, W.Wq[h]));
    const k = x0.map((x) => matVec(x, W.Wk[h]));
    const v = x0.map((x) => matVec(x, W.Wv[h]));
    const raw = q.map((qi) => k.map((kj) => dot(qi, kj) * scale));
    const scores = raw.map((row, i) => row.map((s, j) => (j > i ? -Infinity : s)));
    const A = scores.map((row) => softmax(row));
    const out = A.map((row) => Array.from({ length: DH }, (_, c) => row.reduce((s, a, j) => s + a * v[j][c], 0)));
    heads.push({ q, k, v, raw, scores, A, out });
  }
  const concat = x0.map((_, t) => [...heads[0].out[t], ...heads[1].out[t]]);
  const attnOut = concat.map((c) => matVec(c, W.Wo));
  const x1 = x0.map((x, t) => x.map((v, d) => v + attnOut[t][d]));

  const pre = x1.map((x) => matVec(x, W.W1).map((v, n) => v + W.b1[n]));
  const hidden = pre.map((row) => row.map(relu));
  const ffnOut = hidden.map((hrow) => matVec(hrow, W.W2).map((v, d) => v + W.b2[d]));
  const x2 = x1.map((x, t) => x.map((v, d) => v + ffnOut[t][d]));

  const last = x2[T - 1];
  const logits = W.E.map((e) => dot(last, e));
  const probs = softmax(logits);
  let top = 0;
  for (let w = 1; w < probs.length; w++) if (probs[w] > probs[top]) top = w;
  const ranked = probs.map((p, w) => ({ w, word: VOCAB[w], p, logit: logits[w] })).sort((a, b) => b.p - a.p);
  return { ids, words, T, emb, pos, x0, heads, concat, attnOut, x1, pre, hidden, ffnOut, x2, logits, probs, top, ranked };
}

export function run(text) {
  const tok = tokenize(text);
  if (!tok.ok) return tok;
  return { ok: true, ...forward(tok.ids) };
}

// ------------------------------------------------------------------ inspection

/** The number a scene cell stands for. `ref` is the cell's userData. */
export function valueOf(m, ref) {
  switch (ref.stage) {
    case "token":
      return m.ids[ref.t];
    case "embed":
      return m.x0[ref.t][ref.d];
    case "qkv":
      return m.heads[ref.head][ref.kind][ref.t][ref.j];
    case "attn":
      return m.heads[ref.head].A[ref.i][ref.j];
    case "mix":
      return m.x1[ref.t][ref.d];
    case "ffn":
      return m.hidden[ref.t][ref.n];
    case "logit":
      return ref.raw ? m.logits[ref.w] : m.probs[ref.w];
    default:
      return NaN;
  }
}

export const fmt = (v, digits = 3) => {
  if (v === -Infinity) return "-inf";
  if (!Number.isFinite(v)) return String(v);
  const s = v.toFixed(digits);
  return s === `-${(0).toFixed(digits)}` ? (0).toFixed(digits) : s;
};

const topTerms = (terms, n = 4) =>
  terms
    .map((t) => ({ ...t, abs: Math.abs(t.value) }))
    .sort((a, b) => b.abs - a.abs)
    .slice(0, n);

/** Explain a cell: what it is, its exact value, the formula and the inputs that made it. */
export function explain(m, ref) {
  const value = valueOf(m, ref);
  const w = (t) => `"${m.words[t]}"`;
  switch (ref.stage) {
    case "token": {
      return {
        title: `Token ${ref.t + 1}: ${w(ref.t)}`,
        value,
        valueText: `id ${value}`,
        formula: `id = vocab.indexOf(${w(ref.t)})`,
        terms: [
          ["word", m.words[ref.t]],
          ["position", ref.t],
          ["vocab id", value],
        ],
        note: "The model never sees letters, only this id. The next stage looks the id up in the embedding table.",
      };
    }
    case "embed": {
      const e = m.emb[ref.t][ref.d];
      const p = m.pos[ref.t][ref.d];
      return {
        title: `Embedding of ${w(ref.t)}, dim ${ref.d} (${DIMS[ref.d]})`,
        value,
        valueText: fmt(value),
        formula: `x[${ref.t}][${ref.d}] = E[${m.ids[ref.t]}][${ref.d}] + P[${ref.t}][${ref.d}] = ${fmt(e)} + ${fmt(p)}`,
        terms: [
          [`E[${m.words[ref.t]}][${DIMS[ref.d]}]`, e],
          [`P[pos ${ref.t}][${ref.d}]`, p],
        ],
        note: `Dim ${ref.d} means: ${DIM_HELP[ref.d]}.`,
      };
    }
    case "qkv": {
      const M = { q: W.Wq, k: W.Wk, v: W.Wv }[ref.kind][ref.head];
      const x = m.x0[ref.t];
      const terms = topTerms(x.map((xv, d) => ({ label: `x[${DIMS[d]}] ${fmt(xv)} * W[${d}][${ref.j}] ${fmt(M[d][ref.j])}`, value: xv * M[d][ref.j] })));
      const letter = ref.kind.toUpperCase();
      return {
        title: `${HEADS[ref.head].name} ${letter} of ${w(ref.t)}, component ${ref.j}`,
        value,
        valueText: fmt(value),
        formula: `${ref.kind}[${ref.t}][${ref.j}] = sum_d x[${ref.t}][d] * W_${letter}[d][${ref.j}]`,
        terms: terms.map((t) => [t.label, t.value]),
        note:
          ref.kind === "q"
            ? "The query: what this token is looking for."
            : ref.kind === "k"
              ? "The key: what this token offers to queries that look at it."
              : "The value: what this token hands over when it is attended to.",
      };
    }
    case "attn": {
      const hd = m.heads[ref.head];
      if (ref.j > ref.i) {
        return {
          title: `${HEADS[ref.head].name}: ${w(ref.i)} looking at ${w(ref.j)}`,
          value,
          valueText: fmt(value, 4),
          formula: `key position ${ref.j} > query position ${ref.i}: mask = -inf, so A = exp(-inf) / Z = 0`,
          terms: [
            ["raw score q.k/sqrt(4)", hd.raw[ref.i][ref.j]],
            ["mask", "-inf"],
            ["weight", 0],
          ],
          note: "Causal mask: a token may not look at words that come after it, so the model cannot cheat by reading the answer.",
        };
      }
      const s = hd.scores[ref.i][ref.j];
      const row = hd.scores[ref.i].slice(0, ref.i + 1);
      const max = Math.max(...row);
      const z = row.reduce((a, v) => a + Math.exp(v - max), 0);
      return {
        title: `${HEADS[ref.head].name}: ${w(ref.i)} looking at ${w(ref.j)}`,
        value,
        valueText: `${fmt(value, 4)} (${(value * 100).toFixed(1)}%)`,
        formula: `A[${ref.i}][${ref.j}] = exp(s - max) / Z,  s = q[${ref.i}].k[${ref.j}] / sqrt(4) = ${fmt(s)}`,
        terms: [
          ["score s", s],
          ["row max", max],
          ["exp(s - max)", Math.exp(s - max)],
          ["Z = sum of row", z],
          ["weight", value],
        ],
        note: `Each row sums to 1. ${HEADS[ref.head].name} is the ${HEADS[ref.head].role}: ${HEADS[ref.head].help}`,
      };
    }
    case "mix": {
      const x0 = m.x0[ref.t][ref.d];
      const a = m.attnOut[ref.t][ref.d];
      const c = m.concat[ref.t];
      const terms = topTerms(c.map((cv, r) => ({ label: `head ${r < DH ? 1 : 2} out[${r % DH}] ${fmt(cv)} * W_O[${r}][${ref.d}] ${fmt(W.Wo[r][ref.d])}`, value: cv * W.Wo[r][ref.d] })), 3);
      return {
        title: `After attention: ${w(ref.t)}, dim ${ref.d} (${DIMS[ref.d]})`,
        value,
        valueText: fmt(value),
        formula: `x'[${ref.t}][${ref.d}] = x + (concat(heads) W_O) = ${fmt(x0)} + ${fmt(a)}`,
        terms: [["residual x (from Embed)", x0], ["attention adds", a], ...terms.map((t) => [t.label, t.value])],
        note: "The residual connection: attention only adds to the vector, it never replaces it.",
      };
    }
    case "ffn": {
      const pre = m.pre[ref.t][ref.n];
      const x = m.x1[ref.t];
      const terms = topTerms(x.map((xv, d) => ({ label: `x'[${DIMS[d]}] ${fmt(xv)} * W1[${d}][${ref.n}] ${fmt(W.W1[d][ref.n])}`, value: xv * W.W1[d][ref.n] })), 3);
      return {
        title: `FFN unit ${ref.n} (${NEURONS[ref.n]}) on ${w(ref.t)}`,
        value,
        valueText: fmt(value),
        formula: `h[${ref.t}][${ref.n}] = ReLU(sum_d x'[d] W1[d][${ref.n}] + b1[${ref.n}]) = ReLU(${fmt(pre)})`,
        terms: [["pre-activation", pre], ["bias b1", W.b1[ref.n]], ...terms.map((t) => [t.label, t.value])],
        note: `This unit ${NEURON_HELP[ref.n]}.${pre <= 0 ? " Here it is below zero, so ReLU switches it off." : ""}`,
      };
    }
    case "logit": {
      const last = m.x2[m.T - 1];
      const e = W.E[ref.w];
      const terms = topTerms(last.map((xv, d) => ({ label: `x''[${DIMS[d]}] ${fmt(xv)} * E[${VOCAB[ref.w]}][${d}] ${fmt(e[d])}`, value: xv * e[d] })), 3);
      const rank = m.ranked.findIndex((r) => r.w === ref.w) + 1;
      if (ref.raw) {
        const max = Math.max(...m.logits);
        const z = m.logits.reduce((a, v) => a + Math.exp(v - max), 0);
        return {
          title: `Score (logit) for "${VOCAB[ref.w]}" after "${m.words.join(" ")}"`,
          value,
          valueText: fmt(value),
          formula: `logit[${VOCAB[ref.w]}] = sum_d x''[last][d] * E[${VOCAB[ref.w]}][d] = ${fmt(value)}`,
          terms: [
            ...terms.map((t) => [t.label, t.value]),
            ["exp(logit - max)", Math.exp(value - max)],
            ["Z = sum over all 16 words", z],
            ["softmax -> probability", m.probs[ref.w]],
          ],
          note: "A raw score: any real number. Softmax exponentiates every score and divides by their sum, so the biggest score wins most of the probability.",
        };
      }
      return {
        title: `Next word "${VOCAB[ref.w]}" after "${m.words.join(" ")}"`,
        value,
        valueText: `${(value * 100).toFixed(2)}%  (rank ${rank} of ${VOCAB.length})`,
        formula: `p = softmax(logits),  logit[${VOCAB[ref.w]}] = x''[last] . E[${VOCAB[ref.w]}] = ${fmt(m.logits[ref.w])}`,
        terms: [["logit", m.logits[ref.w]], ["probability", value], ...terms.map((t) => [t.label, t.value])],
        note: "The final vector is compared with every word's embedding (tied weights); softmax turns the scores into probabilities.",
      };
    }
    default:
      return { title: "Nothing selected", value: NaN, valueText: "", formula: "", terms: [], note: "" };
  }
}
