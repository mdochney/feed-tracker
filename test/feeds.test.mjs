import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseFeed, parseDuration, youtubeFeedUrl } from '../src/feeds.js';
import { pollSource } from '../src/poll.js';
import { parseCsv } from '../src/csv.js';

const fixture = (name) => readFile(path.join(import.meta.dirname, 'fixtures', name), 'utf8');

test('YouTube Atom feed', async () => {
  const feed = parseFeed(await fixture('youtube.xml'));
  assert.equal(feed.title, 'Example Channel');
  assert.equal(feed.site_url, 'https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(feed.items.length, 1);
  assert.deepEqual(feed.items[0], {
    guid: 'yt:video:abc123DEF45',
    title: 'How feeds work & why they last',
    url: 'https://www.youtube.com/watch?v=abc123DEF45',
    published_at: '2026-11-10T15:00:00.000Z',
    media_type: 'video',
    media_url: null,
    duration_sec: null,
    thumbnail_url: 'https://i1.ytimg.com/vi/abc123DEF45/hqdefault.jpg',
    summary: 'A short description of the video.',
  });
});

test('Substack RSS feed: podcast episode and text post', async () => {
  const feed = parseFeed(await fixture('substack.xml'));
  assert.equal(feed.title, 'Example Letter');
  assert.equal(feed.site_url, 'https://example.substack.com');
  const [episode, essay] = feed.items;

  assert.equal(episode.media_type, 'audio');
  assert.equal(episode.media_url, 'https://api.substack.com/feed/podcast/123456/abcdef.mp3');
  assert.equal(episode.duration_sec, 6125);
  assert.equal(episode.published_at, '2026-11-12T18:53:47.000Z');
  assert.equal(episode.thumbnail_url, 'https://substackcdn.com/image/ep12.jpg');
  assert.equal(episode.summary, 'We talk about feeds & queues.');

  // No image of its own: the first image in the post body, sized down, else the show's image.
  const noArt = parseFeed((await fixture('substack.xml')).replace(/<itunes:image[^>]*\/>/, '<content:encoded><![CDATA[<p><img src="https://substackcdn.com/image/fetch/$s_!ZQ!,w_1456,c_limit,f_auto/https%3A%2F%2Fx%2Fa.png" alt=""></p>]]></content:encoded>')).items[0];
  assert.equal(noArt.thumbnail_url, 'https://substackcdn.com/image/fetch/$s_!ZQ!,w_320,c_limit,f_auto/https%3A%2F%2Fx%2Fa.png');
  const showArt = parseFeed((await fixture('substack.xml')).replace(/<itunes:image[^>]*\/>/, '').replace('<link>https://example.substack.com</link>', '<link>https://example.substack.com</link><image><url>https://substackcdn.com/show.png</url></image>')).items[0];
  assert.equal(showArt.thumbnail_url, 'https://substackcdn.com/show.png');

  // An image enclosure is a cover image, not media.
  assert.equal(essay.media_type, 'text');
  assert.equal(essay.media_url, null);
  assert.equal(essay.summary, 'The author’s plain text post – no audio.');
  assert.equal(essay.thumbnail_url, 'https://substackcdn.com/image/essay.jpeg');
});

test('parseFeed rejects non-feeds', () => {
  assert.throws(() => parseFeed('<html><body>Sign in</body></html>'), /Not an RSS or Atom feed/);
});

test('parseDuration', () => {
  assert.equal(parseDuration('3725'), 3725);
  assert.equal(parseDuration('1:02:05'), 3725);
  assert.equal(parseDuration('62:05'), 3725);
  assert.equal(parseDuration(''), null);
  assert.equal(parseDuration('n/a'), null);
});

test('youtubeFeedUrl', () => {
  const id = 'UC' + 'a'.repeat(22);
  assert.equal(youtubeFeedUrl(id), `https://www.youtube.com/feeds/videos.xml?playlist_id=UULF${'a'.repeat(22)}`);
  assert.equal(youtubeFeedUrl(id, { longFormOnly: false }), `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`);
  assert.throws(() => youtubeFeedUrl('@handle'));
});

test('pollSource: private override, conditional headers, 304 and errors', async () => {
  const xml = await fixture('substack.xml');
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers });
    if (url.includes('private')) return new Response(xml, { status: 200, headers: { etag: '"v2"' } });
    if (init.headers['if-none-match'] === '"v1"') return new Response(null, { status: 304 });
    return new Response('nope', { status: 404 });
  };

  const source = { key: 'substack:example', feed_url: 'https://example.substack.com/feed', etag: '"v1"' };

  const unchanged = await pollSource(source, { fetchImpl });
  assert.equal(unchanged.status, 'not_modified');
  assert.equal(calls[0].headers['if-none-match'], '"v1"');

  const priv = await pollSource(source, { fetchImpl, privateFeeds: { 'substack:example': 'https://api.substack.com/private/x' } });
  assert.equal(priv.status, 'ok');
  assert.equal(priv.items.length, 2);
  assert.equal(priv.etag, '"v2"');
  assert.equal(calls[1].url, 'https://api.substack.com/private/x');

  await assert.rejects(pollSource({ key: 'x', feed_url: 'https://gone.example/feed' }, { fetchImpl }), /HTTP 404/);
});

test('parseCsv handles quotes and the seed files load', async () => {
  assert.deepEqual(parseCsv('a,b\n"x, y","say ""hi"""\r\n1,2\n'), [
    { a: 'x, y', b: 'say "hi"' },
    { a: '1', b: '2' },
  ]);
  const seeds = parseCsv(await readFile(path.join(import.meta.dirname, '..', 'seeds', 'substack.csv'), 'utf8'));
  assert.ok(seeds.length > 50);
  assert.equal(new Set(seeds.map((s) => s.key)).size, seeds.length, 'seed keys are unique');
  for (const s of seeds) {
    assert.match(s.key, /^substack:[\w-]+$/);
    assert.match(s.feed_url, /^https:\/\/[\w-]+\.substack\.com\/feed$/);
    assert.ok(!/api\.substack\.com/.test(s.feed_url), 'no private feed URLs in the repo');
  }
});

test('trimFeed keeps only the newest items of a very long feed', async () => {
  const { trimFeed } = await import('../src/poll.js');
  const item = (n) => `<item><title>Episode ${n}</title><guid>g${n}</guid><link>https://x.example/${n}</link><description>${'x'.repeat(900)}</description><enclosure url="https://x.example/${n}.mp3" type="audio/mpeg"/></item>`;
  const long = `<?xml version="1.0"?><rss version="2.0"><channel><title>Long Show</title>${Array.from({ length: 400 }, (_, i) => item(400 - i)).join('')}</channel></rss>`;
  const feed = parseFeed(trimFeed(long));
  assert.equal(feed.title, 'Long Show');
  assert.equal(feed.items.length, 40);
  assert.equal(feed.items[0].title, 'Episode 400');
  const short = '<rss><channel><title>S</title><item><title>a</title><guid>1</guid></item></channel></rss>';
  assert.equal(trimFeed(short), short, 'short feeds are left alone');
});
