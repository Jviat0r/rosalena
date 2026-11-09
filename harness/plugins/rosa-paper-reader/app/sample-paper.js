// The built-in sample paper: a real, multi-page PDF assembled by hand at runtime.
//
// Nothing is fetched. The bytes are written object by object (catalog, page tree, fonts,
// content streams, an outline and an info dictionary), with a cross-reference table whose
// offsets are counted as the file is written. Text uses the standard Helvetica fonts, so
// nothing has to be embedded, and the layout wraps and justifies lines with Helvetica's
// own glyph widths. The output is deterministic: the same bytes (and the same document
// hash) every time, so notes made on the sample come back when it is reopened.

/** A sentence the self-tests look for on page 2. */
export const KNOWN_SENTENCE = "The retrieval window is the single strongest predictor of task success.";
/** A phrase in the abstract on page 1. */
export const ABSTRACT_PHRASE = "agents that retrieve less, but retrieve better, finish more tasks";
export const SAMPLE_NAME = "sparse-recall-sample.pdf";
export const SAMPLE_TITLE = "Sparse Recall: How Retrieval Windows Shape Coding-Agent Reliability";

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 72;
const BODY_W = PAGE_W - 2 * MARGIN;

// Helvetica advance widths (1/1000 em) for character codes 32-126, WinAnsiEncoding.
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
// Helvetica-Bold, same range.
const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

const FONTS = {
  F1: { base: "Helvetica", widths: HELVETICA },
  F2: { base: "Helvetica-Bold", widths: HELVETICA_BOLD },
  F3: { base: "Helvetica-Oblique", widths: HELVETICA },
};

function widthOf(text, size, font = "F1") {
  const table = FONTS[font].widths;
  let w = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    w += c >= 32 && c <= 126 ? table[c - 32] : 556;
  }
  return (w * size) / 1000;
}

const num = (n) => (Math.round(n * 100) / 100).toString();
const esc = (s) => s.replace(/[\\()]/g, (c) => "\\" + c);

const CONTENT = {
  authors: "Mara Okafor, Lukas Brandt and Sora Ito",
  affiliation: "Rosalena Sample Lab - a fictional paper bundled with Paper Reader",
  abstract:
    "Coding agents are usually given as much context as their window allows, on the theory that more " +
    "source code can only help. We test that theory on 1,240 repository tasks and find the opposite " +
    "pattern once a window passes a modest size: agents that retrieve less, but retrieve better, finish more tasks " +
    "and make fewer unrelated edits. We describe a sparse recall policy that ranks files by how recently " +
    "and how directly the task touches them, and we show that it raises the task success rate of a " +
    "mid-sized agent from 41 to 58 percent while cutting the tokens it reads by more than half.",
  intro: [
    "Large context windows changed how coding agents are built. A model that can read a hundred thousand " +
      "tokens invites a simple strategy: put the whole repository, or as much of it as fits, in front of the " +
      "agent and let it find what matters. The strategy is easy to implement and easy to explain, and for small " +
      "projects it works well enough that few teams question it.",
    "Larger projects tell a different story. An agent that reads every file it can reach spends most of its " +
      "attention on code that has nothing to do with the task, and the cost is not only tokens. Irrelevant " +
      "context competes with the relevant lines for the model's attention, invites edits to files the task " +
      "never mentioned, and makes the agent's plan harder to follow when a person reviews it.",
    "This paper asks a narrow question: when an agent has a fixed budget of context, which files should fill " +
      "it? We compare four retrieval policies on the same agent and the same tasks, and we measure not only " +
      "whether the task succeeds but how much the agent read, how many files it changed, and how often a " +
      "reviewer had to undo part of its work.",
    "Our contributions are a benchmark of 1,240 tasks drawn from 86 open repositories, a sparse recall " +
      "policy that needs no extra model calls, and an analysis showing where large windows stop helping. " +
      "We release the task list and the scoring scripts so that other teams can repeat the comparison.",
  ],
  method: [
    "Every run gives the agent the same instructions, tools and model; only the retrieval policy changes. " +
      KNOWN_SENTENCE +
      " We therefore hold the window fixed at 32,000 tokens for the main comparison and vary it separately " +
      "in Section 3.",
    "The four policies are: full, which packs files in directory order until the window is full; lexical, " +
      "which ranks files by keyword overlap with the task; embedding, which ranks them by vector similarity; " +
      "and sparse recall, which scores each file by how directly the task names it, how recently it changed, " +
      "and whether it imports or is imported by a file already chosen.",
    "Sparse recall stops adding files when the next file's score falls below a fixed fraction of the best " +
      "score, even if the window still has room. This early stop is the policy's main idea: an agent that " +
      "is shown six relevant files and nothing else makes better decisions than one that is shown the same " +
      "six files buried among forty others.",
  ],
  benchmark: [
    "Tasks come from merged pull requests that closed an issue and changed between one and eight files. " +
      "Each task keeps the issue text as the prompt and the repository's own tests as the oracle; a run " +
      "succeeds when the tests that the pull request added or changed pass and no previously passing test " +
      "fails.",
    "We drop tasks whose tests need network access or take longer than ten minutes, which leaves 1,240 " +
      "tasks in Python, TypeScript, Go and Rust. Every task is run three times per policy and we report the " +
      "mean, so a single lucky run cannot decide a comparison.",
    "A second reviewer read a random sample of 200 finished runs per policy and marked every change that " +
      "was unrelated to the issue. These unrelated edits are the hidden cost of large contexts: they pass " +
      "the tests but still have to be found and reverted by a person.",
  ],
  results: [
    "Table 1 and Figure 1 summarise the main comparison. Sparse recall finishes the most tasks while " +
      "reading the fewest tokens, and its unrelated-edit rate is a third of the full policy's. The " +
      "embedding policy comes second on success but reads almost as much as full, because similarity " +
      "scores rarely fall off sharply enough to stop early.",
  ],
  resultsAfter: [
    "Varying the window shows where the gap comes from. Below 8,000 tokens every policy is starved and the " +
      "differences shrink. Above 32,000 tokens the full policy gets worse, not better: each extra file adds " +
      "more distraction than help, while sparse recall is unaffected because it rarely uses the extra room.",
  ],
  discussion: [
    "The results suggest that a coding agent's context is better treated as a budget to spend than a " +
      "container to fill. The early stop matters more than the ranking itself: when we disabled it, sparse " +
      "recall fell to within two points of the embedding policy.",
    "Two limits deserve mention. Our tasks are small, closed issues; work that spans a whole subsystem may " +
      "need the broad view that a full window gives. And our agent is mid-sized; a much stronger model may " +
      "be better at ignoring noise, which would narrow the gap we report.",
    "A practical reading for tool builders is that the size of the window should not decide how much an " +
      "agent reads. Retrieval that knows when to stop is cheap to add, makes runs easier to review, and " +
      "leaves room in the window for the conversation with the person who asked for the change.",
  ],
  conclusion: [
    "More context is not the same as better context. On 1,240 repository tasks, a sparse recall policy " +
      "that reads less than half as much as a full window finishes 17 more tasks in every hundred and makes " +
      "a third as many unrelated edits. We hope the benchmark helps others test their own retrieval choices.",
  ],
  references: [
    "[1] A. Lindqvist and P. Moreau. Repository-level code completion with retrieval. Sample Proceedings, 2024.",
    "[2] J. Castillo et al. Long contexts and the lost middle in code models. Sample Journal of AI, 2025.",
    "[3] R. Haddad and Y. Chen. Measuring unrelated edits in automated pull requests. Sample Workshop, 2025.",
    "[4] T. Nakamura. Budgeted attention for tool-using agents. Sample Preprint Archive, 2026.",
  ],
};

/**
 * Build the sample paper. Returns { bytes, pageCount, text, pageTexts, outline, title }.
 * `text` is every string placed on the pages, joined with spaces: the self-tests count
 * search matches against it independently of pdf.js.
 */
export function buildSamplePaper() {
  const pages = [];
  const outline = [];
  let page = null;
  let y = 0;

  const newPage = () => {
    page = { ops: [], strings: [] };
    pages.push(page);
    y = PAGE_H - MARGIN;
  };
  const room = (h) => {
    if (y - h < MARGIN + 18) newPage();
  };
  const text = (str, x, baseline, size, font = "F1", { tw = 0, gray = 0 } = {}) => {
    const fill = gray ? `${num(gray)} g ` : "";
    page.ops.push(`q ${fill}BT /${font} ${num(size)} Tf ${num(tw)} Tw 1 0 0 1 ${num(x)} ${num(baseline)} Tm (${esc(str)}) Tj ET Q`);
    page.strings.push(str);
  };
  const wrap = (str, width, size, font) => {
    const words = str.split(/\s+/).filter(Boolean);
    const lines = [];
    let line = [];
    for (const word of words) {
      const next = [...line, word].join(" ");
      if (line.length && widthOf(next, size, font) > width) {
        lines.push(line);
        line = [word];
      } else line.push(word);
    }
    if (line.length) lines.push(line);
    return lines;
  };
  const paragraph = (str, { size = 10.5, leading = 14.2, font = "F1", indent = 14, x = MARGIN, width = BODY_W, after = 6, justify = true } = {}) => {
    // the first line is indented, the rest run the full width
    const first = wrap(str, width - indent, size, font)[0] ?? [];
    const rest = wrap(str.split(/\s+/).filter(Boolean).slice(first.length).join(" "), width, size, font);
    const all = [first, ...rest].filter((l) => l.length);
    all.forEach((words, i) => {
      room(leading);
      y -= leading;
      const lx = x + (i === 0 ? indent : 0);
      const lw = width - (i === 0 ? indent : 0);
      const lineText = words.join(" ");
      let tw = 0;
      const last = i === all.length - 1;
      if (justify && !last && words.length > 1) {
        const extra = (lw - widthOf(lineText, size, font)) / (words.length - 1);
        if (extra > 0 && extra < 4) tw = extra;
      }
      text(lineText, lx, y, size, font, { tw });
    });
    y -= after;
  };
  const heading = (str, { level = 1, gap = 16 } = {}) => {
    const size = level === 1 ? 12.5 : 11;
    room(gap + size + 30);
    y -= gap + size;
    text(str, MARGIN, y, size, "F2");
    outline.push({ title: str, page: pages.length - 1, y: y + size + 4, level });
    y -= 6;
  };
  const centered = (str, size, font, { gray = 0, leading = size * 1.3 } = {}) => {
    const lines = wrap(str, BODY_W, size, font);
    for (const words of lines) {
      const s = words.join(" ");
      y -= leading;
      text(s, (PAGE_W - widthOf(s, size, font)) / 2, y, size, font, { gray });
    }
  };

  // ---- page 1: title block, abstract, introduction
  newPage();
  y -= 18;
  centered(SAMPLE_TITLE, 19, "F2", { leading: 24 });
  y -= 10;
  centered(CONTENT.authors, 11.5, "F1", { leading: 16 });
  centered(CONTENT.affiliation, 9.5, "F3", { gray: 0.38, leading: 13 });
  y -= 14;
  page.ops.push(`q 0.82 G 0.6 w ${MARGIN + 30} ${num(y)} m ${PAGE_W - MARGIN - 30} ${num(y)} l S Q`);
  y -= 4;
  {
    const absX = MARGIN + 30;
    const absW = BODY_W - 60;
    y -= 16;
    text("Abstract", absX, y, 10.5, "F2");
    outline.push({ title: "Abstract", page: 0, y: y + 14, level: 1 });
    y -= 2;
    paragraph(CONTENT.abstract, { size: 9.8, leading: 13.2, x: absX, width: absW, indent: 0, after: 4 });
  }
  page.ops.push(`q 0.82 G 0.6 w ${MARGIN + 30} ${num(y)} m ${PAGE_W - MARGIN - 30} ${num(y)} l S Q`);
  heading("1  Introduction", { gap: 14 });
  CONTENT.intro.forEach((p) => paragraph(p));

  // ---- page 2: method and benchmark
  newPage();
  heading("2  Method", { gap: 0 });
  CONTENT.method.forEach((p) => paragraph(p));
  heading("2.1  Benchmark", { level: 2 });
  CONTENT.benchmark.forEach((p) => paragraph(p));

  // ---- page 3: results with a figure and a table
  newPage();
  heading("3  Results", { gap: 0 });
  CONTENT.results.forEach((p) => paragraph(p));
  {
    // Figure 1: task success by policy, a bar chart drawn with path operators.
    const fh = 170;
    room(fh + 40);
    const top = y - 10;
    const left = MARGIN + 60;
    const chartW = BODY_W - 120;
    const base = top - fh + 24;
    const plotH = fh - 50;
    const bars = [
      { label: "full", value: 41, color: "0.62 0.66 0.72" },
      { label: "lexical", value: 46, color: "0.55 0.68 0.80" },
      { label: "embedding", value: 52, color: "0.33 0.58 0.78" },
      { label: "sparse recall", value: 58, color: "0.05 0.45 0.50" },
    ];
    const ops = page.ops;
    ops.push(`q 0.75 G 0.5 w`);
    for (const tick of [0, 20, 40, 60]) {
      const ty = base + (tick / 60) * plotH;
      ops.push(`${num(left)} ${num(ty)} m ${num(left + chartW)} ${num(ty)} l S`);
    }
    ops.push("Q");
    for (const tick of [0, 20, 40, 60]) {
      const ty = base + (tick / 60) * plotH;
      const s = String(tick);
      text(s, left - 8 - widthOf(s, 8), ty - 3, 8, "F1", { gray: 0.4 });
    }
    const slot = chartW / bars.length;
    bars.forEach((b, i) => {
      const bw = slot * 0.52;
      const bx = left + i * slot + (slot - bw) / 2;
      const bh = (b.value / 60) * plotH;
      ops.push(`q ${b.color} rg ${num(bx)} ${num(base)} ${num(bw)} ${num(bh)} re f Q`);
      const v = `${b.value}%`;
      text(v, bx + (bw - widthOf(v, 8.5, "F2")) / 2, base + bh + 4, 8.5, "F2");
      text(b.label, bx + (bw - widthOf(b.label, 8.5)) / 2, base - 12, 8.5, "F1", { gray: 0.25 });
    });
    y = base - 30;
    const cap = "Figure 1. Task success rate by retrieval policy at a 32,000-token window (mean of three runs).";
    text(cap, (PAGE_W - widthOf(cap, 9, "F3")) / 2, y, 9, "F3", { gray: 0.3 });
    y -= 14;
  }
  {
    // Table 1: booktabs-style rules and four columns.
    const rows = [
      ["Policy", "Success", "Tokens read", "Unrelated edits"],
      ["full", "41.2%", "31,800", "0.62 per task"],
      ["lexical", "46.0%", "24,100", "0.41 per task"],
      ["embedding", "52.3%", "29,500", "0.37 per task"],
      ["sparse recall", "58.1%", "13,900", "0.21 per task"],
    ];
    const cap = "Table 1. Main comparison on 1,240 tasks.";
    room(130);
    y -= 12;
    text(cap, (PAGE_W - widthOf(cap, 9, "F3")) / 2, y, 9, "F3", { gray: 0.3 });
    y -= 10;
    const tx = MARGIN + 50;
    const tw = BODY_W - 100;
    const cols = [0, 0.34, 0.56, 0.78].map((f) => tx + f * tw);
    const rule = (yy, w) => page.ops.push(`q 0 G ${w} w ${num(tx)} ${num(yy)} m ${num(tx + tw)} ${num(yy)} l S Q`);
    rule(y, 0.9);
    rows.forEach((row, r) => {
      y -= 15;
      row.forEach((cell, c) => text(cell, cols[c], y, 9.5, r === 0 ? "F2" : "F1"));
      if (r === 0) {
        y -= 5;
        rule(y, 0.5);
      }
    });
    y -= 6;
    rule(y, 0.9);
    y -= 8;
  }
  CONTENT.resultsAfter.forEach((p) => paragraph(p));

  // ---- page 4: discussion, conclusion, references
  newPage();
  heading("4  Discussion", { gap: 0 });
  CONTENT.discussion.forEach((p) => paragraph(p));
  heading("5  Conclusion");
  CONTENT.conclusion.forEach((p) => paragraph(p));
  heading("References");
  CONTENT.references.forEach((r) => paragraph(r, { size: 9, leading: 12, indent: 0, after: 4, justify: false }));

  // ---- running footer on every page
  pages.forEach((p, i) => {
    page = p;
    const label = `${i + 1}`;
    text(label, (PAGE_W - widthOf(label, 9)) / 2, 40, 9, "F1", { gray: 0.45 });
    if (i > 0) {
      const head = "Sparse Recall - sample paper";
      text(head, MARGIN, PAGE_H - 44, 8, "F3", { gray: 0.5 });
    }
  });

  return {
    bytes: writePdf(pages, outline),
    pageCount: pages.length,
    pageTexts: pages.map((p) => p.strings.join(" ")),
    text: pages.map((p) => p.strings.join(" ")).join(" "),
    outline: outline.map((o) => ({ title: o.title, page: o.page + 1 })),
    title: SAMPLE_TITLE,
  };
}

/** Serialise pages + outline as PDF 1.4 with a correct xref table. */
function writePdf(pages, outline) {
  const objects = [];
  const alloc = () => {
    objects.push(null);
    return objects.length;
  };
  const set = (n, body) => (objects[n - 1] = body);

  const catalog = alloc();
  const pagesObj = alloc();
  const fontObjs = {};
  for (const [key, f] of Object.entries(FONTS)) {
    fontObjs[key] = alloc();
    set(fontObjs[key], `<< /Type /Font /Subtype /Type1 /BaseFont /${f.base} /Encoding /WinAnsiEncoding >>`);
  }
  const fontDict = Object.entries(fontObjs).map(([k, n]) => `/${k} ${n} 0 R`).join(" ");
  const pageObjs = [];
  for (const p of pages) {
    const pageN = alloc();
    const contentN = alloc();
    const stream = p.ops.join("\n");
    set(contentN, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    set(pageN, `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << ${fontDict} >> >> /Contents ${contentN} 0 R >>`);
    pageObjs.push(pageN);
  }
  set(pagesObj, `<< /Type /Pages /Kids [${pageObjs.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageObjs.length} >>`);

  // Outline: level-2 entries become children of the level-1 entry before them.
  const outlinesN = alloc();
  const tops = [];
  for (const entry of outline) {
    const node = { ...entry, n: alloc(), kids: [] };
    if (entry.level === 2 && tops.length) tops[tops.length - 1].kids.push(node);
    else tops.push(node);
  }
  const writeLevel = (nodes, parent) => {
    nodes.forEach((node, i) => {
      const parts = [
        `/Title (${esc(node.title)})`,
        `/Parent ${parent} 0 R`,
        `/Dest [${pageObjs[node.page]} 0 R /XYZ 0 ${num(node.y)} 0]`,
      ];
      if (i > 0) parts.push(`/Prev ${nodes[i - 1].n} 0 R`);
      if (i < nodes.length - 1) parts.push(`/Next ${nodes[i + 1].n} 0 R`);
      if (node.kids.length) {
        parts.push(`/First ${node.kids[0].n} 0 R /Last ${node.kids[node.kids.length - 1].n} 0 R /Count ${node.kids.length}`);
        writeLevel(node.kids, node.n);
      }
      set(node.n, `<< ${parts.join(" ")} >>`);
    });
  };
  writeLevel(tops, outlinesN);
  const totalCount = outline.length;
  set(outlinesN, `<< /Type /Outlines /First ${tops[0].n} 0 R /Last ${tops[tops.length - 1].n} 0 R /Count ${totalCount} >>`);

  set(catalog, `<< /Type /Catalog /Pages ${pagesObj} 0 R /Outlines ${outlinesN} 0 R /PageMode /UseOutlines >>`);
  const info = alloc();
  set(
    info,
    `<< /Title (${esc(SAMPLE_TITLE)}) /Author (${esc(CONTENT.authors)}) /Subject (Retrieval policies for coding agents) ` +
      `/Keywords (coding agents, retrieval, context windows) /Creator (Paper Reader sample) /Producer (Paper Reader) ` +
      `/CreationDate (D:20261103090000Z) >>`,
  );

  let out = "%PDF-1.4\n%RSPR\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  const id = "506170657252656164657253616D706C";
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R /ID [<${id}> <${id}>] >>\nstartxref\n${xrefAt}\n%%EOF\n`;

  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}
