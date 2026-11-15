// YouTube through the Data API v3. The public channel feeds have had repeated
// multi-day outages, so the API is used whenever a key is configured.
//
// Quota: one playlistItems.list call per channel per poll (1 unit) plus one videos.list
// call per run for durations (1 unit). The default daily quota is 10,000 units.

const API = 'https://www.googleapis.com/youtube/v3';

export const channelIdOf = (source) => source.key?.match(/^youtube:(UC[\w-]{22})$/)?.[1] ?? null;

// Every channel has generated playlists: UU… is all uploads, UULF… is long-form only
// (no Shorts, no live streams). Which one a source uses follows its stored feed URL.
export function playlistIdOf(source) {
  const id = channelIdOf(source);
  if (!id) return null;
  return (/playlist_id=UULF|^$/.test(source.feed_url ?? '') ? 'UULF' : 'UU') + id.slice(2);
}

// "PT1H2M5S" -> 3725. Live and upcoming videos report P0D, which comes back as null.
export function parseIsoDuration(value) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value ?? '');
  if (!m) return null;
  const sec = (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
  return sec || null;
}

async function call(path, params, { apiKey, fetchImpl, etag, timeoutMs = 15000 }) {
  const url = `${API}/${path}?${new URLSearchParams({ ...params, key: apiKey })}`;
  const headers = { accept: 'application/json' };
  if (etag) headers['if-none-match'] = etag;
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 304) return { notModified: true };
  let body = null;
  try { body = await res.json(); } catch { /* handled below */ }
  if (!res.ok) {
    const reason = body?.error?.errors?.[0]?.reason;
    const err = new Error(reason === 'quotaExceeded' ? 'YouTube API daily quota used up' : `YouTube API ${res.status}${reason ? ' ' + reason : ''}`);
    err.reason = reason;
    err.status = res.status;
    throw err;
  }
  return { body };
}

// Same result shape as pollSource in poll.js.
export async function pollYoutube(source, { apiKey, fetchImpl = fetch, maxResults = 15 } = {}) {
  const playlistId = playlistIdOf(source);
  if (!playlistId) throw new Error('Not a YouTube channel source');
  const list = (id, etag) => call('playlistItems', { part: 'snippet,contentDetails', maxResults: String(maxResults), playlistId: id }, { apiKey, fetchImpl, etag });
  const missing = (err) => err.reason === 'playlistNotFound' || err.status === 404;
  let res;
  try {
    res = await list(playlistId, source.etag);
  } catch (err) {
    if (!missing(err)) throw err;
    // No long-form playlist (a channel of only Shorts or streams): fall back to all uploads,
    // and treat a channel with nothing at all as empty instead of failed.
    try {
      if (!playlistId.startsWith('UULF')) throw err;
      res = await list('UU' + playlistId.slice(4), null);
    } catch (err2) {
      if (!missing(err2)) throw err2;
      return { status: 'ok', items: [], etag: null, last_modified: null, site_url: `https://www.youtube.com/channel/${channelIdOf(source)}` };
    }
  }
  if (res.notModified) return { status: 'not_modified', items: [], etag: source.etag ?? null, last_modified: null };

  const items = [];
  for (const entry of res.body.items ?? []) {
    const sn = entry.snippet ?? {};
    const videoId = entry.contentDetails?.videoId ?? sn.resourceId?.videoId;
    if (!videoId || sn.title === 'Private video' || sn.title === 'Deleted video') continue;
    const published = entry.contentDetails?.videoPublishedAt ?? sn.publishedAt;
    const th = sn.thumbnails ?? {};
    const description = (sn.description ?? '').replace(/\s+/g, ' ').trim();
    items.push({
      guid: `yt:video:${videoId}`, // same id the channel feed uses, so switching methods never duplicates
      title: sn.title ?? videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      published_at: published ? new Date(published).toISOString() : null,
      media_type: 'video',
      media_url: null,
      duration_sec: null,
      thumbnail_url: (th.medium ?? th.high ?? th.default)?.url ?? null,
      summary: description ? (description.length > 500 ? description.slice(0, 499).trimEnd() + '…' : description) : null,
    });
  }
  return {
    status: 'ok',
    items,
    etag: res.body.etag ?? null,
    last_modified: null,
    site_url: `https://www.youtube.com/channel/${channelIdOf(source)}`,
  };
}

// Durations for up to 50 videos in one call. Returns Map(videoId -> seconds | 0 when unknown).
export async function fetchDurations(videoIds, { apiKey, fetchImpl = fetch } = {}) {
  const out = new Map();
  if (!videoIds.length) return out;
  const { body } = await call('videos', { part: 'contentDetails', id: videoIds.slice(0, 50).join(','), maxResults: '50' }, { apiKey, fetchImpl });
  for (const v of body.items ?? []) out.set(v.id, parseIsoDuration(v.contentDetails?.duration) ?? 0);
  for (const id of videoIds.slice(0, 50)) if (!out.has(id)) out.set(id, 0);
  return out;
}
