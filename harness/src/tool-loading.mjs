/**
 * Tools on demand.
 *
 * Every tool's JSON schema rides along with every request, and with the full set that is
 * several thousand tokens before the person has typed a word. A question like "what is
 * 5*25" pays all of it and uses none of it, and a small local model given forty tools tends
 * to call one whether the question needs it or not.
 *
 * So in "on-demand" mode the request carries ONE small tool, `load_tools`, whose
 * description lists what else exists, by name and a few words each. The model asks for the
 * tools a task needs; from the next step on their schemas are sent too, and they stay
 * loaded for the rest of the chat. A model that calls a known tool without loading it
 * first is not refused: the harness loads it and runs the call, because a refusal would
 * only cost another round trip to learn the same thing.
 *
 * "all" is the old behaviour, every schema from the first request.
 */

export const TOOL_LOADING_MODES = Object.freeze(["on-demand", "all"]);
export const LOAD_TOOLS = "load_tools";

/** The first sentence of a description, cut to `max` characters: the catalog's one line. */
export function summaryOf(description, max = 90) {
  const text = String(description ?? "").replace(/\s+/g, " ").trim();
  const first = text.match(/^(.+?[.!?])(\s|$)/)?.[1] ?? text;
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

const schemaOf = (name, tool) => ({ type: "function", function: { name, description: tool.description, parameters: tool.parameters } });

/**
 * @param {{ byName: object, mode?: string, always?: string[] }} options
 *   `always` names tools that are never deferred (the harness's own control tools, such as
 *   exit_plan_mode, which a run cannot finish without).
 */
export function createToolLoader({ byName, mode = "all", always = [] }) {
  const onDemand = mode === "on-demand";
  const names = Object.keys(byName);
  const loaded = new Set(onDemand ? always.filter((name) => byName[name]) : names);

  const catalog = () =>
    names
      .filter((name) => !loaded.has(name))
      .map((name) => `${name}: ${summaryOf(byName[name].description)}`)
      .join("\n");

  const loaderSchema = () => ({
    type: "function",
    function: {
      name: LOAD_TOOLS,
      description: [
        "Load tools before using them. Only load what the current request needs; a question you can answer from what you know needs no tools at all.",
        'Pass the tool names, or ["all"] for every tool. Loaded tools stay available for the rest of this chat.',
        "Not loaded yet:",
        catalog() || "(everything is loaded)",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: { names: { type: "array", items: { type: "string" }, description: 'Tool names from the list, or ["all"].' } },
        required: ["names"],
      },
    },
  });

  return {
    mode: onDemand ? "on-demand" : "all",
    /** The schemas the next request carries. */
    schemas() {
      const out = names.filter((name) => loaded.has(name)).map((name) => schemaOf(name, byName[name]));
      if (onDemand && loaded.size < names.length) out.push(loaderSchema());
      return out;
    },
    isLoaded: (name) => loaded.has(name),
    loadedNames: () => names.filter((name) => loaded.has(name)),
    /** Load a tool the model called without asking first. True when it exists. */
    ensure(name) {
      if (!byName[name]) return false;
      loaded.add(name);
      return true;
    },
    /** Handle a load_tools call: returns { text, added, unknown }. */
    load(args) {
      const asked = Array.isArray(args?.names) ? args.names.map((n) => String(n).trim()).filter(Boolean) : [];
      const wanted = asked.some((n) => n.toLowerCase() === "all") ? names : asked;
      const added = [];
      const unknown = [];
      for (const name of wanted) {
        if (!byName[name]) unknown.push(name);
        else if (!loaded.has(name)) {
          loaded.add(name);
          added.push(name);
        }
      }
      const parts = [];
      if (added.length) parts.push(`Loaded: ${added.join(", ")}. Call them directly from now on.`);
      else if (!unknown.length) parts.push(asked.length ? "Those tools were already loaded." : "No tool names were given.");
      if (unknown.length) parts.push(`Not a tool here: ${unknown.join(", ")}. The names that exist are in load_tools' description.`);
      return { text: parts.join(" "), added, unknown };
    },
  };
}
