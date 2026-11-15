// Turn whatever the user pastes (a channel URL, a Substack address, a feed URL) into a source.

import { parseFeed, youtubeFeedUrl } from './feeds.js';

const UA = { 'user-agent': 'feed-tracker/0.1 (personal feed reader)' };

async function get(url, fetchImpl) {
  const res = await fetchImpl(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${new URL(url).hostname} answered HTTP ${res.status}`);
  return res.text();
}

function tryFeed(xml) {
  try { return parseFeed(xml); } catch { return null; }
}

const slug = (s) => s.toLowerCase().replace(/^www\./, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

function describe(feedUrl, feed) {
  const host = new URL(feedUrl).hostname;
  const sub = host.match(/^([\w-]+)\.substack\.com$/);
  const hasAudio = feed.items.some((i) => i.media_type !== 'text');
  const platform = sub || /substack/i.test(feedUrl) ? 'substack' : hasAudio ? 'podcast' : 'rss';
  const path = new URL(feedUrl).pathname.replace(/\/(feed|rss)(\.xml)?\/?$/i, '');
  const key = sub ? `substack:${sub[1]}` : `${platform}:${slug(host + path)}`;
  return { key, platform, name: feed.title || host, feed_url: feedUrl, site_url: feed.site_url ?? null };
}

export async function resolveSource(input, { fetchImpl = fetch, longFormOnly = true } = {}) {
  let raw = String(input ?? '').trim();
  if (!raw) throw new Error('Enter a URL');
  if (/^UC[\w-]{22}$/.test(raw)) raw = `https://www.youtube.com/channel/${raw}`;
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  let url;
  try { url = new URL(raw); } catch { throw new Error('That is not a valid URL'); }

  // YouTube: channel pages, @handles, or an existing feed URL.
  if (/(^|\.)youtube\.com$/.test(url.hostname)) {
    let channelId = url.pathname.match(/\/channel\/(UC[\w-]{22})/)?.[1] ?? url.searchParams.get('channel_id');
    let html = null;
    if (!channelId) {
      html = await get(url.href, fetchImpl);
      channelId =
        html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/)?.[1] ??
        html.match(/"(?:channelId|externalId)":"(UC[\w-]{22})"/)?.[1];
    }
    if (!channelId) throw new Error('Could not find a channel on that YouTube page');
    // The name comes from the channel page, not the feed: the feed endpoint has long outages.
    const page = html ?? await get(`https://www.youtube.com/channel/${channelId}`, fetchImpl);
    const title = page.match(/<meta property="og:title" content="([^"]+)"/)?.[1] ?? page.match(/<title>([^<]+?)(?: - YouTube)?<\/title>/)?.[1];
    if (!title) throw new Error('That does not look like a YouTube channel');
    const name = title.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
    return { key: `youtube:${channelId}`, platform: 'youtube', name, feed_url: youtubeFeedUrl(channelId, { longFormOnly }), site_url: `https://www.youtube.com/channel/${channelId}` };
  }

  // Anything else: is it already a feed?
  const body = await get(url.href, fetchImpl);
  const direct = tryFeed(body);
  if (direct) return describe(url.href, direct);

  // An HTML page: follow its declared feed, then fall back to /feed (Substack and WordPress).
  const candidates = [];
  for (const tag of body.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/rel=["']?alternate/i.test(tag) || !/type=["']?application\/(rss|atom)\+xml/i.test(tag)) continue;
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
    if (href) candidates.push(new URL(href.replace(/&amp;/g, '&'), url).href);
  }
  candidates.push(new URL('/feed', url).href);
  for (const candidate of [...new Set(candidates)]) {
    try {
      const feed = tryFeed(await get(candidate, fetchImpl));
      if (feed) return describe(candidate, feed);
    } catch { /* try the next candidate */ }
  }
  throw new Error('No feed found at that address');
}
