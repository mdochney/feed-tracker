-- Where playback last stopped, so another device can pick up from there.
ALTER TABLE items ADD COLUMN position_sec REAL;
ALTER TABLE items ADD COLUMN position_at TEXT;
