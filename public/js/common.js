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

async function ensureLocal() {
  if (localTranslator || !('Translator' in self)) return localTranslator;
  try { localTranslator = await Translator.create({ sourceLanguage: 'hi', targetLanguage: 'en' }); } catch {}
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
  if (t) { try { return { en: await t.translate(hi), engine: 'chrome' }; } catch {} }
  return { en: '', engine: 'none' };
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

  async start(source, { muteLocal = false } = {}) {
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
    this._loop();
    return this.stream;
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
    // Chunking without restarting: Chrome keeps one long result open while a fluent speaker
    // talks. Instead of stopping recognition (which loses the words spoken during the restart),
    // we send the settled part of the open result for translation and keep listening.
    const consumed = new Map();   // result index -> words already sent
    const started = new Map();    // result index -> when the current chunk began
    const HOLD = 3;               // the last few words can still change, so never send them early
    const END_AFTER = /^(\u0939\u0948|\u0939\u0948\u0902|\u0925\u093e|\u0925\u0947|\u0925\u0940|\u0939\u094b|\u0939\u094b\u0917\u093e|\u0917\u093e|\u0917\u0947|\u0917\u0940)$/; // hai, hain, tha, the, thi, ho, hoga, ga, ge, gi
    const BREAK_BEFORE = /^(\u0932\u0947\u0915\u093f\u0928|\u0915\u094d\u092f\u094b\u0902\u0915\u093f|\u0914\u0930|\u0924\u094b|\u092a\u0930|\u091c\u092c|\u0905\u0917\u0930)$/; // lekin, kyonki, aur, to, par, jab, agar
    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const words = res[0].transcript.trim().split(/\s+/).filter(Boolean);
        const done = consumed.get(i) || 0;
        if (res.isFinal) {
          const rest = words.slice(done).join(' ');
          if (rest) this.onFinal?.(rest);
          consumed.delete(i); started.delete(i);
          continue;
        }
        if (!started.has(i)) started.set(i, Date.now());
        const settled = words.length - HOLD;            // words we may send now
        const fresh = settled - done;
        const age = Date.now() - started.get(i);
        let cutAt = -1;
        if (fresh >= 10) {
          // prefer a natural break inside the settled words (scan backwards)
          for (let k = settled; k >= done + 8; k--) {
            if (END_AFTER.test(words[k - 1] || '') || BREAK_BEFORE.test(words[k] || '')) { cutAt = k; break; }
          }
        }
        if (cutAt < 0 && (fresh >= 18 || (fresh >= 6 && age > 8000))) cutAt = settled;
        if (cutAt > done) {
          this.onFinal?.(words.slice(done, cutAt).join(' '));
          consumed.set(i, cutAt); started.set(i, Date.now());
        }
        interim += words.slice(consumed.get(i) || 0).join(' ') + ' ';
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

const voiceKey = (v) => (v.voiceURI || v.name) + '|' + v.lang;

export class ReadAloud {
  constructor() {
    this.on = false; this.voice = null;
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
    if (this.voice && vs.some(v => voiceKey(v) === voiceKey(this.voice))) return; // keep what is already chosen
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
  setRate(r) { this.rate = r; try { localStorage.setItem('lt-rate', r); } catch {} }
  // Lines are spoken one at a time from our own queue. We never call cancel() right before
  // speak(): in Chrome that cancels the new line, and repeated cancels can freeze the speech engine.
  toggle() {
    this.on = !this.on;
    this.queue = [];
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
    this._enqueue(text, force);
  }
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
    if (this.voice) { u.voice = this.voice; u.lang = this.voice.lang; } else u.lang = 'en-US';
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
export function voicePicker(selectEl, testBtn, rateEl, reader) {
  let lastSig = '';
  function fill() {
    const vs = reader.voices();
    if (!vs.length) return;
    const sig = vs.map(voiceKey).join(',');
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
    let group = null, g = null;
    for (const it of items) {
      const gl = it.gender ? it.gender[0].toUpperCase() + it.gender.slice(1) + ' voices' : 'Other voices';
      if (gl !== g) { group = document.createElement('optgroup'); group.label = g = gl; selectEl.append(group); }
      const o = document.createElement('option');
      o.value = it.key; o.textContent = it.label;
      group.append(o);
    }
    if (reader.voice) selectEl.value = voiceKey(reader.voice);
  }
  fill();
  speechSynthesis.addEventListener('voiceschanged', fill);
  setTimeout(edgeHint, 1500); speechSynthesis.addEventListener('voiceschanged', () => setTimeout(edgeHint, 300));

  // Tell people on a computer without natural voices to switch to Edge.
  function edgeHint() {
    const box = document.getElementById('vhint');
    if (!box) return;
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
  selectEl.onchange = () => { reader.setVoice(selectEl.value); reader.say(sample, true); };
  if (testBtn) testBtn.onclick = () => reader.say(sample, true);
  if (rateEl) { rateEl.value = reader.rate; rateEl.oninput = () => reader.setRate(+rateEl.value); }
}

export function transcriptText(lines, title) {
  const head = (title ? title + '\n' : '') + 'Live Hindi to English transcript - ' + new Date().toLocaleString() + '\n\n';
  return head + lines.map(l => `[${new Date(l.t).toLocaleTimeString()}]\nHI: ${l.hi}\nEN: ${l.en}\n`).join('\n');
}

export function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
