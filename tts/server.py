"""Live Translate voice service: turns English lines into natural speech (MP3) with Kokoro.

Runs on CPU. One line is generated at a time (the model already uses every core), and
results are cached so a line spoken to a whole room is only generated once.
"""
import io, json, os, threading, time
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import soundfile as sf
from kokoro_onnx import Kokoro

MODEL = os.environ.get("KOKORO_MODEL", "/models/kokoro-v1.0.onnx")
VOICES = os.environ.get("KOKORO_VOICES", "/models/voices-v1.0.bin")
PORT = int(os.environ.get("PORT", "8000"))

# Male voices first; the app shows these to organisers.
VOICE_LIST = [
    {"id": "bm_george", "label": "George · British · male"},
    {"id": "am_michael", "label": "Michael · American · male"},
    {"id": "bm_lewis", "label": "Lewis · British · male"},
    {"id": "am_adam", "label": "Adam · American · male"},
    {"id": "am_fenrir", "label": "Fenrir · American · male"},
    {"id": "bf_emma", "label": "Emma · British · female"},
    {"id": "af_heart", "label": "Heart · American · female"},
    {"id": "af_bella", "label": "Bella · American · female"},
]
ALLOWED = {v["id"] for v in VOICE_LIST}
SELF_RT = 0.0

t0 = time.time()
kokoro = Kokoro(MODEL, VOICES)
print(f"Kokoro loaded in {time.time() - t0:.1f}s", flush=True)

lock = threading.Lock()
cache = OrderedDict()
CACHE_MAX = 300
stats = {"generated": 0, "audio_s": 0.0, "gen_s": 0.0}


def synth(text, voice, speed):
    key = (voice, round(speed, 2), text)
    if key in cache:
        cache.move_to_end(key)
        return cache[key]
    with lock:
        if key in cache:
            return cache[key]
        t = time.time()
        samples, sr = kokoro.create(text, voice=voice, speed=speed, lang="en-gb" if voice[0] == "b" else "en-us")
        took = time.time() - t
        buf = io.BytesIO()
        sf.write(buf, samples, sr, format="MP3")
        data = buf.getvalue()
        stats["generated"] += 1; stats["audio_s"] += len(samples) / sr; stats["gen_s"] += took
        cache[key] = data
        while len(cache) > CACHE_MAX:
            cache.popitem(last=False)
        return data


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def do_GET(self):
        if self.path.startswith("/health"):
            speed = stats["audio_s"] / stats["gen_s"] if stats["gen_s"] else None
            return self._json(200, {"ok": True, "voices": VOICE_LIST, "generated": stats["generated"], "realtime": speed,
                                    "self_test": round(SELF_RT, 2), "fast_enough": SELF_RT >= 1.05})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/speak"):
            return self._json(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(min(n, 20000)) or b"{}")
            text = str(body.get("text", "")).strip()[:400]
            voice = body.get("voice") if body.get("voice") in ALLOWED else "bm_george"
            speed = max(0.7, min(1.4, float(body.get("speed", 1.0))))
            if not text:
                return self._json(400, {"error": "empty"})
            data = synth(text, voice, speed)
            self.send_response(200); self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
        except Exception as e:
            print("speak error:", e, flush=True)
            self._json(500, {"error": "tts failed"})


def self_test():
    """Time two typical lines: the app only uses this voice if it is faster than speech."""
    gen = aud = 0
    for ln in ["Today we will talk about the heart and about meditation.",
               "Please sit comfortably, close your eyes and relax for a moment."]:
        t = time.time(); s, sr = kokoro.create(ln, voice="bm_george", speed=1.0, lang="en-gb")
        gen += time.time() - t; aud += len(s) / sr
    return aud / gen


if __name__ == "__main__":
    synth("Ready.", "bm_george", 1.0)  # warm up
    SELF_RT = self_test()
    print(f"Self-test: {SELF_RT:.2f}x real time ({'fast enough' if SELF_RT >= 1.05 else 'TOO SLOW - app will use device voices'})", flush=True)
    print(f"Voice service on :{PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
