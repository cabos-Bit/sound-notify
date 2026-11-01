"""Builds sound-notify's done.wav and waiting.wav into the folder given as argv[1].

Soft mallet notes in A major: low enough to stay out of the ear's most
sensitive range, a gentle attack instead of a click, and a short room tail.
Standard library only.
"""
import array
import math
import os
import sys
import wave

RATE = 44100
PEAK_DBFS = -14.0
LEAD_IN = 0.03  # silence first, so a waking USB device does not clip the attack
ATTACK = 0.012
END_FADE = 0.2

A4, CS5, E5 = 440.00, 554.37, 659.25

# (multiple of the note, level, how many times faster than the note it dies)
PARTIALS = (
    (1, 1.00, 1.0),
    (2, 0.20, 2.6),
    (3, 0.06, 4.5),
    (4, 0.025, 7.0),
)

# (frequency, start in seconds, decay time constant, level)
SOUNDS = {
    # rising fifth: settled, finished
    "done": {"length": 1.10, "notes": [(A4, 0.00, 0.24, 1.00), (E5, 0.14, 0.24, 0.85)]},
    # falling minor third: the interval people call out to someone with
    "waiting": {"length": 0.78, "notes": [(E5, 0.00, 0.15, 1.00), (CS5, 0.17, 0.17, 0.90)]},
}


def strike(buf, freq, at, tau, level):
    first = int((LEAD_IN + at) * RATE)
    rise = int(ATTACK * RATE)
    for i in range(first, len(buf)):
        k = i - first
        t = k / RATE
        env = level
        if k < rise:
            env *= 0.5 - 0.5 * math.cos(math.pi * k / rise)
        buf[i] += env * sum(
            a * math.exp(-t * speed / tau) * math.sin(2 * math.pi * m * freq * t)
            for m, a, speed in PARTIALS
        )


def comb(x, delay, feedback=0.6, damp=0.4):
    line = [0.0] * delay
    out = [0.0] * len(x)
    store = 0.0
    for i, v in enumerate(x):
        y = line[i % delay]
        store = y * (1 - damp) + store * damp
        line[i % delay] = v + store * feedback
        out[i] = y
    return out


def allpass(x, delay, gain=0.5):
    line = [0.0] * delay
    out = [0.0] * len(x)
    for i, v in enumerate(x):
        y = line[i % delay]
        line[i % delay] = v + y * gain
        out[i] = y - v * gain
    return out


def room(x, spread):
    wet = [0.0] * len(x)
    for delay in (1116, 1188, 1277, 1356):
        for i, v in enumerate(comb(x, delay + spread)):
            wet[i] += v
    for delay in (556, 441):
        wet = allpass(wet, delay + spread)
    return wet


def render(spec):
    n = int(spec["length"] * RATE)
    dry = [0.0] * n
    for freq, at, tau, level in spec["notes"]:
        strike(dry, freq, at, tau, level)
    channels = []
    for spread in (0, 23):
        wet = room(dry, spread)
        channels.append([d + 0.08 * w for d, w in zip(dry, wet)])
    fade = int(END_FADE * RATE)
    for ch in channels:
        for k in range(fade):
            ch[n - 1 - k] *= 0.5 - 0.5 * math.cos(math.pi * k / fade)
    peak = max(abs(v) for ch in channels for v in ch)
    gain = 10 ** (PEAK_DBFS / 20) / peak
    frames = array.array("h", [0] * (2 * n))
    for i in range(n):
        frames[2 * i] = round(channels[0][i] * gain * 32767)
        frames[2 * i + 1] = round(channels[1][i] * gain * 32767)
    return frames


out_dir = sys.argv[1]
for name, spec in SOUNDS.items():
    with wave.open(os.path.join(out_dir, f"{name}.wav"), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(render(spec).tobytes())
    print(f"wrote {name}.wav")
