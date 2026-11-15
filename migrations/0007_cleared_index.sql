-- Counting and listing the Cleared view without scanning the whole skipped backlog.
-- D1's free plan caps rows read per day, and the backlog is most of the table.
CREATE INDEX items_cleared ON items (status_changed_at DESC)
  WHERE auto_dismissed = 0 AND status IN ('dismissed', 'done');
