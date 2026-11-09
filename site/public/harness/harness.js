/**
 * The Harness window on the web.
 *
 * Two things live here and they are deliberately separate: the window's own behaviour
 * (dock toggle, tabs, the session list, the caret) and one client for `/api/trial`, which
 * is the same free window /try/ uses. Nothing in this file pretends the page can read a
 * folder, run a tool or reach another app: it can send a message and stream an answer, and
 * the copy in index.html says so.
 *
 * The SSE frames are `{delta}`, `{error, kind}`, `{end, usage, quota}` and `{done}`, the
 * contract `functions/api/_lib/trial.mjs` writes.
 */

const els = {
  window: document.getElementById('hz-window'),
  dock: document.getElementById('hz-dock'),
  menu: document.getElementById('hz-menu'),
  newChat: document.getElementById('hz-new'),
  sessions: document.getElementById('hz-sessions'),
  dockCount: document.getElementById('hz-dock-count'),
  log: document.getElementById('hz-log'),
  hero: document.getElementById('hz-hero'),
  form: document.getElementById('hz-form'),
  input: document.getElementById('hz-input'),
  send: document.getElementById('hz-send'),
  count: document.getElementById('hz-count'),
  fine: document.getElementById('hz-fine'),
  tree: document.getElementById('hz-tree'),
  outline: document.getElementById('hz-outline'),
  treeCounts: document.getElementById('hz-tree-counts'),
  treeFoot: document.getElementById('hz-tree-foot'),
  tabChat: document.getElementById('hz-tab-chat'),
  tabTree: document.getElementById('hz-tab-tree'),
  model: document.getElementById('hz-model'),
  status: document.getElementById('hz-status'),
};

const MAX = Number(els.input?.getAttribute('maxlength')) || 1200;

// ------------------------------------------------------------------ language
//
// The page language comes from <html lang>: /es/harness/ (built by site/tools/build-i18n.mjs)
// loads this same file. The English sentences stay where they always were in the code below;
// on the Spanish page tr() swaps each one for its entry here, and the sentences built from
// numbers have their own pair in SAY. A sentence missing from ES shows in English.
const ES = /^es\b/i.test(document.documentElement.getAttribute('lang') || '');
export const STRINGS_ES = {
  'Stop the answer': 'Detener la respuesta',
  'Send the message': 'Enviar el mensaje',
  'Open the chats panel': 'Abrir el panel de chats',
  'Close the chats panel': 'Cerrar el panel de chats',
  'Chats panel closed.': 'Panel de chats cerrado.',
  'Chats panel open.': 'Panel de chats abierto.',
  'This page': 'Esta página',
  'Release note for 0.1.0': 'Nota de versión de la 0.1.0',
  'The two notes that disagree': 'Las dos notas que no coinciden',
  'The map error, explained': 'El error de map, explicado',
  'The chat you are in': 'El chat en el que estás',
  'A sample entry: the app keeps your own chats, this page keeps none': 'Una entrada de muestra: la app guarda tus propios chats, esta página no guarda ninguno',
  You: 'Tú',
  'no tasks yet': 'todavía no hay tareas',
  'none running': 'ninguna en curso',
  "In the app this tab is every run it has made, indented by what spawned it. These rows are this page's own turn, drawn the same way.":
    'En la app, esta pestaña muestra cada ejecución que ha hecho, con sangría según lo que la inició. Estas filas son el turno de esta página, dibujadas igual.',
  'In the app this tab is every run it has made, indented by what spawned it.':
    'En la app, esta pestaña muestra cada ejecución que ha hecho, con sangría según lo que la inició.',
  'Ask the free window': 'Preguntarle al cupo gratis',
  'Stream the answer': 'Recibir la respuesta',
  'Asking the free window.': 'Preguntándole al cupo gratis.',
  'nothing found': 'no encontró nada',
  'Reading the results.': 'Leyendo los resultados.',
  'The search found nothing, so the model answers from what it knows.': 'La búsqueda no encontró nada, así que el modelo responde con lo que sabe.',
  'the free window refused the message': 'el cupo gratis rechazó el mensaje',
  'The free window sent an empty answer. Sending again usually works.': 'El cupo gratis mandó una respuesta vacía. Volver a enviar suele funcionar.',
  'Stopped. Nothing was kept.': 'Detenido. No se guardó nada.',
  'Try it on your own machine instead.': 'Mejor pruébalo en tu propia máquina.',
  'Stopped.': 'Detenido.',
  'The free window did not answer.': 'El cupo gratis no respondió.',
  'free window': 'cupo gratis',
  'free window, used up': 'cupo gratis, agotado',
  'New chat. This page keeps one, and keeps it in memory only.': 'Chat nuevo. Esta página guarda uno, y solo en memoria.',
  'unknown error': 'error desconocido',
};
const tr = (text) => (ES && STRINGS_ES[text]) || text;
/** A site path in the page language: '/try/' or '/es/try/'. */
const sitePath = (path) => (ES ? `/es${path}` : path);
export const SAY_ES = {
  tooLong: (n, max) => `Ese mensaje tiene ${n} caracteres; el cuadro acepta ${max}.`,
  counts: (done, running, failed) => `${done} listas · ${running ? `${running} en curso` : 'ninguna en curso'}${failed ? ` · ${failed} fallidas` : ''}`,
  search: (query) => `Buscar en la web: ${query}`,
  searching: (query) => `Buscando en la web "${query}".`,
  results: (found) => `${found} resultados`,
  tokensOut: (n) => `${n} tokens de salida`,
  notAnswering: (reason) => `El cupo gratis no está respondiendo: ${reason}. La app en tu propia máquina no depende de ningún cupo, así que sigue funcionando cuando esto no.`,
  answered: (status) => `el cupo gratis respondió ${status}`,
  spent: (used, limit) => `Esta dirección ya usó ${used} de ${limit} tokens del día. `,
  fine: (left, limit, tokensLine) => `Cupo gratis: quedan ${left} de ${limit} mensajes hoy en este navegador, sin cuenta y sin clave. ${tokensLine}La app no tiene ese límite, porque en la app responde la máquina que tienes enfrente.`,
};

const state = {
  /** [{role: 'user'|'assistant', content}] in the shape the endpoint validates. */
  history: [],
  busy: false,
  abort: null,
  /** The rows this page's turns produced, drawn as the app draws a task tree. */
  tasks: [],
};

// ------------------------------------------------------------------ small helpers

function status(text) {
  if (els.status) els.status.textContent = text;
}

function scrollLog() {
  if (els.log) els.log.scrollTop = els.log.scrollHeight;
}

function autosize() {
  if (!els.input) return;
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 148)}px`;
}

function paintCount() {
  if (els.count && els.input) els.count.textContent = `${els.input.value.length} / ${MAX}`;
}

function setBusy(busy) {
  state.busy = busy;
  if (!els.send) return;
  els.send.dataset.busy = busy ? 'true' : 'false';
  els.send.setAttribute('aria-label', tr(busy ? 'Stop the answer' : 'Send the message'));
}

/** The dock: one control, two layouts, and it says which one it is in. */
function paintMenu() {
  if (!els.menu || !els.dock) return;
  const closed = els.dock.dataset.closed === 'true';
  els.menu.setAttribute('aria-expanded', closed ? 'false' : 'true');
  els.menu.title = closed ? 'Open the chats panel' : 'Close the chats panel';
  if (ES) els.menu.title = tr(els.menu.title);
}

function toggleDock() {
  if (!els.dock) return;
  els.dock.dataset.closed = els.dock.dataset.closed === 'true' ? 'false' : 'true';
  paintMenu();
  status(tr(els.dock.dataset.closed === 'true' ? 'Chats panel closed.' : 'Chats panel open.'));
}

/** Chat and Tasks are panels of one window, so switching is show/hide, not a reload. */
function showTab(which) {
  const chat = which !== 'tree';
  if (els.tabChat) els.tabChat.setAttribute('aria-selected', chat ? 'true' : 'false');
  if (els.tabTree) els.tabTree.setAttribute('aria-selected', chat ? 'false' : 'true');
  if (els.log) els.log.hidden = !chat;
  if (els.tree) els.tree.hidden = chat;
  if (els.form) els.form.hidden = !chat;
  if (chat) scrollLog();
}

// ------------------------------------------------------------------ transcript

const SESSIONS = [
  { id: 'this', label: 'This page', status: 'running', live: true },
  { id: 'release', label: 'Release note for 0.1.0', status: 'ok' },
  { id: 'folder', label: 'The two notes that disagree', status: 'ok' },
  { id: 'trace', label: 'The map error, explained', status: 'failed' },
];

function paintSessions() {
  if (!els.sessions) return;
  els.sessions.textContent = '';
  for (const session of SESSIONS) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'hz-session';
    button.dataset.status = session.status;
    if (session.live) button.setAttribute('aria-current', 'true');
    button.disabled = !session.live;
    button.title = tr(session.live
      ? 'The chat you are in'
      : 'A sample entry: the app keeps your own chats, this page keeps none');

    const dot = document.createElement('span');
    dot.className = 'hz-session__dot';
    dot.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'hz-session__label';
    label.textContent = tr(session.label);

    button.append(dot, label);
    li.append(button);
    els.sessions.append(li);
  }
  if (els.dockCount) els.dockCount.textContent = String(SESSIONS.length);
}

function clearTranscript() {
  state.history = [];
  state.tasks = [];
  if (els.log) {
    els.log.textContent = '';
    if (els.hero) els.log.append(els.hero);
    els.hero.hidden = false;
  }
  paintTasks();
}

function addTurn(role) {
  if (els.hero) els.hero.hidden = true;
  const turn = document.createElement('div');
  turn.className = `hz-turn hz-turn--${role === 'user' ? 'user' : 'bot'}`;

  const who = document.createElement('div');
  who.className = 'hz-turn__who';
  who.textContent = role === 'user' ? tr('You') : 'Rosalena Harness';

  const body = document.createElement('div');
  body.className = 'hz-turn__body hz-turn__body--text';
  body.textContent = '';

  turn.append(who, body);
  els.log?.append(turn);
  scrollLog();
  return body;
}

function addMeta(body, text) {
  const turn = body.closest('.hz-turn');
  if (!turn) return;
  let meta = turn.querySelector('.hz-turn__meta');
  if (!meta) {
    meta = document.createElement('p');
    meta.className = 'hz-turn__meta';
    turn.append(meta);
  }
  meta.textContent = text;
}

function addNote(body, text, link = null) {
  const turn = body.closest('.hz-turn');
  if (!turn) return;
  const note = document.createElement('p');
  note.className = 'hz-turn__note';
  note.textContent = text;
  if (link) {
    const a = document.createElement('a');
    a.href = link.href;
    a.textContent = link.text;
    note.append(' ', a);
  }
  turn.append(note);
}

// ------------------------------------------------------------------ the task outline

function paintTasks() {
  if (!els.outline) return;
  els.outline.textContent = '';
  for (const task of state.tasks) {
    const row = document.createElement('li');
    row.className = 'hz-row-task';
    row.dataset.depth = String(Math.min(task.depth || 0, 3));
    row.dataset.status = task.status || 'idle';

    const dot = document.createElement('span');
    dot.className = 'hz-row-task__dot';
    dot.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'hz-row-task__label';
    label.textContent = task.label;
    row.append(dot, label);

    if (task.meta) {
      const meta = document.createElement('span');
      meta.className = 'hz-row-task__meta';
      meta.textContent = task.meta;
      row.append(meta);
    }
    els.outline.append(row);
  }

  const running = state.tasks.filter((t) => t.status === 'running').length;
  const done = state.tasks.filter((t) => t.status === 'ok').length;
  const failed = state.tasks.filter((t) => t.status === 'failed').length;
  if (els.treeCounts) {
    els.treeCounts.textContent = state.tasks.length
      ? ES
        ? SAY_ES.counts(done, running, failed)
        : `${done} done · ${running ? `${running} running` : 'none running'}${failed ? ` · ${failed} failed` : ''}`
      : tr('no tasks yet');
  }
  if (els.treeFoot) {
    els.treeFoot.textContent = tr(state.tasks.length
      ? 'In the app this tab is every run it has made, indented by what spawned it. These rows are this page\'s own turn, drawn the same way.'
      : 'In the app this tab is every run it has made, indented by what spawned it.');
  }
}

function addTask(label, depth = 0, status = 'idle', meta = '') {
  const task = { label, depth, status, meta };
  state.tasks.push(task);
  paintTasks();
  return task;
}

// ------------------------------------------------------------------ the free window

/** The `data:` frames of an SSE stream, as objects. Mirrors the parser in /try/. */
async function* frames(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let split = buffer.indexOf('\n\n');
    while (split !== -1) {
      const chunk = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw) continue;
        try {
          yield JSON.parse(raw);
        } catch {
          // A frame that is not JSON is a bug on the server; dropping it is better than
          // leaving the caret blinking forever, and `done` still arrives.
        }
      }
      split = buffer.indexOf('\n\n');
    }
  }
}

async function ask(message) {
  const body = { message, history: state.history.slice(-12) };
  const response = await fetch('/api/trial', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal: state.abort.signal,
  });

  if (!response.ok && response.headers.get('content-type')?.includes('application/json')) {
    const payload = await response.json().catch(() => ({}));
    // The endpoint sends `{error: "sentence", kind}`; a nested `{error: {message}}` is read too.
    const detail = (typeof payload?.error === 'string' && payload.error) || payload?.error?.message || payload?.message || (ES ? SAY_ES.answered(response.status) : `the free window answered ${response.status}`);
    throw new Error(detail);
  }
  if (!response.ok) throw new Error(ES ? SAY_ES.answered(response.status) : `the free window answered ${response.status}`);

  return frames(response);
}

/**
 * The finished answer with its web addresses as links (a searched answer ends with its
 * sources). Built from text nodes and anchors, never innerHTML: the answer is a model's
 * words and the addresses came from a search engine.
 */
function paintLinks(el, text) {
  const parts = text.split(/(https?:\/\/[^\s<>"'`]+)/g);
  if (parts.length === 1) return;
  el.textContent = '';
  for (let i = 0; i < parts.length; i += 1) {
    if (i % 2 === 0) {
      if (parts[i]) el.append(parts[i]);
      continue;
    }
    const trail = /[).,;:!?\]]+$/.exec(parts[i])?.[0] ?? '';
    const href = trail ? parts[i].slice(0, -trail.length) : parts[i];
    const link = document.createElement('a');
    link.href = href;
    link.textContent = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer nofollow';
    el.append(link);
    if (trail) el.append(trail);
  }
}

async function submit(text) {
  const message = text.trim();
  if (!message || state.busy) return;

  if (message.length > MAX) {
    status(ES ? SAY_ES.tooLong(message.length, MAX) : `That message is ${message.length} characters; the box takes ${MAX}.`);
    return;
  }

  showTab('chat');
  const userBody = addTurn('user');
  userBody.textContent = message;
  els.input.value = '';
  autosize();
  paintCount();

  state.tasks = [];
  const turnRow = addTask(message.length > 68 ? `${message.slice(0, 68)}…` : message, 0, 'running');
  const sendRow = addTask(tr('Ask the free window'), 1, 'idle');
  const readRow = addTask(tr('Stream the answer'), 1, 'idle');

  const body = addTurn('assistant');
  const caret = document.createElement('span');
  caret.className = 'hz-caret';
  caret.setAttribute('aria-hidden', 'true');
  body.append(caret);

  state.abort = new AbortController();
  setBusy(true);
  status(tr('Asking the free window.'));

  let answer = '';
  let usage = null;

  try {
    sendRow.status = 'running';
    paintTasks();
    const stream = await ask(message);
    sendRow.status = 'ok';
    readRow.status = 'running';
    paintTasks();

    let searchRow = null;
    for await (const frame of stream) {
      if (typeof frame.delta === 'string') {
        answer += frame.delta;
        body.textContent = answer;
        body.append(caret);
        scrollLog();
      } else if (frame.tool) {
        // The free window's one tool: a web search the model asked for. It runs on the
        // server, so all the page can do is say what is happening and what came back.
        const query = String(frame.tool.query || '');
        if (frame.tool.status === 'running') {
          const shown = query.length > 56 ? `${query.slice(0, 56)}…` : query;
          searchRow = addTask(ES ? SAY_ES.search(shown) : `Search the web: ${shown}`, 1, 'running');
          status(ES ? SAY_ES.searching(query) : `Searching the web for "${query}".`);
        } else if (searchRow) {
          const found = Array.isArray(frame.tool.results) ? frame.tool.results.length : 0;
          searchRow.status = frame.tool.status === 'done' ? 'ok' : 'failed';
          searchRow.meta = found ? (ES ? SAY_ES.results(found) : `${found} results`) : tr('nothing found');
          paintTasks();
          status(tr(found ? 'Reading the results.' : 'The search found nothing, so the model answers from what it knows.'));
        }
      } else if (frame.error) {
        throw new Error(typeof frame.error === 'string' ? frame.error : tr('the free window refused the message'));
      } else if (frame.end || frame.done) {
        // Two ways to say the same thing: the hosted window ends with `{done, usage}` and a
        // stream that stops early ends with `{end}`. Both mean the turn is over, and a row
        // left on "running" after the answer arrived is the page telling a lie about itself.
        usage = frame.usage || usage;
        readRow.status = 'ok';
        turnRow.status = 'ok';
        paintTasks();
        if (frame.done) break;
      }
    }

    if (answer) {
      readRow.status = 'ok';
      turnRow.status = 'ok';
      paintTasks();
      paintLinks(body, answer);
    }

    if (!answer) addNote(body, tr('The free window sent an empty answer. Sending again usually works.'));
    if (usage && Number.isFinite(usage.output)) addMeta(body, ES ? SAY_ES.tokensOut(usage.output) : `${usage.output} tokens out`);
    if (answer) state.history.push({ role: 'assistant', content: answer });
    // Each answer spends one of the day's messages, so the count under the box is only
    // true if it is read again after the turn.
    void readQuota();
  } catch (error) {
    const stopped = error?.name === 'AbortError';
    for (const row of [sendRow, readRow, turnRow]) {
      if (row.status === 'running' || row.status === 'idle') row.status = stopped ? 'idle' : 'failed';
    }
    paintTasks();
    if (!answer) {
      addNote(
        body,
        stopped
          ? tr('Stopped. Nothing was kept.')
          : ES
            ? SAY_ES.notAnswering((error?.message || tr('unknown error')).replace(/\.+$/, ''))
            : `The free window is not answering: ${(error?.message || 'unknown error').replace(/\.+$/, '')}. The app on your own machine has no such window, so it keeps working when this does not.`,
        // Both hosted models refused, so point at the page that answers from the
        // visitor's own app or graphics card instead.
        stopped ? null : { href: sitePath('/try/'), text: tr('Try it on your own machine instead.') },
      );
    }
    status(tr(stopped ? 'Stopped.' : 'The free window did not answer.'));
  } finally {
    caret.remove();
    const turn = body.closest('.hz-turn');
    if (!answer && !body.textContent.trim() && !turn?.querySelector('.hz-turn__note')) {
      // A turn with no text at all would leave a labelled box with nothing in it. A note
      // (the refusal, or "Stopped") sits beside the body, so a turn carrying one stays.
      turn?.remove();
    }
    state.abort = null;
    setBusy(false);
  }
}

// ------------------------------------------------------------------ quota, so the page says what it costs

async function readQuota() {
  try {
    const response = await fetch('/api/quota', { headers: { accept: 'application/json' } });
    if (!response.ok) return;
    const payload = await response.json();
    const window_ = payload?.anonymous;
    if (!window_ || !Number.isFinite(window_.used) || !Number.isFinite(window_.limit)) return;
    const left = Math.max(0, window_.limit - window_.used);
    const meter = payload?.tokens?.address;
    let tokensLine = '';
    if (meter && Number.isFinite(meter.used) && Number.isFinite(meter.limit)) {
      tokensLine = ES
        ? SAY_ES.spent(meter.used.toLocaleString('es-419'), meter.limit.toLocaleString('es-419'))
        : `This address has spent ${meter.used.toLocaleString('en-US')} of ` +
          `${meter.limit.toLocaleString('en-US')} of the day's token allowance. `;
    }
    if (els.fine) {
      els.fine.textContent = ES
        ? SAY_ES.fine(left, window_.limit, tokensLine)
        : `Free window: ${left} of ${window_.limit} messages left today in this browser, no account, no key. ` +
          tokensLine +
          'The app has no such allowance, because in the app the machine in front of you answers.';
    }
    if (els.model) els.model.textContent = tr(left ? 'free window' : 'free window, used up');
  } catch {
    // A page that cannot read the count still works: the message may just be refused, and
    // the refusal is explained where the answer would have been.
  }
}

// ------------------------------------------------------------------ wiring

if (els.menu) els.menu.addEventListener('click', toggleDock);
if (els.newChat) {
  els.newChat.addEventListener('click', () => {
    if (state.busy) return;
    clearTranscript();
    els.input?.focus();
    status(tr('New chat. This page keeps one, and keeps it in memory only.'));
  });
}
if (els.tabChat) els.tabChat.addEventListener('click', () => showTab('chat'));
if (els.tabTree) els.tabTree.addEventListener('click', () => showTab('tree'));

if (els.input) {
  els.input.addEventListener('input', () => {
    autosize();
    paintCount();
  });
  els.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      els.form?.requestSubmit();
    } else if (event.key === 'Escape' && state.busy) {
      event.preventDefault();
      state.abort?.abort();
    }
  });
}

if (els.form) {
  els.form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (state.busy) {
      state.abort?.abort();
      return;
    }
    const text = els.input?.value || '';
    if (!text.trim()) {
      els.input?.focus();
      return;
    }
    void submit(text);
  });
}

if (els.send) {
  els.send.addEventListener('click', (event) => {
    if (!state.busy) return;
    event.preventDefault();
    state.abort?.abort();
  });
}

for (const button of document.querySelectorAll('.hz-suggest')) {
  button.addEventListener('click', () => {
    const prompt = button.getAttribute('data-prompt') || button.textContent || '';
    if (!els.input) return;
    els.input.value = prompt;
    autosize();
    paintCount();
    els.input.focus();
    // Sending on the suggestion's own click is what the app does: the click was the ask.
    els.form?.requestSubmit();
  });
}

window.addEventListener('resize', paintMenu);

// On a phone-width window the dock is a drawer over the transcript, so it starts closed:
// a page whose first paint is a covered prompt box has one job and does it wrong.
if (els.dock && window.matchMedia('(max-width: 820px)').matches) els.dock.dataset.closed = 'true';

paintSessions();
paintMenu();
paintTasks();
paintCount();
autosize();
showTab('chat');
void readQuota();
