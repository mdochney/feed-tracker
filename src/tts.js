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

export async function fetchArticle(item, { fetchImpl = fetch } = {}) {
  let url;
  try { url = new URL(item.url); } catch { throw new TtsError(400, 'This item has no link to read from'); }
  if (!/^https?:$/.test(url.protocol)) throw new TtsError(400, 'This item has no link to read from');
  const headers = { 'user-agent': UA, accept: 'application/json, text/html' };
  const api = substackApiUrl(url.href);
  if (api) {
    const res = await fetchImpl(api, { headers });
    if (res.ok) {
      const post = await res.json().catch(() => null);
      if (post?.body_html) return { text: articleText(post.body_html), partial: post.audience != null && post.audience !== 'everyone' };
    }
  }
  const res = await fetchImpl(url.href, { headers });
  if (!res.ok) throw new TtsError(502, `The post could not be fetched (HTTP ${res.status})`);
  const html = await res.text();
  const body = html.match(/<article\b[\s\S]*<\/article>/i)?.[0] ?? html.match(/<main\b[\s\S]*<\/main>/i)?.[0] ?? '';
  return { text: articleText(body), partial: false };
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
const partKey = (id, n) => `audio:${id}:${n}`;

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
export async function prepareAudio(db, id, cfg, { fetchImpl = fetch } = {}) {
  requireSetup(cfg);
  const item = await db.prepare('SELECT id, title, url, media_type, tts_status, tts_key FROM items WHERE id = ?').bind(Number(id)).first();
  if (!item) throw new TtsError(404, 'No such item');
  if (item.tts_status === 'ready') return { ready: true, parts: Number(item.tts_key) };
  const saved = await cfg.kv.get(textKey(item.id), 'json');
  if (saved?.pieces?.length) return { ready: false, parts: saved.pieces.length, chars: saved.chars, partial: !!saved.partial };

  const { text, partial } = await fetchArticle(item, { fetchImpl });
  if (text.length < 200) throw new TtsError(422, 'No readable text was found for this post');
  const full = item.title + '.\n' + text;
  if (full.length > MAX_POST_CHARS) throw new TtsError(422, `This post is too long to read aloud (${full.length.toLocaleString('en-US')} characters)`);
  const used = await usedThisMonth(db);
  if (used + full.length > cfg.monthlyChars) {
    throw new TtsError(429, `This month's voice allowance is used up (${used.toLocaleString('en-US')} of ${cfg.monthlyChars.toLocaleString('en-US')} characters)`);
  }
  const pieces = splitText(full);
  await cfg.kv.put(textKey(item.id), JSON.stringify({ pieces, chars: full.length, partial }));
  await db.prepare("UPDATE items SET tts_status = 'pending', tts_key = ? WHERE id = ?").bind(String(pieces.length), item.id).run();
  return { ready: false, parts: pieces.length, chars: full.length, partial };
}

// Step 2, once per piece: synthesize it unless it is already stored. The last piece marks
// the item ready.
export async function makeAudioPart(db, id, n, cfg, { fetchImpl = fetch } = {}) {
  requireSetup(cfg);
  const itemId = Number(id), part = Number(n);
  const saved = await cfg.kv.get(textKey(itemId), 'json');
  if (!saved?.pieces?.[part]) throw new TtsError(404, 'Nothing to read for that part; start again');
  const total = saved.pieces.length;
  if (!(await cfg.kv.get(partKey(itemId, part), 'stream'))) {
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
    await cfg.kv.put(partKey(itemId, part), audio);
  }
  const ready = part === total - 1;
  if (ready) {
    await db.prepare("UPDATE items SET tts_status = 'ready', tts_key = ? WHERE id = ?").bind(String(total), itemId).run();
  }
  return { ready, part, parts: total };
}

// The finished audio: the stored MP3 parts end to end.
export async function readAudio(db, id, cfg) {
  if (!cfg.kv) throw new TtsError(503, 'Audio storage is not set up on this Worker');
  const item = await db.prepare('SELECT tts_status, tts_key FROM items WHERE id = ?').bind(Number(id)).first();
  if (!item || item.tts_status !== 'ready') throw new TtsError(404, 'No audio has been made for this item');
  const parts = await Promise.all(Array.from({ length: Number(item.tts_key) }, (_, n) => cfg.kv.get(partKey(Number(id), n), 'arrayBuffer')));
  if (parts.some((p) => !p)) {
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
