import { listExternalSessions, readExternalSession, sessionCounts } from "./src/sessions.mjs";
const t0 = Date.now();
const counts = await sessionCounts({ max: 500 });
console.log("counts:", JSON.stringify(counts), "in", Date.now() - t0, "ms");

const { sessions, notes } = await listExternalSessions({ max: 4, sources: ["claude", "codex", "opencode", "dsh"] });
console.log("notes:", JSON.stringify(notes));
for (const s of sessions) console.log(" ", s.source, "|", String(s.title ?? "").slice(0, 50), "|", s.id.slice(0, 30), "|", new Date(s.at).toISOString());

for (const source of ["claude", "opencode", "dsh"]) {
  const one = sessions.find((s) => s.source === source);
  if (!one) { console.log(source, ": no sample"); continue; }
  const t = Date.now();
  const got = await readExternalSession({ source, id: one.id, max: 6 });
  console.log(`\n== ${source} read in ${Date.now() - t} ms; messages:`, got?.messages.length, "truncated:", got?.truncated, "title:", String(got?.meta.title ?? "").slice(0, 60));
  for (const m of (got?.messages ?? []).slice(0, 3)) console.log("   ", m.role + ":", m.text.replace(/\s+/g, " ").slice(0, 110));
}
