// Creator mode's tools: how the agent builds a sidebar plugin.
//
// The agent never writes into an installed plugin. It works in a draft (creator_new,
// creator_write), runs the verifier on it (creator_verify), and installs it only through
// creator_publish, which refuses a draft whose files are not exactly the ones that passed.
// Every install keeps the version it replaced, and creator_rollback puts one back.
// The rules behind each step live in src/creator.mjs and src/plugin-verify.mjs; this file
// only turns them into tools and commands. The skill that teaches the workflow is
// skills/plugin-builder/SKILL.md.

import { createCreator } from "../../src/creator.mjs";
import { describeReport } from "../../src/plugin-verify.mjs";
import { UI_PERMISSIONS } from "../../src/ui-plugins.mjs";

const reason = (err) => (err instanceof Error ? err.message : String(err));
const MAX_READ = 60_000;

function overviewText(creator) {
  const { plugins, drafts } = creator.overview();
  const lines = ["Installed plugins:"];
  for (const p of plugins) {
    const kept = p.history.length ? `, ${p.history.length} earlier version${p.history.length === 1 ? "" : "s"} kept` : "";
    lines.push(`  ${p.id.padEnd(24)} v${p.version}  ${p.source}${p.enabled ? "" : ", switched off"}${p.ok ? "" : `, BROKEN: ${p.problems.join("; ")}`}${kept}`);
  }
  lines.push(drafts.length ? "Drafts:" : "Drafts: none");
  for (const d of drafts) lines.push(`  ${d.id.padEnd(24)} v${d.version}  ${d.verified ? "verified, ready to publish" : "not verified (or changed since)"}`);
  return lines.join("\n");
}

export default {
  id: "rosa-creator-mode",
  description: "Build, verify, install and roll back sidebar plugins (Creator mode).",
  tools(ctx) {
    const creator = createCreator(ctx.config?.home ? { home: ctx.config.home } : {});
    const wrap = (fn) => async (args = {}) => {
      try {
        return await fn(args);
      } catch (err) {
        return `refused: ${reason(err)}`;
      }
    };
    return [
      {
        name: "creator_new",
        description:
          "Start a new sidebar plugin draft from a template that already passes verification. Load the plugin-builder skill first. " +
          `permissions: any of ${Object.keys(UI_PERMISSIONS).join(", ")}. libs: "three" (3D) and/or "pdfjs" (PDF). ` +
          "from: start from an existing plugin's files instead of the template (it still gets your new id).",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "a-z, 0-9 and -, e.g. habit-tracker" },
            title: { type: "string", description: "sidebar label, at most 40 characters" },
            description: { type: "string", description: "one line" },
            permissions: { type: "array", items: { type: "string" } },
            libs: { type: "array", items: { type: "string" } },
            from: { type: "string", description: "optional: an installed or bundled plugin id to copy" },
            replace: { type: "boolean", description: "throw away an existing draft with this id and start over" },
          },
          required: ["id", "title", "description"],
        },
        run: wrap(async (args) => {
          const made = creator.newDraft(args);
          return `draft "${made.id}" created at ${made.path}\nfiles: ${made.files.join(", ")}\nNext: creator_write the real files, then creator_verify.`;
        }),
      },
      {
        name: "creator_write",
        description: "Write one whole file into a plugin draft (create or replace). Paths are relative to the draft, e.g. app/app.js. Only plugin file types are allowed.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string" },
            path: { type: "string" },
            content: { type: "string", description: "the complete file content" },
          },
          required: ["id", "path", "content"],
        },
        run: wrap(async ({ id, path, content }) => {
          const out = creator.writeFile(id, path, content);
          return `wrote ${out.path} (${out.bytes} bytes) in draft ${id}. The draft must pass creator_verify again before it can be published.`;
        }),
      },
      {
        name: "creator_read",
        description: "Read one file from a plugin draft.",
        parameters: { type: "object", properties: { id: { type: "string" }, path: { type: "string" } }, required: ["id", "path"] },
        run: wrap(async ({ id, path }) => {
          const text = creator.readFile(id, path);
          return text.length > MAX_READ ? `${text.slice(0, MAX_READ)}\n... (${text.length - MAX_READ} more characters)` : text;
        }),
      },
      {
        name: "creator_files",
        description: "List the files in a plugin draft, or delete one (delete: true).",
        parameters: { type: "object", properties: { id: { type: "string" }, delete: { type: "string", description: "optional: a file to delete" } }, required: ["id"] },
        run: wrap(async ({ id, delete: drop }) => {
          if (drop) {
            creator.deleteFile(id, drop);
            return `deleted ${drop}`;
          }
          return creator
            .files(id)
            .map((f) => `${f.path}  ${f.bytes} bytes`)
            .join("\n");
        }),
      },
      {
        name: "creator_verify",
        description:
          "Verify a plugin draft: static rules, then the page loaded in a hidden browser window with the app's sandbox, its Rosalena.test() self-tests run, " +
          "errors collected and a screenshot taken. Fix every FAIL and run it again; only a PASS can be published.",
        parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        run: wrap(async ({ id }) => {
          const report = await creator.verify(id);
          return `${describeReport(report)}\n${report.ok ? "Ready: creator_publish installs exactly these files." : "Not ready: fix the FAIL lines above, then creator_verify again."}`;
        }),
      },
      {
        name: "creator_publish",
        description: "Install a verified draft into the sidebar. Refused unless the draft passed creator_verify and has not changed since. The version it replaces is kept for rollback.",
        parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        run: wrap(async ({ id }) => {
          const out = creator.publish(id);
          return `installed ${out.id} v${out.version}; it is in the sidebar now.${out.replaced ? ` The previous version (v${out.replaced.version}) is kept as ${out.replaced.stamp}; creator_rollback puts it back.` : ""}`;
        }),
      },
      {
        name: "creator_rollback",
        description: "Put back an earlier installed version of a plugin (the newest kept one, or `to`: a stamp or version from creator_status). The version it replaces is kept too.",
        parameters: { type: "object", properties: { id: { type: "string" }, to: { type: "string" } }, required: ["id"] },
        run: wrap(async ({ id, to }) => {
          const out = creator.rollback(id, { to: to || null });
          return `rolled ${out.id} back to v${out.restored} (${out.from}).${out.kept ? ` The version it replaced is kept as ${out.kept.stamp}.` : ""}`;
        }),
      },
      {
        name: "creator_status",
        description: "List installed plugins (with kept versions and on/off state) and drafts (verified or not).",
        parameters: { type: "object", properties: {} },
        run: wrap(async () => overviewText(creator)),
      },
    ];
  },
  commands(ctx) {
    const creator = createCreator(ctx.config?.home ? { home: ctx.config.home } : {});
    const run = (fn) => async (argv) => {
      try {
        return await fn(argv);
      } catch (err) {
        return reason(err);
      }
    };
    return {
      list: run(() => overviewText(creator)),
      verify: run(async ([id]) => describeReport(await creator.verify(id))),
      publish: run(([id]) => JSON.stringify(creator.publish(id), null, 2)),
      rollback: run(([id, to]) => JSON.stringify(creator.rollback(id, { to: to || null }), null, 2)),
      history: run(([id]) => creator.history(id).map((h) => `${h.stamp}  v${h.version}  ${h.reason ?? ""}`).join("\n") || "no kept versions"),
      disable: run(([id]) => JSON.stringify(creator.setEnabled(id, false))),
      enable: run(([id]) => JSON.stringify(creator.setEnabled(id, true))),
      remove: run(([id]) => JSON.stringify(creator.remove(id))),
      ledger: run(() => creator.ledger(30).map((e) => `${e.at}  ${e.action}  ${e.id}${e.version ? ` v${e.version}` : ""}${e.ok === false ? " FAIL" : ""}`).join("\n") || "nothing yet"),
    };
  },
  status: () => "drafts are verified before they are installed; every install can be rolled back",
};
