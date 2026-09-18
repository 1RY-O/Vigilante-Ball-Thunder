#!/usr/bin/env python3
"""MuScriptor transcription worker (REAL engine — no mock anywhere).

Protocol (stdout, one JSON object per line; stderr carries diagnostics that
are only logged server-side, never sent to clients):

  {"type": "progress", "stage": "loading_model"}
  {"type": "progress", "stage": "transcribing", "percent": 0-100}
  {"type": "progress", "stage": "converting"}
  {"type": "result", "durationSec": float, "model": "small|medium|large"}
  {"type": "error", "code": "...", "message": "safe client-facing message"}

Exit codes: 0 success; 3 transcription/decode failure; 4 environment/blocker
(missing deps, missing HF token, gated weights, HF unreachable).

Artifacts written to --out:
  transcription.mid        (real MuScriptor output)
  transcription.musicxml   (converted from that MIDI via music21)
  result.json              (same payload as the final stdout "result" line)

Modes:
  --self-check   Verify deps and HF access WITHOUT loading weights. Prints
                 the usual JSON lines and exits 0/4. Used by the Node engine
                 to report honest availability in GET /api/capabilities.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback

HF_ORG = "MuScriptor"


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def emit_error(code: str, message: str) -> None:
    emit({"type": "error", "code": code, "message": message})


def fail(code: str, message: str, exit_code: int) -> "SystemExit":
    emit_error(code, message)
    return SystemExit(exit_code)


def check_deps() -> None:
    """Import the heavy third-party deps, mapping ImportError to honest codes."""
    try:
        import muscriptor  # noqa: F401
    except Exception as exc:
        raise fail(
            "worker-deps-missing",
            "The muscriptor Python package is not installed. See backend/python/requirements.txt.",
            4,
        ) from exc
    try:
        import music21  # noqa: F401
    except Exception as exc:
        raise fail(
            "worker-deps-missing",
            "The music21 Python package is not installed (needed for MIDI -> MusicXML conversion). See backend/python/requirements.txt.",
            4,
        ) from exc


def hf_repo_for(model: str) -> str:
    return f"{HF_ORG}/muscriptor-{model}"


def check_hf(model: str) -> None:
    """Verify an HF token exists and the gated weights are actually accessible.

    The MuScriptor repos are gated (`gated: auto`): metadata is public, but
    file downloads require a token whose account accepted the CC BY-NC 4.0
    license. So we attempt a tiny real download (`config.json`) — it is gated
    exactly like the weights themselves.
    """
    token = os.environ.get("HF_TOKEN", "").strip()
    if not token:
        raise fail(
            "hf-token-missing",
            "MuScriptor weights require a Hugging Face token. Create backend/.env with HF_TOKEN=... and accept the model license on Hugging Face.",
            4,
        )
    try:
        from huggingface_hub import hf_hub_download
        from huggingface_hub.errors import GatedRepoError, RepositoryNotFoundError
    except Exception as exc:
        raise fail(
            "worker-deps-missing",
            "huggingface_hub is unavailable in the worker environment.",
            4,
        ) from exc
    repo = hf_repo_for(model)
    try:
        hf_hub_download(repo, "config.json")  # tiny, cached, gated like the weights
    except GatedRepoError as exc:
        raise fail(
            "weights-gated",
            f"MuScriptor weights at {repo} are gated: accept the CC BY-NC 4.0 license on https://huggingface.co/{repo} with this token's account.",
            4,
        ) from exc
    except RepositoryNotFoundError as exc:
        raise fail(
            "weights-gated",
            f"MuScriptor weights at {repo} are not accessible with the configured token.",
            4,
        ) from exc
    except Exception as exc:
        raise fail(
            "hf-unreachable",
            f"Could not reach Hugging Face to verify model access ({exc.__class__.__name__}). Check the network connection.",
            4,
        ) from exc


def convert_midi_to_musicxml(midi_path: str, xml_path: str) -> None:
    """Convert real MIDI bytes to MusicXML via music21 (honest conversion of
    the model's output; no content is invented). Raises on failure."""
    from music21 import converter

    score = converter.parse(midi_path)  # parses + quantizes the MIDI stream
    if not score.recurse().notes:
        raise fail(
            "empty-transcription",
            "No notes could be detected in this recording. Try a clearer recording with a prominent melody.",
            3,
        )
    score.write("musicxml", fp=xml_path)


def main() -> int:
    parser = argparse.ArgumentParser(description="MuScriptor transcription worker")
    parser.add_argument("--audio", help="Input audio path (wav/mp3/flac)")
    parser.add_argument("--out", help="Output directory for artifacts")
    parser.add_argument("--model", default="small", choices=["small", "medium", "large"])
    parser.add_argument("--instruments", default=None, help="Comma-separated instrument restricts (optional)")
    parser.add_argument("--self-check", action="store_true", help="Check deps + HF access only; do not transcribe")
    args = parser.parse_args()

    try:
        check_deps()
        check_hf(args.model)
        if args.self_check:
            emit({"type": "ok", "model": args.model})
            return 0
        if not args.audio or not args.out:
            raise fail("worker-args-invalid", "Worker invoked without --audio/--out.", 4)

        emit({"type": "progress", "stage": "loading_model"})
        from muscriptor import TranscriptionModel

        model = TranscriptionModel.load_model(args.model)

        emit({"type": "progress", "stage": "transcribing"})
        midi_path = os.path.join(args.out, "transcription.mid")
        xml_path = os.path.join(args.out, "transcription.musicxml")
        try:
            midi_bytes = model.transcribe_to_midi(
                args.audio,
                instruments=args.instruments.split(",") if args.instruments else None,
            )
        except Exception as exc:
            tail = traceback.format_exc(limit=2)
            print(tail, file=sys.stderr)
            raise fail("transcription-failed", "Transcription failed while running the model.", 3) from exc

        if not midi_bytes:
            raise fail("empty-transcription", "Transcription produced no notes.", 3)
        with open(midi_path, "wb") as fh:
            fh.write(midi_bytes)

        emit({"type": "progress", "stage": "converting"})
        convert_midi_to_musicxml(midi_path, xml_path)

        duration = None
        try:
            import soundfile as sf

            with sf.SoundFile(args.audio) as snd:
                duration = len(snd) / float(snd.samplerate)
        except Exception:
            duration = None  # duration is informational only

        payload = {"type": "result", "durationSec": duration, "model": args.model}
        with open(os.path.join(args.out, "result.json"), "w", encoding="utf-8") as fh:
            json.dump({"durationSec": duration, "model": args.model}, fh)
        emit(payload)
        return 0
    except SystemExit:
        raise
    except Exception as exc:  # last resort: honest generic failure
        traceback.print_exc()
        print(f"worker crashed: {exc!r}", file=sys.stderr)
        emit_error("transcription-failed", "Transcription failed unexpectedly.")
        return 3


if __name__ == "__main__":
    sys.exit(main())
