-- Rosalena phone-access relay (site/relay/worker.mjs).
--
-- relays: one row per install. `id` is the subdomain (24 base32 chars), `secret_hash` the
-- SHA-256 (hex) of the install's 256-bit secret, `target` the current quick-tunnel origin
-- (NULL while the app is off). Rows are never deleted, so an id can never change owner.
CREATE TABLE IF NOT EXISTS relays (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  target TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- relay_limits: hourly counters for registrations and new-id claims per client address.
CREATE TABLE IF NOT EXISTS relay_limits (
  key TEXT PRIMARY KEY,
  window INTEGER NOT NULL,
  count INTEGER NOT NULL
);
