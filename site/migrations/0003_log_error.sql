-- What went wrong, next to what was said.
--
-- `trial_log` (0002) records that an attempt happened and how it ended. When an answer
-- arrives empty, arrives cut off, or the provider fails mid-stream the row says
-- `status = 'failed'` and nothing else, which is not enough to tell a dead upstream from
-- a bad prompt from a model that spent its whole budget thinking.
--
-- `error` holds the provider's own message for that attempt, already stripped of
-- secrets by redact() in functions/api/_lib/trial.mjs. Like `prompt` and `answer` it is
-- written only when TRIAL_LOG_MESSAGES=full: a provider message can quote the request
-- back, so keeping it is the same decision as keeping the words, not a smaller one.
--
-- Nothing is rewritten and no row is dropped: this is a nullable ADD COLUMN, so the
-- migration is safe on a live table and old rows simply have no error text.

ALTER TABLE trial_log ADD COLUMN error TEXT;

-- The operator's first question after a bug report is "how many failed today, and how".
CREATE INDEX IF NOT EXISTS trial_log_status ON trial_log (status, stamp);
