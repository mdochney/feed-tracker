#!/usr/bin/env node
// Build a static preview of the triage UI: fetch every active seed feed, keep the
// last N days, and inline the result into preview/template.html.
//
//   npm run build-preview            # writes reports/preview.html
//   npm run build-preview -- 21      # keep 21 days instead of 7
//
// The preview is a snapshot. It exists to try the triage flow before the Worker
// and D1 are deployed, and only uses public feeds.

import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseCsv } from '../src/csv.js';
import { pollSource } from '../src/poll.js';

const root = path.resolve(import.meta.dirname, '..');
const days = Number(process.argv[2] ?? 7);
const cutoff = new Date(Date.now() - days * 86400000).toISOString();

const seeds = [];
for (const f of (await readdir(path.join(root, 'seeds'))).filter((f) => f.endsWith('.csv'))) {
  for (const row of parseCsv(await readFile(path.join(root, 'seeds', f), 'utf8'))) {
    if (row.active !== '0' && row.feed_url) seeds.push(row);
  }
}

const sources = seeds.map((s) => ({ k: s.key, n: s.name }));
const items = [];
const failed = [];
let next = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (next < seeds.length) {
    const idx = next++;
    const seed = seeds[idx];
    try {
      const res = await pollSource(seed);
      for (const it of res.items) {
        if (!it.published_at || it.published_at < cutoff) continue;
        items.push({
          id: createHash('sha1').update(seed.key + '\n' + it.guid).digest('hex').slice(0, 16),
          s: idx,
          t: it.title,
          u: it.url,
          p: it.published_at,
          m: it.media_type,
          a: it.media_type === 'text' ? null : it.media_url,
          d: it.duration_sec,
          x: it.summary ? (it.summary.length > 220 ? it.summary.slice(0, 219).trimEnd() + '…' : it.summary) : null,
        });
      }
    } catch (err) {
      failed.push(`${seed.key}: ${err.message ?? err}`);
    }
  }
}));

items.sort((a, b) => (a.p < b.p ? 1 : -1));
const data = { generated: new Date().toISOString(), days, sources, items };
// Escape "<" so feed text can never close the script element.
const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16));

const template = await readFile(path.join(root, 'preview', 'template.html'), 'utf8');
if (!template.includes('/*__DATA__*/null')) throw new Error('template is missing the data placeholder');
await mkdir(path.join(root, 'reports'), { recursive: true });
const out = path.join(root, 'reports', 'preview.html');
await writeFile(out, template.replace('/*__DATA__*/null', () => json));

const count = (m) => items.filter((i) => (m === 'text') === (i.m === 'text')).length;
console.log(`${items.length} items from the last ${days} days (${count('av')} audio/video, ${count('text')} text) across ${sources.length} sources`);
if (failed.length) console.log(`Failed feeds:\n  ${failed.join('\n  ')}`);
console.log(`Wrote ${path.relative(process.cwd(), out)} (${Math.round((await readFile(out)).length / 1024)} KB)`);
