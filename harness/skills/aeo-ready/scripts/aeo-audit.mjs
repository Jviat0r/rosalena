// AEO audit: what AI crawlers and AI agents actually see on a site. Read-only. Fails loudly.
//
// usage: node aeo-audit.mjs <https://site> [more paths, e.g. /work /pricing] [--max-links 60] [--json out.json]
//
// Two views of every page:
//   raw      = the HTML a crawler gets with NO JavaScript (GPTBot, ClaudeBot, Meta-WebIndexer, most AI crawlers)
//   rendered = what a browser / browsing agent sees after JavaScript runs (accessibility tree, labels, links)
// Exit code 1 if any FAIL. WARNs are things to look at, not hard failures.

import { writeFileSync } from 'node:fs'
import { launchBrowser } from './browser.mjs'

const args = process.argv.slice(2)
const flag = (name, dflt) => { const i = args.indexOf(name); if (i < 0) return dflt; const v = args[i + 1]; args.splice(i, 2); return v }
const MAX_LINKS = Number(flag('--max-links', 60))
const JSON_OUT = flag('--json', null)
const base = args.shift()
if (!base || !/^https?:\/\//.test(base)) { console.error('usage: node aeo-audit.mjs <https://site> [paths...]'); process.exit(2) }
const origin = new URL(base).origin
const paths = args.length ? args : ['/']
// Git Bash rewrites "/work" into "C:/Program Files/Git/work"; catch that instead of fetching nonsense.
for (const p of paths) if (!p.startsWith('/')) { console.error(`path must start with "/": got "${p}". In Git Bash, prefix the command with MSYS_NO_PATHCONV=1`); process.exit(2) }

const results = []
const add = (level, page, check, detail = '') => { results.push({ level, page, check, detail }); console.log(`${level.padEnd(4)} ${page.padEnd(18)} ${check}${detail ? '  — ' + detail : ''}`) }
const UA = 'Mozilla/5.0 (compatible; aeo-audit/1.0; +raw-html-check)'
const get = async (url) => { const r = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' }); return { status: r.status, url: r.url, text: await r.text() } }
const stripTags = (h) => h.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim()
const bodyOf = (h) => (h.match(/<body[^>]*>([\s\S]*)<\/body>/i) || [, h])[1]
const hostOf = (u) => { try { return new URL(u, origin).host } catch { return '' } }

// ---------- site-level: robots.txt and sitemap ----------
const AI_BOTS = ['meta-webindexer', 'GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-SearchBot', 'Claude-User', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'Bingbot', 'Googlebot']
let sitemapUrls = []
{
  const r = await get(origin + '/robots.txt')
  if (r.status !== 200) add('FAIL', 'robots.txt', 'robots.txt missing', `HTTP ${r.status}`)
  else {
    // Minimal robots parser: groups of user-agent lines followed by rules.
    const groups = []; let cur = null
    for (const line of r.text.split(/\r?\n/)) {
      const m = line.replace(/#.*/, '').trim().match(/^([A-Za-z-]+)\s*:\s*(.*)$/); if (!m) continue
      const k = m[1].toLowerCase(), v = m[2].trim()
      if (k === 'user-agent') { if (!cur || cur.rules.length) groups.push(cur = { agents: [], rules: [] }); cur.agents.push(v.toLowerCase()) }
      else if ((k === 'allow' || k === 'disallow') && cur) cur.rules.push({ k, v })
      else if (k === 'sitemap') sitemapUrls.push(v)
    }
    const blocked = (bot) => { const g = groups.find((x) => x.agents.includes(bot.toLowerCase())) || groups.find((x) => x.agents.includes('*')); return !!g && g.rules.some((x) => x.k === 'disallow' && x.v === '/') && !g.rules.some((x) => x.k === 'allow' && x.v === '/') }
    const blockedBots = AI_BOTS.filter(blocked)
    if (blockedBots.length) add('FAIL', 'robots.txt', 'AI/search crawlers blocked from the whole site', blockedBots.join(', '))
    else add('PASS', 'robots.txt', 'AI and search crawlers allowed', `checked ${AI_BOTS.length} bots`)
    if (!sitemapUrls.length) add('WARN', 'robots.txt', 'no Sitemap: line')
    for (const s of sitemapUrls) if (hostOf(s) !== new URL(origin).host) add('FAIL', 'robots.txt', 'Sitemap line points at a different domain', s)
  }
}
const smUrl = sitemapUrls.find((s) => hostOf(s) === new URL(origin).host) || origin + '/sitemap.xml'
{
  const r = await get(smUrl).catch((e) => ({ status: 0, text: '', err: e.message }))
  if (r.status !== 200) add('FAIL', 'sitemap', 'sitemap.xml not reachable on this domain', `${smUrl} → HTTP ${r.status}`)
  else {
    const locs = [...r.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1])
    const foreign = locs.filter((l) => hostOf(l) !== new URL(origin).host)
    if (!locs.length) add('FAIL', 'sitemap', 'sitemap has no <loc> entries')
    else if (foreign.length) add('FAIL', 'sitemap', `${foreign.length}/${locs.length} sitemap URLs use another domain`, foreign[0])
    else add('PASS', 'sitemap', `${locs.length} URLs, all on this domain`)
    const lm = [...r.text.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1]).sort()
    if (lm.length) { const days = Math.round((Date.now() - new Date(lm[lm.length - 1])) / 864e5); add(days > 90 ? 'WARN' : 'PASS', 'sitemap', `newest lastmod ${lm[lm.length - 1]} (${days} days ago)`) }
  }
}

// ---------- per page: raw HTML (no JavaScript) ----------
const raw = {}
for (const p of paths) {
  const r = await get(origin + p)
  raw[p] = r
  if (r.status >= 400) { add('FAIL', p, 'page returns an error', `HTTP ${r.status}`); continue }
  const h = r.text
  const title = (h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.trim() || ''
  const desc = (h.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i) || [])[1] || ''
  const canon = (h.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)/i) || [])[1] || ''
  const ogUrl = (h.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)/i) || [])[1] || ''
  const ld = [...h.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1])
  const text = stripTags(bodyOf(h))
  r.rawText = text
  if (!title) add('FAIL', p, 'no <title>'); else add('INFO', p, 'title', title)
  if (!desc) add('WARN', p, 'no meta description'); else add('INFO', p, 'meta description', desc.slice(0, 160))
  for (const [name, u] of [['canonical', canon], ['og:url', ogUrl]]) if (u && hostOf(u) !== new URL(origin).host) add('FAIL', p, `${name} points at another domain`, u)
  if (!canon) add('WARN', p, 'no canonical link')
  if (!ld.length) add('WARN', p, 'no JSON-LD structured data in raw HTML')
  else {
    let types = []
    for (const blk of ld) { try { const j = JSON.parse(blk); const walk = (o) => { if (!o || typeof o !== 'object') return; if (o['@type']) types.push([].concat(o['@type']).join('/')); if (o.url && hostOf(o.url) !== new URL(origin).host) add('FAIL', p, 'JSON-LD url points at another domain', o.url); Object.values(o).forEach(walk) }; walk(j) } catch { add('FAIL', p, 'JSON-LD block is not valid JSON') } }
    add('INFO', p, 'JSON-LD types', [...new Set(types)].join(', '))
  }
  const words = text.split(' ').filter(Boolean).length
  if (words < 50) add('FAIL', p, 'raw HTML has almost no text: AI crawlers that skip JavaScript see an empty page', `${words} words`)
  else add('PASS', p, `raw HTML text: ${words} words`)
}

// ---------- per page: rendered (what a browsing agent sees) ----------
let pw = null
try { pw = await import('playwright-core') } catch { add('FAIL', 'setup', 'playwright-core not installed next to this script; rendered checks skipped', 'run: npm i playwright-core (in the scripts folder)') }
if (pw) {
  const browser = await launchBrowser(pw)
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } })
  const internal = new Set()
  for (const p of paths) {
    const page = await ctx.newPage()
    const res = await page.goto(origin + p, { waitUntil: 'networkidle', timeout: 60000 }).catch((e) => ({ err: e }))
    if (res && res.err) { add('FAIL', p, 'page failed to load in a browser', res.err.message.split('\n')[0]); await page.close(); continue }
    await page.waitForTimeout(1500)
    // Scroll so lazy content loads, then measure.
    await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 700) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)) } window.scrollTo(0, 0) })
    const f = await page.evaluate(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
      const name = (el) => (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.textContent || el.textContent || el.getAttribute('title') || (el.querySelector('img[alt]')?.alt) || (el.querySelector('svg title')?.textContent) || '').trim()
      const imgs = [...document.images].filter(vis)
      const noAlt = imgs.filter((i) => !i.hasAttribute('alt')).map((i) => i.currentSrc || i.src)
      const unnamed = [...document.querySelectorAll('a[href], button, [role=button]')].filter(vis).filter((e) => !name(e)).map((e) => e.outerHTML.slice(0, 90))
      const fields = [...document.querySelectorAll('input, select, textarea')].filter((e) => e.type !== 'hidden' && vis(e))
      const unlabeled = fields.filter((e) => !(e.labels && e.labels.length) && !e.getAttribute('aria-label') && !e.getAttribute('aria-labelledby')).map((e) => `${e.tagName.toLowerCase()}[name=${e.name || e.id || '?'}]`)
      const fakeButtons = [...document.querySelectorAll('div, span')].filter(vis).filter((e) => (e.onclick || getComputedStyle(e).cursor === 'pointer') && !e.closest('a,button,[role],label,summary') && e.children.length < 3 && e.textContent.trim().length < 40 && e.textContent.trim()).map((e) => e.textContent.trim()).slice(0, 8)
      const h1 = [...document.querySelectorAll('h1')].filter(vis).map((h) => h.textContent.trim().replace(/\s+/g, ' '))
      const h2 = [...document.querySelectorAll('h2')].filter(vis).map((h) => h.textContent.trim().replace(/\s+/g, ' '))
      const landmarks = ['header', 'nav', 'main', 'footer'].filter((t) => document.querySelector(t) || document.querySelector(`[role=${t === 'header' ? 'banner' : t === 'footer' ? 'contentinfo' : t === 'nav' ? 'navigation' : 'main'}]`))
      // Judge by alt text and the file name only (a hostname like "site-preview" must not match "review").
      const fileName = (src) => { try { return new URL(src).pathname.split('/').pop() } catch { return '' } }
      const textInImages = imgs.filter((i) => /\b(text|quote|testimonial|pricing|price|reviews?)\b/i.test((i.alt || '') + ' ' + fileName(i.currentSrc || i.src).replace(/[-_.]/g, ' '))).map((i) => i.alt || i.currentSrc).slice(0, 5)
      const links = [...document.querySelectorAll('a[href]')].map((a) => a.href).filter((h) => h.startsWith(location.origin))
      return { noAlt, unnamed, unlabeled, fakeButtons, h1, h2, landmarks, textInImages, links, text: document.body.innerText.replace(/\s+/g, ' ').trim() }
    })
    const rw = (raw[p]?.rawText || '').split(' ').filter(Boolean).length
    const rendered = f.text.split(' ').filter(Boolean).length
    const pct = rendered ? Math.round((rw / rendered) * 100) : 100
    add(pct < 60 ? 'FAIL' : pct < 90 ? 'WARN' : 'PASS', p, `crawlers without JavaScript see ${pct}% of the words people see`, `${rw} raw vs ${rendered} rendered`)
    add(f.noAlt.length ? 'FAIL' : 'PASS', p, `images without alt: ${f.noAlt.length}`, f.noAlt.slice(0, 3).join(' | '))
    add(f.unnamed.length ? 'FAIL' : 'PASS', p, `links/buttons with no accessible name: ${f.unnamed.length}`, f.unnamed.slice(0, 2).join(' | '))
    add(f.unlabeled.length ? 'FAIL' : 'PASS', p, `form fields without a label: ${f.unlabeled.length}`, f.unlabeled.slice(0, 4).join(', '))
    if (f.fakeButtons.length) add('WARN', p, 'clickable divs/spans that should be <button> or <a>', f.fakeButtons.join(' | '))
    add(f.h1.length === 1 ? 'PASS' : 'WARN', p, `h1 count: ${f.h1.length}`, f.h1.join(' | ').slice(0, 120))
    add('INFO', p, 'first h2 (is it the reader\'s question, in plain words?)', f.h2[0] || '(none)')
    const missing = ['header', 'nav', 'main', 'footer'].filter((t) => !f.landmarks.includes(t))
    add(missing.length ? 'WARN' : 'PASS', p, `landmarks present: ${f.landmarks.join(', ') || 'none'}`, missing.length ? 'missing ' + missing.join(', ') : '')
    if (f.textInImages.length) add('WARN', p, 'images that may hold important text (check they are also written out)', f.textInImages.join(' | '))
    f.links.forEach((l) => internal.add(l.split('#')[0]))
    await page.close()
  }
  // Broken internal links (HEAD then GET), capped.
  const list = [...internal].slice(0, MAX_LINKS)
  const broken = []
  await Promise.all(Array.from({ length: 6 }, async () => { while (list.length) { const u = list.shift(); try { let r = await fetch(u, { method: 'HEAD', redirect: 'follow', headers: { 'user-agent': UA } }); if (r.status === 405 || r.status === 403) r = await fetch(u, { redirect: 'follow', headers: { 'user-agent': UA } }); if (r.status >= 400) broken.push(`${r.status} ${u}`) } catch (e) { broken.push(`ERR ${u}`) } } }))
  add(broken.length ? 'FAIL' : 'PASS', 'links', `broken internal links: ${broken.length} of ${Math.min(internal.size, MAX_LINKS)} checked`, broken.slice(0, 5).join(' | '))
  await browser.close()
}

const fails = results.filter((r) => r.level === 'FAIL').length
const warns = results.filter((r) => r.level === 'WARN').length
console.log(`\n${fails} FAIL, ${warns} WARN, ${results.filter((r) => r.level === 'PASS').length} PASS`)
console.log('Not automated (check by hand): plain-English definition instead of a slogan; "as of <date>" on prices and stats; real, permissioned testimonials as text; published/updated dates; fair comparison pages.')
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(results, null, 2))
if (fails) process.exit(1)
