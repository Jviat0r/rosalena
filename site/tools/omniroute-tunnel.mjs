#!/usr/bin/env node
/**
 * Puts the OmniRoute on this PC behind a Cloudflare quick tunnel so the site's
 * `omniroute` trial provider can reach it.
 *
 *   node site/tools/omniroute-tunnel.mjs              # gate + tunnel, prints the URL
 *   node site/tools/omniroute-tunnel.mjs --set-secret # also stores OMNIROUTE_URL on Pages
 *
 * The tunnel never points at OmniRoute directly. It points at a small gate on
 * 127.0.0.1:20140 that forwards only POST /v1/chat/completions and GET /v1/models,
 * so the OmniRoute dashboard (and its password page) is not reachable from the
 * internet. Callers must send OMNIROUTE_API_KEY as a Bearer token; the gate checks
 * it, because OmniRoute lets loopback callers in without one.
 *
 * The gate also answers POST /v1/search {query, limit}: the free window's web search,
 * run from this PC, because DuckDuckGo answers Cloudflare's addresses with a bot check.
 * Search results only (search.mjs, the same code the site runs); no page is fetched.
 *
 * A quick tunnel gets a new trycloudflare.com hostname every start. With
 * --set-secret the new one is written to the Pages secret, which takes effect on
 * the next deploy.
 */

import { spawn } from "node:child_process";
import { createServer, request } from "node:http";

import { webSearch } from "../functions/api/_lib/search.mjs";

const UPSTREAM = { host: "127.0.0.1", port: Number(process.env.OMNIROUTE_PORT ?? 20128) };
const GATE_PORT = Number(process.env.OMNIROUTE_GATE_PORT ?? 20140);
const CLOUDFLARED = process.env.CLOUDFLARED ?? "C:/Program Files (x86)/cloudflared/cloudflared.exe";
const ALLOWED = new Set(["POST /v1/chat/completions", "GET /v1/models", "POST /v1/search"]);
const MAX_BODY = 256 * 1024;
const KEY = process.env.OMNIROUTE_API_KEY;
if (!KEY) {
  console.error("OMNIROUTE_API_KEY is not set; the gate refuses to start without it");
  process.exit(2);
}

const gate = createServer((req, res) => {
  const path = (req.url ?? "").split("?")[0];
  if (!ALLOWED.has(`${req.method} ${path}`)) {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
    return;
  }
  if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) {
    res.writeHead(413, { "content-type": "text/plain" }).end("too large\n");
    return;
  }
  // OmniRoute trusts loopback callers without a key, and every tunnelled request
  // arrives from loopback, so the gate checks the key itself.
  if (!KEY || req.headers.authorization !== `Bearer ${KEY}`) {
    res.writeHead(401, { "content-type": "text/plain" }).end("unauthorized\n");
    return;
  }
  if (path === "/v1/search") {
    search(req, res);
    return;
  }
  // Only what OmniRoute needs; Cloudflare's visitor headers stay out.
  const headers = { host: `${UPSTREAM.host}:${UPSTREAM.port}`, authorization: req.headers.authorization };
  for (const h of ["content-type", "content-length", "accept"]) if (req.headers[h]) headers[h] = req.headers[h];
  const up = request({ ...UPSTREAM, method: req.method, path, headers }, (upRes) => {
    res.writeHead(upRes.statusCode ?? 502, upRes.headers);
    upRes.pipe(res);
  });
  up.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(`omniroute unreachable: ${err.code ?? err.message}\n`);
  });
  // res, not req: a request's "close" fires once its body is read, which would
  // cut OmniRoute off before it answers. res closes when the caller goes away.
  res.on("close", () => { if (!res.writableEnded) up.destroy(); });
  req.pipe(up);
});

gate.listen(GATE_PORT, "127.0.0.1", () => {
  console.log(`gate      http://127.0.0.1:${GATE_PORT} -> OmniRoute :${UPSTREAM.port} (chat + models only)`);
  const tunnel = spawn(CLOUDFLARED, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${GATE_PORT}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let found = false;
  const scan = (chunk) => {
    const m = !found && String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (!m) return;
    found = true;
    const url = `${m[0]}/v1`;
    console.log(`tunnel    ${url}`);
    if (process.argv.includes("--set-secret")) setSecret(url);
  };
  tunnel.stdout.on("data", scan);
  tunnel.stderr.on("data", scan);
  tunnel.on("exit", (code) => {
    console.error(`cloudflared exited (${code})`);
    process.exit(1);
  });
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { tunnel.kill(); process.exit(0); });
});

/** POST /v1/search: one DuckDuckGo search from this PC, as JSON {engine, hits}. */
function search(req, res) {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 4096) req.destroy();
  });
  req.on("end", async () => {
    let query = "";
    let limit = 5;
    try {
      const parsed = JSON.parse(body);
      query = String(parsed?.query ?? "").trim().slice(0, 200);
      limit = Math.min(Math.max(Number(parsed?.limit) || 5, 1), 8);
    } catch {
      /* answered below */
    }
    if (!query) {
      res.writeHead(400, { "content-type": "text/plain" }).end("query required\n");
      return;
    }
    try {
      // env: {} on purpose: no key of this PC's is used for the site's searches.
      const found = await webSearch(query, { env: {}, limit });
      console.log(`search    ${found.hits.length} results`);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(found));
    } catch (err) {
      console.error(`search    failed: ${err?.message ?? err}`);
      res.writeHead(502, { "content-type": "text/plain" }).end("search failed\n");
    }
  });
}

function setSecret(url) {
  const put = spawn("npx", ["wrangler", "pages", "secret", "put", "OMNIROUTE_URL", "--project-name", "rosalena"], {
    cwd: new URL("..", import.meta.url),
    shell: process.platform === "win32",
    stdio: ["pipe", "inherit", "inherit"],
  });
  put.stdin.end(`${url}\n`);
  put.on("exit", (code) =>
    console.log(code === 0 ? "secret    OMNIROUTE_URL updated; redeploy the site for it to take effect" : `secret    wrangler exited ${code}`),
  );
}
