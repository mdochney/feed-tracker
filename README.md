# feed-tracker

Personal tracker that pulls new YouTube videos, Substack posts and podcast episodes
into one list, where each item can be queued to watch next or dismissed.

The plan, decisions and build checklist are in [PLAN.md](PLAN.md).

## What is here now

| Path | What |
|---|---|
| `public/index.html` | The app: New, Watch next, Cleared and Sources views |
| `src/worker.js` | Cloudflare Worker: JSON API under `/api`, polling on a cron trigger |
| `src/store.js` | D1 reads and writes (upserts, first-run backfill, status changes) |
| `src/resolve.js` | Turns a pasted YouTube, Substack or feed URL into a source |
| `src/feeds.js`, `src/poll.js` | RSS/Atom parsing and fetching one source |
| `migrations/` | D1 schema and the seeded subscription list |
| `seeds/*.csv` | Subscription lists (public feed URLs only) |
| `scripts/` | Feed coverage check, seed migration generator, static preview builder |
| `test/` | Parser, store and API tests |

## Run it locally

```sh
npm install
npm test
echo "APP_TOKEN=local-dev-token" > .dev.vars
npm run migrate:local
npm run dev                # http://localhost:8787, sign in with the token above
```

Open Sources and press "Check for new items now" a few times to load the feeds
(each press checks about 40 of the sources that have waited longest).

## Deploy to Cloudflare

Needs a Cloudflare account. As built, the poller needs the Workers Paid plan: the
free plan allows 10 ms of CPU and 50 subrequests per run, which is not enough to
fetch and parse a batch of feeds.

```sh
npx wrangler login
npx wrangler d1 create feed-tracker      # copy the database_id into wrangler.toml
npm run migrate                          # schema + seeded subscriptions
npx wrangler secret put APP_TOKEN        # a long random string; the page asks for it once per browser
npx wrangler secret put PRIVATE_FEEDS    # optional: {"substack:samharris":"https://..."}
npx wrangler secret put YOUTUBE_API_KEY  # YouTube Data API v3 key (Google Cloud console)
npm run deploy
```

The cron trigger runs every 10 minutes and checks the sources that have waited longest.
A run stops at `FETCH_BUDGET` outbound requests (45 by default, under the free plan's
limit of 50), which is about 40 sources, so roughly 340 sources are each checked every
hour and a half. On Workers Paid, raise `FETCH_BUDGET` and `POLL_BATCH` in
`wrangler.toml` for more frequent checks.

YouTube uses about one API quota unit per channel per check, so 274 channels checked
every hour and a half is roughly 4,700 of the 10,000 free units a day. Without `YOUTUBE_API_KEY` the
Worker falls back to YouTube's public feeds, which have long outages.

## Other commands

```sh
npm run check-feeds        # fetch every seed feed once, write reports/feed-coverage.csv
npm run build-preview      # static snapshot of the triage page, reports/preview.html
node scripts/make-seed-sql.mjs migrations/0003_more_sources.sql   # after editing seeds/
```

For paid feeds when running the scripts locally, create `private-feeds.json`
(git-ignored) next to `package.json`:

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
