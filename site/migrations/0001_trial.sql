-- The trial's whole storage: counters. No prompt, no completion, no IP, no account.
--
-- One row per UTC day per scope. 'ip:<sha256-16>' is a salted hash of the visitor's
-- address; 'global' is the only row that can stop the whole demo.
CREATE TABLE IF NOT EXISTS trial_usage (
  day    TEXT NOT NULL,          -- 'YYYY-MM-DD' in UTC
  scope  TEXT NOT NULL,          -- 'ip:<sha256-16>' or 'global'
  used   INTEGER NOT NULL DEFAULT 0,
  stamp  INTEGER NOT NULL,       -- last touch, ms since epoch
  PRIMARY KEY (day, scope)
);

-- For pruning old rows and for "how busy was the demo" questions.
CREATE INDEX IF NOT EXISTS trial_usage_stamp ON trial_usage (stamp);
