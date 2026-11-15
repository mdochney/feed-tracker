-- feed-tracker initial schema (Cloudflare D1 / SQLite)

-- A "show" groups sources that publish the same content in several places
-- (e.g. a podcast on Substack, in a public RSS feed and on YouTube) so that
-- an episode appears once in the tracker.
CREATE TABLE shows (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE sources (
  id              INTEGER PRIMARY KEY,
  key             TEXT NOT NULL UNIQUE,          -- e.g. 'substack:samharris', 'youtube:UCxxxx'
  platform        TEXT NOT NULL CHECK (platform IN ('youtube', 'substack', 'podcast')),
  name            TEXT NOT NULL,
  feed_url        TEXT NOT NULL,                 -- public feed; private overrides come from the PRIVATE_FEEDS secret
  site_url        TEXT,
  show_id         INTEGER REFERENCES shows(id),
  active          INTEGER NOT NULL DEFAULT 1,
  etag            TEXT,                          -- for conditional GETs
  last_modified   TEXT,
  last_polled_at  TEXT,
  last_status     TEXT,                          -- 'ok', 'not_modified', or an error string
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE items (
  id                INTEGER PRIMARY KEY,
  source_id         INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  guid              TEXT NOT NULL,
  title             TEXT NOT NULL,
  url               TEXT,
  published_at      TEXT,                        -- ISO 8601 UTC
  media_type        TEXT NOT NULL CHECK (media_type IN ('video', 'audio', 'text')),
  media_url         TEXT,                        -- enclosure URL for audio/video
  duration_sec      INTEGER,
  thumbnail_url     TEXT,
  summary           TEXT,
  status            TEXT NOT NULL DEFAULT 'new'
                      CHECK (status IN ('new', 'queued', 'dismissed', 'done')),
  status_changed_at TEXT,
  queue_position    REAL,                        -- ordering within the watch-next queue
  -- text-to-voice (generated on queue, stored in R2)
  tts_status        TEXT NOT NULL DEFAULT 'none'
                      CHECK (tts_status IN ('none', 'pending', 'ready', 'error')),
  tts_key           TEXT,
  first_seen_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (source_id, guid)
);

CREATE INDEX items_status_published ON items (status, published_at DESC);
CREATE INDEX items_source ON items (source_id);
CREATE INDEX items_queue ON items (queue_position) WHERE status = 'queued';
