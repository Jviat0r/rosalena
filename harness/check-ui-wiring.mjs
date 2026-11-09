// Cross-check the page's wiring without a browser: every element app.js looks up
// must exist in index.html, and every asset it fetches must be served.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "ui");
const html = readFileSync(join(dir, "index.html"), "utf8");
const js = readFileSync(join(dir, "app.js"), "utf8");

const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const wanted = new Set();
// app.js reaches the page through one helper: const el = (id) => document.getElementById(id)
for (const m of js.matchAll(/\bel\(\s*["'`]([a-zA-Z0-9_-]+)["'`]\s*\)/g)) wanted.add(m[1]);
for (const m of js.matchAll(/getElementById\(\s*["'`]([a-zA-Z0-9_-]+)["'`]\s*\)/g)) wanted.add(m[1]);

const missing = [...wanted].filter((id) => !ids.has(id));
const unused = [...ids].filter((id) => !wanted.has(id));

console.log("ids in html      ", ids.size);
console.log("ids used by app  ", wanted.size);
console.log("missing in html  ", missing.length ? missing.join(", ") : "none");
console.log("declared, unused ", unused.length ? unused.join(", ") : "none");

const routes = new Set([...js.matchAll(/fetch\(\s*[`"']\/api\/([a-z]+)/g)].map((m) => m[1]));
console.log("api routes used  ", [...routes].join(", "));

const token = /document\.querySelector\(\s*'meta\[name="rosalena-token"\]'\s*\)/.test(js);
console.log("reads meta token ", token);
process.exit(missing.length ? 1 : 0);
