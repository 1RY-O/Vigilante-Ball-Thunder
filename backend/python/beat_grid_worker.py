#!/usr/bin/env python3
"""Isolated beat-grid helper: runs beat_this in a short-lived process.

The beat tracker (~77 MB weights + torchaudio/soxr + inference) used to live
inside the transcription worker, adding ~170 MB to its peak. This helper runs
it in a child process that exits before generation, so the parent never maps
those pages.

Protocol (stdout: exactly one JSON line; stderr: diagnostics only):
  {"ok": true, "bpm": float, "beats_per_bar": int|null,
   "first_downbeat": float, "beats": [float, ...]}
  {"ok": false, "code": "no-grid"|"bad-audio"|"internal", "message": str}

Exit codes: 0 grid found; 2 no usable grid (BeatDetectionError);
4 environment/argument failure; 3 unexpected crash.

Usage:
  backend/.venv/bin/python backend/python/beat_grid_worker.py --audio <path>
"""
from __future__ import annotations

import argparse
import json
import sys


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def main() -> int:
    parser = argparse.ArgumentParser(description="Isolated beat-grid detection")
    parser.add_argument("--audio", required=True, help="Input audio path")
    args = parser.parse_args()

    try:
        from muscriptor.utils.audio import load_audio
        from muscriptor.utils.beats import BeatDetectionError, detect_grid
    except Exception as exc:
        emit({"ok": False, "code": "internal",
              "message": f"Beat helper dependencies unavailable ({exc.__class__.__name__})."})
        return 4

    try:
        wav = load_audio(args.audio)
    except Exception as exc:
        emit({"ok": False, "code": "bad-audio",
              "message": f"Could not load audio ({exc.__class__.__name__})."})
        return 2
    if wav.shape[0] > 1:
        wav = wav.mean(dim=0, keepdim=True)

    try:
        grid = detect_grid(wav, 16000)
    except BeatDetectionError as exc:
        emit({"ok": False, "code": "no-grid", "message": str(exc)[:300]})
        return 2
    except Exception as exc:
        emit({"ok": False, "code": "internal",
              "message": f"Beat detection crashed ({exc.__class__.__name__})."})
        return 3

    beats = grid.beats
    try:
        beats_list = [float(b) for b in (beats.tolist() if beats is not None else [])]
    except Exception:
        beats_list = []
    emit({
        "ok": True,
        "bpm": float(grid.bpm),
        "beats_per_bar": grid.beats_per_bar,
        "first_downbeat": float(grid.first_downbeat),
        "beats": beats_list,
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
