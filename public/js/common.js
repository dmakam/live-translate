// Shared pieces: audio capture + Hindi speech recognition, translation, read-aloud, level meter.

export const $ = (s, el = document) => el.querySelector(s);

let configPromise;
export function getConfig() {
  configPromise = configPromise || fetch('/api/config').then(r => r.json()).catch(() => ({ claude: false }));
  return configPromise;
}

export function browserCheck() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const isChromium = !!window.chrome;
  const isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
  if (!SR || !isChromium) return 'Open this page in Google Chrome or Microsoft Edge on a computer. Other browsers cannot do the Hindi speech recognition.';
  if (isMobile) return 'Capturing audio needs Chrome or Edge on a laptop or PC. Phones can open the listener link instead.';
  if (!navigator.mediaDevices?.getDisplayMedia) return 'This browser cannot share tab audio. Update Chrome or Edge to the latest version.';
  return null;
}

// ---------------- translation ----------------
let localTranslator = null;

// Call from a click handler: Chrome only downloads its translation model after a user gesture.
export async function prepareTranslation(onStatus = () => {}) {
  const cfg = await getConfig();
  if (cfg.claude) return 'claude';
  if (!('Translator' in self)) throw new Error('No translation engine: this Chrome has no built-in translator and the server has no Claude key.');
  const avail = await Translator.availability({ sourceLanguage: 'hi', targetLanguage: 'en' });
  if (avail === 'unavailable') throw new Error('Chrome cannot translate Hindi to English on this device.');
  localTranslator = await Translator.create({
    sourceLanguage: 'hi', targetLanguage: 'en',
    monitor(m) { m.addEventListener('downloadprogress', e => onStatus(`Downloading translation model ${Math.round(e.loaded * 100)}%`)); },
  });
  return 'chrome';
}

let localFailed = false;
async function ensureLocal() {
  if (localTranslator || localFailed || !('Translator' in self)) return localTranslator;
  // The on-device model may need a download that never finishes; never let it stall the queue.
  const timeout = new Promise((r) => setTimeout(() => r(null), 3000));
  try { localTranslator = await Promise.race([Translator.create({ sourceLanguage: 'hi', targetLanguage: 'en' }), timeout]); } catch {}
  if (!localTranslator) localFailed = true;
  return localTranslator;
}

// Shows which engine translated the latest line, so a silent Claude failure is visible.
function engineBadge(state) {
  const el = document.getElementById('engine');
  if (!el) return;
  const txt = { claude: 'Translation: Claude', failed: 'Translation: Chrome (Claude failed - check server)', limited: 'Translation: Chrome (Claude limit reached)' }[state];
  el.textContent = txt;
  el.style.color = state === 'claude' ? '' : 'var(--warn)';
  el.style.borderColor = state === 'claude' ? '' : 'rgba(255,181,71,.4)';
}

export async function translateLine(hi, context = [], contextEn = []) {
  const cfg = await getConfig();
  if (cfg.claude) {
    try {
      const r = await fetch('/api/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hi, context, contextEn }) });
      if (r.ok) { const j = await r.json(); if (j.en) { engineBadge('claude'); return { en: j.en, engine: 'claude' }; } }
      else if (r.status === 429) engineBadge('limited');
      else engineBadge('failed');
    } catch { engineBadge('failed'); }
  }
  const t = await ensureLocal();
  if (t) { try { return { en: await Promise.race([t.translate(hi), new Promise((_, x) => setTimeout(x, 4000))]), engine: 'chrome' }; } catch {} }
  return { en: '', engine: 'none' };
}

// ---------------- chunking ----------------
// Fluent speakers rarely pause, so a recogniser keeps one long segment open. Instead of
// waiting for it to close, send the settled part for translation and keep listening.
const HOLD = 2;   // the last few words can still change, so never send them early
const END_AFTER = /^(\u0939\u0948|\u0939\u0948\u0902|\u0925\u093e|\u0925\u0947|\u0925\u0940|\u0917\u093e|\u0917\u0947|\u0917\u0940)$/; // hai, hain, tha, the, thi, ga, ge, gi
const BREAK_BEFORE = /^(\u0932\u0947\u0915\u093f\u0928|\u0915\u094d\u092f\u094b\u0902\u0915\u093f|\u0914\u0930|\u0924\u094b|\u092a\u0930|\u091c\u092c|\u0905\u0917\u0930)$/; // lekin, kyonki, aur, to, par, jab, agar
// rahe, raha, rahi, hai, hain, tha, the, thi, jata, jate, jati, gaya, gaye, gayi, sakte, sakta, sakti, pate, pata, chuke, diya, liya, hota, hote, hoti
const AUX_START = /^(\u0930\u0939\u0947|\u0930\u0939\u093e|\u0930\u0939\u0940|\u0939\u0948|\u0939\u0948\u0902|\u0925\u093e|\u0925\u0947|\u0925\u0940|\u091c\u093e\u0924\u093e|\u091c\u093e\u0924\u0947|\u091c\u093e\u0924\u0940|\u0917\u092f\u093e|\u0917\u090f|\u0917\u0908|\u0938\u0915\u0924\u0947|\u0938\u0915\u0924\u093e|\u0938\u0915\u0924\u0940|\u092a\u093e\u0924\u0947|\u092a\u093e\u0924\u093e|\u091a\u0941\u0915\u0947|\u0926\u093f\u092f\u093e|\u0932\u093f\u092f\u093e|\u0939\u094b\u0924\u093e|\u0939\u094b\u0924\u0947|\u0939\u094b\u0924\u0940)[\u0964.,]?$/;
const bare = (w) => String(w || '').replace(/[\u0964\u0965.,?!;:"')]+$/, '');
// A word ending a sentence (Scribe adds punctuation, e.g. "\u0939\u0948\u0964") or a sentence-final verb ending.
const isBreakAfter = (w) => /[\u0964\u0965.?!]["')]*$/.test(w || '') || END_AFTER.test(bare(w));
export class Chunker {
  constructor(onChunk) { this.onChunk = onChunk; this.done = 0; this.started = 0; }
  // text: the whole current segment so far; isFinal: the recogniser closed the segment.
  // Returns the words not yet sent (for the live "in progress" display).
  update(text, isFinal) {
    const words = String(text || '').trim().split(/\s+/).filter(Boolean);
    if (isFinal) {
      const rest = words.slice(this.done).join(' ');
      if (rest) this.onChunk(rest);
      this.done = 0; this.started = 0;
      return '';
    }
    if (!this.started) this.started = Date.now();
    const settled = words.length - HOLD;
    const fresh = settled - this.done;
    const age = Date.now() - this.started;
    let cutAt = -1;
    // Short chunks keep the English close to the speaker: cut at a natural break after
    // 5+ words, or anywhere after 12 words / 5 seconds.
    if (fresh >= 5) {
      for (let k = settled; k >= this.done + 5; k--) {
        if (isBreakAfter(words[k - 1]) || BREAK_BEFORE.test(bare(words[k]))) { cutAt = k; break; }
      }
    }
    if (cutAt < 0 && (fresh >= 12 || (fresh >= 4 && age > 5000))) cutAt = settled;
    // Never start the next chunk with a helper verb ("maan | rahe hain"): move the cut back
    // so the helper stays with its verb.
    while (cutAt > this.done + 3 && AUX_START.test(words[cutAt] || '') && !isBreakAfter(words[cutAt - 1])) cutAt--;
    if (cutAt > this.done) {
      this.onChunk(words.slice(this.done, cutAt).join(' '));
      this.done = cutAt; this.started = Date.now();
    }
    return words.slice(this.done).join(' ');
  }
}

// ---------------- audio stream for server-side recognition (ElevenLabs Scribe) ----------------
// Turns the captured tab audio into 16 kHz 16-bit mono PCM and hands 100 ms frames to send().
const PCM_WORKLET = `
class Pcm extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Int16Array(1600); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      const v = Math.max(-1, Math.min(1, ch[i]));
      this.buf[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.buffer.slice(0)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('pcm16', Pcm);`;
export class PcmStreamer {
  async start(stream, send) {
    this.ctx = new AudioContext({ sampleRate: 16000 });   // the browser resamples the tab audio
    const url = URL.createObjectURL(new Blob([PCM_WORKLET], { type: 'text/javascript' }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    this.src = this.ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    this.node = new AudioWorkletNode(this.ctx, 'pcm16');
    this.node.port.onmessage = (e) => send(e.data);
    this.src.connect(this.node);   // not connected to the speakers: no echo
  }
  stop() { try { this.src?.disconnect(); this.node?.disconnect(); this.ctx?.close(); } catch {} this.ctx = null; }
}

// ---------------- capture + recognition ----------------
// source: 'tab' (YouTube / Zoom / any tab or screen with audio) or 'mic'
export class HindiRecognizer {
  constructor({ onInterim, onFinal, onStatus, onStop }) {
    Object.assign(this, { onInterim, onFinal, onStatus, onStop });
    this.running = false;
    this.stream = null;
    this.track = null;
  }

  async start(source, { muteLocal = false, recognize = true } = {}) {
    if (source === 'tab') {
      // Chrome needs video in the request; we ignore it. User must tick "Also share tab audio".
      this.stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { suppressLocalAudioPlayback: muteLocal, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        systemAudio: 'include',
        selfBrowserSurface: 'exclude',
        preferCurrentTab: false,
      });
      this.track = this.stream.getAudioTracks()[0];
      if (!this.track) {
        this.stream.getTracks().forEach(t => t.stop());
        throw new Error('NO_AUDIO');
      }
      this.stream.getVideoTracks().forEach(t => t.addEventListener('ended', () => this.stop()));
    } else {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.track = this.stream.getAudioTracks()[0];
    }
    this.track.addEventListener('ended', () => this.stop());
    this.running = true;
    if (recognize) this._loop();
    return this.stream;
  }

  // Switch to Chrome's own recognition on the already-captured audio (backup for Scribe).
  startChrome() { if (this.running && !this.rec) this._loop();
  }

  _loop() {
    if (!this.running) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const r = new SR();
    this.rec = r;
    r.lang = 'hi-IN';
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    // One Chunker per Chrome result slot (see Chunker below).
    const chunkers = new Map();
    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (!chunkers.has(i)) chunkers.set(i, new Chunker((t) => this.onFinal?.(t)));
        interim += chunkers.get(i).update(res[0].transcript, res.isFinal) + ' ';
        if (res.isFinal) chunkers.delete(i);
      }
      this.onInterim?.(interim.trim());
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { this.onStatus?.('Speech recognition was blocked by the browser.', 'bad'); this.stop(); }
      else if (e.error === 'network') this.onStatus?.('Speech service unreachable - check the internet connection. Retrying...', 'warn');
      else if (e.error !== 'no-speech' && e.error !== 'aborted') this.onStatus?.('Recognition hiccup: ' + e.error + ' - retrying', 'warn');
    };
    // Chrome ends recognition sessions every so often; restart on the same audio track.
    r.onend = () => { if (this.running) setTimeout(() => this._loop(), 50); };
    try {
      if (this.track && this.track.readyState === 'live') r.start(this.track);
      else r.start();
    } catch (err) {
      this.onStatus?.('This Chrome cannot run speech recognition on tab audio. Update Chrome. (' + err.message + ')', 'bad');
      this.stop();
    }
  }

  // Mute / unmute the shared tab for the person watching, while still capturing its audio.
  async setLocalMute(on) {
    if (!this.track) return null;
    try { await this.track.applyConstraints({ suppressLocalAudioPlayback: !!on }); } catch {}
    const st = this.track.getSettings ? this.track.getSettings() : {};
    return 'suppressLocalAudioPlayback' in st ? st.suppressLocalAudioPlayback === !!on : null;
  }

  stop() {
    if (!this.running && !this.stream) return;
    this.running = false;
    try { this.rec?.abort(); } catch {}
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null; this.track = null;
    this.onStop?.();
  }
}

// ---------------- audio level meter ----------------
export function attachMeter(stream, barEl) {
  try {
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an); // not connected to speakers: no echo
    const buf = new Uint8Array(an.fftSize);
    let alive = true;
    (function tick() {
      if (!alive) return;
      an.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      barEl.style.setProperty('--lvl', Math.min(1, peak / 70).toFixed(3));
      requestAnimationFrame(tick);
    })();
    return () => { alive = false; ctx.close(); barEl.style.setProperty('--lvl', 0); };
  } catch { return () => {}; }
}

// ---------------- read aloud ----------------
const ACCENTS = { US: 'American', GB: 'British', IN: 'Indian', AU: 'Australian', IE: 'Irish', ZA: 'South African', CA: 'Canadian', NZ: 'New Zealand', SG: 'Singaporean' };
const MALE = /\b(male|daniel|rishi|alex|fred|aaron|arthur|evan|nathan|tom|oliver|gordon|lee|reed|rocko|eddy|grandpa|ralph|albert|guy|ryan|prabhat|christopher|eric|davis|andrew|brian|roger|steffan|william|liam|mark|david|george|ravi|james|thomas|connor|kunal|aarav|jamie|junior)\b/i;
const FEMALE = /\b(female|samantha|karen|moira|tessa|veena|kate|serena|fiona|victoria|allison|ava|susan|zoe|nicky|zira|aria|jenny|neerja|heera|sonia|libby|natasha|emma|michelle|catherine|hazel|isha|ananya|siri|flo|sandy|shelley|grandma|kathy|martha)\b/i;

export function voiceInfo(v) {
  const region = (v.lang.split(/[-_]/)[1] || '').toUpperCase();
  const accent = ACCENTS[region] || v.lang;
  const gender = /google us english/i.test(v.name) ? 'female' : MALE.test(v.name) ? 'male' : FEMALE.test(v.name) ? 'female' : '';
  const name = v.name.replace(/^(Microsoft|Google)\s+/i, '').replace(/\s*\(.*\)$/, '').replace(/ Online.*$/i, '');
  // Neural voices (Edge "Online (Natural)", macOS Premium/Enhanced, Google network voices) sound far more human.
  const natural = /natural|premium|enhanced|neural/i.test(v.name) ? 2 : (/online|google/i.test(v.name) || !v.localService) ? 1 : 0;
  return { accent, gender, natural, label: (natural === 2 ? '\u2605 ' : '') + [name, accent, gender].filter(Boolean).join(' \u00b7 ') };
}

// ---------------- natural AI voice player ----------------
// Plays MP3 lines made by the server's AI voice. One <audio> element is unlocked by the
// first tap and reused, which is what phones require.
const SILENT_MP3 = 'data:audio/mpeg;base64,//OExAAAAAAAAAAAAFhpbmcAAAAPAAAABwAAAWgAJCQkJCQkJCQkJCQkJCRJSUlJSUlJSUlJSUlJSW1tbW1tbW1tbW1tbW1tkpKSkpKSkpKSkpKSkpKStra2tra2tra2tra2trbb29vb29vb29vb29vb2///////////////////AAAAPExBTUUzLjEwMAR4AAAAAAAAAAAVCCQEICEAAcwAAAFo3WBJTQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//MUxAAAAANIAAAAAExBTUUzLjEwMFVV//MUxAsAAANIAAAAAFVVVVVVVVVVVVVV//MUxBYAAANIAAAAAFVVVVVVVVVVVVVV//MUxCEAAANIAAAAAFVVVVVVVVVVVVVV//MUxCwAAANIAAAAAFVVVVVVVVVVVVVV//MUxDcAAANIAAAAAFVVVVVVVVVVVVVV//MUxEIAAANIAAAAAFVVVVVVVVVVVVVV';
export class AIPlayer {
  constructor() {
    this.el = new Audio(); this.el.preload = 'auto';
    this.queue = []; this.playing = false; this.rate = 1;
    this.el.onended = () => { this.playing = false; this.onState?.('idle'); this._next(); };
    this.el.onplaying = () => this.onState?.('speaking');
    this.el.onerror = () => { const it = this.cur; this.playing = false; if (it && it.url !== SILENT_MP3) this.onFail?.(it.text); this._next(); };
  }
  unlock() { this.el.src = SILENT_MP3; this.el.play().catch(() => {}); }
  // Every line is spoken. When lines are waiting, speech speeds up gently to catch up;
  // only if more than three are waiting is the oldest skipped.
  catchUp() { const n = this.queue.length; return Math.min(this.rate * (n >= 2 ? 1.3 : n === 1 ? 1.15 : 1), 1.7); }
  play(url, text) {
    const it = { url, text };
    // Download the clip now, while the current one is still playing, so the next sentence
    // starts with no gap (waiting to download each clip added ~0.5 s of silence between lines).
    if (!url.startsWith('data:')) {
      it.ready = fetch(url).then((r) => (r.ok ? r.blob() : null)).then((b) => (it.blob = b ? URL.createObjectURL(b) : null)).catch(() => null);
    }
    this.queue.push(it);
    while (this.queue.length > 3) this._drop(this.queue.shift());
    if (!this.playing) this._next();
    else this.el.playbackRate = this.catchUp();
  }
  _drop(it) { if (it?.blob) setTimeout(() => URL.revokeObjectURL(it.blob), 1000); }
  async _next() {
    const it = this.queue.shift();
    if (!it) return;
    this.playing = true;
    if (it.ready && !it.blob) await Promise.race([it.ready, new Promise((r) => setTimeout(r, 4000))]);
    if (this.cur) this._drop(this.cur);
    this.cur = it;
    this.el.src = it.blob || it.url; this.el.playbackRate = this.catchUp();
    this.el.play().catch(() => { this.playing = false; this.onFail?.(it.text); this._next(); });
  }
  stop() { this.queue = []; this.playing = false; try { this.el.pause(); } catch {} }
}

const voiceKey = (v) => (v.voiceURI || v.name) + '|' + v.lang;

export class ReadAloud {
  constructor() {
    this.on = false; this.voice = null;
    this.ai = null;            // { voice } when the natural AI voice is selected
    this.player = new AIPlayer();
    this.player.onState = (st) => this.onState?.(st);
    this.player.onFail = (text) => this._deviceSay(text);   // network trouble: fall back to the device voice
    try { this.wanted = localStorage.getItem('lt-voice') || ''; this.rate = +localStorage.getItem('lt-rate') || 0.9; } catch { this.wanted = ''; this.rate = 0.9; }
  }
  voices() {
    // Chrome can list the same voice more than once - keep one per key.
    const seen = new Set();
    return speechSynthesis.getVoices().filter(v => /^en/i.test(v.lang) && !seen.has(voiceKey(v)) && seen.add(voiceKey(v)));
  }
  pickVoice() {
    const vs = this.voices();
    const saved = vs.find(v => voiceKey(v) === this.wanted) || vs.find(v => v.name === this.wanted.split('|')[0]);
    if (saved) { this.voice = saved; return; }
    // keep what is already chosen, but swap in Chrome's current object for it
    const same = this.voice && vs.find(v => voiceKey(v) === voiceKey(this.voice));
    if (same) { this.voice = same; return; }
    // Default: Rishi (Indian English, male). On devices without Rishi, prefer another
    // Indian-English male voice, then the most human-sounding male voice.
    // Default order: natural Indian-English male (Edge "Prabhat") > Rishi (Mac) > other Indian male
    // > any natural male > any natural voice > anything else.
    const score = ({ v, i }) => (i.accent === 'Indian' && i.gender === 'male' ? (i.natural === 2 ? 1000 : 400) : 0)
      + (/rishi/i.test(v.name) ? 500 : 0) + i.natural * 100 + (i.gender === 'male' ? 50 : 0);
    const ranked = vs.map(v => ({ v, i: voiceInfo(v) })).sort((a, b) => score(b) - score(a));
    this.voice = ranked[0]?.v || null;
  }
  setVoice(key) {
    this.wanted = key;
    try { localStorage.setItem('lt-voice', key); } catch {}
    this.voice = this.voices().find(v => voiceKey(v) === key) || this.voice;
  }
  currentVoice() {
    const vs = speechSynthesis.getVoices();
    const want = this.voice ? voiceKey(this.voice) : this.wanted;
    const v = (want && vs.find(x => voiceKey(x) === want)) || (this.wanted && vs.find(x => x.name === this.wanted.split('|')[0]));
    if (v) this.voice = v;
    return v || this.voice;
  }
  setRate(r) { this.rate = r; this.player.rate = r / 0.9; try { localStorage.setItem('lt-rate', r); } catch {} }
  // Lines are spoken one at a time from our own queue. We never call cancel() right before
  // speak(): in Chrome that cancels the new line, and repeated cancels can freeze the speech engine.
  useAI(voice) {          // voice id, or null for the device voice
    this.ai = voice ? { voice } : null;
    try { localStorage.setItem('lt-ai', voice || 'off'); } catch {}
  }
  aiUrl(text) { return '/api/tts?voice=' + encodeURIComponent(this.ai.voice) + '&text=' + encodeURIComponent(text); }
  // room pages pass the server's ready-made audio for a line
  playAudio(url, text) { if (this.on && this.ai) this.player.play(url, text); }
  toggle() {
    this.on = !this.on;
    this.queue = [];
    if (this.ai) {
      if (this.on) { this.player.unlock(); this.player.rate = this.rate / 0.9; this.player.play(this.aiUrl('English sound is on.'), 'English sound is on.'); }
      else this.player.stop();
      return this.on;
    }
    if (this.on) {
      if (!this.voice) this.pickVoice();
      this.busy = false;
      // Speak inside the tap itself: phones only allow speech that starts from a user tap.
      this._enqueue('English sound is on.');
    } else { this.busy = false; speechSynthesis.cancel(); }
    return this.on;
  }
  say(text, force = false) {
    if ((!this.on && !force) || !text) return;
    if (this.ai) {
      if (force) { this.player.unlock(); this.player.stop(); }
      this.player.rate = this.rate / 0.9;
      return this.player.play(this.aiUrl(text), text);
    }
    this._enqueue(text, force);
  }
  _deviceSay(text) { if (text && this.on) this._enqueue(text); }
  _enqueue(text, front = false) {
    this.queue = this.queue || [];
    if (front) this.queue = [text]; else this.queue.push(text);
    // Running behind? Keep only the newest two lines so the audio stays close to live.
    while (this.queue.length > 2) this.queue.shift();
    if (!this.busy) this._next();
  }
  _next() {
    const text = (this.queue || []).shift();
    if (!text) { this.busy = false; return; }
    this.busy = true;
    const u = new SpeechSynthesisUtterance(text);
    // Chrome reloads its voice list after the page opens; a voice object from the old list is
    // silently ignored (it falls back to the default female voice). Always use the current object.
    const v = this.currentVoice();
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-US';
    u.rate = this.rate;
    let started = false, done = false;
    const finish = () => { if (done) return; done = true; this.busy = false; this.onState?.('idle'); setTimeout(() => this._next(), 120); };
    u.onstart = () => { started = true; this.stuck = false; this.onState?.('speaking'); };
    u.onend = finish;
    u.onerror = (e) => { if (e.error !== 'interrupted' && e.error !== 'canceled') this.onState?.('error', e.error); finish(); };
    this._keep = [u];   // Chromium can garbage-collect an utterance before it plays
    speechSynthesis.resume();
    speechSynthesis.speak(u);
    // If the engine never starts, report it instead of hammering it with cancels.
    const words = text.split(/\s+/).length;
    setTimeout(() => { if (!started && !done) { this.stuck = true; this.onState?.('stuck'); } }, 5000);
    setTimeout(() => { if (!done) finish(); }, 8000 + words * 900);  // safety: never block the queue forever
  }
}

// Fills a <select> with English voices, male voices first, grouped by gender.
export function voicePicker(selectEl, testBtn, rateEl, reader, aiOptions = null) {
  // aiOptions: [{ id, label }] natural voices offered by the server (null = none)
  let lastSig = '';
  let savedAI = null; try { savedAI = localStorage.getItem('lt-ai'); } catch {}
  if (aiOptions?.length && savedAI !== 'off') reader.useAI(aiOptions.some(o => o.id === savedAI) ? savedAI : aiOptions[0].id);
  function fill() {
    const vs = reader.voices();
    if (!vs.length && !aiOptions?.length) return;   // natural voices work even with no device voices
    const sig = vs.map(voiceKey).join(',') + '|' + (aiOptions || []).map(o => o.id).join(',');
    if (sig === lastSig) return;                       // Chrome fires voiceschanged repeatedly
    if (document.activeElement === selectEl) {          // never rebuild while the list is open
      selectEl.addEventListener('blur', fill, { once: true }); return;
    }
    lastSig = sig;
    reader.pickVoice();
    const items = vs.map(v => ({ v, key: voiceKey(v), ...voiceInfo(v) }));
    const count = {}; items.forEach(it => count[it.label] = (count[it.label] || 0) + 1);
    items.forEach(it => { if (count[it.label] > 1) it.label += ' (' + it.v.lang + (it.v.localService ? '' : ', online') + ')'; });
    const rank = g => g === 'male' ? 0 : g === 'female' ? 1 : 2;
    items.sort((a, b) => rank(a.gender) - rank(b.gender) || (b.natural - a.natural) || a.accent.localeCompare(b.accent) || a.label.localeCompare(b.label));
    selectEl.innerHTML = '';
    if (aiOptions?.length) {
      const ag = document.createElement('optgroup'); ag.label = 'Natural voices (recommended)';
      for (const o of aiOptions) { const op = document.createElement('option'); op.value = 'ai:' + o.id; op.textContent = '\u2605 ' + o.label; ag.append(op); }
      selectEl.append(ag);
    }
    let group = null, g = null;
    for (const it of items) {
      const gl = it.gender ? it.gender[0].toUpperCase() + it.gender.slice(1) + ' voices' : 'Other voices';
      if (gl !== g) { group = document.createElement('optgroup'); group.label = g = gl; selectEl.append(group); }
      const o = document.createElement('option');
      o.value = it.key; o.textContent = it.label;
      group.append(o);
    }
    if (reader.ai) selectEl.value = 'ai:' + reader.ai.voice;
    else if (reader.voice) selectEl.value = voiceKey(reader.voice);
  }
  fill();
  speechSynthesis.addEventListener('voiceschanged', fill);
  setTimeout(edgeHint, 1500); speechSynthesis.addEventListener('voiceschanged', () => setTimeout(edgeHint, 300));

  // Tell people on a computer without natural voices to switch to Edge.
  function edgeHint() {
    const box = document.getElementById('vhint');
    if (!box) return;
    if (aiOptions?.length) { box.innerHTML = '&#9733; Natural voices sound like a real person and work on every device.'; return; }
    const hasNatural = reader.voices().some(v => voiceInfo(v).natural === 2);
    const mobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
    const isEdge = /Edg\//.test(navigator.userAgent);
    if (hasNatural) { box.innerHTML = '&#9733; = natural-sounding voice.'; return; }
    if (mobile) { box.textContent = 'This phone only has basic voices. Its built-in voice is used.'; return; }
    box.innerHTML = (isEdge ? 'Natural voices are still loading - check your internet connection.' :
      '<b style="color:#ffe2b0">Want a natural, human-sounding voice?</b> Open this page in <b>Microsoft Edge</b> - it has free natural voices. ' +
      '<span style="display:block; margin-top:8px"><button class="btn small ghost" id="copyEdge">Copy link for Edge</button></span>');
    const b = document.getElementById('copyEdge');
    if (b) b.onclick = async () => { try { await navigator.clipboard.writeText(location.href); b.textContent = 'Copied - paste it into Edge'; } catch { b.textContent = location.href; } };
  }
  const sample = 'Hello, this is how the English translation will sound.';
  selectEl.onchange = () => {
    const v = selectEl.value;
    if (v.startsWith('ai:')) reader.useAI(v.slice(3));
    else { reader.useAI(null); reader.setVoice(v); }
    reader.say(sample, true);
  };
  if (testBtn) testBtn.onclick = () => reader.say(sample, true);
  if (rateEl) { rateEl.value = reader.rate; rateEl.oninput = () => reader.setRate(+rateEl.value); }
}

export function transcriptText(lines, title) {
  const head = (title ? title + '\n' : '') + 'Live Hindi to English transcript - ' + new Date().toLocaleString() + '\n\n';
  return head + lines.map(l => `[${new Date(l.t).toLocaleTimeString()}${l.tIso ? ' | ' + l.tIso : ''}]\nHI: ${l.hi}\nEN: ${l.en}\n`).join('\n');
}

export function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
