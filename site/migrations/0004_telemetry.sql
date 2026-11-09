-- Early-build tracking from the desktop app (harness/src/telemetry.mjs).
--
-- The trial tables (0001-0003) see the browser demo. These see the installed app: how
-- many installs exist, which were active on a given day, what each spent in tokens, and
-- the runs that failed or that a tester reported as a bad answer.
--
--   tel_install  one row per install id: first and last seen, version, running totals
--   tel_event    one row per event the app sent: session, run, call (one cloud model
--                call, the message log) or feedback
--
-- An install id is a random UUID the app made on first launch. Nothing here is an IP
-- address, a user name or a machine name. `prompt` and `answer` are only ever set for a
-- run on a Rosalena cloud model, and only when that install's sharing level is "full";
-- the app decides that before sending, and the endpoint drops them otherwise.

CREATE TABLE IF NOT EXISTS tel_install (
  id          TEXT PRIMARY KEY,        -- the app's random install id
  first_seen  INTEGER NOT NULL,        -- ms since epoch
  last_seen   INTEGER NOT NULL,
  version     TEXT,
  platform    TEXT,                    -- win32, darwin, linux
  arch        TEXT,
  os          TEXT,
  sessions    INTEGER NOT NULL DEFAULT 0,
  runs        INTEGER NOT NULL DEFAULT 0,
  failed_runs INTEGER NOT NULL DEFAULT 0,
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  tokens_out  INTEGER NOT NULL DEFAULT 0,
  reports     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS tel_install_last_seen ON tel_install (last_seen);

CREATE TABLE IF NOT EXISTS tel_event (
  id          TEXT PRIMARY KEY,        -- random, so a row can be cited in a bug report
  install     TEXT NOT NULL,
  day         TEXT NOT NULL,           -- 'YYYY-MM-DD' in UTC, of when the site received it
  stamp       INTEGER NOT NULL,        -- when the app says it happened, ms since epoch
  kind        TEXT NOT NULL,           -- 'session', 'run', 'call' or 'feedback'
  version     TEXT,
  run         TEXT,                    -- the app's run id
  model       TEXT,                    -- the class the person picked
  targets     TEXT,                    -- JSON array of provider/model that answered
  cloud       INTEGER,                 -- 1 when a Rosalena cloud model answered
  status      TEXT,                    -- run: ok, stopped, failed. feedback: good, bad
  stopped     TEXT,                    -- why a run stopped: max_steps, wall_clock, ...
  steps       INTEGER,
  calls       INTEGER,                 -- model calls in the run
  tool_calls  INTEGER,
  ms          INTEGER,
  ttft_ms     INTEGER,                 -- time to the first token of the first call
  tokens_in   INTEGER,
  tokens_out  INTEGER,
  error       TEXT,
  note        TEXT,                    -- feedback: what the tester typed
  prompt      TEXT,                    -- only at sharing "full", cloud models only
  answer      TEXT,                    -- same rule
  data        TEXT                     -- JSON of the remaining small fields
);

CREATE INDEX IF NOT EXISTS tel_event_day ON tel_event (day, kind);
CREATE INDEX IF NOT EXISTS tel_event_install ON tel_event (install, stamp);
CREATE INDEX IF NOT EXISTS tel_event_status ON tel_event (kind, status, stamp);
