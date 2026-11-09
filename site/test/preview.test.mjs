// The preview page draws the app window in a browser tab so the design can be looked at
// before the hosted door opens. Two things must stay true or the page turns into a lie:
// it must say, above the fold and again underneath, that the conversation is a sample, and
// it must never name the model vendor or pretend a model answered.
//
// These tests are about the page, not about the app it draws.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const page = readFileSync(new URL('../public/preview/index.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../public/preview/preview.js', import.meta.url), 'utf8');

// ------------------------------------------------------------------ the page is honest

test('the page says preview and sample before showing any conversation', () => {
  const ribbon = /<p class="pv-ribbon">([\s\S]*?)<\/p>/.exec(page)?.[1] ?? '';
  assert.ok(ribbon.length > 0, 'the frame needs a ribbon above the window');
  assert.match(ribbon, /Sample/i);
  assert.match(ribbon, /not (online|live) yet/i, 'the ribbon must say the window is not live');
  // The first screen also has to carry the word, not only the small print at the bottom.
  const head = page.slice(0, page.indexOf('id="pv-app"'));
  assert.match(head, /Preview, not live/i);
});

test('the page names no model vendor', () => {
  for (const name of ['DeepSeek', 'deepseek', 'GLM', 'opencode', 'Anthropic', 'Claude', 'OpenAI', 'GPT']) {
    assert.equal(page.includes(name), false, `the preview page names ${name}`);
    assert.equal(script.includes(name), false, `preview.js names ${name}`);
  }
});

test('every scripted turn is tagged as a sample', () => {
  const bubbles = page.match(/class="pv-msg pv-msg-bot"[\s\S]*?<\/div>\s*<\/div>/g) ?? [];
  assert.ok(bubbles.length >= 2, 'there should be at least two scripted turns');
  for (const bubble of bubbles) {
    assert.match(bubble, /class="pv-tag"/, 'a scripted turn without a sample tag is a fake answer');
    assert.match(bubble, />sample</);
  }
});

test('the legend separates what is real from what is drawn', () => {
  assert.match(page, /What is real on this page, and what is not/);
  assert.match(page, /Written by hand and labelled sample/);
  assert.match(page, /No request leaves your browser when you load this page/);
});

// ------------------------------------------------------------------ it is the real shell

test('the preview shows the shell the user asked for, not a generic chat box', () => {
  for (const part of ['Search', 'New chat', 'Artifacts', 'Routines', 'Customize', 'Pinned', 'Inspector', 'More']) {
    assert.ok(page.includes(part), `the left column is missing ${part}`);
  }
  assert.match(page, /pv-running/, 'subagents and background jobs belong in the top bar');
  assert.match(page, /Show in Explorer/);
  assert.match(page, /role="tablist"/, 'chat, trajectory and artifacts are tabs');
  assert.match(page, />Trajectory</);
});

test('the model menu carries effort as a submenu and no Role row', () => {
  const menu = /id="pv-model-menu"([\s\S]*?)<\/div>\s*<\/div>/.exec(page)?.[0] ?? '';
  assert.match(menu, /Model/);
  assert.match(menu, /Effort/);
  assert.match(menu, /Rosalena Fast/);
  assert.ok(!/Role default|>\s*Role\b/i.test(menu), 'Role default was removed from the model menu');
  assert.ok(!/deepseek/i.test(menu));
});

test('the inspector is a rail, not a hidden panel', () => {
  assert.match(page, /class="pv-insp"/);
  assert.match(page, /pv-insp-label">Inspector/);
  assert.match(page, /pv-insp-btn/);
});

// ------------------------------------------------------------------ the page cannot act

test('the page loads no external resource and no inline script', () => {
  assert.match(page, /<link rel="stylesheet" href="\/styles\.css">/);
  assert.match(page, /<script type="module" src="\/preview\/preview\.js"><\/script>/);
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/.test(page.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '')), false, 'no inline script');
  for (const match of page.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) {
    assert.ok(!/^(https?:)?\/\//i.test(match[1]), `external script: ${match[1]}`);
  }
  assert.ok(!/@import\s/i.test(page));
});

test('the script calls no model and stores nothing', () => {
  for (const forbidden of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'localStorage', 'sessionStorage', 'indexedDB', 'EventSource']) {
    assert.equal(script.includes(forbidden), false, `preview.js must not use ${forbidden}`);
  }
  assert.match(script, /textContent/, 'messages are appended as text, never as markup');
  assert.equal(script.includes('innerHTML'), false, 'a typed message must never become markup');
  assert.equal(/https?:\/\//.test(script), false, 'no absolute URL in the preview script');
});

test('the page offers no download of anything', () => {
  for (const href of [...page.matchAll(/href="([^"]*)"/g)].map((m) => m[1])) {
    assert.ok(!/\.(exe|dmg|zip|msi)(\?|#|$)/i.test(href), `artifact link on the preview page: ${href}`);
  }
});

test('every internal link on the page points at a file that exists', () => {
  for (const href of [...page.matchAll(/href="([^"]*)"/g)].map((m) => m[1])) {
    if (href.startsWith('#') || /^https?:/i.test(href)) continue;
    const path = href.split('#')[0].replace(/\/$/, '/index.html');
    const file = new URL(`../public${path}`, import.meta.url);
    assert.ok(existsSync(file), `dead link on the preview page: ${href}`);
  }
});
