// Cloudflare Worker: JSON API under /api, hourly-ish polling from the cron trigger.
// Static files in public/ are served by the platform before this code runs.

import {
  pollBatch, listItems, getState, setItemStatus, addSource, updateSource, deleteSource, pollAndStore,
} from './store.js';
import { resolveSource } from './resolve.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const fail = (status, error) => json({ error }, status);

const pollOpts = (env) => ({
  privateFeeds: privateFeeds(env),
  youtubeApiKey: env.YOUTUBE_API_KEY || null,
  fetchBudget: Number(env.FETCH_BUDGET) || 45,
});

function privateFeeds(env) {
  if (!env.PRIVATE_FEEDS) return {};
  try { return JSON.parse(env.PRIVATE_FEEDS); } catch { console.error('PRIVATE_FEEDS is not valid JSON'); return {}; }
}

async function sameToken(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}

// The API fails closed: no APP_TOKEN configured means nothing is served.
async function authorize(request, env) {
  if (!env.APP_TOKEN) return fail(503, 'APP_TOKEN is not set on this Worker');
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !(await sameToken(token, env.APP_TOKEN))) return fail(401, 'Sign in required');
  return null;
}

async function body(request) {
  try { return (await request.json()) ?? {}; } catch { return {}; }
}

async function api(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;
  const db = env.DB;
  const batch = Number(env.POLL_BATCH) || 20;

  if (path === '/api/state' && method === 'GET') return json(await getState(db));

  if (path === '/api/items' && method === 'GET') {
    const p = url.searchParams;
    return json(await listItems(db, {
      view: p.get('view') ?? 'new', type: p.get('type') ?? 'all', source: p.get('source'),
      q: (p.get('q') ?? '').slice(0, 100), limit: p.get('limit') ?? 100, offset: p.get('offset') ?? 0,
    }));
  }

  let m = path.match(/^\/api\/items\/(\d+)$/);
  if (m && method === 'POST') {
    const { status } = await body(request);
    try {
      return (await setItemStatus(db, m[1], status)) ? json({ ok: true }) : fail(404, 'No such item');
    } catch (err) {
      if (err instanceof RangeError) return fail(400, err.message);
      throw err;
    }
  }

  if (path === '/api/sources' && method === 'POST') {
    const { url: input } = await body(request);
    let resolved;
    try { resolved = await resolveSource(input); } catch (err) { return fail(400, String(err.message ?? err)); }
    const { source, created } = await addSource(db, resolved);
    const polled = await pollAndStore(db, source, pollOpts(env));
    return json({ ok: true, created, source: { id: source.id, name: source.name, platform: source.platform }, polled });
  }

  m = path.match(/^\/api\/sources\/(\d+)$/);
  if (m && method === 'PATCH') {
    return (await updateSource(db, m[1], await body(request))) ? json({ ok: true }) : fail(404, 'No such source, or nothing to change');
  }
  if (m && method === 'DELETE') {
    return (await deleteSource(db, m[1])) ? json({ ok: true }) : fail(404, 'No such source');
  }

  if (path === '/api/poll' && method === 'POST') {
    const { source_id: sourceId } = await body(request);
    const results = await pollBatch(db, { limit: batch, sourceId: sourceId ?? null, ...pollOpts(env) });
    const waiting = await db.prepare('SELECT COUNT(*) AS n FROM sources WHERE active = 1 AND last_polled_at IS NULL').first();
    return json({ ok: true, polled: results.length, never_checked: waiting.n, inserted: results.reduce((n, r) => n + (r.inserted ?? 0), 0), failed: results.filter((r) => !r.ok) });
  }

  return fail(404, 'Not found');
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });
    const denied = await authorize(request, env);
    if (denied) return denied;
    try {
      return await api(request, env, ctx);
    } catch (err) {
      console.error(err);
      return fail(500, 'Something went wrong on the server');
    }
  },

  async scheduled(controller, env, ctx) {
    const results = await pollBatch(env.DB, { limit: Number(env.POLL_BATCH) || 20, ...pollOpts(env) });
    const failed = results.filter((r) => !r.ok);
    console.log(`polled ${results.length} sources, ${results.reduce((n, r) => n + (r.inserted ?? 0), 0)} new items, ${failed.length} failed`);
    for (const f of failed) console.warn(`${f.key}: ${f.error}`);
  },
};
