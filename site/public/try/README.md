# Try it, the demo that runs on your machine

This page is the conversation surface of Rosalena Harness without a server behind it. There is no hosted model, no
shared key and no free slice counted per address: `POST /api/trial` refuses every request on this deployment
(`TRIAL_PROVIDER` is empty), and the page no longer calls it.

What answers instead:

1. **The desktop app on this computer.** The page probes `http://127.0.0.1:8765/health` for two seconds. When the
   Rosalena Harness app is running it answers, and every message goes to it over loopback. The app builds the model
   request from **your** connection, using your own free-model window, and streams the answer back. The header says
   `Model: your own machine, through the desktop app` and no quota meter is drawn, because there is no hosted quota.
2. **A small model in your own tab.** When no app answers, the page stops and offers the WebGPU demo on the home
   page (`/#try`), which downloads a 0.5-2B model and runs it on your graphics card with no network call at all.
   This page does not download a second copy of the weights; the home page already has that path.

Nothing you type reaches `rosalena.pages.dev`. The page sends no analytics, no telemetry, no cookies and loads no
third-party scripts. Its only outbound request is the loopback probe and, if the app is there, the loopback chat.

## Pairing

The bridge refuses any request without a 32-character token, so a stranger's page cannot drive your app. The app
prints a link when it starts:

```
pair link : https://rosalena.pages.dev/try/#pair=<token>
```

The token lives in the URL **fragment**, which no server receives. On load the page moves it into `sessionStorage`
and immediately rewrites the address bar without it (`history.replaceState`), so a screenshot of the URL is not a
leak. Opening the page without a token shows:

> The app is running on this computer but this tab is not paired with it.

A refused or missing token is never a silent failure. The app also allows only three origins
(`https://rosalena.pages.dev`, `http://localhost:8788`, `http://127.0.0.1:8788`) and answers Chrome's Private
Network Access preflight with `access-control-allow-private-network: true`; without that header a public `https://`
page cannot open a socket to loopback at all.

## Keyboard and history

`Enter` sends, `Shift+Enter` adds a line, `Esc` aborts the stream and keeps the partial answer, and the conversation
survives a reload through one versioned `sessionStorage` key capped at about 64 KB. A message is capped at 1,200
characters and the app receives at most the last 16 turns.

## Testing it locally

Serve the folder from `site/` and open the page with a token:

```
cd site
npx --yes http-server public -p 8788
# then, with the harness running (node src/cli.mjs --ui 8091 in harness\):
http://127.0.0.1:8788/try/#pair=<the token from ~/.rosalena/bridge-token.txt>
```

`http://127.0.0.1:8788` is one of the allowed origins, so this works with no edit. The pure logic runs under plain
Node: `cd site && node --test test/try-ui.test.mjs` (19 tests, including the fragment parser and the refusal copy).

Deliberately missing: sign-up and account management, tool calls, file access, markdown rendering (model text stays
plain so a reply can never inject markup), cross-tab history, and any client-side limiter other than the character
cap - the app enforces its own budget (20 requests a minute) and the page is not the authority on it.
