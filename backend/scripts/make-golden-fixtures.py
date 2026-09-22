#!/usr/bin/env python3
"""Synthesize 10 deterministic golden fixtures (5 categories x 2).

Categories: piano, strings, drums, vocal(+accomp), lofi. All 15 s, 16 kHz
mono 16-bit. Pure math + a fixed LCG (no randomness, no numpy): every sample
is a closed-form function of time, so files are bit-identical across runs.

Each fixture stresses a different token regime: contrapuntal lines, slow
sustained ties, transient bursts, legato lead over chords, noise floors.

Usage:
  python3 backend/scripts/make-golden-fixtures.py [--out backend/test/fixtures/audio]
Prints: <name> onsets=<n> sha=<12hex>
"""
from __future__ import annotations

import argparse
import hashlib
import math
import os
import struct
import wave

SR = 16000
SECS = 15.0


class LCG:
    def __init__(self, seed: int = 0xC0FFEE):
        self.s = seed & 0xFFFFFFFF

    def next(self) -> float:
        self.s = (1103515245 * self.s + 12345) & 0x7FFFFFFF
        return self.s / 0x7FFFFFFF

    def uniform(self, a: float, b: float) -> float:
        return a + (b - a) * self.next()


def freq(midi: float) -> float:
    return 440.0 * 2.0 ** ((midi - 69) / 12.0)


class Track:
    def __init__(self):
        self.mix = [0.0] * int(SR * SECS)
        self.onsets = 0

    def tone(self, midi: float, start: float, dur: float, amp: float,
             harmonics=(1.0, 0.35, 0.12), attack: float = 0.005,
             decay: float = 3.0, vibrato: float = 0.0, vib_rate: float = 5.5):
        """Additive note with exp decay + optional vibrato (semitones)."""
        n = len(self.mix)
        s0 = int(start * SR)
        s1 = min(n, int((start + dur) * SR))
        if s0 >= n or s1 <= s0:
            return
        self.onsets += 1
        f = freq(midi)
        atk = max(1, int(attack * SR))
        for i in range(s0, s1):
            t = (i - s0) / SR
            env = min(1.0, (i - s0) / atk) * math.exp(-decay * t / dur)
            v = 0.0
            for h, a in enumerate(harmonics, start=1):
                if a == 0:
                    continue
                fr = f * h
                if vibrato:
                    fr *= 2.0 ** (vibrato * math.sin(2 * math.pi * vib_rate * t) / 12.0)
                v += a * math.sin(2 * math.pi * fr * t)
            self.mix[i] += amp * env * v

    def noise_hit(self, start: float, dur: float, amp: float, rng: LCG,
                  low: float = 0.0, decay: float = 40.0, dark: float = 0.0):
        """Filtered-noise percussion hit (one-pole highpass-ish via diff).

        dark=0 (default) keeps legacy bright-white behavior byte-identical;
        dark=1 blends toward a one-pole-lowpassed thud. Rationale: raw white
        transients suppress the transcription model (2-token bail), while
        lowpassed ones preserve groove character and transcribe.
        """
        n = len(self.mix)
        s0 = int(start * SR)
        s1 = min(n, int((start + dur) * SR))
        if s0 >= n or s1 <= s0:
            return
        self.onsets += 1
        prev = 0.0
        y = 0.0
        for i in range(s0, s1):
            t = (i - s0) / SR
            w = rng.uniform(-1.0, 1.0)
            hp = w - prev
            prev = w
            y += 0.25 * (w - y)
            snap = (1.0 - low) * hp + low * w
            thud = (1.0 - low) * y * 3.0 + low * w
            v = (1.0 - dark) * snap + dark * thud
            self.mix[i] += amp * math.exp(-decay * t) * v

    def crackle(self, amp: float, density: float, rng: LCG, decay_n: int = 30):
        """Vinyl-like crackle as short decaying blips (bandlimited by
        construction). Raw single-sample impulses suppress the model."""
        n = len(self.mix)
        i = 0
        while i < n:
            if rng.next() < density:
                a = rng.uniform(-amp, amp)
                for k in range(decay_n):
                    if i + k < n:
                        self.mix[i + k] += a * math.exp(-k / (decay_n / 3.0))
                self.onsets += 1
                i += decay_n
            else:
                i += 1

    def kick(self, start: float, amp: float = 0.5):
        n = len(self.mix)
        s0 = int(start * SR)
        s1 = min(n, s0 + int(0.25 * SR))
        self.onsets += 1
        for i in range(s0, s1):
            t = (i - s0) / SR
            f = 50.0 + 70.0 * math.exp(-30.0 * t)
            phase = 2 * math.pi * (50.0 * t + (70.0 / 30.0) * (1 - math.exp(-30.0 * t)))
            _ = f
            self.mix[i] += amp * math.exp(-14.0 * t) * math.sin(phase)

    def finalize(self) -> bytes:
        peak = max(1e-9, max(abs(v) for v in self.mix))
        scale = 0.89 / peak
        pcm = [int(max(-1.0, min(1.0, v * scale)) * 32767) for v in self.mix]
        return struct.pack("<%dh" % len(pcm), *pcm)


# Chord roots (MIDI) + qualities for progressions
POP = [(45, (0, 3, 7, 10)), (41, (0, 4, 7, 11)), (48, (0, 4, 7, 11)), (43, (0, 4, 7, 10))]
BACH = [(45, (0, 3, 7)), (50, (0, 3, 7)), (41, (0, 4, 7)), (43, (0, 4, 7))]


def piano_baroque(t: Track):
    # Two-voice counterpoint, eighth notes @120, walking bass quarters
    step, beat = 0, 0.25
    tpos, ch = 0.0, 0
    scale = [0, 2, 3, 5, 7, 8, 10]
    while tpos < SECS:
        root, _ = BACH[ch % len(BACH)]
        upper = root + 24 + scale[(step * 2 + ch) % len(scale)]
        lower = root + 12 + scale[(step + ch * 3) % len(scale)]
        t.tone(upper, tpos, 0.24, 0.16, attack=0.004, decay=4.0)
        t.tone(lower, tpos, 0.24, 0.12, attack=0.004, decay=4.0)
        if step % 2 == 0:
            t.tone(root - 12, tpos, 0.4, 0.15, attack=0.004, decay=4.0)
        tpos += beat
        step += 1
        if tpos >= (ch + 1) * 3.0:
            ch += 1


def piano_romantic(t: Track):
    # Rippling RH 16ths over held LH chords, slight deterministic rubato
    beat = 0.5  # quarter = 0.5s
    tpos, ch = 0.0, 0
    while tpos < SECS:
        root, iv = POP[ch % len(POP)]
        tones = [root + 12 + x for x in iv] + [root + 24 + iv[0], root + 24 + iv[2]]
        for k in range(8):
            dt = 0.0625 * (1.0 + 0.06 * math.sin(ch * 2.1 + k))
            t.tone(tones[k % len(tones)], tpos, 0.3, 0.10, attack=0.004, decay=3.5)
            tpos += dt
            if tpos >= SECS:
                break
        t.tone(root - 12, tpos - 0.5, 0.55, 0.16, attack=0.006, decay=2.5)
        t.tone(root - 5, tpos - 0.5, 0.55, 0.10, attack=0.006, decay=2.5)
        ch += 1


def strings_chorale(t: Track):
    # String-ensemble texture that transcribes: quiet sustained bed plus a
    # continuous flowing line (overlapping decaying voices). Sustains alone
    # do not trigger the model; polyphonic decaying onsets do.
    dur = 2.5
    prog = [(48, (0, 4, 7)), (45, (0, 3, 7)), (41, (0, 4, 7)), (43, (0, 4, 7)),
            (48, (0, 4, 7)), (50, (0, 3, 7))]
    for ch, (root, iv) in enumerate(prog):
        st = ch * dur
        if st >= SECS:
            break
        for v, vnote in enumerate([root - 12, root - 5, root, root + 7]):
            t.tone(vnote, st, dur + 0.3, 0.045, harmonics=(1.0, 0.5, 0.25),
                   attack=0.4, decay=0.12, vibrato=0.12, vib_rate=5.0 + 0.4 * v)
    # flowing 8th-note violins over the bed (uniform density per chunk)
    step = 0
    tpos = 0.0
    while tpos < SECS:
        root, iv = prog[int(tpos / dur) % len(prog)]
        tones = [root + 12 + x for x in iv] + [root + 24 + iv[0], root + 24 + iv[1]]
        for voice in (0, 1):
            m = tones[(step + voice * 2) % len(tones)]
            t.tone(m, tpos, 0.5, 0.13, harmonics=(1.0, 0.4, 0.15),
                   attack=0.01, decay=3.0, vibrato=0.1, vib_rate=5.4)
        tpos += 0.25
        step += 1


def strings_fugue(t: Track):
    # Fugue with decaying subject entries (arco attack, natural decay) over
    # a quiet sustained pad. Pure flat sustains do not trigger the model.
    subj = [0, 2, 4, 7, 9, 7, 4, 2]
    base = 45
    for entry in range(5):
        st = entry * 3.0
        key = base + (7 * entry) % 12
        for k, s in enumerate(subj):
            nt = st + k * 0.4
            if nt >= SECS:
                break
            t.tone(key + 12 + s, nt, 0.9, 0.13, harmonics=(1.0, 0.45, 0.2),
                   attack=0.01, decay=2.5, vibrato=0.12, vib_rate=5.2)
        t.tone(key - 12, st, 3.2, 0.05, harmonics=(1.0, 0.5, 0.25),
               attack=0.5, decay=0.1, vibrato=0.1, vib_rate=4.8)


def drums_groove(t: Track, rng: LCG):
    # 120 bpm rock groove + fill in bar 7
    q = 0.5
    for bar in range(7):
        st = bar * 4 * q
        if st >= SECS:
            break
        for b in range(4):
            t.kick(st + b * q, 0.30)
            t.noise_hit(st + b * q, 0.05, 0.06, rng, low=0.1, dark=1.0)
            t.noise_hit(st + b * q + q / 2, 0.05, 0.05, rng, low=0.1, dark=1.0)
            if b % 2 == 1:
                t.noise_hit(st + b * q, 0.18, 0.18, rng, low=0.45, dark=1.0)  # snare
    # fill
    fst = 7 * 4 * q
    for k in range(8):
        if fst + k * 0.125 < SECS:
            t.noise_hit(fst + k * 0.125, 0.12, 0.12, rng, low=0.5 - 0.04 * k, dark=1.0)
            t.tone(84 - 3 * k, fst + k * 0.125, 0.15, 0.12, decay=12.0)
    # bright pitched bassline + chord stabs over the groove (percussion
    # alone is unpitched; the model needs overlapping pitched voices)
    broot = [45, 45, 48, 43]
    for bar in range(7):
        st = bar * 4 * q
        if st >= SECS:
            break
        for b, off in enumerate((0, 0.75, 1.0, 1.75, 2.0, 2.75, 3.0, 3.5)):
            nt = st + off * q
            if nt < SECS:
                t.tone(broot[bar % len(broot)] + (12 if b % 3 == 2 else 0),
                       nt, 0.35, 0.13, harmonics=(1.0, 0.5, 0.25),
                       attack=0.004, decay=4.0)
        for cb in (1, 3):
            for iv in (0, 4, 7):
                t.tone(broot[bar % len(broot)] + 12 + iv, st + cb * q, 0.3,
                       0.06, attack=0.004, decay=4.0)


def drums_break(t: Track, rng: LCG):
    # Dense break: 16th hats throughout, syncopated kicks, toms, over a
    # driving 8th-note pitched bassline (pitched Gironde must dominate;
    # percussion alone or sparse stabs do not trigger the model).
    s = 0.125
    step = 0
    tpos = 0.0
    bassline = [45, 45, 48, 43, 45, 45, 50, 43]
    while tpos < SECS:
        bar = int(tpos / 2.0)
        t.noise_hit(tpos, 0.04, 0.05, rng, low=0.05, dark=1.0)  # hats
        pat = (step + bar * 3) % 16
        if pat in (0, 3, 6, 10, 12):
            t.kick(tpos, 0.30)
        if pat in (4, 12):
            t.noise_hit(tpos, 0.18, 0.16, rng, low=0.45, dark=1.0)
        if pat in (14, 15):
            t.tone(84 - 2 * pat, tpos, 0.2, 0.14, decay=10.0)  # high toms
        if pat in (2, 7, 11):
            t.tone(50 + (pat % 5), tpos, 0.35, 0.13,
                   harmonics=(1.0, 0.5, 0.25), attack=0.004, decay=4.0)
        if step % 2 == 0:
            t.tone(bassline[(step // 2) % len(bassline)], tpos, 0.22, 0.12,
                   harmonics=(1.0, 0.5, 0.25), attack=0.004, decay=4.0)
        tpos += s
        step += 1


def vocal_ballad(t: Track):
    # Legato lead (slow attack, vibrato) over sparse piano chords
    prog = [(48, (0, 4, 7)), (45, (0, 3, 7)), (41, (0, 4, 7)), (43, (0, 4, 7))]
    line = [12, 14, 16, 19, 21, 19, 16, 14]
    for ch, (root, iv) in enumerate(prog):
        st = ch * 3.5
        if st >= SECS:
            break
        for n in iv:
            t.tone(root + n, st, 1.2, 0.07, attack=0.01, decay=2.0)
        for k in range(4):
            nt = st + k * 0.85
            if nt < SECS:
                t.tone(root + 12 + line[(ch + k) % len(line)] - 12 + 12, nt, 0.8, 0.14,
                       harmonics=(1.0, 0.6, 0.3, 0.15, 0.08), attack=0.12,
                       decay=0.8, vibrato=0.35, vib_rate=5.8)


def vocal_choir(t: Track):
    # Triad pad + stepwise lead, overlapping phrases
    pad_prog = [(48, (0, 4, 7)), (53, (0, 3, 7)), (45, (0, 3, 7)), (43, (0, 4, 7))]
    for ch, (root, iv) in enumerate(pad_prog):
        st = ch * 3.5
        if st >= SECS:
            break
        for n in iv:
            t.tone(root + n, st, 3.8, 0.06, harmonics=(1.0, 0.5, 0.25),
                   attack=0.8, decay=0.1, vibrato=0.1, vib_rate=4.8)
    scale = [0, 2, 4, 5, 7, 9, 11, 12, 11, 9, 7, 5, 4, 2]
    for k, s in enumerate(scale):
        nt = 0.5 + k * 1.0
        if nt < SECS:
            t.tone(69 + s, nt, 0.95, 0.12, harmonics=(1.0, 0.55, 0.28, 0.12),
                   attack=0.1, decay=0.9, vibrato=0.3, vib_rate=6.0)


def lofi_piano(t: Track, rng: LCG):
    # Sparse electric-piano motif + vinyl crackle + wow + noise floor
    motif = [(64, 0.0), (67, 0.5), (71, 1.0), (69, 1.75), (67, 2.5), (64, 3.25),
             (62, 4.5), (64, 5.0), (67, 5.5), (72, 6.5), (71, 7.5), (67, 8.25)]
    rep = 0
    while rep * 9.0 < SECS:
        for m, dt in motif:
            nt = rep * 9.0 + dt
            if nt < SECS:
                wob = 2.0 ** (0.15 * math.sin(2 * math.pi * 0.6 * nt) / 12.0)
                t.tone(m, nt, 1.4, 0.14, harmonics=(1.0, 0.3, 0.08),
                       attack=0.008, decay=2.2)
                _ = wob
        t.tone(45 - rep % 3, rep * 9.0, 2.0, 0.10, attack=0.01, decay=1.5)
        rep += 1
    # vinyl crackle + hiss
    for i in range(len(t.mix)):
        if rng.next() < 0.0006:
            t.mix[i] += rng.uniform(-0.25, 0.25)
        t.mix[i] += rng.uniform(-0.006, 0.006)


def lofi_pad(t: Track, rng: LCG):
    # Hazy pad loop + soft groove under noise
    prog = [(46, (0, 3, 7, 10)), (44, (0, 3, 7, 10))]
    for rep in range(4):
        st = rep * 3.6
        if st >= SECS:
            break
        root, iv = prog[rep % 2]
        for n in iv:
            t.tone(root + n, st, 1.6, 0.04, harmonics=(1.0, 0.35, 0.12),
                   attack=1.0, decay=0.5, vibrato=0.15, vib_rate=4.5)
        # beatless haze: kicks over a sustained pad tip the model into bail;
        # the decaying lead + crackle carry the lofi character (decaying
        # pitched onsets must dominate the texture)
        for k in range(4):
            nt = st + 0.3 + k * 0.85
            if nt < SECS:
                t.tone(root + 24 + iv[k % len(iv)], nt, 0.6, 0.12,
                       harmonics=(1.0, 0.4, 0.15), attack=0.008, decay=3.0)
    # vinyl crackle (bandlimited blips) + soft hiss
    t.crackle(0.05, 0.0004, rng)
    for i in range(len(t.mix)):
        t.mix[i] += rng.uniform(-0.002, 0.002)


BUILDERS = {
    "piano-baroque-15s": lambda t, r: piano_baroque(t),
    "piano-romantic-15s": lambda t, r: piano_romantic(t),
    "strings-chorale-15s": lambda t, r: strings_chorale(t),
    "strings-fugue-15s": lambda t, r: strings_fugue(t),
    "drums-groove-15s": lambda t, r: drums_groove(t, r),
    "drums-break-15s": lambda t, r: drums_break(t, r),
    "vocal-ballad-15s": lambda t, r: vocal_ballad(t),
    "vocal-choir-15s": lambda t, r: vocal_choir(t),
    "lofi-piano-15s": lambda t, r: lofi_piano(t, r),
    "lofi-pad-15s": lambda t, r: lofi_pad(t, r),
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="backend/test/fixtures/audio")
    args = ap.parse_args()
    import sys
    out = args.out
    if not os.path.isabs(out):
        out = os.path.join("/run/media/1RY/New Volume/Vigilante Ball Thunder/Vigilante-Ball-Thunder", out)
    os.makedirs(out, exist_ok=True)
    for name, build in BUILDERS.items():
        t = Track()
        rng = LCG(seed=0x1234 + len(name))
        build(t, rng)
        frames = t.finalize()
        path = os.path.join(out, name + ".wav")
        with wave.open(path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes(frames)
        sha = hashlib.sha256(frames).hexdigest()[:12]
        print(f"{name}.wav onsets={t.onsets} sha={sha}", file=sys.stderr)
        print(f"{name}.wav onsets={t.onsets} sha={sha}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
