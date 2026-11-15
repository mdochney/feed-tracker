#!/usr/bin/env node
// Coverage test: fetch every active seed feed once and report what comes back.
// Run from your own machine (needs open internet access):
//
//   npm install
//   npm run check-feeds                      # all seeds
//   npm run check-feeds -- seeds/substack.csv
//
// Private feed overrides: put {"substack:samharris": "https://..."} in
// private-feeds.json (git-ignored) and they are used in place of the public URL.

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseCsv } from '../src/csv.js';
import { pollSource } from '../src/poll.js';

const root = path.resolve(import.meta.dirname, '..');
const CONCURRENCY = 6;

const args = process.argv.slice(2);
const seedFiles = args.length
  ? args.map((a) => path.resolve(a))
  : (await readdir(path.join(root, 'seeds'))).filter((f) => f.endsWith('.csv')).map((f) => path.join(root, 'seeds', f));

const privatePath = path.join(root, 'private-feeds.json');
const privateFeeds = existsSync(privatePath) ? JSON.parse(await readFile(privatePath, 'utf8')) : {};

const sources = [];
for (const file of seedFiles) {
  for (const row of parseCsv(await readFile(file, 'utf8'))) {
    if (row.active !== '0' && row.feed_url) sources.push(row);
  }
}
console.log(`Checking ${sources.length} feeds from ${seedFiles.length} seed file(s)...\n`);

async function check(source) {
  const base = { key: source.key, name: source.name, av_tier: source.av_tier, private: source.key in privateFeeds };
  try {
    const { items } = await pollSource(source, { privateFeeds });
    const count = (t) => items.filter((i) => i.media_type === t).length;
    const dates = items.map((i) => i.published_at).filter(Boolean).sort();
    return { ...base, ok: true, items: items.length, video: count('video'), audio: count('audio'), text: count('text'), newest: dates.at(-1)?.slice(0, 10) ?? '', error: '' };
  } catch (err) {
    return { ...base, ok: false, items: 0, video: 0, audio: 0, text: 0, newest: '', error: String(err.message ?? err) };
  }
}

const results = new Array(sources.length);
let next = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < sources.length) {
    const i = next++;
    results[i] = await check(sources[i]);
    const r = results[i];
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.key.padEnd(42)} ${r.ok ? `${r.items} items (v${r.video} a${r.audio} t${r.text}) newest ${r.newest}` : r.error}`);
  }
}));

const failed = results.filter((r) => !r.ok);
const empty = results.filter((r) => r.ok && r.items === 0);
// Sources we expected audio/video from that returned none: likely paywalled or video-only posts without enclosures.
const noMedia = results.filter((r) => r.ok && r.items > 0 && r.av_tier === 'regular' && r.video + r.audio === 0);

console.log(`\n${results.length - failed.length}/${results.length} feeds fetched`);
if (failed.length) console.log(`Failed: ${failed.map((r) => r.key).join(', ')}`);
if (empty.length) console.log(`Empty: ${empty.map((r) => r.key).join(', ')}`);
if (noMedia.length) console.log(`Expected audio/video but found none: ${noMedia.map((r) => r.key).join(', ')}`);

const cols = ['key', 'name', 'av_tier', 'private', 'ok', 'items', 'video', 'audio', 'text', 'newest', 'error'];
const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
await mkdir(path.join(root, 'reports'), { recursive: true });
const out = path.join(root, 'reports', 'feed-coverage.csv');
await writeFile(out, [cols.join(','), ...results.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n');
console.log(`\nReport written to ${path.relative(process.cwd(), out)}`);
process.exitCode = failed.length ? 1 : 0;
