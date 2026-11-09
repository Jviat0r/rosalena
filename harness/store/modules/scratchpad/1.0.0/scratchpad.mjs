// The scratchpad module — a single-file module, with no manifest at all.
//
// It exists to prove the store's other shape: a bare `.mjs` file dropped into
// `plugins/` is a plugin whose id is its filename. It is also genuinely useful
// in a long run, because a model that jots a finding down and reads it back
// does not have to keep it in its context window.
//
// The pad lives at module scope on purpose: the host imports a plugin once and
// calls `tools(ctx)` once, so this is per-session state, and the commands below
// can see the same pad the tools write to.

const notes = [];

const render = () => (notes.length ? notes.map((note, i) => `${i + 1}. ${note}`).join("\n") : "(the pad is empty)");

export default {
  id: "scratchpad",
  description: "A per-session notepad the model can write to and read back.",
  tools: () => [
    {
      name: "scratch_write",
      description: "Jot a note down for later in this session, so it does not have to stay in your context window.",
      parameters: { type: "object", properties: { note: { type: "string", description: "The thing to remember." } }, required: ["note"] },
      run: async ({ note } = {}) => {
        const text = String(note ?? "").trim();
        if (!text) throw new Error("nothing to write - pass a non-empty `note`");
        notes.push(text);
        return `noted (${notes.length} on the pad): ${text}`;
      },
    },
    {
      name: "scratch_read",
      description: "Read back everything written to the scratchpad in this session.",
      parameters: { type: "object", properties: {} },
      run: async () => render(),
    },
  ],
  commands: () => ({
    show: () => render(),
    add: (argv = []) => {
      const text = argv.join(" ").trim();
      if (!text) return "usage: /scratchpad add <note>";
      notes.push(text);
      return `noted (${notes.length} on the pad)`;
    },
    clear: () => {
      const had = notes.length;
      notes.length = 0;
      return `cleared ${had} note(s)`;
    },
  }),
  status: () => (notes.length ? `${notes.length} note(s) on the pad` : "pad empty"),
};
