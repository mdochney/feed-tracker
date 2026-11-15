import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createDb } from './d1-shim.mjs';
import { storePoll, pollBatch, listItems, getState, addSource } from '../src/store.js';
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
    if (url === 'https://www.youtube.com/@example') return new Response(`<link rel="canonical" href="https://www.youtube.com/channel/${id}">`);
    if (url.startsWith('https://www.youtube.com/feeds/videos.xml')) return new Response(atom);
    return new Response('nope', { status: 404 });
  };
  assert.deepEqual(await resolveSource('example.substack.com', { fetchImpl }), {
    key: 'substack:example', platform: 'substack', name: 'Example Letter',
    feed_url: 'https://example.substack.com/feed', site_url: 'https://example.substack.com',
  });
  const yt = await resolveSource('https://www.youtube.com/@example', { fetchImpl });
  assert.equal(yt.key, 'youtube:' + id);
  assert.equal(yt.name, 'Example Channel');
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
  assert.deepEqual(state.counts, { new: 3, queue: 0, cleared: 0 });
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
  assert.deepEqual((await getState(db)).counts, { new: 0, queue: 2, cleared: 1 });

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
