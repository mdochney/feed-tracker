// Fetch one source and return normalised items. No storage here: the Worker
// (D1 upserts) and the coverage script (report) both build on this.

import { parseFeed } from './feeds.js';
import { pollYoutube } from './youtube.js';

const USER_AGENT = 'feed-tracker/0.1 (personal feed reader)';

// source: { key, feed_url, etag?, last_modified? }
// privateFeeds: { [source.key]: url } — overrides for paid feeds, never stored in the repo.
// Returns { status: 'ok' | 'not_modified', items, etag, last_modified, title, site_url }.
export async function pollSource(source, { fetchImpl = fetch, privateFeeds = {}, timeoutMs = 15000, youtubeApiKey = null } = {}) {
  // YouTube goes through the Data API when a key is configured; its public feeds are unreliable.
  if (source.platform === 'youtube' && youtubeApiKey) return pollYoutube(source, { apiKey: youtubeApiKey, fetchImpl });
  const url = privateFeeds[source.key] ?? source.feed_url;
  const headers = { 'user-agent': USER_AGENT, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' };
  if (source.etag) headers['if-none-match'] = source.etag;
  if (source.last_modified) headers['if-modified-since'] = source.last_modified;

  // Redirects are followed by hand so that every hop goes through fetchImpl: each one counts
  // against the platform's per-run request limit, and the caller keeps a budget of them.
  let res;
  let finalUrl = url;
  for (let hop = 0; ; hop++) {
    res = await fetchImpl(finalUrl, { headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    const location = res.status >= 300 && res.status < 400 && res.status !== 304 ? res.headers.get('location') : null;
    if (!location) break;
    if (hop >= 4) throw new Error('Too many redirects');
    finalUrl = new URL(location, finalUrl).href;
  }
  if (res.status === 304) {
    return { status: 'not_modified', items: [], etag: source.etag ?? null, last_modified: source.last_modified ?? null };
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const feed = parseFeed(await res.text());
  return {
    status: 'ok',
    items: feed.items,
    title: feed.title,
    site_url: feed.site_url,
    etag: res.headers.get('etag'),
    last_modified: res.headers.get('last-modified'),
    // Where the public feed really lives, so later polls can skip the redirect.
    moved_to: finalUrl !== url && !privateFeeds[source.key] ? finalUrl : null,
  };
}
