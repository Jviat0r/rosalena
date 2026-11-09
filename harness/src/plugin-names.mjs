/**
 * Rosalena's own plugins are named `rosa-*` since 2026-11-08. They used to carry bare
 * names, the same as the DeepSeek Harness plugins several of them started from; the two
 * are separate projects now. Anything saved under an old name - a switch on the Plugins
 * page, a block in harness.config.json, a plugin's saved data, a sidebar tab, a
 * `/plugin local-model-host:list` someone has in their notes - still reaches the plugin
 * through this map. No imports, so every module can use it without a cycle.
 */
export const RENAMED_PLUGINS = Object.freeze({
  advisor: "rosa-advisor",
  browser: "rosa-browser",
  "code-intel": "rosa-code-intel",
  comfyui: "rosa-comfyui",
  "commit-cadence": "rosa-commit-cadence",
  "creator-mode": "rosa-creator-mode",
  "finish-loop-guard": "rosa-finish-loop-guard",
  fuyu: "rosa-fuyu",
  "local-llm": "rosa-local-llm",
  "local-model-host": "rosa-local-model-host",
  "local-model-monitor": "rosa-local-model-monitor",
  "local-model-switch": "rosa-local-model-switch",
  "mcp-manager": "rosa-mcp-manager",
  "mcp-server": "rosa-mcp-server",
  "model-pin": "rosa-model-pin",
  "nested-instructions": "rosa-nested-instructions",
  "opencode-handler": "rosa-opencode-handler",
  // Its name before 2026-11-08's first rename.
  "opencode-freeaccess": "rosa-opencode-handler",
  "paper-reader": "rosa-paper-reader",
  "poster-studio": "rosa-poster-studio",
  "process-tracker": "rosa-process-tracker",
  "rate-limit-failover": "rosa-rate-limit-failover",
  "reveal-file-location": "rosa-reveal-file-location",
  "skill-autoload": "rosa-skill-autoload",
  solbrowser: "rosa-solbrowser",
  "style-lab": "rosa-style-lab",
  "subagent-model-switch": "rosa-subagent-model-switch",
  "todo-guard": "rosa-todo-guard",
  "transformer-3d": "rosa-transformer-3d",
  "video-editor": "rosa-video-editor",
  "vpn-exit-rotator": "rosa-vpn-exit-rotator",
  "wifi-switcher": "rosa-wifi-switcher",
  "world-architecture-3d": "rosa-world-architecture-3d",
});

/** A plugin id as it is now: an old name becomes its `rosa-` name, anything else is kept. */
export function currentPluginId(id) {
  const text = String(id ?? "");
  return Object.hasOwn(RENAMED_PLUGINS, text) ? RENAMED_PLUGINS[text] : text;
}

/**
 * An object keyed by plugin id with every old name moved to its new one. When both are
 * present the new name's entry wins: it was written after the rename.
 */
export function renamePluginKeys(map) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return map;
  const out = {};
  for (const [key, value] of Object.entries(map)) if (currentPluginId(key) !== key) out[currentPluginId(key)] = value;
  for (const [key, value] of Object.entries(map)) if (currentPluginId(key) === key) out[key] = value;
  return out;
}
