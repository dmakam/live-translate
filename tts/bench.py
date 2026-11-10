"""Speed test for this server: can it create speech faster than it is spoken?"""
import os, resource, time
from kokoro_onnx import Kokoro
k = Kokoro(os.environ.get("KOKORO_MODEL", "/models/kokoro-v1.0.onnx"), os.environ.get("KOKORO_VOICES", "/models/voices-v1.0.bin"))
k.create("Warm up.", voice="bm_george", speed=1.0, lang="en-gb")
lines = ["So today, if life looks difficult, don't be in a hurry to change the outside.",
         "Look inside you first, and you will see that the answer is already there.",
         "And Lord Ram just doesn't understand that someone is taking the form of Mother Sita.",
         "This is not a miracle, it is just the harmony between you and the whole universe."]
gen = aud = 0; worst = 0
for ln in lines:
    t = time.time(); s, sr = k.create(ln, voice="bm_george", speed=1.0, lang="en-gb"); d = time.time() - t
    gen += d; aud += len(s) / sr; worst = max(worst, d)
rt = aud / gen
mem = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
print(f"CPU cores: {os.cpu_count()}")
print(f"Speech created: {aud:.1f}s of audio in {gen:.1f}s  ->  {rt:.2f}x real time")
print(f"Slowest line took {worst:.1f}s to create; memory used {mem:.0f} MB")
if rt >= 1.3: print("RESULT: GOOD - natural voice will keep up with a live talk.")
elif rt >= 1.0: print("RESULT: BORDERLINE - works, but English may fall behind with a very fast speaker.")
else: print("RESULT: TOO SLOW - this server cannot keep up; keep the device voice.")
