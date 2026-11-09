// The clock module, version 1.0.0 — the store's first installable module.
//
// A model has no clock. Everything it believes about "now" comes from its
// training data, so it cannot say what today is or how long until Friday. This
// is the smallest honest fix for that: one tool, one command, no state.

function describeLocal() {
  const now = new Date();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const text = new Intl.DateTimeFormat("en-US", { timeZone: zone, dateStyle: "full", timeStyle: "long" }).format(now);
  return `${text} (${zone})\nISO 8601 UTC: ${now.toISOString()}`;
}

export default {
  id: "clock",
  description: "Tells the model what time it is, in the machine's own zone.",
  tools: () => [
    {
      name: "clock_now",
      description: "The current date and time on this machine, with the machine's time zone. Call this before answering anything that depends on today's date.",
      parameters: { type: "object", properties: {} },
      run: async () => describeLocal(),
    },
  ],
  commands: () => ({
    now: () => describeLocal(),
  }),
  status: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
};
