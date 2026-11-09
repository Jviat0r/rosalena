// The clock module, version 1.1.0 — the same tool, now aware of other zones.
//
// 1.0.0 could only tell you the machine's own time, which is useless the moment
// a model is asked about a client in another country. 1.1.0 adds a `zone`
// argument and a `/clock zones` command, so the store's update path has
// something real to install: a module whose tool surface actually changed.

function zoneList() {
  try {
    // Node ships full ICU, so this is the real tz database and not a stub.
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
}

function describe(zone) {
  const now = new Date();
  const wanted = String(zone ?? "").trim();
  const tz = !wanted || wanted === "local" ? Intl.DateTimeFormat().resolvedOptions().timeZone : wanted;
  let text;
  try {
    text = new Intl.DateTimeFormat("en-US", { timeZone: tz, dateStyle: "full", timeStyle: "long" }).format(now);
  } catch {
    throw new Error(`"${wanted}" is not an IANA time zone - try /clock zones`);
  }
  return `${text} (${tz})\nISO 8601 UTC: ${now.toISOString()}`;
}

export default {
  id: "clock",
  description: "Tells the model what time it is, in any IANA time zone.",
  tools: () => [
    {
      name: "clock_now",
      description: "The current date and time, optionally in another IANA time zone (e.g. \"America/New_York\"). Call this before answering anything that depends on today's date.",
      parameters: {
        type: "object",
        properties: { zone: { type: "string", description: "An IANA zone such as Europe/London; omit for this machine's zone." } },
      },
      run: async ({ zone } = {}) => describe(zone),
    },
  ],
  commands: () => ({
    now: (argv = []) => describe(argv.join(" ")),
    zones: (argv = []) => {
      const filter = argv.join(" ").trim().toLowerCase();
      const zones = zoneList().filter((z) => !filter || z.toLowerCase().includes(filter));
      if (!zones.length) return `no IANA zone matches "${filter}"`;
      return `${zones.length} zone(s)${filter ? ` matching "${filter}"` : ""}:\n  ${zones.join("\n  ")}`;
    },
  }),
  status: () => `${Intl.DateTimeFormat().resolvedOptions().timeZone}, ${zoneList().length} zones known`,
};
