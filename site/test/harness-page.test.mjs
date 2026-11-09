// The harness page draws the desktop window on the web and puts a working prompt box in it.
// The risk is not that it breaks: it is that it reads as the app. So the tests below are
// about the difference. The page may show the window, the dock, the tabs and the composer,
// and it may answer through this site's free window, but it has to say so where a reader
// will see it, and it must never claim the boxes below can read a file or run a tool.
//
// They also check the wiring, because a page whose handlers point at ids that are not in
// the markup looks perfect and does nothing: every id the script reaches for is checked
// against the HTML here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../public/harness/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/harness/harness.css', import.meta.url), 'utf8');
const script = readFileSync(new URL('../public/harness/harness.js', import.meta.url), 'utf8');

const home = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const preview = readFileSync(new URL('../public/preview/index.html', import.meta.url), 'utf8');
const tryPage = readFileSync(new URL('../public/try/index.html', import.meta.url), 'utf8');
const sitemap = readFileSync(new URL('../public/sitemap.xml', import.meta.url), 'utf8');

// ------------------------------------------------------------------ it is reachable

test('the page is linked from every page that promises a window', () => {
  for (const [name, html] of [['home', home], ['preview', preview], ['try', tryPage]]) {
    assert.match(html, /href="\/harness\/"/, `the ${name} page does not link the window page`);
  }
  assert.match(sitemap, /<loc>https:\/\/rosalena\.dev\/harness\/<\/loc>/, 'the sitemap does not list /harness/');
  assert.match(sitemap, /<loc>https:\/\/rosalena\.dev\/try\/<\/loc>/, 'the sitemap does not list /try/');
});

test('the home page puts the window where a visitor looks', () => {
  // A link that lives only in the footer is a link that is never clicked. The window has to
  // be reachable from the first screen, and it is the first button: a visitor with no
  // install and no key is the visitor this product is for first. The local demo sits next
  // to it, one button away, for the visitor who came for the graphics card.
  const heroCtas = /<div class="hero-ctas">([\s\S]*?)<\/div>/.exec(home)?.[1] ?? '';
  assert.match(heroCtas, /class="btn btn-primary" href="\/harness\/">Try Harness</, 'the hero has no primary button to the window');
  assert.match(heroCtas, /class="btn btn-secondary" href="#try">Try Local</, 'the hero has no button to the in-browser model');
  const nav = /<nav aria-label="Main">([\s\S]*?)<\/nav>/.exec(home)?.[1] ?? '';
  assert.match(nav, /href="\/harness\/">Try Harness</, 'the nav does not name the free cloud window');
  assert.match(nav, /href="#try">Try Local</, 'the nav does not offer the local demo');
});

test('the page names itself and nothing it is not', () => {
  assert.match(page, /<title>[^<]*Rosalena Harness/i);
  assert.match(page, /<link rel="canonical" href="https:\/\/rosalena\.dev\/harness\/">/);
  assert.match(page, /"@type": "WebPage"/);
});

// ------------------------------------------------------------------ it is honest

test('the page says which part is real and where the answer comes from', () => {
  const lede = /<p class="hz-lede">([\s\S]*?)<\/p>/.exec(page)?.[1] ?? '';
  assert.ok(lede.length > 0, 'the page needs a lede above the window');
  assert.match(lede, /free window/i, 'the lede must name where a web answer comes from');
  assert.match(lede, /your own machine/i, 'the lede must say the app answers from the machine');
  // And the composer repeats it, because the lede scrolls away on a long answer.
  const fine = /<p class="hz-fine"[\s\S]*?<\/p>/.exec(page)?.[0] ?? '';
  assert.match(fine, /free window/i);
  assert.match(fine, /no account/i);
});

test('nothing on the page invites work only the app can do', () => {
  // A suggestion that asks for a folder gets a refusal, which is a bad first impression and
  // a broken promise: the hero says what a page cannot do before the visitor tries it.
  const hero = /<div class="hz-hero"[\s\S]*?<\/div>/.exec(page)?.[0] ?? '';
  assert.match(hero, /a page has no disk/i, 'the hero must say why the app is different');
  const prompts = [...page.matchAll(/data-prompt="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(prompts.length, 3);
  for (const prompt of prompts) {
    assert.equal(/folder|file|disk|read my|open my/i.test(prompt), false, `a suggestion asks for file access: ${prompt}`);
  }
});

test('the page names no model vendor', () => {
  for (const name of ['DeepSeek', 'deepseek', 'GLM', 'glm', 'opencode', 'Anthropic', 'Claude', 'OpenAI', 'GPT']) {
    assert.equal(page.includes(name), false, `the harness page names ${name}`);
    assert.equal(script.includes(name), false, `harness.js names ${name}`);
  }
});

test('the window buttons are drawn, not offered, because a page cannot minimise a window', () => {
  const start = page.indexOf('<div class="hz-chrome"');
  const end = page.indexOf('<div class="hz-row">');
  assert.ok(start > 0 && end > start, 'the title bar must come before the window body');
  const chrome = page.slice(start, end);
  assert.match(chrome, /aria-hidden="true"/, 'the copied title bar must be hidden from assistive tech');
  assert.equal(/<button/.test(chrome), false, 'the copied title bar must not contain a real button');
  assert.equal(/tabindex="0"/.test(chrome), false, 'nor anything focusable');
  // All three glyphs are still drawn, or the window stops looking like the window.
  for (const glyph of ['hz-winbtn--min', 'hz-winbtn--max', 'hz-winbtn--close']) {
    assert.ok(chrome.includes(glyph), `the title bar lost ${glyph}`);
  }
});

test('the sample entries in the dock cannot be opened', () => {
  assert.match(script, /button\.disabled = !session\.live/, 'a sample session must be disabled');
  assert.match(script, /A sample entry/, 'a disabled entry must say why in its title');
});

// ------------------------------------------------------------------ the handlers have targets

test('every id the script reaches for exists in the markup', () => {
  const wanted = [...script.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(wanted.length >= 15, 'the script should be wiring the window, not a corner of it');
  const missing = [...new Set(wanted)].filter((id) => !page.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `harness.js wires ids the page does not have: ${missing.join(', ')}`);
});

test('the dock control reports its state and points at the dock', () => {
  assert.match(page, /id="hz-menu"[^>]*aria-controls="hz-dock"[^>]*aria-expanded="true"/);
  assert.match(page, /<aside class="hz-dock" id="hz-dock"/);
  assert.match(script, /setAttribute\('aria-expanded', closed \? 'false' : 'true'\)/);
  assert.match(script, /els\.menu\.title = closed \? 'Open the chats panel' : 'Close the chats panel'/);
});

test('the tabs are a tablist with two panels, not two labels', () => {
  assert.match(page, /role="tablist"/);
  assert.match(page, /id="hz-tab-chat"[^>]*role="tab"[^>]*aria-selected="true"/);
  assert.match(page, /id="hz-log" role="log"/);
  assert.match(page, /id="hz-tree" role="tabpanel"/);
  // Switching must move aria-selected, or a screen reader keeps announcing the old tab.
  assert.match(script, /setAttribute\('aria-selected', chat \? 'true' : 'false'\)/);
});

// ------------------------------------------------------------------ the one thing it sends

test('a message goes to this site and nowhere else', () => {
  assert.match(script, /fetch\('\/api\/trial'/, 'the trial endpoint is the only one that answers');
  assert.match(script, /headers: \{ 'content-type': 'application\/json', accept: 'text\/event-stream' \}/);
  assert.match(script, /history: state\.history\.slice\(-12\)/, 'the endpoint allows 12 history turns');
  assert.equal(/fetch\('http/.test(script), false, 'the page must not post to another origin');
  assert.equal(/XMLHttpRequest/.test(script), false);
});

test('the frames it accepts are the frames the endpoint writes', () => {
  for (const frame of ['frame.delta', 'frame.error', 'frame.end', 'frame.done']) {
    assert.ok(script.includes(frame), `harness.js never reads ${frame}`);
  }
  assert.match(script, /line\.startsWith\('data:'\)/, 'the stream is SSE, so frames arrive as data lines');
});

test('a finished turn leaves no row marked running', () => {
  // The hosted window ends with `{done, usage}` and never sends `{end}`; a tree that keeps
  // a row spinning after the answer arrived is the page misreporting itself.
  assert.match(script, /frame\.end \|\| frame\.done/);
  assert.match(script, /usage = frame\.usage \|\| usage/, 'the usage rides on the done frame');
  const afterLoop = script.slice(script.indexOf('if (answer) {'), script.indexOf('} catch (error)'));
  assert.match(afterLoop, /readRow\.status = 'ok'/, 'a turn with an answer marks its rows done');
});

test('the box takes the same 1200 characters the endpoint does', () => {
  const max = Number(/maxlength="(\d+)"/.exec(page)?.[1] ?? 0);
  assert.equal(max, 1200);
  assert.match(script, /const MAX = Number\(els\.input\?\.getAttribute\('maxlength'\)\) \|\| 1200/);
});

test('a refusal is explained where the answer would have been', () => {
  assert.match(script, /addNote\(/, 'a turn that failed must say so in the transcript');
  assert.match(script, /The free window is not answering/, 'the note has to name what failed');
  assert.match(script, /has no such window/, 'and point at the app that does not depend on it');
  // The endpoint's refusal is `{error: "sentence", kind}`: reading only `error.message`
  // replaced the real reason with "answered 429".
  assert.match(script, /typeof payload\?\.error === 'string'/, 'the refusal sentence is read as sent');
  // The note sits beside the body, so the empty-turn cleanup removed it with the turn and a
  // refused message showed nothing at all.
  assert.match(script, /!turn\?\.querySelector\('\.hz-turn__note'\)/, 'a turn carrying a note is kept');
});

// ------------------------------------------------------------------ the look is the app's

// The page draws a copy of the app window, so its ink has to be the app's ink. Pinning one
// hex here would have made the copy drift the first time the palette moved: the app's own
// stylesheet is the source, and these read it.
const appCss = readFileSync(new URL('../../harness/ui/styles.css', import.meta.url), 'utf8');
const token = (sheet, name) => new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(sheet)?.[1]?.toLowerCase();
const luminance = (hex) => {
  const channel = (i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
};

test('the copy of the window uses the app palette rather than a new one', () => {
  const pairs = [
    ['hz-bg', 'bg'],
    ['hz-bg-2', 'bg-2'],
    ['hz-panel', 'panel'],
    ['hz-panel-2', 'panel-2'],
    ['hz-line', 'line'],
    ['hz-text', 'text'],
    ['hz-text-2', 'text-2'],
    ['hz-accent', 'accent'],
  ];
  for (const [web, app] of pairs) {
    assert.equal(token(css, web), token(appCss, app), `${web} does not match the app's --${app}`);
  }
});

test('the theme is a deep teal, not near black', () => {
  // Jayden asked for the palette to come up off the floor: cyan and teal, but lit. A
  // background darker than this reads as black on a dim screen and hides the hairline work.
  const dark = readFileSync(new URL('../public/harness/harness.css', import.meta.url), 'utf8');
  const luminanceOfBg = luminance(token(dark, 'hz-bg'));
  assert.ok(luminanceOfBg > 0.008, `--hz-bg is ${luminanceOfBg.toFixed(4)}, too close to black`);
  assert.ok(luminanceOfBg < 0.05, `--hz-bg is ${luminanceOfBg.toFixed(4)}, no longer a night theme`);
  const accent = token(dark, 'hz-accent');
  assert.ok(parseInt(accent.slice(5, 7), 16) > 200 && parseInt(accent.slice(3, 5), 16) > 200, 'the accent is still cyan');
});


test('motion is optional', () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /animation-duration: 0\.001ms !important/);
});
