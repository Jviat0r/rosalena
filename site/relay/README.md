# Phone-access relay (`rosalena-relay` Worker)

One stable address per Rosalena install, `https://<id>.rosalena.dev`, forwarded to whatever
quick-tunnel URL that install registered last. Without it, the phone link changes every time
the app starts (a quick tunnel gets a new random `*.trycloudflare.com` name each time) and the
phone has to scan again. Code: `worker.mjs`. Tests: `site/test/relay.test.mjs`.

The app works without the relay: it falls back to the raw tunnel link and the panel says so.

## How it works

1. The app mints, once per install, a 24-character id and a 256-bit secret
   (`<ROSALENA_HOME>/remote/state.json`).
2. Each time its tunnel comes up, it calls `POST https://relay.rosalena.dev/api/register`
   with `{ id, secret, target }`. The first call claims the id (only a SHA-256 of the secret
   is stored); later calls must carry the same secret. `target` must be
   `https://<name>.trycloudflare.com/`, nothing else, so the relay cannot be pointed at an
   arbitrary site.
3. `https://<id>.rosalena.dev/*` is forwarded to that target, streaming (SSE and WebSockets
   pass through). Only the app's own cookie is forwarded; a `Domain=` on any Set-Cookie
   coming back is removed.
4. When the app turns phone access off, it calls `/api/unregister`, which empties the row
   (the claim stays, so nobody else can take the id). A phone opening the link then gets an
   "offline" page that retries every 10 s.

## Why `<id>.rosalena.dev` and not `<id>.m.rosalena.dev`

Cloudflare's free Universal SSL certificate covers `rosalena.dev` and one level of
subdomain (`*.rosalena.dev`). A second level (`*.m.rosalena.dev`) gets no certificate unless
you buy Advanced Certificate Manager. If you ever do, set `RELAY_SUFFIX = ".m.rosalena.dev"`,
change the route to `*.m.rosalena.dev/*`, and add the matching DNS record; nothing else changes.

Trade-off to know about: every relayed app is a sibling subdomain of the site. The Worker
strips other cookies and `Domain=` attributes, and the app refuses API calls that are not
same-origin, but a page on one relayed subdomain can still set cookies for `rosalena.dev` from
its own JavaScript. The site sets no cookie that matters across subdomains today. A separate
domain just for phone links (for example `rosalena-link.dev`) would remove this entirely.

## Deploy (only when Jayden says so)

All commands from `site/relay/`. Nothing here touches the Pages project `rosalena`.

1. Create the database and put its id in `wrangler.toml` (`database_id` under the top-level
   `[[d1_databases]]`, replacing the zeros):

   ```
   npx wrangler d1 create rosalena-relay
   npx wrangler d1 execute rosalena-relay --remote --file schema.sql
   ```

2. DNS (Cloudflare dashboard > rosalena.dev > DNS > Records > Add record). One record:

   | Type | Name | Content   | Proxy status |
   |------|------|-----------|--------------|
   | AAAA | `*`  | `100::`   | Proxied (orange cloud) |

   `100::` is the discard address; the Worker answers before anything reaches it. The
   explicit records for `rosalena.dev` and `www` (the Pages custom domains) keep winning over
   the wildcard, so the site is unaffected. `relay.rosalena.dev` is covered by the wildcard.

3. Deploy the Worker. Its route, `*.rosalena.dev/*`, is in `wrangler.toml`:

   ```
   npx wrangler deploy
   ```

4. Keep the site's own hostnames out of the Worker. Dashboard > rosalena.dev > Workers Routes >
   Add route, Worker set to **None**, for each:

   - `www.rosalena.dev/*`
   - any other subdomain you serve from Pages or elsewhere

   (The apex `rosalena.dev` does not match `*.rosalena.dev`.) The Worker also passes any host
   that is not `relay.` or a 24-character id through to its origin, so a missed exclusion
   still serves the site, just through one extra hop.

5. Check it:

   ```
   curl https://relay.rosalena.dev/api/health          # {"ok":true}
   curl -I https://abcdefghijklmnopqrstuvwx.rosalena.dev/   # 503, the offline page
   ```

   Then in the app: phone button > switch on. The panel should say "Stable link" within a
   few seconds and the QR should show `https://<id>.rosalena.dev/`.

No secrets are needed: the Worker stores only hashes. Worker logs are off on purpose
(`[observability] enabled = false`): a request URL can carry a pasted pairing code (`?t=`).

## Run it locally

```
npx wrangler d1 execute rosalena-relay --env dev --local --file schema.sql
npx wrangler dev --env dev --local --port 8787 --ip 127.0.0.1
```

`--env dev` has no routes (wrangler dev would rewrite every request's host to the route's
zone) and uses `*.localhost` names. Point a scratch app at it with
`ROSALENA_RELAY=http://localhost:8787`; the phone link is then
`http://<id>.localhost:8787/` (browsers send `*.localhost` to 127.0.0.1). Tested this way
on 2026-11-09 against a real quick tunnel.
