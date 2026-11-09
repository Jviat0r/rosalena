-- What a message costs, and what was asked.
--
-- `trial_usage` (0001) counts messages per UTC day per scope. Counting messages alone
-- is a poor brake: one 1200 character prompt with a 700 token answer costs far more
-- than "hello", and five messages is not five messages' worth of money. This file adds
-- the two things that make the demo answerable to its own operator:
--
--   trial_tokens  what was actually spent, in tokens, per day per scope
--   trial_log     one row per attempt, so abuse can be reviewed instead of guessed at
--
-- Scopes, same vocabulary as 0001: 'global', 'ip:<sha256-16>', 'sid:<sha256-16>'. The
-- sid scope is the browser session cookie, which is what stops a visitor from walking
-- past a used-up allowance by changing address.

CREATE TABLE IF NOT EXISTS trial_tokens (
  day        TEXT NOT NULL,          -- 'YYYY-MM-DD' in UTC
  scope      TEXT NOT NULL,          -- 'sid:...', 'ip:...' or 'global'
  tokens_in  INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  requests   INTEGER NOT NULL DEFAULT 0,
  stamp      INTEGER NOT NULL,       -- last touch, ms since epoch
  PRIMARY KEY (day, scope)
);

CREATE INDEX IF NOT EXISTS trial_tokens_stamp ON trial_tokens (stamp);

-- One row per attempt. The two text columns are the only place a visitor's words could
-- ever land, and they stay NULL unless the deployment sets TRIAL_LOG_MESSAGES=full:
-- the public pages promise that nothing typed there is kept, so keeping it has to be a
-- deliberate, temporary act - an abuse review, not a default.
--
-- Nothing here is joined to an identity: `sid` and `ip` are salted hashes, the same
-- form the counters use, and neither can be turned back into an address or a cookie
-- without the salt.
CREATE TABLE IF NOT EXISTS trial_log (
  id        TEXT PRIMARY KEY,        -- random, so a row can be cited in a report
  day       TEXT NOT NULL,
  stamp     INTEGER NOT NULL,
  sid       TEXT,                    -- hashed session scope, when a cookie was sent
  ip        TEXT,                    -- hashed address scope
  provider  TEXT,                    -- which provider answered, after any fallback
  model     TEXT,                    -- the label the page showed
  status    TEXT NOT NULL,           -- 'ok', 'refused' or 'failed'
  kind      TEXT,                    -- the refusal kind, when refused
  ms        INTEGER,                 -- wall time of the whole attempt
  chars_in  INTEGER,
  chars_out INTEGER,
  tokens_in INTEGER,
  tokens_out INTEGER,
  prompt    TEXT,                    -- NULL unless TRIAL_LOG_MESSAGES=full
  answer    TEXT                     -- NULL unless TRIAL_LOG_MESSAGES=full
);

CREATE INDEX IF NOT EXISTS trial_log_stamp ON trial_log (stamp);
CREATE INDEX IF NOT EXISTS trial_log_ip ON trial_log (ip, stamp);
CREATE INDEX IF NOT EXISTS trial_log_sid ON trial_log (sid, stamp);
