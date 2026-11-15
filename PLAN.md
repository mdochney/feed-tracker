# feed-tracker plan

One place to see new content from YouTube, Substack and podcast subscriptions, and
triage each item: add to the watch-next queue, or dismiss.

## Decisions so far

- **Everything is a feed.** Each source is polled as RSS/Atom. Platform APIs are used
  only (if at all) to seed the list of subscriptions.
  - YouTube: per-channel Atom feed, long-form playlist variant (`UULF…`) to skip Shorts.
    Seeded from the Google Takeout subscriptions CSV, so no OAuth in v1.
  - Substack: `https://<pub>.substack.com/feed`. Paid shows use a per-subscriber private
    feed URL.
  - Spotify shows: resolved once to their public RSS feed; no Spotify API at runtime.
- **Stack:** Cloudflare Worker + D1, cron poller, one responsive page (desktop first
  with keyboard triage, usable on a phone).
- **Login:** the API requires a bearer token (`APP_TOKEN` secret) and refuses everything
  if the secret is not set. Cloudflare Access can be added in front later.
- **Plan limits:** the poller as built assumes Workers Paid. On the free plan (10 ms CPU,
  50 subrequests per run) polling would have to move elsewhere, for example a scheduled
  GitHub Action that pushes parsed items to the Worker.
- **Text posts are included** and can be listened to: audio is generated when a post is
  queued (not on ingest), stored in R2, with browser speech synthesis as the fallback.
- **Secrets stay out of the repo.** Private feed URLs are credentials. They live in the
  `PRIVATE_FEEDS` Worker secret (a JSON map of source key to URL) and, locally, in the
  git-ignored `private-feeds.json`.

## Data model

See `migrations/0001_init.sql`.

- `sources`: one row per feed, keyed like `substack:samharris` or `youtube:UC…`.
- `items`: one row per post/episode/video, unique on `(source_id, guid)`, with
  `status` in `new | queued | dismissed | done` and text-to-voice state.
- `shows`: groups sources that carry the same content (Substack + YouTube + RSS) so an
  episode is shown once. Columns exist; matching logic is not built yet.

## What the first coverage run showed (2026-11-14, Substack seeds)

- All 61 active Substack feeds fetch and parse, including those on custom domains.
- Each feed returns only its latest 20 posts, so hourly polling is plenty but there is
  no deep backfill.
- Video posts arrive with an **audio** enclosure (mp3). The feed alone cannot tell a
  video episode from an audio one; the UI should play the audio in place and link to
  the post for video.
- `av_tier` in the seed file came from email history and is only a hint. What an item
  is gets decided per item from its enclosure.
- Not yet checked: whether paid posts are truncated in public feeds, and how the
  private podcast feeds differ.

## Build order

- [x] Substack seed list (`seeds/substack.csv`)
- [x] Schema, feed parser, single-source poller, coverage script, tests
- [ ] YouTube seed (needs Takeout `subscriptions.csv`)
- [ ] Podcast seed (needs the list of Spotify shows; resolve each to RSS)
- [ ] Private feed URLs for paid Substack shows
- [x] Worker: cron poller writing to D1, first-run backfill rule (items older than a
      week start out dismissed)
- [x] JSON API: list items, change status, add / pause / remove sources, poll on demand
- [x] UI: new-items feed, queue, cleared, sources, keyboard shortcuts, undo, one
      page-wide audio player
- [ ] Deploy (needs a Cloudflare account; see README)
- [x] Skipped backlog kept apart from Cleared; thumbnails from post images and show art
- [ ] Episode durations: filled from the show's podcast feed where it exists; several
      shows (Sam Harris, Stay Tuned, The Long Game) return 404 there and still have none
- [ ] Queue reordering, PWA manifest, YouTube embeds
- [ ] Cross-posting dedupe via `shows`
- [ ] Text-to-voice: article extraction, TTS on queue, R2 storage, Gmail as the text
      source for paid posts
- [ ] Optional: mirror queued videos to a YouTube playlist

## Open questions

- Which TTS provider (cost and voice quality to be compared before building).
- Whether paid Substack text should come from Gmail or a session cookie.
- Deployment: connect this repo to Cloudflare for deploy-on-push, or `wrangler deploy`
  by hand.
