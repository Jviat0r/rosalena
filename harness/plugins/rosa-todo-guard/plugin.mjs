// todo-guard - a task list the model keeps honest.
//
// The failure it exists for: a model writes a plan, then works for thirty steps
// without touching it, so the list freezes at its opening state and a reader
// cannot tell what is actually done. The list is not wrong, it is stale, and
// only the model can fix it.
//
// So this plugin provides the list (todo_write / todo_read) and, when the model
// has run past a threshold without writing back while items are still open,
// appends one reminder before the next step. It is a nudge, never a block: the
// model keeps its own judgement about what is finished.
//
// It also answers "is the task finished?" at the end: a final answer with items
// still open is sent back with the open list (the `beforeFinish` hook), because
// the list is the plan the person approved and an answer is not the end while it
// is unfinished. The engine bounds that (finishRounds), so a model that cannot
// continue still ends, with the list as the record of what is left.
//
// The list is per harness session, not per run - a delegated worker shares its
// parent's list on purpose, so a subagent's progress shows up in the same plan.

const STATUSES = ["pending", "in_progress", "completed"];
const MARK = { pending: "[ ]", in_progress: "[~]", completed: "[x]" };

export function renderList(items) {
  if (!items.length) return "(the list is empty)";
  return items.map((t) => `${MARK[t.status] ?? "[ ]"} ${t.content}`).join("; ");
}

/** Accept only well-formed items: a whole-list replace must not silently lose work. */
export function normalizeTodos(input) {
  const raw = Array.isArray(input) ? input : [];
  const items = [];
  const dropped = [];
  for (const entry of raw.slice(0, 50)) {
    const content = String(entry?.content ?? entry ?? "").trim().slice(0, 200);
    if (!content) {
      dropped.push(String(entry?.content ?? entry ?? "").slice(0, 40) || "(blank)");
      continue;
    }
    const status = STATUSES.includes(entry?.status) ? entry.status : "pending";
    items.push({ content, status });
  }
  return { items, dropped };
}

export default {
  id: "rosa-todo-guard",
  description: "Adds a task list, nudges the model when it stops writing back to it, and sends a final answer back while items are still open",

  tools() {
    const list = () => todoList;
    return [
      {
        name: "todo_write",
        description:
          "Replace the task list with the CURRENT, real status of every item (this is a whole-list replace, so send " +
          "all items every time: completed for finished, in_progress for the one you are on now, pending for the rest). " +
          "Call it when you start, when an item finishes, and when the plan changes.",
        parameters: {
          type: "object",
          properties: {
            todos: {
              type: "array",
              description: "The complete list, in order.",
              items: {
                type: "object",
                properties: {
                  content: { type: "string", description: "One task, short and concrete." },
                  status: { type: "string", enum: STATUSES },
                },
                required: ["content", "status"],
              },
            },
          },
          required: ["todos"],
        },
        run: async (args) => {
          const { items, dropped } = normalizeTodos(args?.todos);
          todoList = items;
          const open = items.filter((t) => t.status !== "completed").length;
          const note = dropped.length ? `\nignored ${dropped.length} item(s) with no content` : "";
          return `${items.length} item(s), ${open} still open${note}\n${renderList(items)}`;
        },
      },
      {
        name: "todo_read",
        description: "Read the current task list back, exactly as the last todo_write left it.",
        parameters: { type: "object", properties: {} },
        run: async () => {
          const items = list();
          const open = items.filter((t) => t.status !== "completed").length;
          return `${items.length} item(s), ${open} still open\n${renderList(items)}`;
        },
      },
    ];
  },

  commands() {
    return {
      show: async () => renderList(todoList),
      clear: async () => {
        todoList = [];
        return "the task list is empty";
      },
    };
  },

  hooks(ctx) {
    const every = Math.max(1, Number(ctx.config.every) || 12);
    const cooldown = Math.max(0, Number(ctx.config.cooldown) || 2);
    return {
      async beforeStep({ run }) {
        const sinceWrite = run.state.get("sinceWrite") ?? 0;
        if (sinceWrite < every) return;
        const nudged = run.state.get("nudged") ?? false;
        if (nudged && (run.state.get("sinceNudge") ?? 0) < cooldown) return;

        const open = todoList.filter((t) => t.status !== "completed");
        // An empty or fully-complete list is not stale - there is nothing to
        // write back. Staying silent here is what keeps this from being noise.
        if (!todoList.length || !open.length) return;

        run.state.set("nudged", true);
        run.state.set("sinceNudge", 0);
        ctx.log(`step: ${sinceWrite} steps since the last todo_write, ${open.length} item(s) still open - nudging`);
        return {
          note:
            `You have run ${sinceWrite} steps without updating the task list, and it still has ${open.length} ` +
            `unfinished item(s). Update it to the real position before continuing - call todo_write with every item, ` +
            `marking what is completed, what you are on now as in_progress, and what remains as pending.\n` +
            `Current list: ${renderList(todoList)}`,
        };
      },

      async afterStep({ run, toolNames }) {
        const wrote = Array.isArray(toolNames) && toolNames.includes("todo_write");
        run.state.set("sinceWrite", wrote ? 0 : (run.state.get("sinceWrite") ?? 0) + 1);
        run.state.set("sinceNudge", wrote ? 0 : (run.state.get("sinceNudge") ?? 0) + 1);
      },

      /**
       * The other half: the model stops, the list is not finished.
       *
       * A run ends when the model answers with no tool call, and a model that has just
       * planned nine items will answer "I have the data model and the insertion points"
       * and stop - the transcript says done, the plan says 1/9 (measured 2026-11-06).
       * The list is the only record of what "finished" means, so an answer while items
       * are open sends the run back once more, with the list repeated. The loop bounds
       * this (finishRounds), so a model that genuinely cannot continue still ends, and
       * the list stays as the record of what is left.
       */
      async beforeFinish({ run }) {
        const open = todoList.filter((t) => t.status !== "completed");
        if (!todoList.length || !open.length) return;
        const round = (run.state.get("finishNudges") ?? 0) + 1;
        run.state.set("finishNudges", round);
        ctx.log(`answer with ${open.length} of ${todoList.length} item(s) still open - sending it back (${round})`);
        return {
          note:
            `Your task list still has ${open.length} unfinished item(s) out of ${todoList.length}, so the work is not finished:\n` +
            `${open.map((t) => `${MARK[t.status] ?? "[ ]"} ${t.content}`).join("\n")}\n` +
            "Carry on with the next one now, using your tools. If everything on the list really is done, " +
            "call todo_write marking every item completed (and only then answer).",
        };
      },
    };
  },

  status() {
    const open = todoList.filter((t) => t.status !== "completed").length;
    return todoList.length ? `${todoList.length} item(s), ${open} open` : "list empty";
  },
};

/** The list itself: one per harness session, shared with delegated workers. */
let todoList = [];
