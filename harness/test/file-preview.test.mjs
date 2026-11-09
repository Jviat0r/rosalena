/**
 * The sidebar's file viewer (2026-11-08): file kinds, Office previews read with the built-in
 * zip reader, and /api/file's rules (the page token, workspace-only paths, HTML sandboxed).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { deflateRawSync } from "node:zlib";

import { fileKind, officePart, officePreview, readZip } from "../src/file-preview.mjs";
import { createUiServer } from "../src/ui.mjs";

/** A minimal zip: the first entry stored, the rest deflated, so both methods are read. */
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  Object.entries(files).forEach(([name, content], index) => {
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const method = index === 0 ? 0 : 8;
    const data = method === 0 ? raw : deflateRawSync(raw);
    const nameBuf = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  });
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const dir = mkdtempSync(join(tmpdir(), "file-preview-"));
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

test("kinds come from the name, and an unknown name with no NUL bytes is text", () => {
  assert.equal(fileKind("a/b.png"), "image");
  assert.equal(fileKind("deck.PPTX"), "office");
  assert.equal(fileKind("notes.md"), "markdown");
  assert.equal(fileKind("index.html"), "html");
  assert.equal(fileKind("Makefile", Buffer.from("all:\n\techo hi\n")), "text");
  assert.equal(fileKind("blob.bin", Buffer.from([1, 0, 2])), "binary");
});

test("a .pptx shows each slide's text and its pictures, in slide order", () => {
  const file = join(dir, "deck.pptx");
  writeFileSync(
    file,
    zip({
      "[Content_Types].xml": "<Types/>",
      "ppt/slides/slide2.xml": "<p:sld><a:p><a:r><a:t>Second slide</a:t></a:r></a:p></p:sld>",
      "ppt/slides/slide1.xml": "<p:sld><a:p><a:r><a:t>Hello </a:t></a:r><a:r><a:t>&amp; welcome</a:t></a:r></a:p><a:p><a:r><a:t>Point two</a:t></a:r></a:p></p:sld>",
      "ppt/slides/_rels/slide1.xml.rels": '<Relationships><Relationship Target="../media/image1.png"/></Relationships>',
      "ppt/media/image1.png": PNG,
    }),
  );
  assert.ok(readZip(readFileSync(file)).has("ppt/media/image1.png"));
  const preview = officePreview(file);
  assert.equal(preview.kind, "slides");
  assert.deepEqual(preview.slides.map((s) => s.n), [1, 2]);
  assert.deepEqual(preview.slides[0].lines, ["Hello & welcome", "Point two"]);
  assert.deepEqual(preview.slides[0].images, ["ppt/media/image1.png"]);
  assert.deepEqual(officePart(file, "ppt/media/image1.png"), PNG);
  assert.throws(() => officePart(file, "../../etc/passwd"), /no such picture/);
});

test("a .docx shows its paragraphs and a .xlsx its cells, shared strings resolved", () => {
  const docx = join(dir, "letter.docx");
  writeFileSync(docx, zip({ "[Content_Types].xml": "<Types/>", "word/document.xml": "<w:body><w:p><w:r><w:t>Dear reader,</w:t></w:r></w:p><w:p><w:r><w:t xml:space=\"preserve\">Thanks </w:t></w:r><w:r><w:t>again.</w:t></w:r></w:p></w:body>" }));
  assert.deepEqual(officePreview(docx).paragraphs, ["Dear reader,", "Thanks again."]);
  const xlsx = join(dir, "sheet.xlsx");
  writeFileSync(
    xlsx,
    zip({
      "[Content_Types].xml": "<Types/>",
      "xl/workbook.xml": '<workbook><sheets><sheet name="Budget" sheetId="1"/></sheets></workbook>',
      "xl/sharedStrings.xml": "<sst><si><t>Item</t></si><si><t>Cost</t></si><si><t>Rent</t></si></sst>",
      "xl/worksheets/sheet1.xml": '<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1200</v></c></row></sheetData>',
    }),
  );
  const sheets = officePreview(xlsx).sheets;
  assert.equal(sheets[0].name, "Budget");
  assert.deepEqual(sheets[0].rows, [["Item", "Cost"], ["Rent", "1200"]]);
});

test("/api/file needs the token, stays inside the workspace, and serves HTML sandboxed", async () => {
  const TOKEN = "file-token-0123456789abcdef";
  const ws = mkdtempSync(join(tmpdir(), "file-route-"));
  mkdirSync(join(ws, "docs"));
  writeFileSync(join(ws, "docs", "page.html"), "<h1>hi</h1><script>1</script>");
  writeFileSync(join(ws, "notes.txt"), "line one\nline two\n");
  const ui = createUiServer({ port: 0, home: join(ws, ".home"), workspace: ws, token: TOKEN });
  const { port } = await ui.ready();
  after(() => ui.close());
  const base = `http://127.0.0.1:${port}`;
  const headers = { "x-rosalena-token": TOKEN };
  assert.equal((await fetch(`${base}/api/file?path=notes.txt`)).status, 403, "no token, no file");
  // The token in the address is refused: a sandboxed page could read it from there.
  assert.equal((await fetch(`${base}/api/file?path=notes.txt&t=${TOKEN}`)).status, 403, "token in the URL is not accepted");
  const text = await fetch(`${base}/api/file?path=notes.txt`, { headers });
  assert.equal(text.status, 200);
  assert.equal(await text.text(), "line one\nline two\n");
  const info = await (await fetch(`${base}/api/file/info?path=docs/page.html`, { headers })).json();
  assert.equal(info.kind, "html");
  // A ticket opens that one file without the header (what <img>/<iframe> need), and only it.
  const { ticket } = await (await fetch(`${base}/api/file/ticket?abs=${encodeURIComponent(info.abs)}`, { headers })).json();
  assert.ok(ticket && ticket.length >= 20);
  const html = await fetch(`${base}/api/file?k=${ticket}`);
  assert.equal(html.status, 200);
  assert.match(html.headers.get("content-security-policy") ?? "", /sandbox/);
  assert.equal(await html.text(), "<h1>hi</h1><script>1</script>");
  const wrongFile = await fetch(`${base}/api/file?k=${ticket}&path=notes.txt&abs=${encodeURIComponent(join(ws, "notes.txt"))}`);
  assert.equal(await wrongFile.text(), "<h1>hi</h1><script>1</script>", "a ticket ignores any other path asked for");
  assert.equal((await fetch(`${base}/api/file?k=not-a-ticket`)).status, 403);
  const outside = join(tmpdir(), "file-route-outside.txt");
  writeFileSync(outside, "secret");
  assert.equal((await fetch(`${base}/api/file?abs=${encodeURIComponent(outside)}`, { headers })).status, 403);
  assert.equal((await fetch(`${base}/api/file/ticket?abs=${encodeURIComponent(outside)}`, { headers })).status, 403, "no ticket for a file outside");
  assert.equal((await fetch(`${base}/api/file?path=..%2F..%2Fx`, { headers })).status, 403);
});

