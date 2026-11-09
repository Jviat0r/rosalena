// Pre-render a built single-page app (Vite + React etc.) so every route ships real HTML.
// AI crawlers that skip JavaScript then see the same words people do. Fails loudly.
//
// usage: node prerender.mjs <distDir> [--routes / /work /contact] [--sitemap <distDir>/sitemap.xml] [--skip /admin] [--dirs]
//   - Serves <distDir> on a local port with SPA fallback, opens each route in Chromium,
//     waits for it to settle, and writes the rendered HTML to <distDir>/<route>.html
//     (or <distDir>/<route>/index.html with --dirs).
//   - Run it AFTER `npm run build`, as part of the build (e.g. "build": "vite build && node prerender.mjs dist").
//   - The app keeps working as an SPA: React's createRoot replaces the pre-rendered markup on load.
//   - Pages that need a login, show per-visitor data, or are noindex (admin) must be skipped.

import { createServer } from 'node:http'
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join, extname, resolve } from 'node:path'
import { launchBrowser } from './browser.mjs'

const args = process.argv.slice(2)
const dist = resolve(args.shift() || '')
if (!existsSync(join(dist, 'index.html'))) { console.error(`no index.html in ${dist}; run the build first`); process.exit(2) }
const list = (name) => { const i = args.indexOf(name); if (i < 0) return []; const out = []; for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) out.push(args[j]); return out }
const DIRS = args.includes('--dirs')
let routes = list('--routes')
const skip = list('--skip').concat(['/admin'])
const sm = list('--sitemap')[0] || join(dist, 'sitemap.xml')
if (!routes.length && existsSync(sm)) routes = [...readFileSync(sm, 'utf8').matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => new URL(m[1]).pathname)
if (!routes.length) routes = ['/']
routes = [...new Set(routes)].filter((r) => !skip.some((s) => r === s || r.startsWith(s + '/')))
for (const r of routes) if (!r.startsWith('/')) { console.error(`route must start with "/": ${r} (Git Bash: prefix with MSYS_NO_PATHCONV=1)`); process.exit(2) }

const shell = readFileSync(join(dist, 'index.html'), 'utf8') // the untouched SPA shell, served for every route
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.xml': 'application/xml', '.txt': 'text/plain' }
const server = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  const f = join(dist, p)
  if (f.startsWith(dist) && existsSync(f) && statSync(f).isFile()) { res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' }); return res.end(readFileSync(f)) }
  if (p.startsWith('/api/')) { res.writeHead(404); return res.end() } // no backend during pre-render
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(shell)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

let pw
try { pw = await import('playwright-core') } catch { console.error('playwright-core missing: run npm i playwright-core next to this script'); process.exit(2) }
const browser = await launchBrowser(pw)
const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, reducedMotion: 'reduce' })
let failed = 0
for (const r of routes) {
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  try {
    await page.goto(`http://127.0.0.1:${port}${r}`, { waitUntil: 'networkidle', timeout: 45000 })
    await page.waitForTimeout(800)
    let html = await page.evaluate(() => {
      // Drop things that should never be frozen into static HTML.
      document.querySelectorAll('[data-no-prerender], .preloader').forEach((e) => e.remove())
      return '<!doctype html>\n' + document.documentElement.outerHTML
    })
    // Runtime state the app puts on <html>/<body> (theme, reduced-motion flags, scroll locks) must not
    // be frozen for every visitor: put back the original tags from the untouched shell.
    for (const tag of ['html', 'body']) {
      const orig = shell.match(new RegExp(`<${tag}(\\s[^>]*)?>`, 'i'))
      if (!orig) throw new Error(`shell has no <${tag}> tag`)
      html = html.replace(new RegExp(`<${tag}(\\s[^>]*)?>`, 'i'), orig[0])
    }
    const words = (await page.evaluate(() => document.body.innerText)).split(/\s+/).filter(Boolean).length
    if (errors.length) throw new Error('page errors: ' + errors.join(' | '))
    if (words < 30) throw new Error(`only ${words} words rendered; is the route real?`)
    // Default "/work" -> work.html (Cloudflare Pages, Vercel cleanUrls and Netlify serve it at /work with no
    // trailing-slash redirect). --dirs writes work/index.html instead, for hosts that need folders.
    const rel = r.replace(/^\/|\/$/g, '')
    const out = r === '/' ? join(dist, 'index.html') : DIRS ? join(dist, rel, 'index.html') : join(dist, rel + '.html')
    mkdirSync(join(out, '..'), { recursive: true })
    writeFileSync(out, html)
    console.log(`OK   ${r}  ${words} words → ${out.replace(dist, 'dist')}`)
  } catch (e) {
    failed++
    console.log(`FAIL ${r}  ${e.message.split('\n')[0]}`)
  }
  await page.close()
}
await browser.close()
server.close()
// Hosts fall back to index.html for unknown paths, and index.html is now the pre-rendered home page.
// Keep the untouched shell so app-only routes (/admin) can be pointed at it, e.g. Cloudflare Pages
// `_redirects`: "/admin /spa-shell 200" and "/admin/* /spa-shell 200".
writeFileSync(join(dist, 'spa-shell.html'), shell)
console.log('kept the untouched app shell as spa-shell.html (point /admin and other app-only routes at it)')
if (failed) { console.error(`${failed} route(s) failed to pre-render`); process.exit(1) }
