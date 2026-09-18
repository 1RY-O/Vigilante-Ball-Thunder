#!/usr/bin/env python3
"""TEST-ONLY MOCK of the MuScriptor worker protocol (never used in production).

Implements the same stdout-JSONL protocol as backend/python/transcribe_worker.py
so unit tests can exercise the REAL Node-side MuScriptorEngine subprocess path
deterministically, offline, and without the gated model weights.

Mode is selected via the FAKE_WORKER_MODE env var (all outputs are synthetic
test fixtures, clearly not real transcription):

  ok        emit progress, write tiny fixture MIDI + MusicXML, result.json, exit 0
  fail      emit a transcription-failed error and exit 3
  gated     emit a weights-gated error and exit 4
  no-token  (self-check) emit hf-token-missing and exit 4
  no-write  exit 0 without producing artifacts (engine must detect this)
  crash     print non-JSON noise and exit 2
  sleep     sleep ~25s (used by cancellation tests; killed by the engine)
"""

from __future__ import annotations

import json
import os
import sys
import time


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def fail(code: str, message: str, exit_code: int) -> None:
    emit({"type": "error", "code": code, "message": message})
    sys.exit(exit_code)


def fixture_midi() -> bytes:
    """Tiny but structurally valid SMF (header + one empty track)."""
    track_body = bytes([0x00, 0xFF, 0x2F, 0x00])  # delta 0, end-of-track
    return (
        b"MThd" + (6).to_bytes(4, "big") + (0).to_bytes(2, "big")
        + (1).to_bytes(2, "big") + (480).to_bytes(2, "big")
        + b"MTrk" + len(track_body).to_bytes(4, "big") + track_body
    )


def arg_value(flag: str) -> str | None:
    if flag in sys.argv:
        i = sys.argv.index(flag)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return None


def main() -> int:
    mode = os.environ.get("FAKE_WORKER_MODE", "ok")

    if "--self-check" in sys.argv:
        if mode == "no-token":
            fail("hf-token-missing", "HF_TOKEN is missing (simulated by test fixture).", 4)
        emit({"type": "ok"})
        return 0

    out_dir = arg_value("--out")
    model = arg_value("--model") or "small"

    if mode == "sleep":
        time.sleep(25)
        return 0
    if mode == "crash":
        print("!!! simulated python traceback noise !!!")
        return 2
    if mode == "fail":
        fail("transcription-failed", "Simulated model failure (test fixture).", 3)
    if mode == "gated":
        fail("weights-gated", "Simulated gated-weights failure (test fixture).", 4)

    emit({"type": "progress", "stage": "loading_model"})
    emit({"type": "progress", "stage": "transcribing", "percent": 50})
    if not out_dir:
        fail("worker-args-invalid", "No --out given.", 4)

    if mode == "no-write":
        return 0

    with open(os.path.join(out_dir, "transcription.mid"), "wb") as fh:
        fh.write(fixture_midi())
    with open(os.path.join(out_dir, "transcription.musicxml"), "w", encoding="utf-8") as fh:
        fh.write(
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<score-partwise version="4.0">\n'
            '  <part-list><score-part id="P1"><part-name>FAKE WORKER FIXTURE (MOCK)</part-name></score-part></part-list>\n'
            '  <part id="P1"><measure number="1">\n'
            '    <attributes><divisions>480</divisions><key><fifths>0</fifths></key>'
            '<time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>\n'
            '    <note><pitch><step>C</step><octave>4</octave></pitch><duration>480</duration><type>quarter</type></note>\n'
            '  </measure></part>\n'
            '</score-partwise>\n'
        )
    with open(os.path.join(out_dir, "result.json"), "w", encoding="utf-8") as fh:
        json.dump({"durationSec": 1.0, "model": model}, fh)
    emit({"type": "progress", "stage": "converting"})
    emit({"type": "result", "durationSec": 1.0, "model": model})
    return 0


if __name__ == "__main__":
    sys.exit(main())
