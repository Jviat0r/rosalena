/**
 * Rosalena Harness, the public "try it" demo.
 *
 * Plain ES module, no dependencies, no build step. The pure functions at the top are
 * exported so `node --test` can exercise them without a browser; the page code at the
 * bottom only runs when a document exists, which is what makes the same file
 * importable from Node.
 *
 * Two rules shape everything here:
 *  1. Model text is written with textContent only. Nothing the server, the model or
 *     the session store returns is ever parsed as HTML.
 *  2. The quota is a measurement, not decoration. When it cannot be read, the page
 *     says so in a sentence instead of drawing a number it does not have.
 */

// ---------------------------------------------------------------- constants

export const CHAR_CAP = 1200;
/** Session-store budget for the whole turn array, serialised as JSON. */
export const HISTORY_BYTES = 64 * 1024;
/** Per-request budget for the history we send to the server. */
export const REQUEST_BYTES = 12 * 1024;
export const STORAGE_KEY = 'rosalena.try.v1';

const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;

// ------------------------------------------------------------- language
//
// The page language comes from <html lang>: /es/try/ (built by site/tools/build-i18n.mjs)
// loads this same file. In Node there is no document, so the tests see English unless they
// call setLang('es'). The English entries are the sentences this page always wrote.

function pageLang() {
  const value = typeof document !== 'undefined' ? document.documentElement?.getAttribute?.('lang') ?? '' : '';
  return /^es\b/i.test(value) ? 'es' : 'en';
}

let lang = pageLang();

/** Switch every sentence this module writes to 'en' or 'es'. For tests. */
export function setLang(next) {
  lang = next === 'es' ? 'es' : 'en';
  return lang;
}

/** A path on this site in the page language: '/download/' stays, or becomes '/es/download/'. */
export function sitePath(path) {
  return lang === 'es' ? `/es${path}` : path;
}

export const TEXT = {
  en: {
    accountMessages: 'account messages',
    freeMessages: 'free messages',
    quotaUnknown: 'Free messages left today: unknown',
    quotaLabel: (remaining, limit, noun) => `${remaining} of ${limit} ${noun} left today`,
    locale: 'en-US',
    resetOn: (time, day) => `${time} on ${day}`,
    resetToday: (time) => `${time} today`,
    resetTomorrow: (time) => `${time} tomorrow`,
    providerLocal: 'your own machine, through the desktop app',
    providerHosted: 'a free model on this website, no key needed',
    providerGpu: 'your own graphics card, in this tab',
    providerNone: 'nothing on this machine yet',
    sampleReply: [
      'This is a sample answer, written into the page. It is not a model output.',
      '',
      'The page could not reach the demo API, so the quota in the header and this reply are a scripted sample. Nothing here was measured.',
      '',
      'In the live demo a small hosted model answers one message at a time, and the meter counts down from five free messages a day. Rosalena Harness itself adds the router, the roles, the tools and models that run on your own machine, none of which a static page can show.',
    ],
    hint: 'Enter sends · Shift+Enter new line · Esc stops',
    toDark: 'Switch to the dark theme',
    toLight: 'Switch to the light theme',
    modelThisComputer: 'the app on this computer',
    modelOwnMachine: 'a model on your own machine',
    quotaUnreadable: 'The demo quota could not be read, so the count is unknown.',
    statusUnknown: 'Demo status unknown. Messages still reach the server.',
    samplePrefix: 'Sample data. ',
    statusUnknownLabel: 'Demo status: the free-message count is unknown',
    modelWithNote: (label, note) => `Model: ${label}, ${note}.`,
    model: (label) => `Model: ${label}.`,
    modelUnreadable: 'Model: the page could not read which model answers this demo.',
    comeBackAt: (reset) => `Free messages come back at ${reset}.`,
    comeBackDay: 'Free messages come back when the day rolls over.',
    sampleModelNote: 'a small model, running on Cloudflare, for the demo only',
    modelLocal: (label) => `Model: ${label}. The app asks the model from your own connection; nothing goes through this website.`,
    noticeLocal: 'The desktop app on this computer is answering, using your own connection and your own free-model window. Close the app and this page stops answering.',
    actionBrowser: 'Run it in your browser instead',
    noticeHosted: 'DeepSeek V4.1 Flash is answering here from a free, keyless window on this website: no account, no API key. Your messages leave this machine for the one call that answers them. Start the desktop app for the same model under your own account, with nothing sent through this site.',
    actionOwnMachine: 'Use your own machine instead',
    modelNone: 'Model: none yet. No hosted model is configured, so a model has to run on your own machine.',
    noticeNone: 'No Rosalena app answered on this machine and no hosted model is configured, so there is nothing to answer with yet. Run a small model on your own graphics card in the browser, or install the app and open the pairing link it prints.',
    actionGpu: 'Run it on your GPU',
    actionCheck: 'What can my PC run?',
    streaming: 'streaming',
    thinking: 'thinking…',
    tokensOut: (n) => `${n} tokens out`,
    stopped: 'stopped',
    sampleReplyTag: 'sample reply',
    copy: 'Copy',
    copyLabel: 'Copy this answer',
    you: 'You',
    modelWho: 'Model',
    stoppedBefore: 'Stopped before the model answered, so there is nothing to keep.',
    tryAgain: 'Try again',
    noStream: 'The demo answered without a stream.',
    couldNotAnswer: 'The demo could not answer that.',
    signInLarger: 'Sign in for a larger slice',
    quotaExtraAt: (reset) => ` Free messages come back at ${reset}.`,
    quotaExtraDay: ' Free messages come back when the day rolls over.',
    capacityAt: (reset) => ` The demo is full for today; free messages come back at ${reset}.`,
    capacityDay: ' The demo is full for today, and limits reset daily.',
    runCheck: 'Run the human check',
    noSiteKey: ' This page has no human-check site key configured, so only the server can say what it needs next.',
    askAgain: 'Ask the server again',
    editMessage: 'Edit the message',
    hintNoKey: 'No human-check site key is configured in this page, so the server decides.',
    hintCheckLoad: 'The human check could not load. The server will explain what it needs.',
    hintCheckError: 'The human check reported an error. Try again in a moment.',
    noticeNothing: 'Nothing can answer yet: this page has no hosted model configured and no Rosalena app answered on this machine. Run a small model on your own graphics card in the browser, or install the app and open the pairing link it prints.',
    notPaired: 'The app is running on this computer but this tab is not paired with it. Open the pairing link the app printed when it started, or paste the token it shows into the address bar after #pair=.',
    appHttp: (status) => `The app answered with HTTP ${status}.`,
    streamClosed: 'The server closed the stream before the answer finished, so the text above may be incomplete.',
    unreachable: 'The demo could not be reached.',
    nothingSent: (reason) => `${reason} Nothing was sent to a model.`,
    sampleSpent: 'The sample has no free messages left today.',
    sampleFailed: 'The sample stream could not finish.',
    stoppedKept: 'Stopped. The part that had arrived is kept.',
    pasteTrimmed: (cap) => `That paste was trimmed to the ${cap}-character limit.`,
    pasteTrimmedSay: (cap) => `The pasted text was trimmed to ${cap} characters.`,
    overLimit: 'That message is over the limit. Trim it to send.',
    typeFirst: 'Type a message first.',
    overBy: (count, cap, over) => `${count} / ${cap} · over by ${over}`,
    copied: 'Copied',
    copyFailed: 'Copy failed',
    copiedSay: 'The answer was copied to the clipboard.',
    copyFailedSay: 'The answer could not be copied.',
  },
  es: {
    accountMessages: 'mensajes de la cuenta',
    freeMessages: 'mensajes gratis',
    quotaUnknown: 'Mensajes gratis que quedan hoy: desconocido',
    quotaLabel: (remaining, limit, noun) => `Quedan ${remaining} de ${limit} ${noun} hoy`,
    locale: 'es-419',
    resetOn: (time, day) => `el ${day} ${time.startsWith('1:') ? 'a la' : 'a las'} ${time}`,
    resetToday: (time) => `hoy ${time.startsWith('1:') ? 'a la' : 'a las'} ${time}`,
    resetTomorrow: (time) => `mañana ${time.startsWith('1:') ? 'a la' : 'a las'} ${time}`,
    providerLocal: 'tu propia máquina, a través de la app de escritorio',
    providerHosted: 'un modelo gratis en este sitio, sin necesidad de clave',
    providerGpu: 'tu propia tarjeta gráfica, en esta pestaña',
    providerNone: 'nada en esta máquina todavía',
    sampleReply: [
      'Esta es una respuesta de muestra, escrita en la página. No la generó un modelo.',
      '',
      'La página no pudo conectarse con la API de la demo, así que la cuota del encabezado y esta respuesta son una muestra preparada. Nada de esto se midió.',
      '',
      'En la demo en vivo, un modelo pequeño alojado responde un mensaje a la vez, y el medidor cuenta hacia atrás desde cinco mensajes gratis al día. Rosalena Harness agrega el router, los roles, las herramientas y los modelos que corren en tu propia máquina, y nada de eso lo puede mostrar una página estática.',
    ],
    hint: 'Enter envía · Shift+Enter nueva línea · Esc detiene',
    toDark: 'Cambiar al tema oscuro',
    toLight: 'Cambiar al tema claro',
    modelThisComputer: 'la app en esta computadora',
    modelOwnMachine: 'un modelo en tu propia máquina',
    quotaUnreadable: 'No se pudo leer la cuota de la demo, así que el conteo es desconocido.',
    statusUnknown: 'Estado de la demo desconocido. Los mensajes igual llegan al servidor.',
    samplePrefix: 'Datos de muestra. ',
    statusUnknownLabel: 'Estado de la demo: el conteo de mensajes gratis es desconocido',
    modelWithNote: (label, note) => `Modelo: ${label}, ${note}.`,
    model: (label) => `Modelo: ${label}.`,
    modelUnreadable: 'Modelo: la página no pudo saber qué modelo responde esta demo.',
    comeBackAt: (reset) => `Los mensajes gratis vuelven ${reset}.`,
    comeBackDay: 'Los mensajes gratis vuelven cuando cambia el día.',
    sampleModelNote: 'un modelo pequeño que corre en Cloudflare, solo para la demo',
    modelLocal: (label) => `Modelo: ${label}. La app le pide la respuesta al modelo desde tu propia conexión; nada pasa por este sitio.`,
    noticeLocal: 'Está respondiendo la app de escritorio de esta computadora, con tu propia conexión y tu propia ventana de modelos gratis. Si cierras la app, esta página deja de responder.',
    actionBrowser: 'Mejor córrelo en tu navegador',
    noticeHosted: 'Aquí responde DeepSeek V4.1 Flash desde una ventana gratis y sin clave de este sitio: sin cuenta y sin clave de API. Tus mensajes salen de esta máquina para la llamada que los responde. Abre la app de escritorio para usar el mismo modelo con tu propia cuenta, sin enviar nada a través de este sitio.',
    actionOwnMachine: 'Mejor usa tu propia máquina',
    modelNone: 'Modelo: ninguno todavía. No hay un modelo alojado configurado, así que el modelo tiene que correr en tu propia máquina.',
    noticeNone: 'Ninguna app de Rosalena respondió en esta máquina y no hay un modelo alojado configurado, así que todavía no hay con qué responder. Corre un modelo pequeño en tu propia tarjeta gráfica en el navegador, o instala la app y abre el enlace de vinculación que muestra.',
    actionGpu: 'Córrelo en tu GPU',
    actionCheck: '¿Qué puede correr mi PC?',
    streaming: 'recibiendo',
    thinking: 'pensando…',
    tokensOut: (n) => `${n} tokens de salida`,
    stopped: 'detenido',
    sampleReplyTag: 'respuesta de muestra',
    copy: 'Copiar',
    copyLabel: 'Copiar esta respuesta',
    you: 'Tú',
    modelWho: 'Modelo',
    stoppedBefore: 'Se detuvo antes de que el modelo respondiera, así que no hay nada que guardar.',
    tryAgain: 'Intentar de nuevo',
    noStream: 'La demo respondió sin un stream.',
    couldNotAnswer: 'La demo no pudo responder eso.',
    signInLarger: 'Inicia sesión para tener más mensajes',
    quotaExtraAt: (reset) => ` Los mensajes gratis vuelven ${reset}.`,
    quotaExtraDay: ' Los mensajes gratis vuelven cuando cambia el día.',
    capacityAt: (reset) => ` La demo se llenó por hoy; los mensajes gratis vuelven ${reset}.`,
    capacityDay: ' La demo se llenó por hoy, y los límites se reinician cada día.',
    runCheck: 'Hacer la verificación humana',
    noSiteKey: ' Esta página no tiene configurada una clave de sitio para la verificación humana, así que solo el servidor puede decir qué necesita.',
    askAgain: 'Preguntarle otra vez al servidor',
    editMessage: 'Editar el mensaje',
    hintNoKey: 'Esta página no tiene configurada una clave de sitio para la verificación humana, así que decide el servidor.',
    hintCheckLoad: 'No se pudo cargar la verificación humana. El servidor va a explicar qué necesita.',
    hintCheckError: 'La verificación humana reportó un error. Inténtalo de nuevo en un momento.',
    noticeNothing: 'Todavía nada puede responder: esta página no tiene un modelo alojado configurado y ninguna app de Rosalena respondió en esta máquina. Corre un modelo pequeño en tu propia tarjeta gráfica en el navegador, o instala la app y abre el enlace de vinculación que muestra.',
    notPaired: 'La app está corriendo en esta computadora, pero esta pestaña no está vinculada con ella. Abre el enlace de vinculación que la app mostró al arrancar, o pega el token que muestra en la barra de direcciones después de #pair=.',
    appHttp: (status) => `La app respondió con HTTP ${status}.`,
    streamClosed: 'El servidor cerró el stream antes de que terminara la respuesta, así que el texto de arriba puede estar incompleto.',
    unreachable: 'No se pudo conectar con la demo.',
    nothingSent: (reason) => `${reason} No se envió nada a ningún modelo.`,
    sampleSpent: 'A la muestra no le quedan mensajes gratis hoy.',
    sampleFailed: 'No se pudo terminar el stream de muestra.',
    stoppedKept: 'Detenido. Se conserva lo que ya había llegado.',
    pasteTrimmed: (cap) => `Lo que pegaste se recortó al límite de ${cap} caracteres.`,
    pasteTrimmedSay: (cap) => `El texto pegado se recortó a ${cap} caracteres.`,
    overLimit: 'Ese mensaje pasa el límite. Recórtalo para enviarlo.',
    typeFirst: 'Primero escribe un mensaje.',
    overBy: (count, cap, over) => `${count} / ${cap} · sobran ${over}`,
    copied: 'Copiado',
    copyFailed: 'No se pudo copiar',
    copiedSay: 'La respuesta se copió al portapapeles.',
    copyFailedSay: 'No se pudo copiar la respuesta.',
  },
};

const L = () => TEXT[lang];


// ------------------------------------------------------------ pure helpers

export function byteLength(text) {
  const value = String(text ?? '');
  return encoder ? encoder.encode(value).length : value.length;
}

/** Count user-perceived characters, so an emoji costs one against the cap. */
export function countChars(text) {
  return Array.from(String(text ?? '')).length;
}

/**
 * Keep the newest turns that fit in `maxBytes`, dropping whole turns oldest first.
 * When a single turn is bigger than the budget it is kept but truncated, because
 * throwing away the only thing the reader typed is worse than showing less of it.
 */
export function trimHistory(turns, maxBytes = HISTORY_BYTES) {
  const kept = (Array.isArray(turns) ? turns : [])
    .filter((turn) => turn && typeof turn.content === 'string' && (turn.role === 'user' || turn.role === 'assistant'))
    .map((turn) => ({ ...turn }));

  const fits = (list) => byteLength(JSON.stringify(list)) <= maxBytes;

  while (kept.length > 1 && !fits(kept)) kept.shift();

  if (kept.length === 1 && !fits(kept)) {
    const turn = kept[0];
    // The truncation marker costs bytes too, so every candidate carries it and the
    // measurement of the result matches the measurement used to search for it.
    const candidate = (content) => [{ ...turn, content, truncated: true }];
    if (!fits(candidate(''))) return [];

    let low = 0;
    let high = turn.content.length;
    let best = 0;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (fits(candidate(turn.content.slice(0, middle)))) {
        best = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (best === 0) return [];
    kept[0] = { ...turn, content: turn.content.slice(0, best), truncated: true };
  }

  return kept;
}

/**
 * Decode the `data:` lines of a Server-Sent Events stream into frames.
 *
 * The decoder holds a partial line between chunks and skips a frame it cannot parse:
 * one bad line must not end a stream that is otherwise fine.
 */
export function createSseDecoder() {
  let buffer = '';
  let finished = false;

  function parseLine(line) {
    if (!line || line.startsWith(':')) return [];
    if (!line.startsWith('data:')) return [];

    let payload = line.slice(5);
    if (payload.startsWith(' ')) payload = payload.slice(1);
    payload = payload.trim();
    if (!payload) return [];

    if (payload === '[DONE]') {
      finished = true;
      return [{ type: 'done' }];
    }

    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return [];
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];

    if (typeof parsed.delta === 'string') return [{ type: 'delta', text: parsed.delta }];
    if (typeof parsed.error === 'string') {
      return [{ type: 'error', error: parsed.error, kind: typeof parsed.kind === 'string' ? parsed.kind : 'provider' }];
    }
    if (parsed.done === true) {
      return [{ type: 'end', done: true, usage: parsed.usage, quota: parsed.quota }];
    }
    return [];
  }

  return {
    push(chunk) {
      if (finished) return [];
      buffer += String(chunk ?? '');
      const frames = [];
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if (line) frames.push(...parseLine(line));
        if (finished) {
          buffer = '';
          break;
        }
        index = buffer.indexOf('\n');
      }
      return frames;
    },
    end() {
      if (finished) return [];
      const rest = buffer.trim();
      buffer = '';
      return rest ? parseLine(rest) : [];
    },
    get finished() {
      return finished;
    },
  };
}

/**
 * Turn one quota slice into the numbers and the sentence the page shows.
 * Anything unreadable collapses to `known: false` with a plain sentence, so the UI
 * can never render "undefined of undefined".
 */
export function describeQuota(slice, options = {}) {
  const kind = options.kind === 'account' ? 'account' : 'anonymous';
  const noun = kind === 'account' ? L().accountMessages : L().freeMessages;
  const resetAt = slice && typeof slice.resetAt === 'string' ? slice.resetAt : null;
  const used = slice && Number.isFinite(slice.used) && slice.used >= 0 ? Math.floor(slice.used) : null;
  const limit = slice && Number.isFinite(slice.limit) && slice.limit > 0 ? Math.floor(slice.limit) : null;

  if (used === null || limit === null) {
    return {
      known: false,
      kind,
      used,
      limit,
      remaining: null,
      spent: false,
      percent: null,
      resetAt,
      label: L().quotaUnknown,
    };
  }

  const remaining = Math.max(0, limit - used);
  return {
    known: true,
    kind,
    used,
    limit,
    remaining,
    spent: remaining === 0,
    percent: Math.min(100, Math.max(0, (used / limit) * 100)),
    resetAt,
    label: L().quotaLabel(remaining, limit, noun),
  };
}

/**
 * Format a reset instant as a local clock time, relative to an injected clock.
 * `timeZone` exists so the test can pin the output instead of depending on the
 * machine that runs it.
 */
export function formatResetTime(iso, now = new Date(), options = {}) {
  if (typeof iso !== 'string' || !iso) return null;
  const date = new Date(iso);
  const reference = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime()) || Number.isNaN(reference.getTime())) return null;

  const locale = typeof options.locale === 'string' && options.locale ? options.locale : L().locale;
  const timeZone = typeof options.timeZone === 'string' && options.timeZone ? options.timeZone : undefined;
  const tidy = (value) => value.replace(/[\u00a0\u202f]/g, ' ');

  let time;
  try {
    time = tidy(new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone }).format(date));
  } catch {
    return null;
  }

  const dayKey = (value) => {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).formatToParts(value);
      const pick = (type) => parts.find((part) => part.type === type)?.value ?? '';
      return `${pick('year')}-${pick('month')}-${pick('day')}`;
    } catch {
      return '';
    }
  };

  const toDayNumber = (key) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
    if (!match) return null;
    return Math.round(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86400000);
  };

  const target = toDayNumber(dayKey(date));
  const today = toDayNumber(dayKey(reference));
  const monthDay = tidy(new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone }).format(date));

  if (target === null || today === null) return L().resetOn(time, monthDay);
  const difference = target - today;
  if (difference === 0) return L().resetToday(time);
  if (difference === 1) return L().resetTomorrow(time);
  return L().resetOn(time, monthDay);
}

/** The composer's view of its own value: count, headroom, and whether sending is legal. */
export function composerState(value, cap = CHAR_CAP) {
  const text = String(value ?? '');
  const count = countChars(text);
  const trimmed = text.trim();
  return {
    count,
    cap,
    remaining: Math.max(0, cap - count),
    over: count > cap,
    empty: trimmed.length === 0,
    canSend: trimmed.length > 0 && count <= cap,
  };
}

/** Slice text down to the cap by code point, reporting whether anything was dropped. */
export function clampToCap(text, cap = CHAR_CAP) {
  const chars = Array.from(String(text ?? ''));
  if (chars.length <= cap) return { text: chars.join(''), truncated: false };
  return { text: chars.slice(0, cap).join(''), truncated: true };
}

// ------------------------------------------------------------- where it runs

/**
 * The demo answers from the visitor's own machine. Not from a Worker, not from a shared
 * egress address, not from anyone else's quota.
 *
 * Two ways that can happen, and this page only knows how to do the first:
 *
 *   `local-app`  the desktop app is running on this computer. The page asks it over
 *                loopback, and the app makes the model request from the visitor's own
 *                connection using the visitor's own keyless window. The request carries a
 *                pairing token that rode in the URL's fragment, so another tab or a
 *                stranger's page cannot drive the app.
 *   `gpu`        no app: the visitor runs a small model in the tab on their own graphics
 *                card. That demo lives on the home page, so this page hands over rather
 *                than downloading a second copy of the weights.
 *
 * Anything else is `none`, and the page says so instead of pretending a server exists.
 */
export const BRIDGE_ORIGIN = 'http://127.0.0.1:8765';

/** How long a page waits for the app before deciding it is not there. */
export const BRIDGE_PROBE_MS = 2000;

/**
 * The pairing token, from the fragment only. A fragment is never sent to a server and is
 * not readable across origins, which is why the app puts it there rather than in a query.
 */
export function pairTokenFromHash(hash) {
  const raw = String(hash ?? '').replace(/^#/, '');
  if (!raw) return null;
  for (const part of raw.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq) !== 'pair') continue;
    let value = part.slice(eq + 1);
    try {
      value = decodeURIComponent(value);
    } catch {
      return null;
    }
    return /^[A-Za-z0-9_-]{16,}$/.test(value) ? value : null;
  }
  return null;
}

/** The bridge's chat endpoint, asking for the frame shape this page already parses. */
export function bridgeChatUrl(origin = BRIDGE_ORIGIN) {
  return `${origin}/v1/chat?format=trial`;
}

/**
 * The conversation the app receives. The page owns the words; it does not get to send a
 * system role, tools or a bigger answer than the demo promises - the bridge enforces the
 * same rules on its side.
 */
export function bridgeMessages(history, message, limit = 16) {
  const turns = [];
  for (const item of Array.from(history ?? [])) {
    if (!item || typeof item.content !== 'string') continue;
    if (item.role !== 'user' && item.role !== 'assistant') continue;
    if (!item.content.trim()) continue;
    turns.push({ role: item.role, content: item.content });
  }
  const said = String(message ?? '').trim();
  if (said) turns.push({ role: 'user', content: said });
  return turns.slice(-limit);
}

/** What the header says about who is answering. */
export function providerLabel(provider) {
  if (provider === 'local-app') return L().providerLocal;
  if (provider === 'hosted') return L().providerHosted;
  if (provider === 'gpu') return L().providerGpu;
  return L().providerNone;
}

// --------------------------------------------------------------- page code

const sampleReply = () => L().sampleReply.join('\n');

function boot() {
  const $ = (id) => document.getElementById(id);

  const els = {
    main: $('rt-main'),
    log: $('rt-log'),
    welcome: $('rt-welcome'),
    starters: $('rt-starters'),
    model: $('rt-model'),
    quota: $('rt-quota'),
    quotaFill: $('rt-quota-fill'),
    quotaText: $('rt-quota-text'),
    sampleTag: $('rt-sample-tag'),
    demoNote: $('rt-demo-note'),
    account: $('rt-account'),
    accountEmail: $('rt-account-email'),
    signin: $('rt-signin'),
    theme: $('rt-theme'),
    upgrade: $('rt-upgrade'),
    upgradeReset: $('rt-upgrade-reset'),
    upgradeSignin: $('rt-upgrade-signin'),
    check: $('rt-check'),
    turnstile: $('rt-turnstile'),
    form: $('rt-form'),
    input: $('rt-input'),
    send: $('rt-send'),
    stop: $('rt-stop'),
    count: $('rt-count'),
    hint: $('rt-hint'),
    status: $('rt-status'),
  };

  // Who is answering: 'local-app' when the desktop app on this computer answers the
  // probe, 'none' when nothing on the machine can. There is no hosted provider to fall
  // back to, which is the point: no message may be spent from a shared address.
  let provider = 'unknown';
  let pairToken = null;
  const PAIR_KEY = 'rosalena.try.pair';

  const state = {
    turns: [],
    busy: false,
    abort: null,
    data: null,
    demo: false,
    demoSends: 0,
    turnstileToken: '',
    pendingRetry: '',
    ids: 0,
    hintTimer: 0,
  };

  const demoAllowed = new URLSearchParams(location.search).get('demo') === '1';

  // ------------------------------------------------------------- utilities

  const nextId = () => {
    state.ids += 1;
    return `turn-${state.ids}`;
  };

  function say(text) {
    if (els.status) els.status.textContent = text;
  }

  function flashHint(text) {
    if (!els.hint) return;
    els.hint.textContent = text;
    window.clearTimeout(state.hintTimer);
    state.hintTimer = window.setTimeout(() => {
      els.hint.textContent = L().hint;
    }, 5000);
  }

  function timeoutSignal(ms) {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return AbortSignal.timeout(ms);
    }
    const controller = new AbortController();
    window.setTimeout(() => controller.abort(), ms);
    return controller.signal;
  }

  async function readJson(response) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  function isAbort(error) {
    return Boolean(error) && (error.name === 'AbortError' || error.code === 20);
  }

  function scrollToEnd(force = false) {
    if (!els.main) return;
    const distance = els.main.scrollHeight - els.main.scrollTop - els.main.clientHeight;
    if (!force && distance > 120) return; // the reader scrolled up; leave them there
    els.main.scrollTop = els.main.scrollHeight;
  }

  // --------------------------------------------------------------- session

  function loadSession() {
    let raw = '';
    try {
      raw = sessionStorage.getItem(STORAGE_KEY) || '';
    } catch {
      return [];
    }
    if (!raw) return [];
    try {
      const data = JSON.parse(raw);
      if (!data || data.version !== 1 || !Array.isArray(data.turns)) return [];
      return data.turns
        .filter((turn) => turn && typeof turn.content === 'string' && (turn.role === 'user' || turn.role === 'assistant'))
        .slice(0, 200);
    } catch {
      return [];
    }
  }

  function saveSession() {
    const turns = state.turns.map((turn) => ({
      role: turn.role,
      content: turn.content,
      ...(turn.stopped ? { stopped: true } : {}),
      ...(turn.sample ? { sample: true } : {}),
      ...(typeof turn.model === 'string' && turn.model ? { model: turn.model } : {}),
    }));
    const kept = trimHistory(turns, HISTORY_BYTES);
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, turns: kept }));
    } catch {
      // A full or blocked session store is not worth an error message: the page still works.
    }
  }

  // ---------------------------------------------------------------- theme

  // One key for the whole site (/theme.js reads it before first paint), so a choice made on
  // the home page carries over here and back.
  const THEME_KEY = 'rosalena-theme';

  function applyTheme(theme, save = true) {
    const light = theme === 'light';
    document.documentElement.dataset.theme = light ? 'light' : 'dark';
    if (els.theme) {
      els.theme.setAttribute('aria-pressed', light ? 'true' : 'false');
      els.theme.setAttribute('aria-label', light ? L().toDark : L().toLight);
      els.theme.textContent = light ? '◑' : '◐';
    }
    if (!save) return;
    try {
      localStorage.setItem(THEME_KEY, light ? 'light' : 'dark');
    } catch {
      // Storage can be off; the toggle still works for this page view.
    }
  }

  function loadTheme() {
    // /theme.js has already applied the saved (or ?theme=) choice; just sync the button.
    applyTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark', false);
  }

  // ---------------------------------------------------------------- quota

  function activeSlice(data = state.data) {
    if (!data || typeof data !== 'object') return null;
    if (data.account && typeof data.account === 'object') return data.account;
    if (data.anonymous && typeof data.anonymous === 'object') return data.anonymous;
    return null;
  }

  function activeKind(data = state.data) {
    return data && data.account && typeof data.account === 'object' ? 'account' : 'anonymous';
  }

  function signInUrl() {
    return state.data && typeof state.data.signInUrl === 'string' && state.data.signInUrl ? state.data.signInUrl : '';
  }

  function accountEmail() {
    const account = state.data && state.data.account;
    return account && typeof account.email === 'string' ? account.email : '';
  }

  function currentReset() {
    const slice = activeSlice();
    return formatResetTime(slice && slice.resetAt, new Date());
  }

  function modelLabel() {
    const model = state.data && state.data.model;
    if (model && typeof model.label === 'string' && model.label) return model.label;
    // The hosted path names the free model it actually calls; the paired path names the
    // machine that answered. Neither ever guesses a model neither one ran.
    if (provider === 'hosted') return 'DeepSeek V4.1 Flash';
    return provider === 'local-app' ? L().modelThisComputer : L().modelOwnMachine;
  }

  function renderQuota(data) {
    state.data = data;
    const slice = activeSlice();
    const view = describeQuota(slice, { kind: activeKind() });
    const reset = currentReset();

    if (view.known) {
      els.quotaText.textContent = view.label;
      els.quota.classList.toggle('rt-quota--spent', view.spent);
      els.quota.classList.remove('rt-quota--unknown');
      els.quotaFill.style.width = `${view.percent}%`;
      // role="meter" is only honest once a value exists; see the unknown branch.
      els.quota.setAttribute('role', 'meter');
      els.quota.setAttribute('aria-valuemin', '0');
      els.quota.setAttribute('aria-valuemax', String(view.limit));
      // The bar fills with what is left, so the exposed value is the remainder too:
      // a spent meter reads "0 of 5", matching the empty bar and the label.
      els.quota.setAttribute('aria-valuenow', String(view.remaining));
      els.quota.setAttribute('aria-valuetext', view.label);
      els.quota.setAttribute('aria-label', `${state.demo ? L().samplePrefix : ''}${view.label}`);
    } else {
      els.quotaText.textContent = data
        ? L().quotaUnreadable
        : L().statusUnknown;
      els.quotaFill.style.width = '0%';
      els.quota.classList.add('rt-quota--unknown');
      els.quota.classList.remove('rt-quota--spent');
      // A meter must carry a value. Without one, expose the pill as a labelled image so
      // assistive technology says "unknown" instead of reading a fabricated zero.
      els.quota.setAttribute('role', 'img');
      els.quota.removeAttribute('aria-valuemin');
      els.quota.removeAttribute('aria-valuemax');
      els.quota.removeAttribute('aria-valuenow');
      els.quota.removeAttribute('aria-valuetext');
      els.quota.setAttribute('aria-label', L().statusUnknownLabel);
    }

    els.sampleTag.hidden = !state.demo;
    els.demoNote.hidden = !state.demo;

    const url = signInUrl();
    els.signin.hidden = !url || view.kind === 'account';
    if (url) els.signin.href = url;

    const email = accountEmail();
    els.account.hidden = !email;
    els.accountEmail.textContent = email;

    const label = modelLabel();
    const note = state.data && state.data.model && typeof state.data.model.note === 'string' ? state.data.model.note : '';
    els.model.textContent = data
      ? note
        ? L().modelWithNote(label, note)
        : L().model(label)
      : L().modelUnreadable;

    const showUpgrade = view.known && view.spent && view.kind === 'anonymous';
    els.upgrade.hidden = !showUpgrade;
    if (showUpgrade) {
      els.upgradeReset.textContent = reset
        ? L().comeBackAt(reset)
        : L().comeBackDay;
      els.upgradeSignin.hidden = !url;
      if (url) els.upgradeSignin.href = url;
    }

    if (state.data && state.data.turnstileRequired === true) void prepareTurnstile();
  }

  function sampleQuota() {
    return {
      ok: true,
      anonymous: { used: 2, limit: 5, resetAt: new Date(Date.now() + 7 * 3600 * 1000).toISOString() },
      account: null,
      // No sign-in route exists yet, so the sample state must not invent one.
      signInUrl: '',
      model: { label: 'Llama 3.1 8B', note: L().sampleModelNote },
      turnstileRequired: false,
    };
  }

  /**
   * Which machine answers, in the order that spends the least of a stranger's trust:
   * the desktop app on this computer first (their connection, their free window), then
   * the free model hosted here (no install, no account, no key) and only then nothing.
   * The header always names which one it picked.
   */
  async function loadProvider() {
    takePairFromHash();
    if (await probeLocalApp()) {
      provider = 'local-app';
    } else {
      const quota = await fetchQuota();
      // `/api/quota` reports whether a hosted model is configured at all. A static host
      // (no Functions) answers 404, which reads as "no" rather than as an error.
      provider = quota && quota.model && quota.model.hosted !== false ? 'hosted' : 'none';
    }
    renderProvider();
    if (state.data && state.data.turnstileRequired === true) void prepareTurnstile();
  }

  /** The hosted endpoint's own counter. Absent on a static host, which is not a failure. */
  async function fetchQuota() {
    try {
      const response = await fetch('/api/quota', {
        cache: 'no-store',
        headers: { accept: 'application/json' },
        signal: timeoutSignal(BRIDGE_PROBE_MS),
      });
      if (!response.ok) return null;
      const body = await readJson(response);
      if (!body || typeof body !== 'object') return null;
      renderQuota(body);
      return body;
    } catch {
      return null;
    }
  }

  function takePairFromHash() {
    const token = pairTokenFromHash(location.hash);
    if (!token) return false;
    pairToken = token;
    try {
      sessionStorage.setItem(PAIR_KEY, token);
    } catch {
      /* private mode: the token still works for this page view */
    }
    // The secret has done its job once it is in memory; leaving it in the address bar
    // invites a screenshot of it, so the URL forgets it immediately.
    try {
      history.replaceState(null, '', `${location.pathname}${location.search}`);
    } catch {
      /* an older browser that refuses replaceState simply keeps the hash */
    }
    return true;
  }

  function pairTokenNow() {
    if (pairToken) return pairToken;
    try {
      pairToken = sessionStorage.getItem(PAIR_KEY) || null;
    } catch {
      pairToken = null;
    }
    return pairToken;
  }

  async function probeLocalApp() {
    try {
      const response = await fetch(`${BRIDGE_ORIGIN}/health`, {
        cache: 'no-store',
        signal: timeoutSignal(BRIDGE_PROBE_MS),
      });
      if (!response.ok) return false;
      const body = await readJson(response);
      return Boolean(body && body.ok === true && body.app === 'rosalena-harness');
    } catch {
      return false;
    }
  }

  function renderProvider() {
    const onThisMachine = provider === 'local-app';
    const hosted = provider === 'hosted';
    // A hosted model means a real counter, and renderQuota already filled it in. With no
    // hosted model there is no quota, so the meter is removed rather than shown at "0 of 5",
    // which would describe a server that does not exist.
    if (els.quota) els.quota.hidden = !hosted;

    if (onThisMachine) {
      if (els.model) {
        els.model.textContent = L().modelLocal(providerLabel('local-app'));
      }
      state.data = null;
      els.demoNote.hidden = true;
      addNotice({
        text: L().noticeLocal,
        tone: 'info',
        actions: [actionLink(L().actionBrowser, sitePath('/#try'))],
      });
    } else if (hosted) {
      els.demoNote.hidden = true;
      addNotice({
        text: L().noticeHosted,
        tone: 'info',
        actions: [actionLink(L().actionOwnMachine, sitePath('/download/'))],
      });
    } else {
      if (els.model) {
        els.model.textContent = L().modelNone;
      }
      addNotice({
        text: L().noticeNone,
        tone: 'warn',
        actions: [actionLink(L().actionGpu, sitePath('/#try')), actionLink(L().actionCheck, sitePath('/check/'))],
      });
    }
  }


  function mergeQuota(patch) {
    if (!state.data || typeof state.data !== 'object') return;
    const key = activeKind();
    const slice = state.data[key];
    if (!slice || typeof slice !== 'object') return;
    renderQuota({ ...state.data, [key]: { ...slice, ...patch } });
  }

  function bumpSampleQuota() {
    const slice = activeSlice();
    if (!slice) return;
    const limit = Number.isFinite(slice.limit) && slice.limit > 0 ? slice.limit : 5;
    const used = Math.min(limit, (Number.isFinite(slice.used) ? slice.used : 0) + 1);
    mergeQuota({ used });
  }

  function sampleRemaining() {
    const view = describeQuota(activeSlice(), { kind: 'anonymous' });
    return view.known ? view.remaining : 5;
  }

  // ------------------------------------------------------------ transcript

  function updateMeta(turn) {
    if (!turn.node) return;
    const meta = turn.node.meta;
    if (!meta) return;
    meta.textContent = '';

    if (turn.role === 'assistant') {
      const bits = document.createElement('span');
      bits.className = 'rt-meta__bits';
      const values = [turn.model || modelLabel()];
      if (turn.streaming) values.push(turn.content ? L().streaming : L().thinking);
      if (turn.tokens) values.push(L().tokensOut(turn.tokens));
      if (turn.stopped) values.push(L().stopped);
      if (turn.sample) values.push(L().sampleReplyTag);
      for (const value of values) {
        const item = document.createElement('span');
        item.textContent = value;
        bits.append(item);
      }
      meta.append(bits);

      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'rt-copy';
      copy.dataset.copy = turn.id;
      copy.textContent = L().copy;
      copy.setAttribute('aria-label', L().copyLabel);
      meta.append(copy);
    }
  }

  function buildTurn(turn) {
    const article = document.createElement('article');
    article.className = `rt-msg rt-msg--${turn.role === 'user' ? 'user' : 'bot'}`;
    article.dataset.id = turn.id;
    if (turn.streaming) article.classList.add('rt-msg--streaming');
    if (turn.stopped) article.classList.add('rt-msg--stopped');

    const who = document.createElement('p');
    who.className = 'rt-who';
    who.textContent = turn.role === 'user' ? L().you : L().modelWho;

    const main = document.createElement('div');
    main.className = 'rt-msg__main';

    const body = document.createElement('div');
    body.className = 'rt-body';
    const text = document.createElement('p');
    text.className = 'rt-text';
    text.textContent = turn.content;
    body.append(text);

    let caret = null;
    if (turn.streaming) {
      caret = document.createElement('span');
      caret.className = 'rt-caret';
      caret.setAttribute('aria-hidden', 'true');
      body.append(caret);
    }

    main.append(body);
    if (turn.role === 'assistant') {
      const meta = document.createElement('div');
      meta.className = 'rt-meta';
      main.append(meta);
      turn.node = { article, text, caret, meta };
    } else {
      turn.node = { article, text, caret: null, meta: null };
    }

    article.append(who, main);
    updateMeta(turn);
    return article;
  }

  function pushTurn(turn) {
    state.turns.push(turn);
    els.welcome.hidden = true;
    els.log.append(buildTurn(turn));
    scrollToEnd(true);
    return turn;
  }

  function removeTurn(turn) {
    const index = state.turns.indexOf(turn);
    if (index >= 0) state.turns.splice(index, 1);
    if (turn.node && turn.node.article && turn.node.article.parentNode) {
      turn.node.article.remove();
    }
    els.welcome.hidden = state.turns.length > 0;
  }

  function removeLastTurn() {
    const last = state.turns[state.turns.length - 1];
    if (last) removeTurn(last);
  }

  function rewindExchange() {
    while (state.turns.length && state.turns[state.turns.length - 1].role === 'assistant') removeLastTurn();
    if (state.turns.length && state.turns[state.turns.length - 1].role === 'user') removeLastTurn();
    saveSession();
  }

  function updateStreamingTurn(turn) {
    if (!turn.node) return;
    turn.node.text.textContent = turn.content;
    scrollToEnd();
  }

  function finishTurn(turn, options = {}) {
    turn.streaming = false;
    if (options.stopped) turn.stopped = true;
    if (options.usage && Number.isFinite(options.usage.output)) turn.tokens = options.usage.output;
    // Remember which model answered: after a reload the quota response may not have
    // arrived yet, and the restored transcript should still name the model it came from.
    if (!turn.model) turn.model = modelLabel();

    if (!turn.content && turn.stopped) {
      removeTurn(turn);
      addNotice({ text: L().stoppedBefore, tone: 'info' });
      return;
    }

    if (turn.node) {
      turn.node.article.classList.remove('rt-msg--streaming');
      turn.node.article.classList.toggle('rt-msg--stopped', Boolean(turn.stopped));
      if (turn.node.caret) {
        turn.node.caret.remove();
        turn.node.caret = null;
      }
      updateMeta(turn);
    }
    els.log.setAttribute('aria-busy', 'false');
    saveSession();
  }

  function failTurn(turn, message) {
    const keep = Boolean(turn.content);
    if (keep) finishTurn(turn);
    else removeTurn(turn);
    addNotice({
      text: message,
      tone: 'bad',
      actions: keep ? [] : [actionButton(L().tryAgain, () => retry(turn.sentMessage || ''))],
    });
  }

  function addNotice({ text, tone = 'info', actions = [] }) {
    const line = document.createElement('div');
    line.className = `rt-line rt-line--${tone}`;
    line.setAttribute('role', 'status');

    const mark = document.createElement('span');
    mark.className = 'rt-line__mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = tone === 'bad' ? '!' : '·';

    const body = document.createElement('div');
    body.className = 'rt-line__body';
    const paragraph = document.createElement('p');
    paragraph.className = 'rt-line__text';
    paragraph.textContent = text;
    body.append(paragraph);

    if (actions.length) {
      const row = document.createElement('div');
      row.className = 'rt-line__actions';
      for (const action of actions) row.append(action);
      body.append(row);
    }

    line.append(mark, body);
    els.log.append(line);
    scrollToEnd(true);
    return line;
  }

  function actionButton(label, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'rt-action';
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
  }

  function actionLink(label, href) {
    const link = document.createElement('a');
    link.className = 'rt-action';
    link.href = href;
    link.textContent = label;
    return link;
  }

  async function copyAnswer(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Clipboard permissions can be missing (a plain http origin, for instance).
    }
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.top = '-1000px';
      area.style.opacity = '0';
      document.body.append(area);
      area.select();
      const copied = document.execCommand('copy');
      area.remove();
      return copied;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- stream

  function applyFrames(frames, turn, status) {
    let stop = false;
    for (const frame of frames) {
      if (frame.type === 'delta') {
        turn.content += frame.text;
        updateStreamingTurn(turn);
      } else if (frame.type === 'end') {
        status.sawEnd = true;
        if (frame.usage && Number.isFinite(frame.usage.output)) turn.tokens = frame.usage.output;
        if (frame.quota && typeof frame.quota === 'object') mergeQuota(frame.quota);
        if (turn.node) updateMeta(turn);
      } else if (frame.type === 'done') {
        stop = true;
      } else if (frame.type === 'error') {
        status.sawError = true;
        addNotice({
          text: frame.error,
          tone: 'bad',
          actions: turn.content ? [] : [actionButton(L().tryAgain, () => retry(turn.sentMessage || ''))],
        });
        stop = true;
      }
    }
    return stop;
  }

  async function pumpResponse(response, turn) {
    const reader = response.body && response.body.getReader ? response.body.getReader() : null;
    if (!reader) throw new Error(L().noStream);

    const decoder = new TextDecoder();
    const sse = createSseDecoder();
    const status = { sawEnd: false, sawError: false };
    let stop = false;
    try {
      while (!stop) {
        const { value, done } = await reader.read();
        if (done) break;
        stop = applyFrames(sse.push(decoder.decode(value, { stream: true })), turn, status);
      }
      if (!stop) applyFrames(sse.end(), turn, status);
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Nothing to release if the read already failed.
      }
    }
    return { ended: status.sawEnd || sse.finished, failed: status.sawError };
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  async function runSampleStream(turn) {
    const chunks = sampleReply().match(/\s*\S+/g) || [];
    for (const chunk of chunks) {
      if (state.abort && state.abort.signal.aborted) {
        const error = new Error('The stream was stopped.');
        error.name = 'AbortError';
        throw error;
      }
      await delay(26);
      turn.content += chunk;
      updateStreamingTurn(turn);
    }
    if (turn.node) updateMeta(turn);
  }

  // -------------------------------------------------------------- refusals

  function refuse(body, message, turn = null) {
    const kind = typeof body.kind === 'string' ? body.kind : 'provider';
    const sentence = typeof body.error === 'string' && body.error.trim() ? body.error.trim() : L().couldNotAnswer;
    const reset = currentReset();
    const actions = [];
    let extra = '';

    if (turn && !turn.content) removeTurn(turn);

    if (kind === 'quota') {
      if (!accountEmail() && signInUrl()) actions.push(actionLink(L().signInLarger, signInUrl()));
      extra = reset ? L().quotaExtraAt(reset) : L().quotaExtraDay;
    } else if (kind === 'capacity') {
      extra = reset ? L().capacityAt(reset) : L().capacityDay;
    } else if (kind === 'turnstile') {
      if (siteKey()) {
        actions.push(
          actionButton(L().runCheck, () => {
            state.pendingRetry = message;
            void prepareTurnstile();
          }),
        );
      } else {
        extra = L().noSiteKey;
        actions.push(actionButton(L().askAgain, () => retry(message)));
      }
    } else if (kind === 'provider') {
      actions.push(actionButton(L().tryAgain, () => retry(message)));
    } else {
      actions.push(
        actionButton(L().editMessage, () => {
          rewindExchange();
          setComposer(message);
        }),
      );
    }

    addNotice({ text: `${sentence}${extra}`, tone: kind === 'quota' || kind === 'capacity' ? 'warn' : 'bad', actions });
    say(sentence);
  }

  function retry(message) {
    const text = typeof message === 'string' ? message : '';
    if (!text.trim()) return;
    rewindExchange();
    void send(text);
  }

  // -------------------------------------------------------------- turnstile

  let turnstileScript = null;
  let turnstileWidget = null;

  function siteKey() {
    const fromWindow = typeof window.__ROSALENA_TURNSTILE_KEY__ === 'string' ? window.__ROSALENA_TURNSTILE_KEY__.trim() : '';
    if (fromWindow) return fromWindow;
    // A meta tag is the CSP-safe place for a key: an inline script assignment is blocked
    // by the site's own script-src. The window global stays the documented override.
    const meta = document.querySelector('meta[name="rosalena-turnstile-key"]');
    return meta && typeof meta.content === 'string' ? meta.content.trim() : '';
  }

  function loadTurnstileScript() {
    if (turnstileScript) return turnstileScript;
    const key = siteKey();
    if (!key) return Promise.resolve(false);
    turnstileScript = new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      script.onload = () => resolve(true);
      script.onerror = () => {
        turnstileScript = null;
        resolve(false);
      };
      document.head.append(script);
    });
    return turnstileScript;
  }

  async function prepareTurnstile() {
    const key = siteKey();
    if (!key) {
      flashHint(L().hintNoKey);
      return false;
    }
    const loaded = await loadTurnstileScript();
    if (!loaded || !window.turnstile || typeof window.turnstile.render !== 'function') {
      flashHint(L().hintCheckLoad);
      return false;
    }

    els.check.hidden = false;
    if (turnstileWidget) {
      try {
        window.turnstile.reset(turnstileWidget);
      } catch {
        // A stale widget can be re-rendered below.
      }
      return true;
    }

    turnstileWidget = window.turnstile.render(els.turnstile, {
      sitekey: key,
      theme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
      callback: (token) => {
        state.turnstileToken = typeof token === 'string' ? token : '';
        els.check.hidden = true;
        const pending = state.pendingRetry;
        state.pendingRetry = '';
        if (pending) retry(pending);
      },
      'error-callback': () => {
        flashHint(L().hintCheckError);
      },
      'expired-callback': () => {
        state.turnstileToken = '';
      },
    });
    return true;
  }

  // -------------------------------------------------------------- composer

  function autosize() {
    if (!els.input) return;
    els.input.style.height = 'auto';
    els.input.style.height = `${Math.min(els.input.scrollHeight, 200)}px`;
  }

  function updateComposer() {
    const view = composerState(els.input.value, CHAR_CAP);
    els.count.textContent = view.over ? L().overBy(view.count, CHAR_CAP, view.count - CHAR_CAP) : `${view.count} / ${CHAR_CAP}`;
    els.count.classList.toggle('rt-count--over', view.over);
    els.input.classList.toggle('rt-input--over', view.over);
    els.send.disabled = state.busy || !view.canSend;
    els.input.setAttribute('aria-invalid', view.over ? 'true' : 'false');
    return view;
  }

  function setBusy(busy) {
    state.busy = busy;
    els.stop.hidden = !busy;
    els.log.setAttribute('aria-busy', busy ? 'true' : 'false');
    if (busy) {
      els.send.disabled = true;
    } else {
      updateComposer();
    }
  }

  function setComposer(text) {
    els.input.value = text;
    autosize();
    updateComposer();
    els.input.focus();
    els.input.setSelectionRange(text.length, text.length);
  }

  function clearComposer() {
    els.input.value = '';
    autosize();
    updateComposer();
  }

  // ------------------------------------------------------------------ send

  function apiHistory() {
    const turns = state.turns
      .filter((turn) => (turn.role === 'user' || turn.role === 'assistant') && turn.content.trim())
      .map((turn) => ({ role: turn.role, content: turn.content }));
    return trimHistory(turns, REQUEST_BYTES).map(({ role, content }) => ({ role, content }));
  }

  /**
   * The hosted free model. Same frame contract as the bridge (`{delta}`, `{error,kind}`,
   * `[DONE]`), so one decoder reads both and the answer bubble cannot tell them apart —
   * only the header does, which is the point.
   */
  function postTrial(message, history, signal) {
    const body = { message, history: history.slice(-12) };
    if (state.turnstileToken) body.turnstileToken = state.turnstileToken;
    return fetch('/api/trial', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal,
    });
  }

  async function send(raw) {
    if (state.busy) return;
    const message = String(raw ?? '').trim();
    const view = composerState(message, CHAR_CAP);
    if (!view.canSend) return;

    const history = apiHistory();

    state.busy = true;
    setBusy(true);

    const userTurn = pushTurn({ id: nextId(), role: 'user', content: message });
    clearComposer();

    const turn = pushTurn({ id: nextId(), role: 'assistant', content: '', streaming: true, sample: state.demo });
    turn.sentMessage = message;
    state.abort = new AbortController();

    try {
      if (provider === 'none') {
        removeTurn(turn);
        addNotice({
          text: L().noticeNothing,
          tone: 'warn',
          actions: [actionLink(L().actionGpu, sitePath('/#try')), actionLink(L().actionCheck, sitePath('/check/'))],
        });
        return;
      }

      let response;
      if (provider === 'hosted') {
        response = await postTrial(message, history, state.abort.signal);
      } else {
        const token = pairTokenNow();
        if (!token) {
          removeTurn(turn);
          addNotice({
            text: L().notPaired,
            tone: 'bad',
          });
          return;
        }

        response = await fetch(bridgeChatUrl(), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            'x-rosalena-pair': token,
          },
          body: JSON.stringify({ messages: bridgeMessages(history, message), max_tokens: 400 }),
          signal: state.abort.signal,
        });
      }

      if (!response.ok) {
        // In demo mode the API was already missing when the quota failed to load, so a
        // non-200 here is the static host answering, not a considered refusal. Showing the
        // scripted sample (still tagged "sample") is more useful than relaying its 404 body.
        if (state.demo) {
          await sampleFallback(turn, message);
        } else {
          const body = await readJson(response);
          // Two shapes arrive here: the page's own {error: "text"} and the app's
          // {error: {message, kind}}. Both are refusals worth reading out loud.
          const said =
            body && body.error
              ? typeof body.error === 'string'
                ? body.error
                : body.error.message
              : '';
          if (said && String(said).trim()) {
            refuse({ error: String(said), kind: (body.error && body.error.kind) || body.kind }, message, turn);
          } else {
            throw new Error(L().appHttp(response.status));
          }
        }
      } else {
        const result = await pumpResponse(response, turn);
        if (result.failed) {
          if (turn.content) finishTurn(turn);
          else removeTurn(turn);
        } else {
          if (!result.ended) {
            addNotice({
              text: L().streamClosed,
              tone: 'warn',
            });
          }
          finishTurn(turn);
        }
      }
    } catch (error) {
      if (isAbort(error)) {
        finishTurn(turn, { stopped: true });
      } else if (state.demo) {
        await sampleFallback(turn, message);
      } else {
        failTurn(turn, L().nothingSent(error && error.message ? error.message : L().unreachable));
      }
    } finally {
      state.busy = false;
      state.abort = null;
      // A human-check token is single use; keeping it would make the next message fail
      // with a confusing "check again" instead of simply asking for a fresh one.
      if (provider === 'hosted') state.turnstileToken = '';
      setBusy(false);
      updateComposer();
      saveSession();
    }
  }

  async function sampleFallback(turn, message) {
    try {
      if (sampleRemaining() <= 0) {
        refuse({ error: L().sampleSpent, kind: 'quota' }, message, turn);
        return;
      }
      await runSampleStream(turn);
      bumpSampleQuota();
      finishTurn(turn);
    } catch (error) {
      if (isAbort(error)) finishTurn(turn, { stopped: true });
      else failTurn(turn, L().sampleFailed);
    }
  }

  function stopStream() {
    if (!state.busy || !state.abort) return;
    state.abort.abort();
    say(L().stoppedKept);
  }

  // ---------------------------------------------------------------- events

  function onKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!els.send.disabled) els.form.requestSubmit();
      return;
    }
    if (event.key === 'Escape' && state.busy) {
      event.preventDefault();
      stopStream();
    }
  }

  function onPaste(event) {
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    const pasted = clipboard.getData('text');
    if (!pasted) return;

    const start = els.input.selectionStart ?? els.input.value.length;
    const end = els.input.selectionEnd ?? start;
    const next = `${els.input.value.slice(0, start)}${pasted}${els.input.value.slice(end)}`;
    const clamped = clampToCap(next, CHAR_CAP);
    if (!clamped.truncated) return; // a normal paste is left to the browser

    event.preventDefault();
    els.input.value = clamped.text;
    const caret = clamped.text.length;
    els.input.setSelectionRange(caret, caret);
    autosize();
    updateComposer();
    flashHint(L().pasteTrimmed(CHAR_CAP));
    say(L().pasteTrimmedSay(CHAR_CAP));
  }

  els.form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = els.input.value;
    const view = composerState(value, CHAR_CAP);
    if (!view.canSend || state.busy) {
      flashHint(view.over ? L().overLimit : L().typeFirst);
      return;
    }
    void send(value);
  });

  els.input.addEventListener('input', () => {
    autosize();
    updateComposer();
  });
  els.input.addEventListener('keydown', onKeyDown);
  els.input.addEventListener('paste', onPaste);
  els.stop.addEventListener('click', stopStream);
  els.theme.addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  });

  els.starters.addEventListener('click', (event) => {
    const button = event.target.closest('[data-prompt]');
    if (!button) return;
    setComposer(button.dataset.prompt || '');
  });

  els.log.addEventListener('click', (event) => {
    const button = event.target.closest('[data-copy]');
    if (!button) return;
    const turn = state.turns.find((item) => item.id === button.dataset.copy);
    if (!turn) return;
    void copyAnswer(turn.content).then((copied) => {
      button.textContent = copied ? L().copied : L().copyFailed;
      button.classList.toggle('rt-copy--done', copied);
      say(copied ? L().copiedSay : L().copyFailedSay);
      window.setTimeout(() => {
        button.textContent = L().copy;
        button.classList.remove('rt-copy--done');
      }, 2000);
    });
  });

  // ------------------------------------------------------------------ init

  loadTheme();

  const saved = loadSession();
  for (const stored of saved) {
    state.turns.push({
      id: nextId(),
      role: stored.role,
      content: stored.content,
      stopped: Boolean(stored.stopped),
      sample: Boolean(stored.sample),
      ...(typeof stored.model === 'string' && stored.model ? { model: stored.model } : {}),
    });
  }
  for (const turn of state.turns) els.log.append(buildTurn(turn));
  els.welcome.hidden = state.turns.length > 0;
  if (state.turns.length) scrollToEnd(true);

  autosize();
  updateComposer();
  els.input.focus({ preventScroll: true });

  void loadProvider();

  // The sample note is revealed by the quota render, and only when the sample is in use.
  els.demoNote.hidden = true;
}

if (typeof document !== 'undefined') boot();
