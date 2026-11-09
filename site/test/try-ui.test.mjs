// Tests for the pure logic behind the public "try it" page.
//
// The page code itself needs a browser, so everything worth checking is factored into
// exports at the top of public/try/app.js. These tests import that file directly and
// never touch the DOM.
//
// Run with:  cd site && node --test test/try-ui.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { OPENCODE_MODEL } from '../functions/api/_lib/trial.mjs';

import {
  BRIDGE_ORIGIN,
  CHAR_CAP,
  bridgeChatUrl,
  bridgeMessages,
  byteLength,
  trimHistory,
  createSseDecoder,
  describeQuota,
  formatResetTime,
  countChars,
  composerState,
  clampToCap,
  pairTokenFromHash,
  providerLabel,
} from '../public/try/app.js';

const turn = (role, content) => ({ role, content });

// ------------------------------------------------------------- history trim

test('trimHistory drops the oldest turns first and keeps the newest', () => {
  const turns = Array.from({ length: 40 }, (_, index) =>
    turn(index % 2 === 0 ? 'user' : 'assistant', `turn ${index} ${'x'.repeat(40)}`),
  );

  const kept = trimHistory(turns, 1200);

  assert.ok(kept.length > 0, 'something survives');
  assert.ok(kept.length < turns.length, 'the oldest turns are gone');
  assert.equal(kept.at(-1).content, turns.at(-1).content, 'the newest turn is intact');
  assert.equal(kept[0].content, turns.at(turns.length - kept.length).content, 'what is left is the tail');
  assert.ok(byteLength(JSON.stringify(kept)) <= 1200, 'the serialised result fits the budget');
});

test('trimHistory keeps a single oversized turn by truncating its text', () => {
  const kept = trimHistory([turn('user', 'y'.repeat(4000))], 400);

  assert.equal(kept.length, 1);
  assert.equal(kept[0].role, 'user');
  assert.equal(kept[0].truncated, true);
  assert.ok(kept[0].content.length > 0);
  assert.ok(kept[0].content.length < 4000);
  assert.ok(byteLength(JSON.stringify(kept)) <= 400);
});

// ------------------------------------------------------------- SSE decoding

test('createSseDecoder reads a whole stream of delta, end and done frames', () => {
  const decoder = createSseDecoder();
  const frames = decoder.push(
    'data: {"delta":"Hello"}\n\n' +
      'data: {"done":true,"usage":{"input":12,"output":3},"quota":{"used":3,"limit":5,"resetAt":"2026-10-21T04:00:00.000Z"}}\n\n' +
      'data: [DONE]\n\n',
  );

  assert.deepEqual(frames.map((frame) => frame.type), ['delta', 'end', 'done']);
  assert.equal(frames[0].text, 'Hello');
  assert.equal(frames[1].usage.output, 3);
  assert.equal(frames[1].quota.used, 3);
  assert.equal(decoder.finished, true);
});

test('createSseDecoder holds a frame split across chunk boundaries', () => {
  const decoder = createSseDecoder();

  assert.deepEqual(decoder.push('data: {"del'), []);
  assert.deepEqual(decoder.push('ta":"split'), []);
  const frames = decoder.push(' frame"}\n');

  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, 'delta');
  assert.equal(frames[0].text, 'split frame');
});

test('createSseDecoder skips a malformed frame and keeps reading', () => {
  const decoder = createSseDecoder();
  const frames = decoder.push('data: {not json at all}\ndata: {"delta":"still here"}\n\n');

  assert.deepEqual(frames, [{ type: 'delta', text: 'still here' }]);
});

test('createSseDecoder keeps newlines and escaped quotes inside one delta', () => {
  const decoder = createSseDecoder();
  const frames = decoder.push('data: {"delta":"She said \\"hi\\" \\nand left."}\n');

  assert.equal(frames.length, 1);
  assert.equal(frames[0].text, 'She said "hi" \nand left.');
});

test('createSseDecoder flushes a final frame with no trailing newline', () => {
  const decoder = createSseDecoder();

  assert.deepEqual(decoder.push('data: {"delta":"last"}'), []);
  const frames = decoder.end();

  assert.equal(frames.length, 1);
  assert.equal(frames[0].text, 'last');
});

// ------------------------------------------------------------------- quota

test('describeQuota renders the free slice as "3 of 5"', () => {
  const view = describeQuota({ used: 2, limit: 5, resetAt: '2026-10-21T04:00:00.000Z' });

  assert.equal(view.known, true);
  assert.equal(view.remaining, 3);
  assert.equal(view.spent, false);
  assert.equal(view.percent, 40);
  assert.equal(view.label, '3 of 5 free messages left today');
  assert.equal(view.resetAt, '2026-10-21T04:00:00.000Z');
});

test('describeQuota marks a spent slice without losing the numbers', () => {
  const view = describeQuota({ used: 5, limit: 5 });

  assert.equal(view.known, true);
  assert.equal(view.spent, true);
  assert.equal(view.remaining, 0);
  assert.equal(view.label, '0 of 5 free messages left today');
});

test('describeQuota uses the account numbers when the slice is an account', () => {
  const view = describeQuota({ email: 'a@b.c', used: 12, limit: 40 }, { kind: 'account' });

  assert.equal(view.known, true);
  assert.equal(view.kind, 'account');
  assert.equal(view.remaining, 28);
  assert.equal(view.label, '28 of 40 account messages left today');
});

test('describeQuota falls back to a sentence when a field is missing', () => {
  const view = describeQuota({ used: 2 });

  assert.equal(view.known, false);
  assert.equal(view.percent, null);
  assert.equal(view.label, 'Free messages left today: unknown');
  assert.ok(!/undefined|NaN|null/.test(view.label), 'no placeholder ever reaches the page');
});

// -------------------------------------------------------------- reset time

test('formatResetTime prints a local clock time against an injected clock', () => {
  const now = new Date('2026-10-21T09:00:00.000Z');
  const options = { timeZone: 'UTC', locale: 'en-US' };

  assert.equal(formatResetTime('2026-10-21T04:00:00.000Z', now, options), '4:00 AM today');
  assert.equal(formatResetTime('2026-10-22T04:00:00.000Z', now, options), '4:00 AM tomorrow');
  assert.equal(
    formatResetTime('2026-10-25T04:00:00.000Z', new Date('2026-10-21T09:00:00.000Z'), options),
    '4:00 AM on Oct 25',
  );
  assert.equal(formatResetTime('not a date', now, options), null);
  assert.equal(formatResetTime(undefined, now, options), null);
});

// ------------------------------------------------------------ character cap

test('countChars counts code points, so an emoji costs one', () => {
  assert.equal(countChars(''), 0);
  assert.equal(countChars('abc'), 3);
  assert.equal(countChars('a😀b'), 3);
  assert.equal(countChars(null), 0);
});

test('composerState refuses over-cap input but still counts it', () => {
  const exact = composerState('x'.repeat(CHAR_CAP));
  assert.equal(exact.count, CHAR_CAP);
  assert.equal(exact.over, false);
  assert.equal(exact.remaining, 0);
  assert.equal(exact.canSend, true);

  const over = composerState('x'.repeat(CHAR_CAP + 42));
  assert.equal(over.over, true);
  assert.equal(over.canSend, false);

  assert.equal(composerState('   ').canSend, false, 'whitespace is not a message');
});

test('clampToCap trims an oversized paste to exactly the cap', () => {
  const pasted = clampToCap('z'.repeat(1500), CHAR_CAP);

  assert.equal(pasted.truncated, true);
  assert.equal(countChars(pasted.text), CHAR_CAP);

  const short = clampToCap('hello', CHAR_CAP);

  assert.equal(short.truncated, false);
  assert.equal(short.text, 'hello');
});

// ------------------------------------------------ the demo runs on your machine

test('the pairing token is read from the fragment, and nowhere else', () => {
  const token = 'a-P34redtNTbhJMr3JPJq9Xw-WZnBknU';
  assert.equal(pairTokenFromHash(`#pair=${token}`), token);
  assert.equal(pairTokenFromHash(`#pair=${token}&theme=light`), token);
  assert.equal(pairTokenFromHash(`#theme=light&pair=${token}`), token);
  // A query string is sent to the server and lands in logs, so it is not a place for a
  // secret; the page must not read one from there.
  assert.equal(pairTokenFromHash(''), null);
  assert.equal(pairTokenFromHash('#'), null);
  assert.equal(pairTokenFromHash('#pair='), null);
  assert.equal(pairTokenFromHash('#pair=short'), null, 'a stub is not a token');
  assert.equal(pairTokenFromHash('#pair=has%20space%20inside'), null);
});

test('the bridge is addressed on loopback and asked for the page frame shape', () => {
  assert.equal(bridgeChatUrl(), 'http://127.0.0.1:8765/v1/chat?format=trial');
  assert.match(BRIDGE_ORIGIN, /^http:\/\/127\.0\.0\.1:/);
});

test('bridgeMessages appends the message, drops junk, and keeps the recent window', () => {
  const history = [
    turn('user', 'first'),
    turn('assistant', 'answer'),
    { role: 'system', content: 'ignore this' },
    turn('user', '   '),
  ];
  assert.deepEqual(bridgeMessages(history, 'now'), [
    turn('user', 'first'),
    turn('assistant', 'answer'),
    turn('user', 'now'),
  ]);
  const many = Array.from({ length: 30 }, (_, i) => turn(i % 2 === 0 ? 'user' : 'assistant', `m${i}`));
  const kept = bridgeMessages(many, 'last');
  assert.equal(kept.length, 16);
  assert.deepEqual(kept[kept.length - 1], turn('user', 'last'));
});

test('providerLabel never names a server that is not there', () => {
  assert.match(providerLabel('local-app'), /desktop app/);
  assert.match(providerLabel('gpu'), /graphics card/);
  assert.match(providerLabel('none'), /nothing/);
  assert.equal(/cloudflare|hosted|served/i.test(providerLabel('none')), false);
});

// ------------------------------------------------------- the hosted path, on
//
// The page has two doors: the visitor's app, and a free keyless window on the site.
// These tests pin the second one, because an X post that says "try DeepSeek V4.1 Flash
// free" is only true while the config, the label and the page copy all agree.

const wrangler = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const tryHtml = readFileSync(new URL('../public/try/index.html', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../public/try/app.js', import.meta.url), 'utf8');

test('the hosted provider is on: the free tier first, then OmniRoute, Workers AI last', () => {
  const line = wrangler.match(/^\s*TRIAL_PROVIDER\s*=\s*(.*)$/m);
  assert.ok(line, 'wrangler.toml must state TRIAL_PROVIDER explicitly');
  assert.match(line[1], /"opencode-free,omniroute,workers-ai"/);
});

test('the model the ad names is the model the endpoint pins', () => {
  assert.equal(OPENCODE_MODEL, 'deepseek-v4.1-flash-free');
});

test('the hosted label names the free tier and claims no key', () => {
  const label = providerLabel('hosted');
  assert.match(label, /free/i);
  assert.match(label, /key/i);
  // It must not pretend the model runs on the visitor's machine, nor hide which one runs.
  assert.equal(/your own machine/i.test(label), false);
});

test('the page names the product, never the model behind its free window', () => {
  // The free window is a product feature here, not a vendor advertisement: the page says
  // what it does for the visitor and keeps the backing model out of the markup, so a
  // build cannot end up advertising a third party's model as the product.
  assert.match(tryHtml, /<title>[^<]*Rosalena Harness/i);
  assert.equal(/deepseek|glm|qwen|gpt|claude/i.test(tryHtml), false, 'no backing model name in the page');
  assert.match(tryHtml, /free messages/i, 'the page says the free window is finite');
});

test('the page sends hosted messages to /api/trial and pairs a bridge message separately', () => {
  assert.match(appSource, /fetch\('\/api\/trial'/);
  assert.match(appSource, /x-rosalena-pair/);
  // A hosted turn is a POST with the message and the trimmed history, nothing else.
  assert.match(appSource, /history: history\.slice\(-12\)/);
});
