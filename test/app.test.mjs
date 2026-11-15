import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createDb } from './d1-shim.mjs';
import { storePoll, pollBatch, listItems, getState, addSource, setItemStatus, scanPodcastFeed, enrichSubstackAudio } from '../src/store.js';
import { resolveSource } from '../src/resolve.js';
import worker from '../src/worker.js';

const fixture = (name) => readFile(path.join(import.meta.dirname, 'fixtures', name), 'utf8');
const item = (guid, published_at, extra = {}) => ({
  guid, title: 'Title ' + guid, url: 'https://example.com/' + guid, published_at,
  media_type: 'text', media_url: null, duration_sec: null, thumbnail_url: null, summary: null, ...extra,
});

async function seeded() {
  const db = await createDb();
  const { source } = await addSource(db, { key: 'substack:example', platform: 'substack', name: 'Example', feed_url: 'https://example.substack.com/feed' });
  return { db, source };
}

test('first poll dismisses old items; later polls keep the user’s status', async () => {
  const { db, source } = await seeded();
  const at = '2026-11-14T12:00:00Z';
  const first = await storePoll(db, source, {
    status: 'ok',
    items: [item('fresh', '2026-11-13T10:00:00.000Z'), item('stale', '2026-10-01T10:00:00.000Z')],
  }, at);
  assert.equal(first.inserted, 2);
  const rows = db.sqlite.prepare('SELECT guid, status FROM items ORDER BY guid').all();
  assert.deepEqual(rows.map((r) => [r.guid, r.status]), [['fresh', 'new'], ['stale', 'dismissed']]);

  db.sqlite.prepare("UPDATE items SET status = 'queued' WHERE guid = 'fresh'").run();
  const polled = db.sqlite.prepare('SELECT * FROM sources').get();
  const second = await storePoll(db, polled, {
    status: 'ok',
    items: [item('fresh', '2026-11-13T10:00:00.000Z', { title: 'Retitled' }), item('older-but-new-to-us', '2026-09-01T00:00:00.000Z')],
  }, '2026-11-14T13:00:00Z');
  assert.equal(second.inserted, 1);
  const after = Object.fromEntries(db.sqlite.prepare('SELECT guid, status, title FROM items').all().map((r) => [r.guid, r]));
  assert.equal(after.fresh.status, 'queued');
  assert.equal(after.fresh.title, 'Retitled');
  // Only the first poll backfills as dismissed.
  assert.equal(after['older-but-new-to-us'].status, 'new');
});

test('pollBatch stores items and records failures per source', async () => {
  const { db } = await seeded();
  await addSource(db, { key: 'rss:broken', platform: 'rss', name: 'Broken', feed_url: 'https://broken.example/feed' });
  const xml = await fixture('substack.xml');
  const fetchImpl = async (url) => (url.includes('broken') ? new Response('no', { status: 500 }) : new Response(xml, { headers: { etag: '"a"' } }));
  const results = await pollBatch(db, { fetchImpl });
  assert.equal(results.length, 2);
  assert.equal(results.find((r) => r.key === 'substack:example').inserted, 2);
  assert.match(results.find((r) => r.key === 'rss:broken').error, /HTTP 500/);
  const sources = Object.fromEntries(db.sqlite.prepare('SELECT key, last_status, etag FROM sources').all().map((r) => [r.key, r]));
  assert.equal(sources['substack:example'].last_status, 'ok');
  assert.equal(sources['substack:example'].etag, '"a"');
  assert.match(sources['rss:broken'].last_status, /^error: HTTP 500/);
});

test('resolveSource: Substack home page, YouTube channel, plain feed', async () => {
  const rss = await fixture('substack.xml');
  const atom = await fixture('youtube.xml');
  const id = 'UC' + 'a'.repeat(22);
  const fetchImpl = async (url) => {
    if (url === 'https://example.substack.com/') return new Response('<html><head><link rel="alternate" type="application/rss+xml" href="/feed"></head></html>');
    if (url === 'https://example.substack.com/feed') return new Response(rss);
    if (url === 'https://www.youtube.com/@example') return new Response(`<link rel="canonical" href="https://www.youtube.com/channel/${id}"><meta property="og:title" content="Example &amp; Co">`);
    if (url.startsWith('https://www.youtube.com/feeds/videos.xml')) return new Response(atom);
    return new Response('nope', { status: 404 });
  };
  assert.deepEqual(await resolveSource('example.substack.com', { fetchImpl }), {
    key: 'substack:example', platform: 'substack', name: 'Example Letter',
    feed_url: 'https://example.substack.com/feed', site_url: 'https://example.substack.com',
  });
  const yt = await resolveSource('https://www.youtube.com/@example', { fetchImpl });
  assert.equal(yt.key, 'youtube:' + id);
  assert.equal(yt.name, 'Example & Co');
  assert.match(yt.feed_url, /playlist_id=UULFa{22}$/);
  await assert.rejects(resolveSource('https://nothing.example', { fetchImpl }), /HTTP 404/);
});

test('API: auth, listing, status changes, queue order, source toggles', async () => {
  const { db, source } = await seeded();
  await storePoll(db, source, {
    status: 'ok',
    items: [
      item('a', '2026-11-14T10:00:00.000Z'),
      item('b', '2026-11-13T10:00:00.000Z', { media_type: 'audio', media_url: 'https://cdn.example/b.mp3' }),
      item('c', '2026-11-12T10:00:00.000Z'),
    ],
  }, '2026-11-14T12:00:00Z');

  const call = (env, method, p, bodyObj, token = 'secret') => worker.fetch(new Request('https://app.example' + p, {
    method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: bodyObj ? JSON.stringify(bodyObj) : undefined,
  }), env, {});
  const env = { DB: db, APP_TOKEN: 'secret' };

  assert.equal((await call({ DB: db }, 'GET', '/api/state')).status, 503);
  assert.equal((await call(env, 'GET', '/api/state', null, 'wrong')).status, 401);

  const state = await (await call(env, 'GET', '/api/state')).json();
  assert.deepEqual(state.counts, { new: 3, queue: 0, cleared: 0, backlog: 0 });
  assert.equal(state.sources[0].new_count, 3);

  const all = await (await call(env, 'GET', '/api/items?view=new')).json();
  assert.deepEqual(all.items.map((i) => i.title), ['Title a', 'Title b', 'Title c']);
  const av = await (await call(env, 'GET', '/api/items?view=new&type=av')).json();
  assert.deepEqual(av.items.map((i) => i.media_url), ['https://cdn.example/b.mp3']);
  const search = await (await call(env, 'GET', '/api/items?view=new&q=' + encodeURIComponent('le c'))).json();
  assert.equal(search.total, 1);

  const [a, b, c] = all.items;
  assert.equal((await call(env, 'POST', `/api/items/${c.id}`, { status: 'queued' })).status, 200);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await call(env, 'POST', `/api/items/${a.id}`, { status: 'queued' })).status, 200);
  assert.equal((await call(env, 'POST', `/api/items/${b.id}`, { status: 'dismissed' })).status, 200);
  assert.equal((await call(env, 'POST', `/api/items/${b.id}`, { status: 'bogus' })).status, 400);
  assert.equal((await call(env, 'POST', '/api/items/9999', { status: 'done' })).status, 404);

  const queue = await (await call(env, 'GET', '/api/items?view=queue')).json();
  assert.deepEqual(queue.items.map((i) => i.title), ['Title c', 'Title a'], 'queue keeps the order items were added');
  assert.deepEqual((await getState(db)).counts, { new: 0, queue: 2, cleared: 1, backlog: 0 });

  // Undo: back to new.
  await call(env, 'POST', `/api/items/${b.id}`, { status: 'new' });
  assert.equal((await listItems(db, { view: 'new' })).total, 1);

  // Pausing a source hides its new items; removing it deletes them.
  assert.equal((await call(env, 'PATCH', `/api/sources/${source.id}`, { active: false })).status, 200);
  assert.equal((await getState(db)).counts.new, 0);
  assert.equal((await call(env, 'DELETE', `/api/sources/${source.id}`)).status, 200);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM items').get().n, 0);
  assert.equal((await call(env, 'GET', '/api/nope')).status, 404);
});

test('the skipped backlog stays out of Cleared until an item is restored', async () => {
  const { db, source } = await seeded();
  await storePoll(db, source, {
    status: 'ok',
    items: [item('fresh', '2026-11-13T10:00:00.000Z'), item('stale', '2026-10-01T10:00:00.000Z')],
  }, '2026-11-14T12:00:00Z');
  const fresh = db.sqlite.prepare("SELECT id FROM items WHERE guid = 'fresh'").get().id;
  const stale = db.sqlite.prepare("SELECT id FROM items WHERE guid = 'stale'").get().id;
  await setItemStatus(db, fresh, 'dismissed');

  assert.deepEqual((await getState(db)).counts, { new: 0, queue: 0, cleared: 1, backlog: 1 });
  assert.deepEqual((await listItems(db, { view: 'cleared' })).items.map((i) => i.id), [fresh]);
  assert.deepEqual((await listItems(db, { view: 'backlog' })).items.map((i) => i.id), [stale]);

  // Restoring then dismissing by hand makes it an ordinary cleared item.
  await setItemStatus(db, stale, 'new');
  await setItemStatus(db, stale, 'dismissed');
  assert.deepEqual((await getState(db)).counts, { new: 0, queue: 0, cleared: 2, backlog: 0 });
});

test('Substack episodes pick up duration and art from the show\u2019s podcast feed', async () => {
  const { db, source } = await seeded();
  const post = 'https://example.substack.com/p/episode-12';
  await storePoll(db, source, {
    status: 'ok',
    items: [item('ep', new Date().toISOString(), { url: post, media_type: 'audio', media_url: 'https://api.substack.com/feed/podcast/1/a.mp3' })],
  });
  const podcastXml = `<rss><channel><item><title>Ep</title><link>${post}</link>
    <itunes:duration>1797</itunes:duration><itunes:image href="https://substackcdn.com/feed/podcast/94899/post/1/art.jpg"/></item>
    <item><link>https://example.substack.com/p/other</link><itunes:duration>1:02:05</itunes:duration></item></channel></rss>`;
  assert.deepEqual(scanPodcastFeed(podcastXml).get('https://example.substack.com/p/other'), { duration_sec: 3725, thumbnail_url: null });

  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === post) return new Response('<script>{"publication_id":94899,"x":1}</script>');
    if (url === 'https://api.substack.com/feed/podcast/94899.rss') return new Response(podcastXml);
    return new Response('no', { status: 404 });
  };
  const row = () => db.sqlite.prepare('SELECT * FROM sources').get();
  assert.equal(await enrichSubstackAudio(db, row(), { fetchImpl }), 1);
  const ep = db.sqlite.prepare("SELECT duration_sec, thumbnail_url FROM items WHERE guid = 'ep'").get();
  assert.equal(ep.duration_sec, 1797);
  assert.match(ep.thumbnail_url, /art\.jpg$/);
  assert.equal(row().podcast_feed_url, 'https://api.substack.com/feed/podcast/94899.rss');

  // Nothing left to fill in: no further requests.
  const before = calls.length;
  assert.equal(await enrichSubstackAudio(db, row(), { fetchImpl }), 0);
  assert.equal(calls.length, before);
});

test('YouTube via the Data API: items, empty playlists, 304s, quota errors, durations', async () => {
  const { pollYoutube, parseIsoDuration, playlistIdOf } = await import('../src/youtube.js');
  const { fillYoutubeDurations } = await import('../src/store.js');
  const id = 'UC' + 'b'.repeat(22);
  const db = await createDb();
  const { source } = await addSource(db, { key: 'youtube:' + id, platform: 'youtube', name: 'Chan', feed_url: `https://www.youtube.com/feeds/videos.xml?playlist_id=UULF${'b'.repeat(22)}` });
  assert.equal(playlistIdOf(source), 'UULF' + 'b'.repeat(22));
  assert.equal(playlistIdOf({ key: 'youtube:' + id, feed_url: `https://www.youtube.com/feeds/videos.xml?channel_id=${id}` }), 'UU' + 'b'.repeat(22));
  assert.equal(parseIsoDuration('PT1H2M5S'), 3725);
  assert.equal(parseIsoDuration('PT45S'), 45);
  assert.equal(parseIsoDuration('P0D'), null);

  let mode = 'ok';
  const seen = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    seen.push({ path: u.pathname, params: Object.fromEntries(u.searchParams), headers: init.headers });
    if (u.pathname.endsWith('/videos')) {
      return Response.json({ items: [{ id: 'vid1', contentDetails: { duration: 'PT12M30S' } }, { id: 'live1', contentDetails: { duration: 'P0D' } }] });
    }
    if (mode === 'missing') return Response.json({ error: { errors: [{ reason: 'playlistNotFound' }] } }, { status: 404 });
    if (mode === 'quota') return Response.json({ error: { errors: [{ reason: 'quotaExceeded' }] } }, { status: 403 });
    if (init.headers['if-none-match'] === '"e1"') return new Response(null, { status: 304 });
    return Response.json({
      etag: '"e1"',
      items: [
        { snippet: { title: 'First video', description: 'About  things', publishedAt: '2026-11-14T10:00:00Z', thumbnails: { medium: { url: 'https://i.ytimg.com/vi/vid1/mqdefault.jpg' } }, resourceId: { videoId: 'vid1' } }, contentDetails: { videoId: 'vid1', videoPublishedAt: '2026-11-14T09:00:00Z' } },
        { snippet: { title: 'Live now', publishedAt: '2026-11-14T11:00:00Z', resourceId: { videoId: 'live1' } }, contentDetails: { videoId: 'live1' } },
        { snippet: { title: 'Private video', resourceId: { videoId: 'gone' } }, contentDetails: { videoId: 'gone' } },
      ],
    });
  };

  const opts = { fetchImpl, youtubeApiKey: 'k' };
  const [first] = await pollBatch(db, opts);
  assert.deepEqual([first.ok, first.inserted], [true, 2]);
  assert.equal(seen[0].params.playlistId, 'UULF' + 'b'.repeat(22));
  assert.equal(seen[0].params.key, 'k');
  const rows = Object.fromEntries(db.sqlite.prepare('SELECT guid, title, url, media_type, duration_sec, thumbnail_url, published_at, summary FROM items').all().map((r) => [r.guid, r]));
  assert.equal(rows['yt:video:vid1'].url, 'https://www.youtube.com/watch?v=vid1');
  assert.equal(rows['yt:video:vid1'].media_type, 'video');
  assert.equal(rows['yt:video:vid1'].published_at, '2026-11-14T09:00:00.000Z');
  assert.equal(rows['yt:video:vid1'].summary, 'About things');
  assert.equal(rows['yt:video:vid1'].duration_sec, 750, 'duration filled in by the same run');
  assert.equal(rows['yt:video:live1'].duration_sec, 0, 'no duration yet: recorded so it is not asked for again');
  assert.equal(await fillYoutubeDurations(db, opts), 0);

  // Unchanged playlist: conditional request, nothing new.
  const [second] = await pollBatch(db, opts);
  assert.equal(second.inserted, 0);
  assert.equal(db.sqlite.prepare('SELECT last_status FROM sources').get().last_status, 'not_modified');

  db.sqlite.prepare('UPDATE sources SET etag = NULL').run();
  mode = 'missing';
  const empty = await pollYoutube(db.sqlite.prepare('SELECT * FROM sources').get(), { apiKey: 'k', fetchImpl });
  assert.deepEqual([empty.status, empty.items.length], ['ok', 0]);

  mode = 'quota';
  const [third] = await pollBatch(db, opts);
  assert.equal(third.ok, false);
  assert.match(third.error, /daily quota/);
  assert.ok(!/key=/.test(db.sqlite.prepare('SELECT last_status FROM sources').get().last_status), 'the key never lands in stored errors');
});

test('a run stays inside its request budget and leaves the rest for next time', async () => {
  const db = await createDb();
  for (let i = 0; i < 30; i++) {
    await addSource(db, { key: `rss:s${i}`, platform: 'rss', name: `S${i}`, feed_url: `https://s${i}.example/feed` });
  }
  const xml = await fixture('substack.xml');
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response(xml); };

  const first = await pollBatch(db, { limit: 100, fetchBudget: 12, fetchImpl });
  assert.ok(calls <= 12, `made ${calls} requests`);
  assert.ok(first.length >= 5 && first.length < 30, `polled ${first.length}`);
  assert.ok(first.every((r) => r.ok), 'no source is failed by the budget');
  const waiting = () => db.sqlite.prepare('SELECT COUNT(*) AS n FROM sources WHERE last_polled_at IS NULL').get().n;
  assert.equal(waiting(), 30 - first.length);

  // Repeated runs work through the remainder without re-polling the same sources first.
  for (let i = 0; i < 6 && waiting() > 0; i++) await pollBatch(db, { limit: 100, fetchBudget: 12, fetchImpl });
  assert.equal(waiting(), 0);
});

test('redirects count against the budget and the feed’s real address is remembered', async () => {
  const { db } = await seeded();
  const xml = await fixture('substack.xml');
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    assert.equal(init.redirect, 'manual');
    if (url === 'https://example.substack.com/feed') return new Response(null, { status: 301, headers: { location: 'https://www.example.com/feed' } });
    return new Response(xml);
  };
  const [r] = await pollBatch(db, { fetchImpl, fetchBudget: 10 });
  assert.equal(r.inserted, 2);
  assert.deepEqual(calls.slice(0, 2), ['https://example.substack.com/feed', 'https://www.example.com/feed']);
  assert.equal(db.sqlite.prepare('SELECT feed_url FROM sources').get().feed_url, 'https://www.example.com/feed');

  // Next poll goes straight to the new address.
  calls.length = 0;
  await pollBatch(db, { fetchImpl, fetchBudget: 10 });
  assert.equal(calls[0], 'https://www.example.com/feed');
});

test('a source whose first attempts failed still has its backlog skipped when it loads', async () => {
  const { db } = await seeded();
  const [bad] = await pollBatch(db, { fetchImpl: async () => new Response('no', { status: 500 }) });
  assert.equal(bad.ok, false);
  const source = db.sqlite.prepare('SELECT * FROM sources').get();
  assert.ok(source.last_polled_at, 'the failed attempt is recorded');

  await storePoll(db, source, {
    status: 'ok',
    items: [item('fresh', '2026-11-13T10:00:00.000Z'), item('stale', '2026-10-01T10:00:00.000Z')],
  }, '2026-11-14T12:00:00Z');
  const rows = Object.fromEntries(db.sqlite.prepare('SELECT guid, status, auto_dismissed FROM items').all().map((r) => [r.guid, r]));
  assert.equal(rows.fresh.status, 'new');
  assert.deepEqual([rows.stale.status, rows.stale.auto_dismissed], ['dismissed', 1]);
});
