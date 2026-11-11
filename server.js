// Live Hindi -> English translation (proof of concept)
// - Host mode: one host captures a stream's audio, many listeners follow a room link
// - Solo mode: one person translates a stream on their own screen
// Speech-to-text runs in the host's Chrome (Web Speech API, free).
// Translation: Claude (if ANTHROPIC_API_KEY is set), otherwise Chrome's on-device translator.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT || 3000);
const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY || '';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-5-5';
const TTS_URL = process.env.TTS_URL || '';           // e.g. http://live-translate-tts:8000 (natural AI voice)
// Optional premium voice: ElevenLabs. Set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID in .env.
const EL_KEY = process.env.ELEVENLABS_API_KEY || '';
const EL_VOICE = process.env.ELEVENLABS_VOICE_ID || '';
const EL_NAME = process.env.ELEVENLABS_VOICE_NAME || 'Premium Indian voice';
const EL_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5';
const EL_ON = Boolean(EL_KEY && EL_VOICE);
const DEFAULT_VOICE = process.env.TTS_VOICE || (EL_ON ? 'el:' + EL_VOICE : 'bm_george');
const VOICE_ID_RE = /^([a-z]{2}_[a-z]+|el:[A-Za-z0-9]{8,40})$/;
// Speech recognition: ElevenLabs Scribe v2 Realtime when a key is set (STT=chrome turns it off).
const STT_ON = Boolean(EL_KEY) && process.env.STT !== 'chrome';
const STT_KEYTERMS = (process.env.STT_KEYTERMS || 'Dharma,samskara,samskaras,karma,Heartfulness,Daaji,Mathura,meditation,Pranahuti,spirituality,Pramadam,Yudhishthira,Yaksha,Mahabharata,Dharmaputra,Gurudev')
  .split(',').map(t => t.trim()).filter(Boolean).slice(0, 50);

// Guardrails so a public proof of concept can't run up a bill
const LIMITS = {
  maxRooms: Number(process.env.MAX_ROOMS || 100),
  roomHours: Number(process.env.ROOM_HOURS || 4),        // a live room closes this long after its last activity
  advanceDays: Number(process.env.ADVANCE_DAYS || 14),   // links can be created this far ahead of the event
  perIpPerMin: Number(process.env.TRANSLATE_PER_MIN || 40),
  dailyTranslations: Number(process.env.DAILY_TRANSLATIONS || 5000),
  maxChars: 600,
  historyLines: 300,
};

const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const ROUTES = { '/': 'index.html', '/host': 'host.html', '/solo': 'solo.html', '/test': 'test.html' };

// ---------- rooms ----------
// room: { code, hostToken, title, startsAt, created, expiresAt, live, history, interim, clients:Set }
const rooms = new Map();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
const RESERVED = new Set(['HOST', 'SOLO', 'TEST', 'API', 'WS', 'JOIN', 'ADMIN', 'NEW']);

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from(crypto.randomBytes(5), b => A[b % A.length]).join(''); } while (rooms.has(c));
  return c;
}
const normCode = (c) => String(c || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');

// Rooms are saved so links created days ahead survive a restart (history is not saved).
let saveTimer = null;
function saveRooms() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const out = [...rooms.values()].map(({ code, hostToken, title, startsAt, created, expiresAt, voice }) => ({ code, hostToken, title, startsAt, created, expiresAt, voice }));
      fs.writeFileSync(ROOMS_FILE + '.tmp', JSON.stringify(out));
      fs.renameSync(ROOMS_FILE + '.tmp', ROOMS_FILE);
    } catch (e) { console.error('Could not save rooms:', e.message); }
  }, 500);
}
function loadRooms() {
  try {
    for (const r of JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'))) {
      if (r.expiresAt > Date.now()) rooms.set(r.code, { ...r, live: false, history: [], interim: null, clients: new Set() });
    }
    if (rooms.size) console.log(`Restored ${rooms.size} room(s)`);
  } catch {}
}
loadRooms();

function touch(room) {
  // a room in use stays open for ROOM_HOURS after its latest activity
  room.expiresAt = Math.max(room.expiresAt, Date.now() + LIMITS.roomHours * 3600e3);
}

function sweepRooms() {
  const now = Date.now();
  let changed = false;
  for (const [code, r] of rooms) {
    if (now > r.expiresAt) {
      for (const c of r.clients) { try { c.send(JSON.stringify({ type: 'closed' })); c.close(); } catch {} }
      rooms.delete(code); changed = true;
    }
  }
  if (changed) saveRooms();
}
setInterval(sweepRooms, 60e3);

const publicRoom = (r) => ({ code: r.code, title: r.title, startsAt: r.startsAt || null, live: !!r.live, expiresAt: r.expiresAt, voice: r.voice || DEFAULT_VOICE, naturalVoice: tts.ready });

// ---------- translation ----------
const ipHits = new Map(); // ip -> [timestamps]
let day = new Date().toDateString(), dayCount = 0;

function allowTranslate(ip) {
  const today = new Date().toDateString();
  if (today !== day) { day = today; dayCount = 0; }
  if (dayCount >= LIMITS.dailyTranslations) return 'daily';
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter(t => now - t < 60e3);
  if (hits.length >= LIMITS.perIpPerMin) return 'rate';
  hits.push(now); ipHits.set(ip, hits); dayCount++;
  return null;
}
setInterval(() => { const now = Date.now(); for (const [ip, h] of ipHits) if (!h.some(t => now - t < 60e3)) ipHits.delete(ip); }, 120e3);

let lastErr = { msg: '', at: 0 };

const SYSTEM_PROMPT =
  'You are a live subtitle translator. You turn spoken Hindi (from speech recognition, often Hinglish, unpunctuated, ' +
  'sometimes with recognition errors) into natural English subtitles for viewers of a talk or event.\n' +
  'Speech is cut into chunks at fixed lengths, so the line may be a fragment that starts or ends mid-sentence. ' +
  'Translate exactly what the fragment says, so it reads as a natural continuation of the previous English line. ' +
  'Do not complete the thought. Translate EVERYTHING in this line: speakers often repeat a phrase on purpose ' +
  '(for emphasis, e.g. "that is Dharma ... that is Dharma"), so translate repeats again; never drop words, numbers or prices. ' +
  'The chunks do not overlap, so nothing in this line has been translated before.\n' +
  'If the line ends mid-sentence, end your English with NO final punctuation; put a full stop, question mark or ' +
  'exclamation mark only when the sentence is really complete.\n' +
  'Keep names, Sanskrit terms and English words as spoken.\n' +
  'Speech recognition sometimes writes a Hindi word in English letters: "bus" usually means \u092c\u0938 ' +
  '(e.g. "\u092e\u0947\u0930\u0947 bus \u0915\u0947 \u092c\u093e\u0939\u0930" = "beyond my control"), "to" may be \u0924\u094b ("so"). ' +
  'Translate by the meaning in the Hindi sentence, not the English spelling. ' +
  'If a word looks like a strange proper name that does not fit, it is probably a misheard ordinary word: ' +
  'infer the likely meaning from context instead of inventing a name.\n' +
  'Reply with ONLY <en>the English</en>. Never explain, never comment, never ask questions, never leave it empty: ' +
  'even for a filler word or a line that repeats an earlier one, give the closest short English (for example <en>and then</en>).';

async function callClaude(userText, system = SYSTEM_PROMPT, tagged = true) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 1024, system, messages: [{ role: 'user', content: userText }] }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'Claude error');
  const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  let out;
  if (!tagged) out = text.split('\n')[0];
  else {
    const m = text.match(/<en>([\s\S]*?)(<\/en>|$)/i);   // a missing closing tag (cut-off reply) still counts
    // Untagged text is the model explaining, which must never reach viewers.
    out = m ? m[1] : (text.length < 160 && !/translat|hindi|\n/i.test(text) ? text : '');
  }
  out = out.replace(/<\/?en>/gi, '').replace(/^["\s]+|["\s]+$/g, '').trim();
  if (!out) console.error(`Empty translation (stop: ${j.stop_reason}): ${JSON.stringify(text.slice(0, 200))}`);
  return out;
}

const PLAIN_PROMPT = 'Translate the spoken Hindi (possibly garbled speech recognition, possibly English words written in Hindi script) ' +
  'into short, natural English. Give your best guess even if it is unclear. Output only the English, on one line.';

// Recognisers sometimes write a Hindi word in English letters; fix the known ones before translating.
function fixLatinHindi(t) {
  const DEV = '[\\u0900-\\u097F]';
  return String(t || '').replace(new RegExp('(' + DEV + '[^\\sA-Za-z]*\\s+)bus(?=\\s+' + DEV + ')', 'gi'), '$1\u092c\u0938');
}

async function claudeTranslate(hi, context, contextEn) {
  hi = fixLatinHindi(hi);
  const ctx = context.map((h, i) => `${h} => ${contextEn[i] || ''}`).join('\n');
  let en = await callClaude(`Earlier lines (Hindi => English already shown):\n${ctx || '(none)'}\n\nTranslate this line:\n${hi}`);
  if (!en) en = await callClaude(`Translate this line:\n${hi}`);   // retry once without context
  if (!en) en = await callClaude(hi, PLAIN_PROMPT, false);          // last resort: plain answer, no tags
  return en;
}

// ---------- natural voice (Kokoro service) ----------
const tts = { ready: EL_ON, voices: EL_ON ? [{ id: 'el:' + EL_VOICE, label: EL_NAME + ' \u00b7 ElevenLabs' }] : [] };
async function checkTts() {
  if (!TTS_URL) return;
  try {
    const j = await (await fetch(TTS_URL + '/health', { signal: AbortSignal.timeout(4000) })).json();
    if (!tts.ready && j.ok) console.log(`Natural voice service: self-test ${j.self_test}x real time - ${j.fast_enough === false ? 'too slow, using device voices' : 'in use'}`);
    const kokoroOk = !!j.ok && j.fast_enough !== false;
    tts.ready = EL_ON || kokoroOk; tts.selfTest = j.self_test;
    tts.voices = [...(EL_ON ? [{ id: 'el:' + EL_VOICE, label: EL_NAME + ' \u00b7 ElevenLabs' }] : []), ...(kokoroOk ? j.voices || [] : [])];
  } catch { if (tts.ready && !EL_ON) console.error('Natural voice service not reachable'); tts.ready = EL_ON; tts.voices = EL_ON ? tts.voices.filter(v => v.id.startsWith('el:')) : []; }
}
checkTts(); setInterval(checkTts, 30e3);

async function elevenSpeak(text, voiceId, previousText) {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'xi-api-key': EL_KEY, Accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: EL_MODEL, ...(previousText ? { previous_text: previousText.slice(-300) } : {}) }), signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error('elevenlabs ' + r.status + ' ' + (await r.text()).slice(0, 160));
  return Buffer.from(await r.arrayBuffer());
}

async function ttsSpeak(text, voice, previousText) {
  if (voice && voice.startsWith('el:')) {
    try { return await elevenSpeak(text, voice.slice(3), previousText); }
    catch (e) {
      console.error('ElevenLabs failed, using the free voice for this line:', e.message);
      if (!TTS_URL) throw e;
      voice = 'bm_george';
    }
  }
  const r = await fetch(TTS_URL + '/speak', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice }), signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error('tts ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

// Each room line is voiced once; listeners fetch the same MP3. One job at a time; if the
// service falls behind, the oldest waiting lines are skipped (their text still shows).
const audioStore = new Map();   // id -> Buffer
const ttsQueue = [];
let ttsBusy = false;
// Subtitles go out chunk by chunk, but speech waits for a whole English sentence, so the
// voice never stops mid-sentence. A short pause from the speaker also releases it.
const SENTENCE_END = /[.!?\u0964]["')\]]*\s*$/;
function addSpeech(room, line) {
  if (!tts.ready || !line.en) return;
  const sp = room.speech || (room.speech = { parts: [], firstAt: 0, lastId: null, timer: null });
  if (!sp.parts.length) sp.firstAt = Date.now();
  sp.parts.push(line.en.trim()); sp.lastId = line.id;
  clearTimeout(sp.timer);
  const text = sp.parts.join(' ');
  if (SENTENCE_END.test(text) || text.length > 240 || Date.now() - sp.firstAt > 9000) flushSpeech(room);
  else sp.timer = setTimeout(() => flushSpeech(room), 2500);   // speaker paused: say what we have
}
function flushSpeech(room) {
  const sp = room.speech;
  if (!sp || !sp.parts.length) return;
  clearTimeout(sp.timer);
  const en = sp.parts.join(' ').replace(/\s+/g, ' ').trim();
  sp.parts = [];
  queueRoomAudio(room, { id: sp.lastId, en });
}

function queueRoomAudio(room, line) {
  if (!tts.ready || !line.en) return;
  ttsQueue.push({ room, line });
  while (ttsQueue.length > 3) ttsQueue.shift();
  runTts();
}
async function runTts() {
  if (ttsBusy) return;
  const job = ttsQueue.shift();
  if (!job) return;
  ttsBusy = true;
  try {
    const buf = await ttsSpeak(job.line.en, job.room.voice || DEFAULT_VOICE, job.room.lastSpoken);
    job.room.lastSpoken = job.line.en;
    audioStore.set(job.line.id, buf);
    while (audioStore.size > 400) audioStore.delete(audioStore.keys().next().value);
    toListeners(job.room, { type: 'audio', id: job.line.id, url: '/audio/' + job.line.id + '.mp3' });
  } catch (e) { console.error('voice:', e.message); }
  ttsBusy = false;
  runTts();
}

// ---------- http ----------
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', d => { b += d; if (b.length > 20000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/api/config') return json(res, 200, { claude: Boolean(CLAUDE_KEY), roomHours: LIMITS.roomHours, advanceDays: LIMITS.advanceDays, tts: { ready: tts.ready, voices: tts.voices, defaultVoice: DEFAULT_VOICE }, stt: STT_ON ? 'elevenlabs' : 'chrome' });

  if (p === '/api/rooms' && req.method === 'POST') {
    sweepRooms();
    if (rooms.size >= LIMITS.maxRooms) return json(res, 429, { error: 'Too many rooms right now. Try again later.' });
    const body = await readBody(req);
    let code = newCode();
    if (body.slug) {
      code = normCode(body.slug);
      if (!/^[A-Z0-9][A-Z0-9-]{2,23}$/.test(code)) return json(res, 400, { error: 'Link names need 3-24 letters, numbers or dashes.' });
      if (RESERVED.has(code)) return json(res, 400, { error: 'That name is reserved. Try another.' });
      if (rooms.has(code)) return json(res, 409, { error: 'That link name is already taken. Try another.' });
    }
    let startsAt = null;
    if (body.startsAt) {
      startsAt = Date.parse(body.startsAt);
      if (!startsAt || startsAt > Date.now() + LIMITS.advanceDays * 86400e3) return json(res, 400, { error: `The start time must be within ${LIMITS.advanceDays} days.` });
    }
    const created = Date.now();
    const room = {
      code, hostToken: crypto.randomBytes(16).toString('hex'),
      title: String(body.title || '').slice(0, 80), startsAt, created,
      voice: VOICE_ID_RE.test(body.voice || '') ? body.voice : DEFAULT_VOICE,
      // open until the event plus a few hours; links without a start time last 2 days unless used
      expiresAt: Math.max(startsAt || created + 2 * 86400e3, created) + LIMITS.roomHours * 3600e3,
      live: false, history: [], interim: null, clients: new Set(),
    };
    rooms.set(code, room); saveRooms();
    return json(res, 200, { ...publicRoom(room), hostToken: room.hostToken });
  }

  if (p.startsWith('/api/rooms/') && req.method === 'GET') {
    const r = rooms.get(normCode(p.split('/')[3]));
    if (!r) return json(res, 404, { error: 'Room not found' });
    const key = url.searchParams.get('key');
    return json(res, 200, { ...publicRoom(r), isHost: key ? key === r.hostToken : undefined });
  }

  const am = p.match(/^\/audio\/([A-Za-z0-9]+)\.mp3$/);
  if (am) {
    const buf = audioStore.get(am[1]);
    if (!buf) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=3600' });
    return res.end(buf);
  }

  if (p === '/api/tts' && req.method === 'GET') {
    // on-demand natural voice for solo mode and the "sound is on" check
    if (!tts.ready) return json(res, 503, { error: 'voice unavailable' });
    const text = String(url.searchParams.get('text') || '').slice(0, 400).trim();
    const voice = tts.voices.some(v => v.id === url.searchParams.get('voice')) ? url.searchParams.get('voice') : DEFAULT_VOICE;
    if (!text) return json(res, 400, { error: 'empty' });
    const block = allowTranslate(clientIp(req));
    if (block) return json(res, 429, { error: block });
    try {
      const buf = await ttsSpeak(text, voice);
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=86400' });
      return res.end(buf);
    } catch (e) { return json(res, 502, { error: 'voice failed' }); }
  }

  if (p === '/api/translate' && req.method === 'POST') {
    if (!CLAUDE_KEY) return json(res, 501, { error: 'no-claude' });
    const body = await readBody(req);
    const hi = String(body.hi || '').slice(0, LIMITS.maxChars).trim();
    if (!hi) return json(res, 400, { error: 'empty' });
    const block = allowTranslate(clientIp(req));
    if (block) return json(res, 429, { error: block });
    const context = (Array.isArray(body.context) ? body.context : []).slice(-3).map(s => String(s).slice(0, LIMITS.maxChars));
    const contextEn = (Array.isArray(body.contextEn) ? body.contextEn : []).slice(-3).map(s => String(s).slice(0, 2000));
    try { return json(res, 200, { en: await claudeTranslate(hi, context, contextEn), engine: 'claude' }); }
    catch (e) {
      // Log each distinct error once a minute instead of flooding the terminal
      const now = Date.now();
      if (e.message !== lastErr.msg || now - lastErr.at > 60e3) { console.error('Claude translation failed (falling back to Chrome translator):', e.message); lastErr = { msg: e.message, at: now }; }
      return json(res, 502, { error: 'upstream' });
    }
  }

  // static files
  let file = ROUTES[p];
  if (!file && /^\/r\/[A-Za-z0-9-]{3,24}$/.test(p)) file = 'room.html';
  if (!file) file = p.slice(1);
  const full = path.join(PUBLIC, path.normalize(file));
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------- speech recognition relay (ElevenLabs Scribe v2 Realtime) ----------
// The organiser's page streams 16 kHz PCM; we forward it with our key (the key never reaches a
// browser) and send partial / committed Hindi text back to the organiser's page.
function startStt(room, hostWs) {
  stopStt(room);
  const q = new URLSearchParams({
    model_id: 'scribe_v2_realtime', language_code: 'hi', audio_format: 'pcm_16000',
    commit_strategy: 'vad', vad_silence_threshold_secs: '0.8',
  });
  q.append('secondary_languages', 'en');        // the speaker switches into English often
  for (const k of STT_KEYTERMS) q.append('keyterms', k);
  const el = new WebSocket((process.env.STT_URL || 'wss://api.elevenlabs.io/v1/speech-to-text/realtime') + '?' + q, { headers: { 'xi-api-key': EL_KEY } });
  const st = { el, host: hostWs, pending: [], open: false, started: Date.now(), bytes: 0 };
  room.stt = st;
  el.on('open', () => { st.open = true; for (const b of st.pending) sendAudio(st, b); st.pending = []; });
  el.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const to = st.host;
    if (m.message_type === 'partial_transcript') send(to, { type: 'stt', partial: m.text || '' });
    else if (m.message_type === 'committed_transcript') send(to, { type: 'stt', final: m.text || '' });
    else if (m.message_type === 'session_started') { console.log(`Scribe session started for room ${room.code}`); send(to, { type: 'stt-ready' }); }
    else if (m.error || /error|quota|throttled|invalid/i.test(m.message_type || '')) {
      console.error(`Scribe error (room ${room.code}):`, m.message_type, m.error || '');
      send(to, { type: 'stt-error', error: m.message_type + (m.error ? ': ' + m.error : '') });
      stopStt(room);
    }
  });
  el.on('error', (e) => { console.error('Scribe connection error:', e.message); send(st.host, { type: 'stt-error', error: 'connection' }); stopStt(room); });
  el.on('close', () => { if (room.stt === st) { room.stt = null; send(st.host, { type: 'stt-error', error: 'closed' }); } });
}
function sendAudio(st, buf) {
  st.bytes += buf.length;
  st.el.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: buf.toString('base64'), commit: false, sample_rate: 16000 }));
}
function sttAudio(room, buf) {
  const st = room.stt;
  if (!st) return;
  if (!st.open) { if (st.pending.length < 50) st.pending.push(buf); return; }
  if (st.el.readyState === 1) sendAudio(st, buf);
}
function stopStt(room) {
  const st = room.stt;
  if (!st) return;
  room.stt = null;
  const mins = (Date.now() - st.started) / 60000;
  console.log(`Scribe session ended for room ${room.code}: ${mins.toFixed(1)} min, ${(st.bytes / 32000 / 60).toFixed(1)} min of audio`);
  try { st.el.close(); } catch {}
}

// ---------- websocket ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function toListeners(room, obj) { const s = JSON.stringify(obj); for (const c of room.clients) if (!c.isHost && c.readyState === 1) c.send(s); }
function stats(room) {
  const n = [...room.clients].filter(c => !c.isHost).length;
  for (const c of room.clients) if (c.isHost) send(c, { type: 'stats', listeners: n });
}
function setLive(room, live) {
  if (room.live === live) return;
  room.live = live;
  toListeners(room, { type: 'status', live });
}

wss.on('connection', (ws, req) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const room = rooms.get(normCode(q.get('room')));
  if (!room) { send(ws, { type: 'error', error: 'Room not found or it has ended.' }); return ws.close(); }
  ws.isHost = q.get('host') === room.hostToken;
  room.clients.add(ws);

  send(ws, { type: 'hello', ...publicRoom(room), history: room.history, interim: room.interim, isHost: ws.isHost });
  stats(room);

  ws.on('message', (raw, isBinary) => {
    if (!ws.isHost) return;
    if (isBinary) return sttAudio(room, raw);          // organiser's audio for speech recognition
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'stt-start') { if (STT_ON) startStt(room, ws); else send(ws, { type: 'stt-error', error: 'not configured' }); return; }
    if (m.type === 'stt-stop') { stopStt(room); return; }
    if (m.type === 'status') {
      clearTimeout(room.offTimer);
      setLive(room, !!m.live); touch(room); saveRooms();
    } else if (m.type === 'interim') {
      room.interim = String(m.hi || '').slice(0, LIMITS.maxChars);
      setLive(room, true);
      toListeners(room, { type: 'interim', hi: room.interim });
    } else if (m.type === 'final' && m.hi) {
      room.interim = null;
      setLive(room, true); touch(room);
      const line = { id: Date.now().toString(36) + crypto.randomBytes(3).toString('hex'), t: Date.now(), hi: String(m.hi).slice(0, LIMITS.maxChars), en: String(m.en || '').slice(0, 2000) };
      room.history.push(line);
      if (room.history.length > LIMITS.historyLines) room.history.shift();
      toListeners(room, { type: 'final', line });
      addSpeech(room, line);
    } else if (m.type === 'voice' && VOICE_ID_RE.test(m.voice || '')) {
      room.voice = m.voice; saveRooms();
    } else if (m.type === 'clear') {
      room.history = []; room.interim = null;
      toListeners(room, { type: 'clear' });
    } else if (m.type === 'end') {
      toListeners(room, { type: 'closed' });
      for (const c of room.clients) try { c.close(); } catch {}
      rooms.delete(room.code); saveRooms();
    }
  });

  ws.on('close', () => {
    room.clients.delete(ws); stats(room);
    // host's connection dropped: tell listeners it's paused if it doesn't come back soon
    if (ws.isHost && room.stt && room.stt.host === ws) stopStt(room);   // never bill for an abandoned stream
    if (ws.isHost && ![...room.clients].some(c => c.isHost)) {
      clearTimeout(room.offTimer);
      room.offTimer = setTimeout(() => setLive(room, false), 20e3);
    }
  });
});

// keep connections alive behind proxies
setInterval(() => { for (const c of wss.clients) { try { c.ping(); } catch {} } }, 25e3);

server.listen(PORT, () => {
  console.log(`Live Translate on http://localhost:${PORT}`);
  console.log(`Translation engine: ${CLAUDE_KEY ? 'Claude (' + CLAUDE_MODEL + ')' : 'Chrome on-device translator (no ANTHROPIC_API_KEY)'}`);
});
