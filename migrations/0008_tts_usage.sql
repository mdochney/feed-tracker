-- Characters sent to Google Text-to-Speech per calendar month (UTC), so the tracker can
-- stop before the free allowance runs out.
CREATE TABLE tts_usage (
  month TEXT PRIMARY KEY,
  chars INTEGER NOT NULL DEFAULT 0
);
