#!/usr/bin/env python3
"""Deterministic dense musical fixture for the KV-cache experiment.

Writes a 15 s, 16 kHz mono 16-bit WAV with deliberately high note density
(~35 onsets/s) so per-chunk token counts stress max_gen_len caps:

  - bars: 4/4 at 120 bpm (bar = 2.0 s), progression Am F C G x2 + Am (7.5 bars)
  - arpeggio: continuous 16th notes cycling chord tones across 2 octaves,
    rotating through 4 octave registers (= 4 quasi-voices, 32 onsets/s)
  - bass: quarter-note roots an octave below
  - melody: 8th-note line on chord thirds/fifths, one octave above

Pure math (no randomness, no numpy): every sample is a closed-form function
of time, so the file is bit-identical across runs and machines. Each note is
fundamental + 2 harmonics with an exponential decay; amplitudes are scaled so
the mix cannot clip.

Usage:
  python3 backend/scripts/make-dense-fixture.py [--out /tmp/vbt-ram/dense-15s.wav]
"""
from __future__ import annotations

import argparse
import hashlib
import math
import struct
import wave

SR = 16000
SECS = 15.0

# Semitone -> ratio
def freq(midi: int) -> float:
    return 440.0 * 2.0 ** ((midi - 69) / 12.0)

# Am F C G, roots as MIDI; chord tones = root+12 + [0,3/4,7] minor/major
PROG = [
    (45, [0, 3, 7]),   # Am
    (41, [0, 4, 7]),   # F
    (48, [0, 4, 7]),   # C
    (43, [0, 4, 7]),   # G
]
BAR = 2.0  # 4/4 @120bpm
SIXTEENTH = 0.125
EIGHTH = 0.25
QUARTER = 0.5

def render() -> tuple[list[float], int]:
    n = int(SR * SECS)
    mix = [0.0] * n
    onsets = 0

    def add_note(midi: int, start: float, dur: float, amp: float) -> None:
        nonlocal onsets
        f = freq(midi)
        s0 = int(start * SR)
        s1 = min(n, int((start + dur) * SR))
        if s0 >= n:
            return
        onsets += 1
        for i in range(s0, s1):
            t = (i - s0) / SR
            env = math.exp(-3.0 * t / dur)
            s = (math.sin(2 * math.pi * f * t)
                 + 0.4 * math.sin(2 * math.pi * 2 * f * t)
                 + 0.15 * math.sin(2 * math.pi * 3 * f * t))
            mix[i] += amp * env * s

    t = 0.0
    bar_idx = 0
    # 16th-note arpeggio bed for the full 15 s
    step = 0
    while t < SECS:
        root, ivals = PROG[bar_idx % len(PROG)]
        tones = [root + 12 + iv for iv in ivals] + [root + 24 + ivals[0]]
        reg = (step // 4) % 4  # rotate octave register => 4 quasi-voices
        midi = tones[step % len(tones)] + 0
        # spread voices: even steps low octave, odd steps high octave
        midi += 12 if (step % 2) else 0
        add_note(midi, t, 0.22, 0.10)
        # bass quarter notes
        if step % 4 == 0:
            add_note(root - 12, t, 0.45, 0.14)
        # melody 8ths on chord third
        if step % 2 == 0:
            add_note(root + 24 + ivals[1], t, 0.20, 0.08)
        t += SIXTEENTH
        step += 1
        if t >= (bar_idx + 1) * BAR:
            bar_idx += 1

    # normalize to [-0.89, 0.89] deterministically
    peak = max(1e-9, max(abs(v) for v in mix))
    scale = 0.89 / peak
    pcm = [int(max(-1.0, min(1.0, v * scale)) * 32767) for v in mix]
    return pcm, onsets


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="/tmp/vbt-ram/dense-15s.wav")
    args = ap.parse_args()
    pcm, onsets = render()
    frames = struct.pack("<%dh" % len(pcm), *pcm)
    with wave.open(args.out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(frames)
    sha = hashlib.sha256(frames).hexdigest()[:16]
    print(f"wrote {args.out}: {len(pcm)/SR:.1f}s @{SR}Hz onsets={onsets} sha={sha}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
