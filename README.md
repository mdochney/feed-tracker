# feed-tracker

Personal tracker that pulls new YouTube videos, Substack posts and podcast episodes
into one list, where each item can be queued to watch next or dismissed.

The plan, decisions and build checklist are in [PLAN.md](PLAN.md).

## What is here now

| Path | What |
|---|---|
| `seeds/*.csv` | Subscription lists (public feed URLs only) |
| `migrations/0001_init.sql` | D1 schema |
| `src/feeds.js` | RSS/Atom parsing into a common item shape |
| `src/poll.js` | Fetch one source (conditional GET, private feed override) |
| `scripts/check-feeds.mjs` | Fetch every seed feed once and report coverage |
| `test/` | Parser and poller tests against fixtures |

## Usage

```sh
npm install
npm test
npm run check-feeds        # writes reports/feed-coverage.csv
```

For paid feeds, create `private-feeds.json` (git-ignored) next to `package.json`:

```json
{ "substack:samharris": "https://api.substack.com/feed/podcast/…" }
```

## Seed file columns

`key, platform, name, feed_url, av_tier, private_feed, active, notes`

- `key`: stable id, `<platform>:<slug>`.
- `av_tier`: `regular | occasional | none`, a hint from email history about how often
  the source publishes audio or video.
- `private_feed`: `yes` if a per-subscriber feed URL is needed, `check` if unsure.
- `active`: `0` to skip the source.
