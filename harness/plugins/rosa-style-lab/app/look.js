// Style Lab's "App look" section: the app's own look settings (light or dark, palette,
// accent, text size, density) and which parts of the window show. They used to sit in the
// account popover; here they sit next to the skins, and every change shows at once in the
// app behind. Everything goes through Rosalena.appearance ("appearance" permission).

const $ = (sel) => document.querySelector(sel);
const LABEL = (value) => String(value).charAt(0).toUpperCase() + String(value).slice(1);
const NAMES = {
  theme: { auto: "Auto", dark: "Dark", light: "Light" },
  textSize: { small: "Small", normal: "Normal", large: "Large" },
  density: { comfortable: "Comfortable", compact: "Compact" },
};

let current = null;

function seg(name, values, chosen, labels, onPick) {
  const row = document.createElement("div");
  row.className = "look-row";
  const label = document.createElement("span");
  label.className = "field-label";
  label.textContent = name;
  const group = document.createElement("div");
  group.className = "look-seg";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", name);
  for (const value of values) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "look-opt";
    button.textContent = labels?.[value] ?? LABEL(value);
    button.setAttribute("aria-pressed", String(value === chosen));
    button.addEventListener("click", () => onPick(value));
    group.append(button);
  }
  row.append(label, group);
  return row;
}

function swatchRow(name, values, chosen, paint, title, onPick) {
  const row = document.createElement("div");
  row.className = "look-row";
  const label = document.createElement("span");
  label.className = "field-label";
  label.textContent = name;
  const group = document.createElement("div");
  group.className = "look-swatches";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", name);
  for (const value of values) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "look-swatch";
    button.title = title(value);
    button.setAttribute("aria-label", title(value));
    button.setAttribute("aria-pressed", String(value === chosen));
    button.style.background = paint(value);
    button.addEventListener("click", () => onPick(value));
    group.append(button);
  }
  row.append(label, group);
  return row;
}

// Accent names map to the app's own accent colours; these are close stand-ins for the
// swatch only (the app paints the real one).
const ACCENT_SWATCH = { cyan: "#5fd3e6", violet: "#a78bfa", rose: "#f28bb0", green: "#6fd59a", amber: "#f2c46d" };

function render() {
  const grid = $("#look-grid");
  const switches = $("#look-switches");
  if (!current || !grid || !switches) return;
  const { appearance, show, choices, labels } = current;
  const set = (patch) => void change(patch);
  grid.replaceChildren(
    seg("Theme", choices.themes ?? ["auto", "dark", "light"], appearance.theme, NAMES.theme, (theme) => set({ appearance: { theme } })),
    swatchRow(
      "Palette",
      choices.palettes ?? [],
      appearance.palette,
      (name) => {
        const p = labels?.palettes?.[name];
        return p ? `linear-gradient(135deg, ${p.base} 0 55%, ${p.raised} 55% 100%)` : "#333";
      },
      (name) => `${LABEL(name)} palette`,
      (palette) => set({ appearance: { palette } }),
    ),
    swatchRow(
      "Accent",
      choices.accents ?? [],
      appearance.accent,
      (name) => ACCENT_SWATCH[name] ?? "#888",
      (name) => labels?.accents?.[name] ?? LABEL(name),
      (accent) => set({ appearance: { accent } }),
    ),
    seg("Text size", choices.textSizes ?? [], appearance.textSize, NAMES.textSize, (textSize) => set({ appearance: { textSize } })),
    seg("Density", choices.densities ?? [], appearance.density, NAMES.density, (density) => set({ appearance: { density } })),
  );
  switches.replaceChildren(
    ...Object.entries(labels?.show ?? {}).map(([key, info]) => {
      const row = document.createElement("label");
      row.className = "look-switch";
      const text = document.createElement("span");
      text.className = "look-switch-text";
      const title = document.createElement("strong");
      title.textContent = info.title;
      const help = document.createElement("small");
      help.textContent = info.help;
      text.append(title, help);
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = show?.[key] !== false;
      input.setAttribute("aria-label", info.title);
      input.addEventListener("change", () => set({ show: { [key]: input.checked } }));
      row.append(text, input);
      return row;
    }),
  );
}

async function change(patch) {
  try {
    const result = await Rosalena.appearance.set(patch);
    if (result && !result.verifying) current = result;
    else if (current) {
      // A verify run never changes the window: show the pick anyway so the page stays usable.
      current = { ...current, appearance: { ...current.appearance, ...(patch.appearance ?? {}) }, show: { ...current.show, ...(patch.show ?? {}) } };
    }
    render();
  } catch (err) {
    const status = $("#status");
    if (status) {
      status.textContent = `Could not change that: ${err?.message || err}`;
      status.className = "status err";
    }
  }
}

export const lookReady = (async () => {
  if (!window.Rosalena?.appearance) return false;
  try {
    current = await Rosalena.appearance.get();
  } catch {
    return false; // a host without the settings (or no permission): the section stays hidden
  }
  if (!current?.appearance) return false;
  $("#look-section").hidden = false;
  render();
  return true;
})();

Rosalena.test("the App look section draws the app's settings when the host offers them", async () => {
  const shown = await lookReady;
  if (!shown) {
    Rosalena.assert($("#look-section").hidden, "with no settings from the host the section must stay hidden");
    return;
  }
  Rosalena.assert($("#look-grid").childElementCount >= 4, "the look grid is missing rows");
  const pressed = document.querySelectorAll('#look-grid [aria-pressed="true"]').length;
  Rosalena.assert(pressed >= 4, `expected the current choice marked in each row, found ${pressed}`);
});
