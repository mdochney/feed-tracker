// Text posts read aloud: fetch the article text, cut it into pieces Google's
// Text-to-Speech accepts, synthesize each piece once and keep the MP3 parts in KV.
// The page drives it one piece per request, so no single request does much work.

const UA = 'Mozilla/5.0 (compatible; feed-tracker/0.1)';
const MAX_PIECE_BYTES = 3600;      // Google rejects input above 5,000 bytes
export const MAX_POST_CHARS = 100_000; // about two hours of audio
const DEFAULT_VOICE = 'en-US-Chirp3-HD-Charon';
const DEFAULT_MONTHLY_CHARS = 900_000; // Google's free allowance for this voice family is 1,000,000

export class TtsError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') {
    const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' ';
  }
  return ENTITIES[e.toLowerCase()] ?? m;
});

// Article HTML to the words a reader would hear: no captions, buttons, footnote marks or
// subscribe prompts.
export function articleText(html) {
  let s = String(html ?? '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(figure|script|style|button|form|svg|iframe|noscript|audio|video|sup)\b[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<a\b[^>]*class="[^"]*(footnote-anchor|button)[^"]*"[^>]*>[\s\S]*?<\/a>/gi, ' ');
  s = s.replace(/<(br|hr)\b[^>]*>/gi, '\n');
  s = s.replace(/<\/(p|div|h[1-6]|li|blockquote|tr|section|article|ul|ol|pre)>/gi, '\n');
  s = decode(s.replace(/<[^>]+>/g, ''));
  const lines = s.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) =>
    l && !/^(share|subscribe( now)?|leave a comment|read more|upgrade to paid|give a gift subscription|refer a friend)$/i.test(l) &&
    !/^thanks for reading\b.*\bsubscribe\b/i.test(l) && !/^this (post|substack) is (public|reader-supported)\b/i.test(l));
  return lines.join('\n');
}

const bytes = (s) => new TextEncoder().encode(s).length;

// Cut text into pieces no larger than maxBytes, breaking between paragraphs where possible,
// then sentences, then words.
export function splitText(text, maxBytes = MAX_PIECE_BYTES) {
  const units = [];
  for (const para of String(text).split('\n')) {
    if (!para.trim()) continue;
    if (bytes(para) <= maxBytes) { units.push(para); continue; }
    for (const sentence of para.match(/[^.!?]+[.!?]+["”’)\]]*\s*|[^.!?]+$/g) ?? [para]) {
      if (bytes(sentence) <= maxBytes) { units.push(sentence.trim()); continue; }
      let cur = '';
      // A single unbroken run longer than the limit is cut by characters.
      const words = sentence.split(/\s+/).flatMap((w) => {
        if (bytes(w) <= maxBytes) return [w];
        const out = []; let run = '';
        for (const ch of w) { if (bytes(run + ch) > maxBytes) { out.push(run); run = ch; } else run += ch; }
        return run ? [...out, run] : out;
      });
      for (const word of words) {
        if (cur && bytes(cur + ' ' + word) > maxBytes) { units.push(cur); cur = word; } else cur = cur ? cur + ' ' + word : word;
      }
      if (cur) units.push(cur);
    }
  }
  const pieces = [];
  let cur = '';
  for (const u of units) {
    if (cur && bytes(cur + '\n' + u) > maxBytes) { pieces.push(cur); cur = u; } else cur = cur ? cur + '\n' + u : u;
  }
  if (cur) pieces.push(cur);
  return pieces;
}

// Where a post's full text can be read. Substack serves it as JSON beside the post.
function substackApiUrl(postUrl) {
  const u = new URL(postUrl);
  const m = u.pathname.match(/^\/p\/([^/]+)/);
  return m ? `${u.origin}/api/v1/posts/${m[1]}` : null;
}

const words = (s) => (s.match(/\S+/g) ?? []).length;
// Substack reports the full post's word count even when it serves only the preview.
const isPartial = (text, post) => post.wordcount > 0 && words(text) < post.wordcount * 0.8;

const SID_KEY = 'substack:sid';
const SID_STATE_KEY = 'substack:sid-state';

// The pasted Substack login cookie, reduced to its value. Throws on anything that is not one.
export function cleanSid(input) {
  let v = String(input ?? '').trim().replace(/^cookie:\s*/i, '');
  const named = v.match(/(?:^|;\s*)substack\.sid=([^;\s]+)/);
  if (named) v = named[1];
  if (!/^[A-Za-z0-9%._~+/=:-]{20,2000}$/.test(v)) throw new RangeError('That does not look like a substack.sid cookie value');
  return v;
}

// One signed-in request to substack.com. The cookie is sent to that host only, redirects are
// not followed, and a renewed cookie in the reply replaces the stored one.
async function substackFetch(kv, sid, path, fetchImpl) {
  const res = await fetchImpl('https://substack.com' + path, {
    headers: { 'user-agent': UA, accept: 'application/json', cookie: 'substack.sid=' + sid },
    redirect: 'manual',
  });
  let renewed = false;
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const m = c.match(/^substack\.sid=([^;]+)/);
    if (m && m[1] && m[1] !== sid && !/max-age=0\b|expires=thu, 01 jan 1970/i.test(c)) {
      try { await kv.put(SID_KEY, cleanSid(m[1])); renewed = true; } catch {}
    }
  }
  return { res, renewed };
}

// Substack answers 401 or 403 to a request that is not signed in. Any other reply short of
// a server error or rate limit got past that check, whatever it thought of the request.
async function checkSignedIn(kv, sid, fetchImpl) {
  const { res, renewed } = await substackFetch(kv, sid, '/api/v1/user/profile/self', fetchImpl);
  const signedIn = res.status === 401 || res.status === 403 ? false : res.status < 500 && res.status !== 429 ? true : null;
  return { signedIn, status: res.status, renewed };
}

async function setSidState(kv, ok) {
  await kv.put(SID_STATE_KEY, JSON.stringify({ ok, at: new Date().toISOString() }));
}

export async function saveSubstackSession(kv, input, { fetchImpl = fetch } = {}) {
  if (!kv) throw new TtsError(503, 'Storage is not set up on this Worker');
  const sid = cleanSid(input);
  const { signedIn, status, renewed } = await checkSignedIn(kv, sid, fetchImpl);
  if (signedIn !== true) throw new RangeError(signedIn === false ? 'Substack did not accept that cookie. It was not saved.' : `Substack could not be reached to check it (HTTP ${status}). It was not saved.`);
  if (!renewed) await kv.put(SID_KEY, sid); // a renewed cookie in the reply was already stored
  await setSidState(kv, true);
}

export async function clearSubstackSession(kv) {
  if (!kv) return;
  await kv.delete(SID_KEY);
  await kv.delete(SID_STATE_KEY);
}

// What the page may know: whether a sign-in is stored and whether it last worked. Never the cookie.
export async function substackSessionState(kv) {
  if (!kv) return { available: false, set: false };
  const state = await kv.get(SID_STATE_KEY, 'json');
  return { available: true, set: !!state, ok: state?.ok ?? null, checked_at: state?.at ?? null };
}

// Returns { text, partial, signedIn }: signedIn is true or false when a stored Substack
// sign-in was tried, and null when none was.
export async function fetchArticle(item, { fetchImpl = fetch, kv = null } = {}) {
  let url;
  try { url = new URL(item.url); } catch { throw new TtsError(400, 'This item has no link to read from'); }
  if (!/^https?:$/.test(url.protocol)) throw new TtsError(400, 'This item has no link to read from');
  const headers = { 'user-agent': UA, accept: 'application/json, text/html' };
  const api = substackApiUrl(url.href);
  if (api) {
    const res = await fetchImpl(api, { headers });
    if (res.ok) {
      const post = await res.json().catch(() => null);
      if (post?.body_html) {
        const text = articleText(post.body_html);
        if (!isPartial(text, post)) return { text, partial: false, signedIn: null };
        const sid = kv && post.id ? await kv.get(SID_KEY) : null;
        if (!sid) return { text, partial: true, signedIn: null };
        // Paid post: ask substack.com for it as the signed-in reader.
        const { res: full } = await substackFetch(kv, sid, `/api/v1/posts/by-id/${encodeURIComponent(post.id)}`, fetchImpl);
        const body = full.ok ? (await full.json().catch(() => null))?.post?.body_html : null;
        const fullText = body ? articleText(body) : '';
        if (fullText && !isPartial(fullText, post)) { await setSidState(kv, true); return { text: fullText, partial: false, signedIn: true }; }
        // Still the preview: either the sign-in has lapsed or this account has no access.
        const { signedIn } = await checkSignedIn(kv, sid, fetchImpl);
        if (signedIn !== null) await setSidState(kv, signedIn);
        return { text: fullText.length > text.length ? fullText : text, partial: true, signedIn };
      }
    }
  }
  const res = await fetchImpl(url.href, { headers });
  if (!res.ok) throw new TtsError(502, `The post could not be fetched (HTTP ${res.status})`);
  const html = await res.text();
  const body = html.match(/<article\b[\s\S]*<\/article>/i)?.[0] ?? html.match(/<main\b[\s\S]*<\/main>/i)?.[0] ?? '';
  return { text: articleText(body), partial: false, signedIn: null };
}

function fromBase64(b64) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(b64);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function synthesize(text, { apiKey, voice = DEFAULT_VOICE, fetchImpl = fetch } = {}) {
  const res = await fetchImpl('https://texttospeech.googleapis.com/v1/text:synthesize', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: voice.split('-').slice(0, 2).join('-'), name: voice },
      audioConfig: { audioEncoding: 'MP3' },
    }),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null))?.error?.message ?? '';
    throw new TtsError(502, `Google Text-to-Speech refused the request (HTTP ${res.status})${detail ? ': ' + detail.slice(0, 200) : ''}`);
  }
  const data = await res.json();
  if (!data.audioContent) throw new TtsError(502, 'Google Text-to-Speech returned no audio');
  return fromBase64(data.audioContent);
}

const month = (at = new Date()) => at.toISOString().slice(0, 7);
const textKey = (id) => `text:${id}`;
// Parts are keyed by the run that made them, so audio from an earlier run is never mixed in.
const partKey = (id, run, n) => `audio:${id}:${run}:${n}`;
const parseKey = (k) => { const [run, parts] = String(k ?? '').split(':'); return { run, parts: Number(parts) }; };

export function ttsConfig(env) {
  return {
    apiKey: env.GOOGLE_TTS_KEY || env.YOUTUBE_API_KEY || null,
    voice: env.TTS_VOICE || DEFAULT_VOICE,
    monthlyChars: Number(env.TTS_MONTHLY_CHARS) || DEFAULT_MONTHLY_CHARS,
    kv: env.AUDIO ?? null,
  };
}

async function usedThisMonth(db) {
  return (await db.prepare('SELECT chars FROM tts_usage WHERE month = ?').bind(month()).first())?.chars ?? 0;
}

function requireSetup(cfg) {
  if (!cfg.kv) throw new TtsError(503, 'Audio storage is not set up on this Worker');
  if (!cfg.apiKey) throw new TtsError(503, 'No Google API key is set on this Worker');
}

// Step 1: read the post and cut it up. Returns how many pieces the page must ask for.
export async function prepareAudio(db, id, cfg, { fetchImpl = fetch, allowPartial = false } = {}) {
  requireSetup(cfg);
  const item = await db.prepare('SELECT id, title, url, media_type, tts_status, tts_key FROM items WHERE id = ?').bind(Number(id)).first();
  if (!item) throw new TtsError(404, 'No such item');
  if (item.tts_status === 'ready') return { ready: true, parts: parseKey(item.tts_key).parts };
  // Text saved by an unfinished run is reused, so its stored parts still line up.
  const saved = item.tts_status === 'pending' ? await cfg.kv.get(textKey(item.id), 'json') : null;
  if (saved?.run && saved.pieces?.length) return { ready: false, parts: saved.pieces.length, chars: saved.chars, partial: !!saved.partial };

  const { text, partial, signedIn } = await fetchArticle(item, { fetchImpl, kv: cfg.kv });
  if (text.length < 200 && !partial) throw new TtsError(422, 'No readable text was found for this post');
  const full = item.title + '.\n' + text;
  // Nothing is made or saved from a preview unless the page says to go ahead.
  if (partial && !allowPartial) return { ready: false, partial: true, needs_confirm: true, chars: full.length, signed_in: signedIn };
  if (full.length > MAX_POST_CHARS) throw new TtsError(422, `This post is too long to read aloud (${full.length.toLocaleString('en-US')} characters)`);
  const used = await usedThisMonth(db);
  if (used + full.length > cfg.monthlyChars) {
    throw new TtsError(429, `This post (${full.length.toLocaleString('en-US')} characters) would go over this month's voice allowance: ${used.toLocaleString('en-US')} of ${cfg.monthlyChars.toLocaleString('en-US')} used`);
  }
  const pieces = splitText(full);
  const run = crypto.randomUUID().slice(0, 8);
  await cfg.kv.put(textKey(item.id), JSON.stringify({ run, pieces, chars: full.length, partial }));
  await db.prepare("UPDATE items SET tts_status = 'pending', tts_key = ? WHERE id = ?").bind(`${run}:${pieces.length}`, item.id).run();
  return { ready: false, parts: pieces.length, chars: full.length, partial };
}

// Step 2, once per piece: synthesize it unless it is already stored. The last piece marks
// the item ready.
export async function makeAudioPart(db, id, n, cfg, { fetchImpl = fetch } = {}) {
  requireSetup(cfg);
  const itemId = Number(id), part = Number(n);
  const saved = await cfg.kv.get(textKey(itemId), 'json');
  if (!saved?.run || !saved.pieces?.[part]) throw new TtsError(404, 'Nothing to read for that part; start again');
  const total = saved.pieces.length;
  if (!(await cfg.kv.get(partKey(itemId, saved.run, part), 'stream'))) {
    const text = saved.pieces[part];
    const used = await usedThisMonth(db);
    if (used + text.length > cfg.monthlyChars) throw new TtsError(429, "This month's voice allowance is used up");
    // Counted before the call so a failure can never lead to uncounted spending.
    await db.prepare('INSERT INTO tts_usage (month, chars) VALUES (?, ?) ON CONFLICT (month) DO UPDATE SET chars = chars + excluded.chars')
      .bind(month(), text.length).run();
    let audio;
    try { audio = await synthesize(text, { apiKey: cfg.apiKey, voice: cfg.voice, fetchImpl }); } catch (err) {
      // A refused request is not billed, so it is taken back off the count.
      if (err instanceof TtsError) await db.prepare('UPDATE tts_usage SET chars = MAX(0, chars - ?) WHERE month = ?').bind(text.length, month()).run();
      throw err;
    }
    await cfg.kv.put(partKey(itemId, saved.run, part), audio);
  }
  const ready = part === total - 1;
  if (ready) {
    await db.prepare("UPDATE items SET tts_status = 'ready', tts_key = ? WHERE id = ?").bind(`${saved.run}:${total}`, itemId).run();
  }
  return { ready, part, parts: total };
}

// The finished audio: the stored MP3 parts end to end.
export async function readAudio(db, id, cfg) {
  if (!cfg.kv) throw new TtsError(503, 'Audio storage is not set up on this Worker');
  const item = await db.prepare('SELECT tts_status, tts_key FROM items WHERE id = ?').bind(Number(id)).first();
  if (!item || item.tts_status !== 'ready') throw new TtsError(404, 'No audio has been made for this item');
  const key = parseKey(item.tts_key);
  const parts = await Promise.all(Array.from({ length: key.parts || 0 }, (_, n) => cfg.kv.get(partKey(Number(id), key.run, n), 'arrayBuffer')));
  if (!parts.length || parts.some((p) => !p)) {
    await db.prepare("UPDATE items SET tts_status = 'none', tts_key = NULL WHERE id = ?").bind(Number(id)).run();
    throw new TtsError(404, 'The stored audio is incomplete; make it again');
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) { out.set(new Uint8Array(p), at); at += p.byteLength; }
  return out;
}

export async function ttsUsage(db, cfg) {
  return { month: month(), chars: await usedThisMonth(db), limit: cfg.monthlyChars };
}
