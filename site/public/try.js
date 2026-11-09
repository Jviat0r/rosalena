// "Try it in your browser": a small open model running on the visitor's own GPU through WebGPU (WebLLM).
// Nothing typed here leaves the browser; the weights download once from Hugging Face into the browser cache.
const WEBLLM = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.85/+esm';

// The page language comes from <html lang>: /es/ (built by site/tools/build-i18n.mjs) loads this
// same file, so every sentence it writes is in this table, English first.
const ES = /^es\b/i.test(document.documentElement.getAttribute('lang') || '');
export const TEXT = {
  en: {
    tiny: 'tiny, quickest to load', better: 'better answers', code: 'code', biggest: 'biggest here',
    about: (size) => `about ${size}`,
    noWebGpu: 'Your browser does not have WebGPU, so it cannot run a model locally. Try Chrome or Edge on a computer with a graphics card.',
    gpuOff: 'WebGPU is turned off or your graphics card is not supported here. Try Chrome or Edge on a desktop.',
    loadingLib: 'Loading WebLLM…',
    loading: 'Loading…',
    running: (name) => `${name} is running on your device. Ask it something.`,
    askPlaceholder: 'Ask something…',
    loaded: 'Model loaded. Answers are generated on your own graphics card.',
    loadFailed: (why) => `Could not load the model: ${why}. A smaller model may fit.`,
    switchModel: 'Switch model',
    wentWrong: (why) => `Something went wrong: ${why}`,
    system: 'You are a small open-source AI model running locally in the user\'s web browser, on their own device, as a demo on the Rosalena Harness website. Answer briefly and plainly. If you are not sure, say so instead of guessing.',
  },
  es: {
    tiny: 'diminuto, el que carga más rápido', better: 'mejores respuestas', code: 'código', biggest: 'el más grande aquí',
    about: (size) => `unos ${size}`,
    noWebGpu: 'Tu navegador no tiene WebGPU, así que no puede correr un modelo localmente. Prueba con Chrome o Edge en una computadora con tarjeta gráfica.',
    gpuOff: 'WebGPU está desactivado o tu tarjeta gráfica no es compatible aquí. Prueba con Chrome o Edge en una computadora de escritorio.',
    loadingLib: 'Cargando WebLLM…',
    loading: 'Cargando…',
    running: (name) => `${name} está corriendo en tu dispositivo. Pregúntale algo.`,
    askPlaceholder: 'Pregunta algo…',
    loaded: 'Modelo cargado. Las respuestas se generan en tu propia tarjeta gráfica.',
    loadFailed: (why) => `No se pudo cargar el modelo: ${why}. Puede que quepa un modelo más pequeño.`,
    switchModel: 'Cambiar de modelo',
    wentWrong: (why) => `Algo salió mal: ${why}`,
    system: 'Eres un modelo de IA de código abierto pequeño que corre localmente en el navegador del usuario, en su propio dispositivo, como demo en el sitio de Rosalena Harness. Responde en español, breve y claro. Si no estás seguro, dilo en lugar de adivinar.',
  },
};
const T = ES ? TEXT.es : TEXT.en;

// Small models that fit a normal laptop or desktop GPU, smallest first. Ids exist in WebLLM 0.2.85's prebuilt list.
const MODELS = [
  { id: 'SmolLM2-360M-Instruct-q4f16_1-MLC', label: `SmolLM2 360M (${T.tiny})` },
  { id: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', label: 'Qwen2.5 0.5B' },
  { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 1B' },
  { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', label: `Qwen2.5 1.5B (${T.better})` },
  { id: 'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC', label: `Qwen2.5 Coder 1.5B (${T.code})` },
  { id: 'gemma-2-2b-it-q4f16_1-MLC', label: `Gemma 2 2B (${T.biggest})` },
];
const SYSTEM = T.system;

const $ = (id) => document.getElementById(id);
const select = $('model'), loadBtn = $('load'), status = $('status'), bar = $('progress'), chat = $('chat');
const form = $('composer'), prompt = $('prompt'), send = $('send'), stop = $('stop');

let webllm = null;
let engine = null;
let loadedId = null;
let busy = false;
let f16 = true;
const history = [{ role: 'system', content: SYSTEM }];

const say = (text, error = false) => { status.textContent = text; status.classList.toggle('error', error); };
const add = (role, text) => {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div;
};
const variant = (id) => (f16 ? id : id.replace('q4f16_1', 'q4f32_1'));

function fillModels(sizes = {}) {
  select.innerHTML = '';
  for (const m of MODELS) {
    const o = document.createElement('option');
    o.value = m.id;
    const mb = sizes[variant(m.id)];
    o.textContent = mb ? `${m.label} · ${T.about(mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`)}` : m.label;
    select.appendChild(o);
  }
}
fillModels();

async function checkGpu() {
  if (!('gpu' in navigator)) {
    say(T.noWebGpu, true);
    loadBtn.disabled = true;
    return false;
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('no adapter');
    f16 = adapter.features.has('shader-f16');
    return true;
  } catch {
    say(T.gpuOff, true);
    loadBtn.disabled = true;
    return false;
  }
}

async function lib() {
  if (webllm) return webllm;
  say(T.loadingLib);
  webllm = await import(WEBLLM);
  const sizes = {};
  for (const m of webllm.prebuiltAppConfig.model_list) if (m.vram_required_MB) sizes[m.model_id] = m.vram_required_MB;
  const keep = select.value;
  fillModels(sizes);
  select.value = keep;
  return webllm;
}

async function load() {
  if (busy) return;
  if (!(await checkGpu())) return;
  busy = true;
  loadBtn.disabled = true;
  select.disabled = true;
  bar.style.display = 'block';
  bar.firstElementChild.style.width = '0%';
  const id = variant(select.value);
  try {
    const w = await lib();
    const onProgress = (p) => {
      bar.firstElementChild.style.width = `${Math.round((p.progress ?? 0) * 100)}%`;
      say(p.text || T.loading);
    };
    if (engine) { engine.setInitProgressCallback?.(onProgress); await engine.reload(id); }
    else engine = await w.CreateMLCEngine(id, { initProgressCallback: onProgress });
    loadedId = id;
    say(T.running(select.options[select.selectedIndex].text.split(' · ')[0]));
    prompt.disabled = false;
    send.disabled = false;
    prompt.placeholder = T.askPlaceholder;
    prompt.focus();
    history.length = 1;
    add('note', T.loaded);
  } catch (e) {
    say(T.loadFailed(String(e?.message ?? e).slice(0, 220)), true);
  } finally {
    busy = false;
    loadBtn.disabled = false;
    select.disabled = false;
    loadBtn.textContent = T.switchModel;
    setTimeout(() => { bar.style.display = 'none'; }, 600);
  }
}

async function ask(text) {
  if (!engine || busy || !text.trim()) return;
  busy = true;
  send.disabled = true;
  stop.hidden = false;
  add('user', text);
  history.push({ role: 'user', content: text });
  const out = add('bot', '…');
  let reply = '';
  try {
    const chunks = await engine.chat.completions.create({ messages: history.slice(-12), stream: true, temperature: 0.7, max_tokens: 512 });
    for await (const c of chunks) {
      reply += c.choices[0]?.delta?.content ?? '';
      out.textContent = reply || '…';
      chat.scrollTop = chat.scrollHeight;
    }
    history.push({ role: 'assistant', content: reply });
  } catch (e) {
    out.textContent = T.wentWrong(String(e?.message ?? e).slice(0, 200));
  } finally {
    busy = false;
    send.disabled = false;
    stop.hidden = true;
    prompt.focus();
  }
}

loadBtn.addEventListener('click', () => void load());
form.addEventListener('submit', (e) => { e.preventDefault(); const t = prompt.value; prompt.value = ''; void ask(t); });
prompt.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
stop.addEventListener('click', () => { try { engine?.interruptGenerate(); } catch { /* nothing running */ } });
void checkGpu();
