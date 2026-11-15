// Feed parsing shared by the Worker poller and the local coverage script.
// Handles RSS 2.0 (Substack, podcasts) and Atom (YouTube).

import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  // Keep these as arrays even when a feed has a single entry.
  isArray: (name) => name === 'item' || name === 'entry' || name === 'link',
});

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

// fast-xml-parser returns either a string or { '#text': ..., '@_attr': ... }.
function text(node) {
  if (node == null) return null;
  if (typeof node === 'object') node = node['#text'];
  if (node == null) return null;
  const s = String(node).trim();
  return s === '' ? null : s;
}

function toIso(value) {
  const s = text(value);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// itunes:duration is either seconds ("3725") or a clock ("1:02:05", "62:05").
export function parseDuration(value) {
  const s = text(value);
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
  const parts = s.split(':').map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some(Number.isNaN)) return null;
  return Math.round(parts.reduce((acc, p) => acc * 60 + p, 0));
}

function stripHtml(html, max = 500) {
  const s = text(html);
  if (!s) return null;
  const plain = s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return null;
  return plain.length > max ? plain.slice(0, max - 1).trimEnd() + '…' : plain;
}

function mediaTypeFromEnclosure(type, url) {
  const t = (type || '').toLowerCase();
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  const u = (url || '').toLowerCase().split('?')[0];
  if (/\.(mp4|m4v|mov|webm)$/.test(u)) return 'video';
  if (/\.(mp3|m4a|aac|ogg|opus|wav)$/.test(u)) return 'audio';
  return null;
}

function parseRssItem(item) {
  const enclosure = asArray(item.enclosure)[0];
  const mediaUrl = enclosure?.['@_url'] ?? null;
  const mediaType = mediaUrl ? mediaTypeFromEnclosure(enclosure['@_type'], mediaUrl) : null;
  const link = text(asArray(item.link)[0]);
  const guid = text(item.guid) ?? link ?? mediaUrl;
  const title = text(item.title);
  if (!guid || !title) return null;
  return {
    guid,
    title,
    url: link,
    published_at: toIso(item.pubDate ?? item['dc:date']),
    media_type: mediaType ?? 'text',
    media_url: mediaType ? mediaUrl : null,
    duration_sec: parseDuration(item['itunes:duration']),
    thumbnail_url:
      item['itunes:image']?.['@_href'] ??
      asArray(item['media:thumbnail'])[0]?.['@_url'] ??
      // Substack puts the post's cover image in an image/* enclosure on text posts.
      (mediaUrl && !mediaType && /^image\//.test(enclosure['@_type'] || '') ? mediaUrl : null),
    summary: stripHtml(item.description ?? item['itunes:summary']),
  };
}

function parseAtomEntry(entry) {
  const links = asArray(entry.link);
  const alt = links.find((l) => (l['@_rel'] ?? 'alternate') === 'alternate') ?? links[0];
  const videoId = text(entry['yt:videoId']);
  const group = entry['media:group'];
  const guid = text(entry.id) ?? alt?.['@_href'];
  const title = text(entry.title);
  if (!guid || !title) return null;
  return {
    guid,
    title,
    url: alt?.['@_href'] ?? null,
    published_at: toIso(entry.published ?? entry.updated),
    media_type: videoId ? 'video' : 'text',
    media_url: null,
    duration_sec: null, // not present in YouTube feeds
    thumbnail_url: asArray(group?.['media:thumbnail'])[0]?.['@_url'] ?? null,
    summary: stripHtml(group?.['media:description'] ?? entry.summary),
  };
}

// Returns { title, site_url, items[] }. Throws if the document is neither RSS nor Atom.
export function parseFeed(xml) {
  const doc = parser.parse(xml);
  if (doc.rss?.channel) {
    const ch = doc.rss.channel;
    return {
      title: text(ch.title),
      site_url: text(asArray(ch.link).find((l) => typeof l !== 'object' || l['#text'])),
      items: asArray(ch.item).map(parseRssItem).filter(Boolean),
    };
  }
  if (doc.feed) {
    const links = asArray(doc.feed.link);
    const alt = links.find((l) => l['@_rel'] === 'alternate');
    return {
      title: text(doc.feed.title),
      site_url: alt?.['@_href'] ?? null,
      items: asArray(doc.feed.entry).map(parseAtomEntry).filter(Boolean),
    };
  }
  throw new Error('Not an RSS or Atom feed');
}

// YouTube: build the feed URL for a channel. `longFormOnly` swaps the channel's
// uploads feed for its long-form playlist, which leaves out Shorts and live streams.
export function youtubeFeedUrl(channelId, { longFormOnly = true } = {}) {
  if (!/^UC[\w-]{22}$/.test(channelId)) throw new Error(`Not a channel id: ${channelId}`);
  return longFormOnly
    ? `https://www.youtube.com/feeds/videos.xml?playlist_id=UULF${channelId.slice(2)}`
    : `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
}
