// D1 reads and writes. Everything takes a D1-style database (prepare/bind/run/all/first/batch)
// so it runs in the Worker and, through a small shim, in Node tests.

import { pollSource } from './poll.js';
import { fetchDurations } from './youtube.js';

export const BACKFILL_DAYS = 7;   // on a source's first poll, older items start out dismissed
const MAX_ITEMS_PER_POLL = 50;    // podcast feeds can carry a show's whole history

export const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

const UPSERT_ITEM = `
  INSERT INTO items (source_id, guid, title, url, published_at, media_type, media_url,
                     duration_sec, thumbnail_url, summary, status, status_changed_at, first_seen_at,
                     auto_dismissed)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (source_id, guid) DO UPDATE SET
    title = excluded.title,
    url = excluded.url,
    media_type = excluded.media_type,
    media_url = excluded.media_url,
    duration_sec = COALESCE(excluded.duration_sec, items.duration_sec),
    thumbnail_url = COALESCE(excluded.thumbnail_url, items.thumbnail_url),
    summary = excluded.summary`;

// Write one poll result: one read and one batch per source.
//
// Only rows that are new or actually changed are written. D1's free plan allows 100,000 row
// writes a day (each index counts as another row), and re-writing every item of every feed on
// every poll would use that up within hours.
export async function storePoll(db, source, result, at = nowIso()) {
  if (result.status === 'not_modified') {
    await db.prepare('UPDATE sources SET last_polled_at = ?, last_status = ? WHERE id = ?')
      .bind(at, 'not_modified', source.id).run();
    return { inserted: 0, updated: 0 };
  }
  const cutoff = new Date(Date.parse(at) - BACKFILL_DAYS * 86400000).toISOString();
  const items = [...result.items]
    .sort((a, b) => ((a.published_at ?? '') < (b.published_at ?? '') ? 1 : -1))
    .slice(0, MAX_ITEMS_PER_POLL);

  // Newest 400 is far more than any feed lists at once, and bounds the rows read per poll.
  const { results: stored } = await db.prepare(
    `SELECT id, guid, title, url, media_type, media_url, duration_sec, thumbnail_url, summary
     FROM items WHERE source_id = ? ORDER BY id DESC LIMIT 400`).bind(source.id).all();
  const byGuid = new Map(stored.map((r) => [r.guid, r]));
  // "First poll" means nothing stored yet, not "never attempted": a source whose first
  // attempts failed must still have its backlog skipped when it finally loads.
  const firstPoll = stored.length === 0;
  // With a private feed, the full-episode audio merged in from it must not be replaced by
  // the public feed's preview on the next poll.
  const keepMedia = source.platform === 'substack' && !!source.private_feed_url;

  const stmts = [];
  let inserted = 0;
  let updated = 0;
  const seen = new Set();
  for (const it of items) {
    if (seen.has(it.guid)) continue; // a feed listing the same id twice
    seen.add(it.guid);
    const row = byGuid.get(it.guid);
    if (!row) {
      const published = it.published_at ?? at;
      const old = firstPoll && published < cutoff;
      stmts.push(db.prepare(UPSERT_ITEM).bind(
        source.id, it.guid, it.title, it.url, published, it.media_type, it.media_url,
        it.duration_sec, it.thumbnail_url, it.summary,
        old ? 'dismissed' : 'new', old ? at : null, at, old ? 1 : 0));
      inserted++;
      continue;
    }
    const mediaType = keepMedia ? row.media_type : it.media_type;
    const mediaUrl = keepMedia && row.media_url ? row.media_url : it.media_url;
    const duration = row.duration_sec || it.duration_sec || row.duration_sec;
    const thumbnail = row.thumbnail_url ?? it.thumbnail_url;
    const same = row.title === it.title && (row.url ?? null) === (it.url ?? null) && row.media_type === mediaType &&
      (row.media_url ?? null) === (mediaUrl ?? null) && (row.duration_sec ?? null) === (duration ?? null) &&
      (row.thumbnail_url ?? null) === (thumbnail ?? null) && (row.summary ?? null) === (it.summary ?? null);
    if (same) continue;
    stmts.push(db.prepare(
      `UPDATE items SET title = ?, url = ?, media_type = ?, media_url = ?, duration_sec = ?, thumbnail_url = ?, summary = ?
       WHERE id = ?`).bind(it.title, it.url, mediaType, mediaUrl, duration ?? null, thumbnail ?? null, it.summary, row.id));
    updated++;
  }
  stmts.push(db.prepare(
    `UPDATE sources SET last_polled_at = ?, last_status = 'ok', etag = ?, last_modified = ?,
            site_url = COALESCE(?, site_url) WHERE id = ?`)
    .bind(at, result.etag ?? null, result.last_modified ?? null, result.site_url ?? null, source.id));
  // OR IGNORE: feed_url is unique, and two sources must not be merged by a shared redirect target.
  if (result.moved_to) stmts.push(db.prepare('UPDATE OR IGNORE sources SET feed_url = ? WHERE id = ?').bind(result.moved_to, source.id));
  await db.batch(stmts);
  return { inserted, updated };
}

// ---- Substack episode details -------------------------------------------------
// A publication's /feed has no durations or episode art. Its podcast feed
// (api.substack.com/feed/podcast/<publication id>.rss) has both, keyed by post link.

const UA = { 'user-agent': 'feed-tracker/0.1 (personal feed reader)' };
const getText = async (url, fetchImpl) => {
  const res = await fetchImpl(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
};

// Podcast feeds run to hundreds of episodes, so this scans the text instead of building a document.
export function scanPodcastFeed(xml) {
  const out = new Map();
  for (const block of xml.split('<item>').slice(1)) {
    const link = block.match(/<link>([^<]+)<\/link>/)?.[1]?.trim();
    if (!link) continue;
    const dur = block.match(/<itunes:duration>([^<]+)<\/itunes:duration>/)?.[1]?.trim();
    const parts = dur ? dur.split(':').map(Number) : [];
    const seconds = parts.length && !parts.some(Number.isNaN) ? Math.round(parts.reduce((a, p) => a * 60 + p, 0)) : null;
    const image = block.match(/<itunes:image href="([^"]+)"/)?.[1]?.replace(/&amp;/g, '&') ?? null;
    const media = block.match(/<enclosure\b[^>]*\burl="([^"]+)"/)?.[1]?.replace(/&amp;/g, '&') ?? null;
    const title = block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1]?.trim() ?? null;
    const date = block.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1];
    const published = date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : null;
    out.set(link, { duration_sec: seconds || null, thumbnail_url: image, media_url: media, title, published_at: published });
  }
  return out;
}

// Fill in durations for a Substack source's recent audio items. Returns how many were updated.
export async function enrichSubstackAudio(db, source, { fetchImpl = fetch, privateFeeds = {} } = {}) {
  if (source.platform !== 'substack') return 0;
  const privateUrl = source.private_feed_url || privateFeeds[source.key] || null;
  if (privateUrl) return syncPrivateSubstackFeed(db, source, privateUrl, { fetchImpl });
  if (source.podcast_feed_url === '') return 0;
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const { results: missing } = await db.prepare(
    `SELECT id, url FROM items WHERE source_id = ? AND media_type <> 'text' AND duration_sec IS NULL
       AND url IS NOT NULL AND published_at >= ? ORDER BY published_at DESC LIMIT 25`).bind(source.id, since).all();
  if (!missing.length) return 0;

  let feedUrl = source.podcast_feed_url;
  if (feedUrl == null) {
    const page = await getText(missing[0].url, fetchImpl);
    const pubId = page.match(/"publication_id":(\d+)/)?.[1];
    feedUrl = pubId ? `https://api.substack.com/feed/podcast/${pubId}.rss` : '';
    await db.prepare('UPDATE sources SET podcast_feed_url = ? WHERE id = ?').bind(feedUrl, source.id).run();
    if (!feedUrl) return 0;
  }
  let xml;
  try { xml = await getText(feedUrl, fetchImpl); } catch (err) {
    // Some shows have no feed at this address. Stop asking instead of retrying on every poll.
    if (/HTTP 40[34]/.test(String(err?.message))) {
      await db.prepare("UPDATE sources SET podcast_feed_url = '' WHERE id = ?").bind(source.id).run();
      return 0;
    }
    throw err;
  }
  const details = scanPodcastFeed(xml);
  const stmts = [];
  for (const row of missing) {
    const d = details.get(row.url);
    if (d?.duration_sec) {
      stmts.push(db.prepare('UPDATE items SET duration_sec = ?, thumbnail_url = COALESCE(?, thumbnail_url) WHERE id = ?')
        .bind(d.duration_sec, d.thumbnail_url, row.id));
    }
  }
  if (stmts.length) await db.batch(stmts);
  return stmts.length;
}

// A paid Substack show's private podcast feed carries the full episodes. It is merged into
// the items already loaded from the publication's feed, matched on the post's address, so
// each episode stays one item: its audio is swapped for the full version and its duration
// and art are filled in. Subscriber-only episodes missing from the public feed are added.
export async function syncPrivateSubstackFeed(db, source, privateUrl, { fetchImpl = fetch, at = nowIso() } = {}) {
  const entries = [...scanPodcastFeed(await getText(privateUrl, fetchImpl))].slice(0, 40);
  if (!entries.length) return 0;
  const { results: existing } = await db.prepare(
    'SELECT id, url, media_url, duration_sec FROM items WHERE source_id = ? AND url IS NOT NULL ORDER BY published_at DESC LIMIT 300').bind(source.id).all();
  const byUrl = new Map(existing.map((r) => [r.url, r]));
  const cutoff = new Date(Date.parse(at) - BACKFILL_DAYS * 86400000).toISOString();
  const stmts = [];
  for (const [link, d] of entries) {
    if (!d.media_url) continue;
    const row = byUrl.get(link);
    if (row) {
      if (row.media_url === d.media_url && (row.duration_sec || !d.duration_sec)) continue;
      stmts.push(db.prepare(
        `UPDATE items SET media_url = ?, media_type = CASE WHEN media_type = 'text' THEN 'audio' ELSE media_type END,
                duration_sec = COALESCE(?, duration_sec), thumbnail_url = COALESCE(thumbnail_url, ?) WHERE id = ?`)
        .bind(d.media_url, d.duration_sec, d.thumbnail_url, row.id));
    } else if (d.title && d.published_at && d.published_at >= cutoff) {
      // Same id the publication feed would use (the post's address), so a later public copy merges.
      stmts.push(db.prepare(UPSERT_ITEM).bind(source.id, link, d.title, link, d.published_at, 'audio', d.media_url,
        d.duration_sec, d.thumbnail_url, null, 'new', null, at, 0));
    }
  }
  if (stmts.length) await db.batch(stmts);
  return stmts.length;
}

// ---- Listening time for text posts ---------------------------------------------
// Substack's archive listing gives each post's word count, including posts behind the
// paywall, in one request. That becomes an estimated read-aloud length.

export const SPOKEN_WPM = 160;
const spokenSeconds = (words) => Math.max(60, Math.round((words / SPOKEN_WPM) * 60));

export async function estimateSubstackText(db, source, { fetchImpl = fetch } = {}) {
  if (source.platform !== 'substack') return 0;
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const { results: missing } = await db.prepare(
    `SELECT id, url FROM items WHERE source_id = ? AND media_type = 'text' AND duration_sec IS NULL
       AND url IS NOT NULL AND published_at >= ? ORDER BY published_at DESC LIMIT 25`).bind(source.id, since).all();
  if (!missing.length) return 0;
  let origin;
  try { origin = new URL(missing[0].url).origin; } catch { return 0; }
  const res = await fetchImpl(`${origin}/api/v1/archive?sort=new&limit=25`, { headers: { ...UA, accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const posts = Array.isArray(data) ? data : data?.posts ?? [];
  const words = new Map(posts.filter((p) => p?.slug && p.wordcount > 0).map((p) => [p.slug, p.wordcount]));
  const slug = (u) => { try { return new URL(u).pathname.match(/^\/p\/([^/]+)/)?.[1] ?? null; } catch { return null; } };
  // 0 marks "looked, not found", so a post missing from the listing is not asked about again.
  const stmts = missing.map((m) => {
    const w = words.get(slug(m.url));
    return db.prepare('UPDATE items SET duration_sec = ? WHERE id = ? AND duration_sec IS NULL').bind(w ? spokenSeconds(w) : 0, m.id);
  });
  await db.batch(stmts);
  return missing.filter((m) => words.has(slug(m.url))).length;
}

export async function pendingTextSources(db, max = 6) {
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  // Only untriaged and queued items, which keeps this on the status index.
  const { results } = await db.prepare(
    `SELECT i.source_id FROM items i JOIN sources s ON s.id = i.source_id
     WHERE i.status IN ('new', 'queued') AND i.media_type = 'text' AND i.duration_sec IS NULL AND i.url IS NOT NULL
       AND i.published_at >= ? AND s.platform = 'substack' AND s.active = 1
     GROUP BY i.source_id ORDER BY RANDOM() LIMIT ?`).bind(since, max).all();
  return results.map((r) => r.source_id);
}

export async function backfillTextEstimates(db, opts = {}, ids = null) {
  let done = 0;
  for (const id of ids ?? await pendingTextSources(db)) {
    const source = await db.prepare('SELECT * FROM sources WHERE id = ?').bind(id).first();
    // A failure leaves the posts waiting: the random order means one unreachable
    // publication cannot hold up the others, and it is tried again on a later run.
    try { done += await estimateSubstackText(db, source, opts); } catch (err) {
      console.warn(`${source.key}: post lengths unavailable (${err?.message ?? err})`);
    }
  }
  return done;
}

export async function pollAndStore(db, source, opts = {}) {
  try {
    const result = await pollSource(source, opts);
    const { inserted } = await storePoll(db, source, result);
    // Only when the feed changed, and within a per-run budget: each lookup costs extra requests.
    if (result.status === 'ok' && source.platform === 'substack' && (opts.enrichBudget?.left ?? 1) > 0) {
      try {
        if (opts.enrichBudget) opts.enrichBudget.left--;
        await enrichSubstackAudio(db, source, opts);
      } catch (err) { console.warn(`${source.key}: episode details unavailable (${err?.message ?? err})`); }
      try { await estimateSubstackText(db, source, opts); } catch (err) { console.warn(`${source.key}: post lengths unavailable (${err?.message ?? err})`); }
    }
    return { key: source.key, ok: true, inserted };
  } catch (err) {
    const message = String(err?.message ?? err).slice(0, 200);
    await db.prepare('UPDATE sources SET last_polled_at = ?, last_status = ? WHERE id = ?')
      .bind(nowIso(), 'error: ' + message, source.id).run();
    return { key: source.key, ok: false, error: message };
  }
}

// Poll the sources that have waited longest. `limit` keeps one invocation inside the
// platform's subrequest budget (each source costs one fetch plus a few D1 calls).
//
// `fetchBudget` caps outbound requests for the whole run. Cloudflare's free plan allows 50
// per invocation and fails the run when it is exceeded, so polling stops taking new sources
// while there is still room for the ones in flight (each may need a second request) and for
// the duration lookup. Sources not reached are simply first in line next run.
export async function pollBatch(db, { limit = 20, concurrency = 6, sourceId = null, fetchBudget = 45, ...opts } = {}) {
  opts.enrichBudget ??= { left: 5 };
  const budget = { left: fetchBudget };
  const rawFetch = opts.fetchImpl ?? fetch;
  opts.fetchImpl = (url, init) => {
    if (budget.left <= 0) throw new Error('Request budget for this run is used up');
    budget.left--;
    return rawFetch(url, init);
  };
  // Publications with text posts still waiting for a length each need one request after
  // polling, so that many are held back from the polling budget.
  let waiting = [];
  if (!sourceId) {
    try { waiting = await pendingTextSources(db, 6); } catch (err) { console.warn(`post lengths unavailable (${err?.message ?? err})`); }
  }
  const reserve = (opts.youtubeApiKey ? 1 : 0) + waiting.length;
  let inFlight = 0;
  const query = sourceId
    ? db.prepare('SELECT * FROM sources WHERE id = ?').bind(sourceId)
    : db.prepare('SELECT * FROM sources WHERE active = 1 ORDER BY last_polled_at IS NOT NULL, last_polled_at LIMIT ?').bind(limit);
  const { results: sources } = await query.all();
  const out = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, sources.length) }, async () => {
    while (next < sources.length && budget.left - inFlight * 2 >= 2 + reserve) {
      inFlight++;
      // Episode details and post lengths cost up to three more requests; skip them when the
      // run is nearly out.
      const room = budget.left - inFlight * 2 >= 5 + reserve;
      try { out.push(await pollAndStore(db, sources[next++], room ? opts : { ...opts, enrichBudget: { left: 0 } })); }
      finally { inFlight--; }
    }
  }));
  // Text posts still waiting for a length (their feed has not changed since they arrived).
  if (waiting.length) {
    try { await backfillTextEstimates(db, opts, waiting.slice(0, Math.max(0, budget.left - (opts.youtubeApiKey ? 1 : 0)))); } catch (err) { console.warn(`post lengths unavailable (${err?.message ?? err})`); }
  }
  if (opts.youtubeApiKey && budget.left >= 1) {
    try { await fillYoutubeDurations(db, opts); } catch (err) { console.warn(`YouTube durations unavailable (${err?.message ?? err})`); }
  }
  return out;
}

// One API call per run fills in durations for the newest YouTube videos that lack one.
// 0 is stored when the API has no duration (live or upcoming), so those are not asked for again.
export async function fillYoutubeDurations(db, { youtubeApiKey, fetchImpl = fetch } = {}) {
  const { results } = await db.prepare(
    `SELECT id, guid FROM items WHERE guid LIKE 'yt:video:%' AND duration_sec IS NULL
     ORDER BY published_at DESC LIMIT 50`).all();
  if (!results.length) return 0;
  const ids = results.map((r) => r.guid.slice('yt:video:'.length));
  const durations = await fetchDurations(ids, { apiKey: youtubeApiKey, fetchImpl });
  await db.batch(results.map((r, i) => db.prepare('UPDATE items SET duration_sec = ? WHERE id = ?').bind(durations.get(ids[i]) ?? 0, r.id)));
  return results.length;
}

// ---- reads for the API -------------------------------------------------------

const VIEW_SQL = {
  new: { where: "i.status = 'new' AND s.active = 1", order: 'i.published_at DESC, i.id DESC' },
  queue: { where: "i.status = 'queued'", order: 'i.queue_position ASC, i.id ASC' },
  // The hint keeps this on the small partial index instead of walking every dismissed row.
  cleared: { hint: 'INDEXED BY items_cleared', where: "i.auto_dismissed = 0 AND i.status IN ('dismissed', 'done')", order: 'i.status_changed_at DESC, i.id DESC' },
  // Older items skipped automatically when their source was first checked.
  backlog: { where: "i.status = 'dismissed' AND i.auto_dismissed = 1", order: 'i.published_at DESC, i.id DESC' },
};

export async function listItems(db, { view = 'new', type = 'all', source = null, q = '', minMinutes = 0, limit = 100, offset = 0 } = {}) {
  const v = VIEW_SQL[view] ?? VIEW_SQL.new;
  const where = [v.where];
  const args = [];
  if (type === 'text') where.push("i.media_type = 'text'");
  if (type === 'av') where.push("i.media_type <> 'text'");
  if (source) { where.push('i.source_id = ?'); args.push(Number(source)); }
  // Hides only items known to be shorter (for text posts, the estimated listening time).
  // Items with no recorded length stay.
  const minSec = Math.round((Number(minMinutes) || 0) * 60);
  if (minSec > 0) { where.push('(i.duration_sec IS NULL OR i.duration_sec = 0 OR i.duration_sec >= ?)'); args.push(minSec); }
  if (q) { where.push("i.title LIKE ? ESCAPE '\\'"); args.push('%' + q.replace(/[\\%_]/g, '\\$&') + '%'); }
  const cap = Math.max(1, Math.min(200, Number(limit) || 100));
  const sql = `
    SELECT i.id, i.source_id, s.name AS source_name, s.platform, i.title, i.url, i.published_at,
           i.media_type, i.media_url, i.duration_sec, i.thumbnail_url, i.summary, i.status,
           i.status_changed_at, i.tts_status, i.position_sec
    FROM items i ${v.hint ?? ''} JOIN sources s ON s.id = i.source_id
    WHERE ${where.join(' AND ')}
    ORDER BY ${v.order}
    LIMIT ? OFFSET ?`;
  const { results } = await db.prepare(sql).bind(...args, cap + 1, Math.max(0, Number(offset) || 0)).all();
  const total = await db.prepare(
    `SELECT COUNT(*) AS n FROM items i ${v.hint ?? ''} JOIN sources s ON s.id = i.source_id WHERE ${where.join(' AND ')}`)
    .bind(...args).first();
  return { items: results.slice(0, cap), more: results.length > cap, total: total.n };
}

// Counts and the source list for the page chrome. Each count reads only the rows it counts
// (D1's free plan caps rows read per day), so the large skipped backlog is counted only
// when asked for.
export async function getState(db, { backlog = true } = {}) {
  const stmts = [
    db.prepare("SELECT COUNT(*) AS n FROM items i JOIN sources s ON s.id = i.source_id WHERE i.status = 'new' AND s.active = 1"),
    db.prepare("SELECT COUNT(*) AS n FROM items WHERE status = 'queued'"),
    db.prepare("SELECT COUNT(*) AS n FROM items INDEXED BY items_cleared WHERE auto_dismissed = 0 AND status IN ('dismissed', 'done')"),
    db.prepare("SELECT source_id, COUNT(*) AS n FROM items WHERE status = 'new' GROUP BY source_id"),
    db.prepare(`
      SELECT s.id, s.key, s.platform, s.name, s.feed_url, s.site_url, s.active, s.last_polled_at, s.last_status,
             (s.private_feed_url IS NOT NULL AND s.private_feed_url <> '') AS has_private_feed
      FROM sources s ORDER BY s.name COLLATE NOCASE`),
  ];
  if (backlog) stmts.push(db.prepare("SELECT COUNT(*) AS n FROM items WHERE status = 'dismissed' AND auto_dismissed = 1"));
  const rows = await Promise.all(stmts.map((st) => st.all()));
  const one = (i) => rows[i].results[0]?.n ?? 0;
  const newBySource = new Map(rows[3].results.map((r) => [r.source_id, r.n]));
  const counts = { new: one(0), queue: one(1), cleared: one(2) };
  if (backlog) counts.backlog = one(5);
  return { counts, sources: rows[4].results.map((s) => ({ ...s, new_count: newBySource.get(s.id) ?? 0 })) };
}

const STATUSES = new Set(['new', 'queued', 'dismissed', 'done']);

export async function setItemStatus(db, id, status) {
  if (!STATUSES.has(status)) throw new RangeError('Unknown status: ' + status);
  const at = nowIso();
  const res = await db.prepare(
    `UPDATE items SET status = ?, status_changed_at = ?, auto_dismissed = 0,
            queue_position = CASE WHEN ? = 'queued' THEN ? ELSE NULL END
     WHERE id = ?`)
    .bind(status, status === 'new' ? null : at, status, Date.now(), Number(id)).run();
  return (res.meta?.changes ?? 0) > 0;
}

// Playback position, shared across devices. Zero clears it.
export async function setItemPosition(db, id, seconds, at = nowIso()) {
  const sec = seconds;
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0 || sec > 1_000_000) throw new RangeError('position_sec must be a number of seconds');
  const res = await db.prepare('UPDATE items SET position_sec = ?, position_at = ? WHERE id = ?')
    .bind(sec > 0 ? Math.round(sec * 10) / 10 : null, at, Number(id)).run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function getItemPosition(db, id) {
  return db.prepare('SELECT position_sec, position_at FROM items WHERE id = ?').bind(Number(id)).first();
}

export async function addSource(db, { key, platform, name, feed_url, site_url = null }) {
  const existing = await db.prepare('SELECT * FROM sources WHERE key = ? OR feed_url = ?').bind(key, feed_url).first();
  if (existing) {
    if (!existing.active) await db.prepare('UPDATE sources SET active = 1 WHERE id = ?').bind(existing.id).run();
    return { source: { ...existing, active: 1 }, created: false };
  }
  await db.prepare('INSERT INTO sources (key, platform, name, feed_url, site_url) VALUES (?, ?, ?, ?, ?)')
    .bind(key, platform, name, feed_url, site_url).run();
  const source = await db.prepare('SELECT * FROM sources WHERE key = ?').bind(key).first();
  return { source, created: true };
}

export async function updateSource(db, id, { active, name, private_feed_url: privateUrl }) {
  const sets = [];
  const args = [];
  if (privateUrl !== undefined) {
    const value = String(privateUrl ?? '').trim();
    if (value && !/^https:\/\/[^\s]+$/.test(value)) throw new RangeError('The private feed must be an https address');
    sets.push('private_feed_url = ?'); args.push(value || null);
  }
  if (active !== undefined) { sets.push('active = ?'); args.push(active ? 1 : 0); }
  if (typeof name === 'string' && name.trim()) { sets.push('name = ?'); args.push(name.trim().slice(0, 200)); }
  if (!sets.length) return false;
  const res = await db.prepare(`UPDATE sources SET ${sets.join(', ')} WHERE id = ?`).bind(...args, Number(id)).run();
  return (res.meta?.changes ?? 0) > 0;
}

// Removing a source removes its items too (ON DELETE CASCADE needs foreign keys on,
// which D1 enforces; the explicit delete keeps it true everywhere).
export async function deleteSource(db, id) {
  const res = await db.batch([
    db.prepare('DELETE FROM items WHERE source_id = ?').bind(Number(id)),
    db.prepare('DELETE FROM sources WHERE id = ?').bind(Number(id)),
  ]);
  return (res[1].meta?.changes ?? 0) > 0;
}
