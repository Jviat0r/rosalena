// The preview page is a drawing of the app, not the app. This script only moves the parts
// that a picture cannot show: the model menu opening, the effort choice moving, the
// inspector rail staying a rail, and your own message appearing in the log with a scripted
// answer underneath it. No fetch, no model, no storage - a reload puts the page back.
//
// Everything it builds goes through textContent, never markup strings, so a message you
// type can never turn into HTML. The page is served under a CSP with script-src 'self',
// which is why this lives in its own file.

// The page language comes from <html lang>: /es/preview/ (built by site/tools/build-i18n.mjs)
// loads this same file, so the words it writes come from this table, English first.
export const TEXT = {
  en: {
    reply: [
      "This is a preview, so I cannot answer that for real yet.",
      "When the hosted window opens, the free cloud models answer here with no account and no key, and the whole shell you are looking at is what you will actually use.",
    ],
    inspectorOpen: "In the app this opens the inspector: graph, files and the chat settings",
    inspectorRail: "The inspector stays a rail until you open it",
    you: "You",
    sample: "sample",
    scripted: "scripted answer, not a model",
  },
  es: {
    reply: [
      "Esto es una vista previa, así que todavía no puedo responderte de verdad.",
      "Cuando abra la ventana alojada, los modelos gratis en la nube van a responder aquí sin cuenta y sin clave, y toda la interfaz que estás viendo es la que vas a usar.",
    ],
    inspectorOpen: "En la app, esto abre el inspector: el grafo, los archivos y la configuración del chat",
    inspectorRail: "El inspector se queda como riel hasta que lo abres",
    you: "Tú",
    sample: "muestra",
    scripted: "respuesta preparada, no de un modelo",
  },
};
const T = /^es\b/i.test(document.documentElement.getAttribute("lang") || "") ? TEXT.es : TEXT.en;

const SAMPLE_REPLY = T.reply;

const app = document.getElementById("pv-app");

function getModelMenu() {
  return {
    button: document.getElementById("pv-model"),
    menu: document.getElementById("pv-model-menu"),
  };
}

function closeMenu({ button, menu }) {
  if (!menu || !button) return;
  menu.hidden = true;
  button.setAttribute("aria-expanded", "false");
}

function wireMenu() {
  const parts = getModelMenu();
  const { button, menu } = parts;
  if (!button || !menu) return;

  button.addEventListener("click", () => {
    const open = menu.hidden;
    menu.hidden = !open;
    button.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) menu.querySelector('[role="menuitemradio"]')?.focus();
  });

  menu.addEventListener("click", (event) => {
    const item = event.target.closest('[role="menuitemradio"]');
    if (!item) return;
    const row = item.parentElement;
    for (const other of row.querySelectorAll('[role="menuitemradio"]')) {
      other.setAttribute("aria-checked", other === item ? "true" : "false");
    }
    closeMenu(parts);
    button.focus();
  });

  document.addEventListener("click", (event) => {
    if (!menu.hidden && !menu.contains(event.target) && !button.contains(event.target)) closeMenu(parts);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) {
      closeMenu(parts);
      button.focus();
    }
  });
}

function wireInspector() {
  const button = document.getElementById("pv-insp-btn");
  if (!button) return;
  // The rail is the collapsed state by design: on a narrow window the app keeps it as a
  // rail rather than hiding the chat column behind nothing. Clicking only says so.
  button.addEventListener("click", () => {
    const open = button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", open ? "true" : "false");
    button.textContent = open ? "\u25C2" : "\u25B8";
    button.title = open
      ? T.inspectorOpen
      : T.inspectorRail;
  });
}

function addMessage(log, who, lines, sample) {
  const wrap = document.createElement("div");
  wrap.className = who === "you" ? "pv-msg pv-msg-you" : "pv-msg pv-msg-bot";

  const label = document.createElement("span");
  label.className = "pv-who";
  label.textContent = who === "you" ? T.you : "Rosalena";
  wrap.append(label);

  const bubble = document.createElement("div");
  bubble.className = "pv-bubble";
  for (const line of lines) {
    const p = document.createElement("p");
    p.textContent = line;
    bubble.append(p);
  }
  wrap.append(bubble);

  if (sample) {
    const tagline = document.createElement("span");
    tagline.className = "pv-tagline";
    const tag = document.createElement("span");
    tag.className = "pv-tag";
    tag.textContent = T.sample;
    tagline.append(tag, document.createTextNode(T.scripted));
    wrap.append(tagline);
  }

  log.append(wrap);
  log.scrollTop = log.scrollHeight;
}

function wireComposer() {
  const form = document.getElementById("pv-composer");
  const input = document.getElementById("pv-prompt");
  const log = document.getElementById("pv-log");
  if (!form || !input || !log) return;

  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (text === "") return;
    addMessage(log, "you", [text], false);
    input.value = "";
    input.style.height = "auto";
    addMessage(log, "bot", SAMPLE_REPLY, true);
  });
}

function wireTabs() {
  const tabs = [...document.querySelectorAll(".pv-tab")];
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      for (const other of tabs) other.setAttribute("aria-selected", other === tab ? "true" : "false");
    });
  }
}

function boot() {
  if (!app) return;
  wireMenu();
  wireInspector();
  wireComposer();
  wireTabs();
}

boot();
