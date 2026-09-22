#!/usr/bin/env python3
"""Note-level summary of a MuScriptor MIDI artifact (Phase B quality view).

Parses each MIDI with music21 (already a worker dependency) and prints a
one-line JSON record: note/chord/rest counts, distinct pitches, pitch range,
total sounding duration. Deterministic; read-only.

Usage:
  backend/.venv/bin/python backend/scripts/midi-notes.py <a.mid> [<b.mid> ...]
"""
from __future__ import annotations

import json
import sys


def summarize(path: str) -> dict:
    from music21 import converter, chord as chord_mod, note as note_mod
    score = converter.parse(path)
    notes = list(score.recurse().getElementsByClass(note_mod.Note))
    chords = list(score.recurse().getElementsByClass(chord_mod.Chord))
    pitches = [n.pitch.midi for n in notes]
    for c in chords:
        pitches.extend(p.midi for p in c.pitches)
    chit = chords and [len(c.pitches) for c in chords]
    return {
        "file": path,
        "notes": len(notes),
        "chords": len(chords),
        "noteEvents": len(notes) + len(chords),
        "soundingNotes": len(notes) + sum(chit or []),
        "distinctPitches": len(set(pitches)),
        "pitchMin": min(pitches) if pitches else None,
        "pitchMax": max(pitches) if pitches else None,
    }


def main() -> int:
    for path in sys.argv[1:]:
        try:
            print(json.dumps(summarize(path)))
        except Exception as exc:
            print(json.dumps({"file": path, "error": f"{exc.__class__.__name__}: {exc}"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
