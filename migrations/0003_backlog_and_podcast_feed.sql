-- Separate the backlog that was skipped automatically on a source's first check from
-- items the user dismissed, and remember each Substack show's podcast feed (it carries
-- durations and episode art that the publication feed leaves out).

ALTER TABLE items ADD COLUMN auto_dismissed INTEGER NOT NULL DEFAULT 0;

-- Items dismissed in the same write that first stored them were dismissed by the backfill rule.
UPDATE items SET auto_dismissed = 1 WHERE status = 'dismissed' AND status_changed_at = first_seen_at;

-- NULL = not looked up yet, '' = looked up and the show has none.
ALTER TABLE sources ADD COLUMN podcast_feed_url TEXT;
