// Cloudflare Worker: JSON API under /api, hourly-ish polling from the cron trigger.
// Static files in public/ are served by the platform before this code runs.

import {
  pollBatch, listItems, getState, setItemStatus, addSource, updateSource, deleteSource, pollAndStore,
  enrichSubstackAudio,
} from './store.js';
import { resolveSource } from './resolve.js';
import {
  TtsError, ttsConfig, prepareAudio, makeAudioPart, readAudio, ttsUsage,
  saveSubstackSession, clearSubstackSession, substackSessionState,
} from './tts.js';

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

  if (path === '/api/state' && method === 'GET') {
    const [state, substack, voice] = await Promise.all([
      getState(db, { backlog: url.searchParams.get('backlog') === '1' }), substackSessionState(env.AUDIO ?? null),
      ttsUsage(db, ttsConfig(env))]);
    return json({ ...state, substack_session: substack, voice_usage: voice });
  }

  // The Substack sign-in used to read paid posts in full. Stored in KV; never returned.
  if (path === '/api/substack-session' && (method === 'PUT' || method === 'DELETE')) {
    try {
      if (method === 'DELETE') await clearSubstackSession(env.AUDIO ?? null);
      else await saveSubstackSession(env.AUDIO ?? null, (await body(request)).cookie);
    } catch (err) {
      if (err instanceof RangeError) return fail(400, err.message);
      if (err instanceof TtsError) return fail(err.status, err.message);
      throw err;
    }
    return json({ ok: true, substack_session: await substackSessionState(env.AUDIO ?? null) });
  }

  if (path === '/api/items' && method === 'GET') {
    const p = url.searchParams;
    return json(await listItems(db, {
      view: p.get('view') ?? 'new', type: p.get('type') ?? 'all', source: p.get('source'),
      q: (p.get('q') ?? '').slice(0, 100), minMinutes: p.get('min_minutes') ?? 0,
      limit: p.get('limit') ?? 100, offset: p.get('offset') ?? 0,
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

  // Read-aloud audio for text posts. The page asks for one piece at a time.
  m = path.match(/^\/api\/items\/(\d+)\/audio(?:\/(\d+))?$/);
  if (m) {
    const cfg = ttsConfig(env);
    try {
      if (method === 'GET' && m[2] === undefined) {
        const audio = await readAudio(db, m[1], cfg);
        return new Response(audio, { headers: { 'content-type': 'audio/mpeg', 'content-length': String(audio.byteLength), 'cache-control': 'private, max-age=86400' } });
      }
      if (method === 'POST' && m[2] === undefined) {
        const { allow_partial: allowPartial } = await body(request);
        return json({ ok: true, ...(await prepareAudio(db, m[1], cfg, { allowPartial: allowPartial === true })), usage: await ttsUsage(db, cfg) });
      }
      if (method === 'POST') return json({ ok: true, ...(await makeAudioPart(db, m[1], m[2], cfg)) });
    } catch (err) {
      if (err instanceof TtsError) return fail(err.status, err.message);
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
    const change = await body(request);
    let changed;
    try { changed = await updateSource(db, m[1], change); } catch (err) {
      if (err instanceof RangeError) return fail(400, err.message);
      throw err;
    }
    if (!changed) return fail(404, 'No such source, or nothing to change');
    // A newly set private feed is applied straight away, so a bad address is reported now.
    if (change.private_feed_url) {
      const source = await db.prepare('SELECT * FROM sources WHERE id = ?').bind(Number(m[1])).first();
      try {
        const updated = source.platform === 'substack'
          ? await enrichSubstackAudio(db, source, pollOpts(env))
          : (await pollAndStore(db, { ...source, etag: null, last_modified: null }, pollOpts(env))).inserted ?? 0;
        return json({ ok: true, private_feed: 'applied', updated });
      } catch (err) {
        await db.prepare('UPDATE sources SET private_feed_url = NULL WHERE id = ?').bind(source.id).run();
        return fail(400, 'That private feed could not be read (' + String(err?.message ?? err).slice(0, 80) + '). It was not saved.');
      }
    }
    return json({ ok: true });
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
