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
  assert.deepEqual(state.counts, { new: 3, queue: 0, cleared: 0 }, 'the backlog is only counted on request');
  assert.equal((await (await call(env, 'GET', '/api/state?backlog=1')).json()).counts.backlog, 0);
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
  const other = scanPodcastFeed(podcastXml).get('https://example.substack.com/p/other');
  assert.deepEqual([other.duration_sec, other.thumbnail_url], [3725, null]);

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

test('a private Substack feed upgrades existing episodes in place and adds subscriber-only ones', async () => {
  const { syncPrivateSubstackFeed } = await import('../src/store.js');
  const { db, source } = await seeded();
  const at = '2026-11-14T12:00:00Z';
  const post = (slug) => `https://example.substack.com/p/${slug}`;
  await storePoll(db, source, {
    status: 'ok',
    items: [
      item(post('ep-public'), '2026-11-13T10:00:00.000Z', { url: post('ep-public'), media_type: 'audio', media_url: 'https://api.substack.com/feed/podcast/1/preview.mp3' }),
      item(post('essay'), '2026-11-12T10:00:00.000Z', { url: post('essay') }),
    ],
  }, at);
  const privateXml = `<rss><channel>
    <item><title><![CDATA[Episode, in full]]></title><link>${post('ep-public')}</link><guid isPermaLink="false">substack:post:1</guid>
      <pubDate>Fri, 13 Nov 2026 10:00:00 GMT</pubDate><enclosure url="https://api.substack.com/feed/podcast/1/private/full.mp3?token=abc&amp;x=1" type="audio/mpeg"/>
      <itunes:duration>3600</itunes:duration><itunes:image href="https://substackcdn.com/art.jpg"/></item>
    <item><title>Subscriber only</title><link>${post('ep-paid')}</link><guid isPermaLink="false">substack:post:2</guid>
      <pubDate>Thu, 12 Nov 2026 09:00:00 GMT</pubDate><enclosure url="https://api.substack.com/feed/podcast/2/private/paid.mp3" type="audio/mpeg"/><itunes:duration>120</itunes:duration></item>
    <item><title>Ancient</title><link>${post('ep-old')}</link><pubDate>Thu, 01 Jan 2026 09:00:00 GMT</pubDate><enclosure url="https://api.substack.com/x.mp3" type="audio/mpeg"/></item>
  </channel></rss>`;
  const fetchImpl = async () => new Response(privateXml);
  const src = db.sqlite.prepare('SELECT * FROM sources').get();

  assert.equal(await syncPrivateSubstackFeed(db, src, 'https://api.substack.com/feed/podcast/9/private/t.rss', { fetchImpl, at }), 2);
  const rows = Object.fromEntries(db.sqlite.prepare('SELECT guid, title, media_type, media_url, duration_sec, status FROM items').all().map((r) => [r.guid, r]));
  assert.equal(Object.keys(rows).length, 3, 'no duplicate of the public episode, and the old one is not added');
  assert.equal(rows[post('ep-public')].media_url, 'https://api.substack.com/feed/podcast/1/private/full.mp3?token=abc&x=1');
  assert.equal(rows[post('ep-public')].duration_sec, 3600);
  assert.equal(rows[post('ep-public')].title, 'Title ' + post('ep-public'), 'the existing item is kept, only its media changes');
  assert.deepEqual([rows[post('ep-paid')].title, rows[post('ep-paid')].media_type, rows[post('ep-paid')].status], ['Subscriber only', 'audio', 'new']);
  assert.equal(rows[post('essay')].media_type, 'text');

  // Running it again changes nothing.
  assert.equal(await syncPrivateSubstackFeed(db, src, 'https://x', { fetchImpl, at }), 0);

  // If the public feed later lists the subscriber-only episode, it merges into the same item.
  await storePoll(db, db.sqlite.prepare('SELECT * FROM sources').get(), {
    status: 'ok', items: [item(post('ep-paid'), '2026-11-12T09:00:00.000Z', { url: post('ep-paid'), media_type: 'audio', media_url: 'https://api.substack.com/feed/podcast/2/preview.mp3' })],
  }, at);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM items').get().n, 3);
});

test('API: saving a private feed applies it, hides the address, and rejects bad ones', async () => {
  const { db, source } = await seeded();
  const env = { DB: db, APP_TOKEN: 'secret' };
  const call = (method, p, bodyObj) => worker.fetch(new Request('https://app.example' + p, {
    method, headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body: bodyObj ? JSON.stringify(bodyObj) : undefined,
  }), env, {});
  assert.equal((await call('PATCH', `/api/sources/${source.id}`, { private_feed_url: 'not a url' })).status, 400);

  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('gone', { status: 404 });
    const bad = await call('PATCH', `/api/sources/${source.id}`, { private_feed_url: 'https://api.substack.com/feed/podcast/9/private/bad.rss' });
    assert.equal(bad.status, 400);
    assert.equal(db.sqlite.prepare('SELECT private_feed_url FROM sources').get().private_feed_url, null, 'an unreadable address is not kept');

    globalThis.fetch = async () => new Response('<rss><channel></channel></rss>');
    const ok = await call('PATCH', `/api/sources/${source.id}`, { private_feed_url: 'https://api.substack.com/feed/podcast/9/private/good.rss' });
    assert.equal(ok.status, 200);
  } finally { globalThis.fetch = realFetch; }

  const state = await (await call('GET', '/api/state')).json();
  assert.equal(state.sources[0].has_private_feed, 1);
  assert.ok(!JSON.stringify(state).includes('good.rss'), 'the address is never sent back');
  assert.equal((await call('PATCH', `/api/sources/${source.id}`, { private_feed_url: '' })).status, 200);
  assert.equal((await getState(db)).sources[0].has_private_feed, 0);
});

test('minimum-length filter hides known-short items and keeps text and unknown lengths', async () => {
  const { db, source } = await seeded();
  await storePoll(db, source, {
    status: 'ok',
    items: [
      item('clip', '2026-11-14T10:00:00.000Z', { media_type: 'video', duration_sec: 240 }),
      item('show', '2026-11-14T09:00:00.000Z', { media_type: 'video', duration_sec: 3600 }),
      item('exactly-ten', '2026-11-14T08:00:00.000Z', { media_type: 'audio', duration_sec: 600 }),
      item('unknown', '2026-11-14T07:00:00.000Z', { media_type: 'audio', duration_sec: null }),
      item('essay', '2026-11-14T06:00:00.000Z'),
    ],
  }, '2026-11-14T12:00:00Z');
  db.sqlite.prepare("UPDATE items SET duration_sec = 0 WHERE guid = 'unknown'").run();
  const guids = async (opts) => (await listItems(db, opts)).items.map((i) => db.sqlite.prepare('SELECT guid FROM items WHERE id = ?').get(i.id).guid);
  assert.deepEqual(await guids({ view: 'new' }), ['clip', 'show', 'exactly-ten', 'unknown', 'essay']);
  assert.deepEqual(await guids({ view: 'new', minMinutes: 10 }), ['show', 'exactly-ten', 'unknown', 'essay']);
  assert.deepEqual(await guids({ view: 'new', minMinutes: '30' }), ['show', 'unknown', 'essay']);
  assert.equal((await listItems(db, { view: 'new', minMinutes: 30 })).total, 3);

  const res = await worker.fetch(new Request('https://app.example/api/items?view=new&min_minutes=30&type=av', { headers: { authorization: 'Bearer s' } }), { DB: db, APP_TOKEN: 's' }, {});
  assert.deepEqual((await res.json()).items.map((i) => i.title), ['Title show', 'Title unknown']);
});

test('polling an unchanged feed writes no item rows, and a private feed’s audio survives public polls', async () => {
  const { db, source } = await seeded();
  const at = '2026-11-14T12:00:00Z';
  const feed = () => ({ status: 'ok', items: [
    item('a', '2026-11-13T10:00:00.000Z', { media_type: 'audio', media_url: 'https://cdn.example/preview.mp3', summary: 'S' }),
    item('b', '2026-11-12T10:00:00.000Z'),
  ] });
  assert.deepEqual(await storePoll(db, source, feed(), at), { inserted: 2, updated: 0 });

  // Count statements sent in the batch: only the source's own bookkeeping row.
  const realBatch = db.batch;
  let batchSizes = [];
  db.batch = (stmts) => { batchSizes.push(stmts.length); return realBatch(stmts); };
  const row = () => db.sqlite.prepare('SELECT * FROM sources').get();
  assert.deepEqual(await storePoll(db, row(), feed(), '2026-11-14T13:00:00Z'), { inserted: 0, updated: 0 });
  assert.deepEqual(batchSizes, [1]);

  // Details filled in later (duration, art) are not undone by a feed that lacks them.
  db.sqlite.prepare("UPDATE items SET duration_sec = 900, thumbnail_url = 'https://cdn.example/art.jpg' WHERE guid = 'a'").run();
  batchSizes = [];
  assert.deepEqual(await storePoll(db, row(), feed(), '2026-11-14T14:00:00Z'), { inserted: 0, updated: 0 });
  assert.deepEqual(batchSizes, [1]);

  // A real change is written, once.
  const changed = feed(); changed.items[1].title = 'B, retitled';
  assert.deepEqual(await storePoll(db, row(), changed, '2026-11-14T15:00:00Z'), { inserted: 0, updated: 1 });

  // With a private feed saved, the merged-in full audio is kept when the public feed is polled.
  db.sqlite.prepare("UPDATE sources SET private_feed_url = 'https://api.substack.com/feed/podcast/1/private/x.rss'").run();
  db.sqlite.prepare("UPDATE items SET media_url = 'https://cdn.example/full.mp3' WHERE guid = 'a'").run();
  assert.deepEqual(await storePoll(db, row(), changed, '2026-11-14T16:00:00Z'), { inserted: 0, updated: 0 });
  assert.equal(db.sqlite.prepare("SELECT media_url FROM items WHERE guid = 'a'").get().media_url, 'https://cdn.example/full.mp3');
});

test('a text post is read aloud once, in pieces, and counted against the monthly allowance', async () => {
  const { articleText, splitText } = await import('../src/tts.js');
  const html = '<p>First &amp; <em>foremost</em>.<a class="footnote-anchor" href="#f1">1</a></p><figure><figcaption>A caption</figcaption></figure>' +
    '<p class="button-wrapper"><a class="button primary" href="/subscribe">Subscribe now</a></p><h2>Next</h2><ul><li>One</li><li>Two&#8217;s</li></ul>';
  assert.equal(articleText(html), 'First & foremost.\nNext\nOne\nTwo’s');
  const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
  const pieces = splitText(long + '\n' + 'é'.repeat(300), 400);
  assert.ok(pieces.length > 3 && pieces.every((p) => new TextEncoder().encode(p).length <= 400));
  assert.equal(pieces.join(' ').replace(/\s+/g, ''), (long + 'é'.repeat(300)).replace(/\s+/g, ''), 'no text is lost');

  const db = await createDb();
  await db.prepare("INSERT INTO sources (key, platform, name, feed_url) VALUES ('substack:x', 'substack', 'X', 'https://x.example/feed')").run();
  await db.prepare("INSERT INTO items (source_id, guid, title, url, media_type) VALUES (1, 'g', 'A post', 'https://x.example/p/a-post', 'text')").run();
  const store = new Map();
  const kv = {
    async get(k, type) { const v = store.get(k); return v == null ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
  const env = { DB: db, APP_TOKEN: 'secret', AUDIO: kv, YOUTUBE_API_KEY: 'k', TTS_MONTHLY_CHARS: '15000' };
  const para = (i) => `<p>${('Paragraph ' + i + ' of the post. ').repeat(30)}</p>`;
  const preview = para(0);
  const body = Array.from({ length: 12 }, (_, i) => para(i)).join('');
  const wordcount = articleText(body).match(/\S+/g).length;
  const SID = 's%3Aabcdefghijklmnopqrstuvwxyz.0123456789', SID2 = 's%3Arenewedrenewedrenewedrenewed.0123456789';
  const calls = [];
  const cookies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    calls.push(url);
    const cookie = init.headers?.cookie ?? null;
    if (cookie) { cookies.push([new URL(url).host, cookie]); assert.equal(init.redirect, 'manual'); }
    const good = cookie === 'substack.sid=' + SID || cookie === 'substack.sid=' + SID2;
    if (url === 'https://x.example/api/v1/posts/a-post') return Response.json({ id: 77, audience: 'only_paid', wordcount, body_html: preview });
    if (url === 'https://substack.com/api/v1/posts/by-id/77') {
      return Response.json({ post: { body_html: good ? body : preview } }, { headers: good ? { 'set-cookie': `substack.sid=${SID2}; Path=/; HttpOnly` } : {} });
    }
    if (url === 'https://substack.com/api/v1/subscriptions') return good ? Response.json({}) : new Response('{}', { status: 401 });
    if (url.startsWith('https://texttospeech.googleapis.com/')) {
      assert.equal(init.headers['x-goog-api-key'], 'k');
      return Response.json({ audioContent: btoa('mp3:' + JSON.parse(init.body).input.text.length + ';') });
    }
    return new Response('no', { status: 404 });
  };
  const call = (method, p, b) => worker.fetch(new Request('https://app.example' + p, {
    method, headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }), env, {});
  const synth = () => calls.filter((u) => u.includes('texttospeech')).length;
  try {
    assert.equal((await call('GET', '/api/items/1/audio')).status, 404, 'nothing made yet');

    // No sign-in: a paid post is only its preview, and nothing is made without a go-ahead.
    let job = await (await call('POST', '/api/items/1/audio')).json();
    assert.deepEqual([job.needs_confirm, job.partial, job.signed_in], [true, true, null]);
    assert.equal(store.has('text:1'), false);
    assert.equal(synth(), 0);

    // A cookie Substack rejects is not saved; a good one is, and is never returned.
    assert.equal((await call('PUT', '/api/substack-session', { cookie: 'substack.sid=s%3Awrongwrongwrongwrongwrong.000' })).status, 400);
    assert.equal((await call('PUT', '/api/substack-session', { cookie: 'x' })).status, 400);
    assert.equal(store.has('substack:sid'), false);
    const saved = await call('PUT', '/api/substack-session', { cookie: ' substack.sid=' + SID + '; other=1' });
    assert.equal(saved.status, 200);
    const state = await (await call('GET', '/api/state')).json();
    assert.deepEqual([state.substack_session.set, state.substack_session.ok], [true, true]);
    assert.ok(!JSON.stringify(state).includes('abcdefghij') && !(await saved.text()).includes('abcdefghij'));

    // Signed in: the full post is read, and the renewed cookie replaces the stored one.
    job = await (await call('POST', '/api/items/1/audio')).json();
    assert.deepEqual([job.ready, job.partial, job.needs_confirm], [false, false, undefined], JSON.stringify(job));
    assert.ok(job.parts >= 2);
    assert.equal(store.get('substack:sid'), SID2);
    assert.ok(cookies.length && cookies.every(([host]) => host === 'substack.com'), 'the cookie only ever goes to substack.com');
    for (let n = 0; n < job.parts; n++) {
      const r = await (await call('POST', `/api/items/1/audio/${n}`)).json();
      assert.equal(r.ready, n === job.parts - 1);
    }
    const synthCalls = synth();
    assert.equal(synthCalls, job.parts);
    await call('POST', '/api/items/1/audio/0');
    assert.equal(synth(), synthCalls, 'a stored part is never paid for twice');
    const used = (await db.prepare('SELECT chars FROM tts_usage').first()).chars;
    assert.equal(used, job.chars - (job.parts - 1), 'every character sent is counted (joins between pieces are not sent)');

    const audio = await call('GET', '/api/items/1/audio');
    assert.equal(audio.headers.get('content-type'), 'audio/mpeg');
    assert.match(await audio.text(), /^(mp3:\d+;)+$/);
    assert.equal((await (await call('POST', '/api/items/1/audio')).json()).ready, true);
    assert.equal((await (await call('GET', '/api/items?view=new')).json()).items[0].tts_status, 'ready');

    await db.prepare("INSERT INTO items (source_id, guid, title, url, media_type) VALUES (1, 'h', 'Another', 'https://x.example/p/a-post', 'text')").run();
    assert.equal((await call('POST', '/api/items/2/audio')).status, 429, 'the monthly allowance stops new audio');
    assert.equal((await worker.fetch(new Request('https://app.example/api/items/1/audio'), env, {})).status, 401);

    // An expired sign-in is reported, and the preview can still be read on request.
    store.set('substack:sid', 's%3Aexpiredexpiredexpiredexpired.000');
    env.TTS_MONTHLY_CHARS = '90000';
    job = await (await call('POST', '/api/items/2/audio')).json();
    assert.deepEqual([job.needs_confirm, job.signed_in], [true, false]);
    assert.equal((await (await call('GET', '/api/state')).json()).substack_session.ok, false);
    job = await (await call('POST', '/api/items/2/audio', { allow_partial: true })).json();
    assert.deepEqual([job.partial, job.parts], [true, 1]);
    assert.equal((await call('DELETE', '/api/substack-session')).status, 200);
    assert.equal(store.has('substack:sid'), false);
  } finally { globalThis.fetch = realFetch; }
});
