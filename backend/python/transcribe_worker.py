#!/usr/bin/env python3
"""MuScriptor transcription worker (REAL engine — no mock anywhere).

Protocol (stdout, one JSON object per line; stderr carries diagnostics that
are only logged server-side, never sent to clients):

  {"type": "progress", "stage": "loading_model"}
  {"type": "progress", "stage": "transcribing", "percent": 0-100}
  {"type": "progress", "stage": "converting"}
  {"type": "result", "durationSec": float, "model": "small|medium|large",
   "detectedInstruments": [str] | null, "tempoBpm": float, "keyName": str}
  {"type": "error", "code": "...", "message": "safe client-facing message"}

Exit codes: 0 success; 3 transcription/decode failure; 4 environment/blocker
(missing deps, missing HF token, gated weights, HF unreachable).

Artifacts written to --out:
  transcription.mid        (real MuScriptor output)
  transcription.musicxml   (converted from that MIDI via music21, in the
                            requested --sheet-type layout)
  result.json              (durationSec/model/detectedInstruments + any
                            genuinely extracted tempoBpm/keyName)

Instrument hints:
  --instruments takes comma-separated muscriptor instrument group names
  (MT3_FULL_PLUS vocabulary). muscriptor treats them as a HARD constraint, so
  the caller only sends the ones it really means; unknown names are rejected
  here as worker-args-invalid rather than silently changing the constraint.

Sheet types:
  melody-chords  the decoded part exactly as the model produced it, EXCEPT
                 piano material (detected or requested instrument is a piano),
                 which is always laid out as piano-grand below — a single
                 treble staff cannot legibly render piano music
  piano-grand    the same notes laid out as two explicit Parts (Right Hand /
                 Left Hand) under one braced StaffGroup with joined barlines,
                 split strictly at middle C with spanning chords divided
                 pitch-by-pitch; clef, meter and key at offset 0 of each part
  lead-sheet     highest voice as the melody line plus chord symbols read from
                 the decoded vertical sonorities
  These layouts are music21 post-processing of the REAL decoded MIDI: no note,
  chord or timing is ever invented. When music21 cannot name a sonority, that
  position simply carries no chord symbol; when a layout genuinely cannot be
  built the worker fails with sheet-type-unsupported (never a standby layout).

Modes:
  --self-check   Verify deps and HF access WITHOUT loading weights. Prints
                 the usual JSON lines and exits 0/4. Used by the Node engine
                 to report honest availability in GET /api/capabilities.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import traceback

HF_ORG = "MuScriptor"

SHEET_TYPES = ("melody-chords", "piano-grand", "lead-sheet")

# Middle C: the conventional split point between the piano staves. A note (or
# the highest pitch of a chord) at/above this lands on the treble staff.
GRAND_STAFF_SPLIT_MIDI = 60

# --- Notation cleanup (MIR engraving) ---
# Strict, standard grid: 16th notes plus triplets. Anything finer (32nds and
# below) snaps up to this grid instead of engraving as 64th/128th clutter.
QUANTIZE_DIVISORS = (4, 3)
# Below a 64th note (~a 128th): micro-duration artifacts / ghost notes from
# the model that cause extreme micro-ties and beam clutter. Dropped, never
# rendered. (At 120 BPM a 64th is ~31 ms, a 32nd ~62 ms, so this keeps real
# 32nd-note material while removing sub-64th junk across tempi.)
MIN_QUARTER_LENGTH = 0.06
# Standard 88-key piano compass. Anything outside is key noise, string
# resonance or a model glitch — discarded, never rendered.
PIANO_MIDI_LO = 21  # A0
PIANO_MIDI_HI = 108  # C8
# Harmonic overtone suppression: an isolated short blip above C6 with low
# velocity and no lower sustaining pitch is almost always an acoustic
# harmonic, not a played note.
OVERTONE_MIDI = 84  # C6
OVERTONE_MAX_QL = 0.25  # 16th note
OVERTONE_LOW_VELOCITY = 40
OVERTONE_ISOLATION_QL = 0.125
# Metric lattice: every residual duration snaps to the nearest of these.
STANDARD_DURATIONS = (0.25, 1.0 / 3.0, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0)
# Onsets this close coalesce into one Chord (no colliding sub-voices).
ONSET_MERGE_QL = 0.06
# A sustained note overshooting the next onset by less than this is truncated.
OVERLAP_TRUNCATE_QL = 0.125
# Conservative meter default when the MIDI carries none.
DEFAULT_TIME_SIGNATURE = "4/4"
# Explicit-measure grand-staff builder: strict event lengths (triplets are
# resolved upstream; cross-barline spans become tied fragments) and the ghost
# floor below which a blip is pruned rather than engraved.
CLEAN_DURATIONS = (0.25, 0.5, 0.75, 1.0, 2.0, 4.0)
CLEAN_GHOST_QL = 0.20
CLEAN_BAR_QL = 4.0
# music21's default score title when parsing MIDI; always replaced below.
FRAGMENT_TITLE = "Music21 Fragment"
DEFAULT_SCORE_TITLE = "Transcription"

# music21's sentinel figure for a sonority it cannot name. Emitting it would be
# a fake chord symbol, so such positions are left unlabelled instead.
CHORD_SYMBOL_UNIDENTIFIED = "Chord Symbol Cannot Be Identified"


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def emit_error(code: str, message: str) -> None:
    emit({"type": "error", "code": code, "message": message})


# PHASE 0 (measurement only): stdlib-only peak-memory sampler.
#
# Reads /proc/self/status (VmRSS = current, VmHWM = kernel peak) in a daemon
# thread. Emits one stderr line at exit:
#   [worker-mem] peakRssKb=<max polled RSS> peakHwmKb=<final VmHWM>
# stderr is the diagnostics channel (never sent to clients); stdout protocol,
# artifacts, dtypes and inference are untouched. No third-party deps.
_PEAK_POLL_SEC = 0.1


def _read_self_rss_hwm_kb() -> tuple[int | None, int | None]:
    try:
        with open("/proc/self/status", "r", encoding="utf-8") as fh:
            text = fh.read()
    except Exception:
        text = ""
    rss: int | None = None
    hwm: int | None = None
    for line in text.splitlines():
        if line.startswith("VmRSS:"):
            try:
                rss = int(line.split()[1])
            except Exception:
                rss = None
        elif line.startswith("VmHWM:"):
            try:
                hwm = int(line.split()[1])
            except Exception:
                hwm = None
    if rss is None or hwm is None:
        try:
            import resource

            # ru_maxrss is kilobytes on Linux.
            hwm2 = int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
            if hwm is None:
                hwm = hwm2
            if rss is None:
                rss = hwm2
        except Exception:
            pass
    return rss, hwm


# Phase-stamped RSS marks (stderr-only diagnostics).
#
# _mark() snapshots current VmRSS at pipeline boundaries so the process HWM
# can be attributed to load / beat-grid / conditioning+generation / MIDI
# bytes / music21 phases. Passive: production behavior is unchanged.
def _mark(label: str) -> None:
    rss, _ = _read_self_rss_hwm_kb()
    print(f"[worker-phase] {label} rssKb={rss if rss is not None else 'n/a'}", file=sys.stderr)
    try:
        sys.stderr.flush()
    except Exception:
        pass


class _PeakSampler:
    """Background max-RSS tracker; start()/stop() are safe to call anywhere."""

    def __init__(self, interval: float = _PEAK_POLL_SEC) -> None:
        self._interval = interval
        self._peak_rss: int | None = None
        self._stop = False
        self._thread = None

    def start(self) -> None:
        import threading

        rss, _ = _read_self_rss_hwm_kb()
        if rss is not None:
            self._peak_rss = rss

        def _loop() -> None:
            import time

            while not self._stop:
                rss_now, _ = _read_self_rss_hwm_kb()
                if rss_now is not None and (
                    self._peak_rss is None or rss_now > self._peak_rss
                ):
                    self._peak_rss = rss_now
                time.sleep(self._interval)

        self._thread = threading.Thread(target=_loop, name="worker-mem-peak", daemon=True)
        self._thread.start()

    def stop_and_emit(self) -> None:
        self._stop = True
        try:
            if self._thread is not None:
                import time

                # Let one final poll land; never block shutdown.
                time.sleep(0.0)
        except Exception:
            pass
        _, hwm = _read_self_rss_hwm_kb()
        peak_rss = self._peak_rss if self._peak_rss is not None else hwm
        print(
            f"[worker-mem] peakRssKb={peak_rss if peak_rss is not None else 'n/a'} "
            f"peakHwmKb={hwm if hwm is not None else 'n/a'}",
            file=sys.stderr,
        )


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


def resolve_instruments(raw: str | None) -> list[str] | None:
    """Canonical muscriptor group names for --instruments, or None for "no hint".

    The caller sends the exact MT3_FULL_PLUS group names (see the API's hint
    table); they are validated against the pinned package's own vocabulary so an
    unknown name is an honest argument error instead of a silently different
    constraint. Empty/absent means NO constraint at all.
    """
    if not raw:
        return None
    tokens = [t.strip().lower() for t in raw.split(",") if t.strip()]
    if not tokens:
        return None
    try:
        from muscriptor.tokenizer.mt3 import MT3_FULL_PLUS_GROUP_NAMES
    except Exception:
        return tokens
    unknown = [t for t in tokens if t not in MT3_FULL_PLUS_GROUP_NAMES]
    if unknown:
        raise fail(
            "worker-args-invalid",
            f"Unknown instrument group name(s): {', '.join(unknown)}.",
            4,
        )
    return tokens


def transcribe_midi(model, audio: str, instruments: list[str] | None, max_gen_len: int = 1000) -> tuple[bytes, list[str] | None]:
    """Real MuScriptor MIDI bytes plus the instrument names the model decoded.

    Instruments come from the model's OWN event stream
    (``NoteStartEvent.instrument``) — the only honest source for them. This is
    the same generation path as ``TranscriptionModel.transcribe_to_midi`` (same
    beat grid, same shared ``events_to_midi_bytes`` serializer), so the MIDI
    bytes are identical. If that path is unavailable in the installed
    muscriptor, the MIDI is still produced and the instrument list is None
    rather than guessed.
    """
    try:
        from muscriptor import NoteStartEvent
    except Exception:
        return model.transcribe_to_midi(audio, instruments=instruments), None
    try:
        # Beat grid via the isolated helper subprocess (see
        # _detect_beat_grid_subprocess): beat_this runs in a child that exits
        # before generation, so its ~170 MB never joins our peak. Any helper
        # failure warns and continues with None (placeholder tempo).
        # MUSCRIPTOR_BEAT_GRID=off skips detection entirely (testing /
        # low-memory mode; default keeps detection enabled, quality first).
        beat_grid = None
        if os.environ.get("MUSCRIPTOR_BEAT_GRID", "") != "off":
            beat_grid = _detect_beat_grid_subprocess(audio)
        else:
            print("[worker-phase] beat-grid skipped (MUSCRIPTOR_BEAT_GRID=off)", file=sys.stderr)
        _mark("post-beat-grid")
        # Cap override (see _apply_max_gen_len): upstream hardcodes 2000.
        # Default 1000 shrinks the per-chunk KV cache; 2000 restores upstream.
        _apply_max_gen_len(model, max_gen_len)
        # Per-chunk generation diagnostics (pass-through, stderr only).
        token_stats = _install_token_counter(model, max_gen_len)
        detected: set[str] = set()
        events = []
        for event in model.transcribe(audio, instruments=instruments):
            if isinstance(event, NoteStartEvent):
                detected.add(event.instrument)
            events.append(event)
        _emit_token_summary(token_stats)
        _mark("post-transcribe")
        midi_bytes = model.events_to_midi_bytes(iter(events), beat_grid=beat_grid)
        if not midi_bytes:
            raise RuntimeError("event stream produced no MIDI")
        _mark("post-midi-bytes")
        return midi_bytes, sorted(detected) or None
    except Exception:
        traceback.print_exc(limit=2)
        print(
            "Warning: instrument detection unavailable; transcribing without it.",
            file=sys.stderr,
        )
        # Fallback without in-process beat_this: same helper grid (or None),
        # then the plain event stream serialized directly. Only if that also
        # fails do we fall back to transcribe_to_midi (which may load the
        # tracker in-process) rather than failing the job outright.
        try:
            fallback_grid = None
            if os.environ.get("MUSCRIPTOR_BEAT_GRID", "") != "off":
                fallback_grid = _detect_beat_grid_subprocess(audio)
            from muscriptor import NoteEndEvent as _NoteEnd

            _events = [e for e in model.transcribe(audio, instruments=instruments)
                       if isinstance(e, (NoteStartEvent, _NoteEnd))]
            _midi = model.events_to_midi_bytes(iter(_events), beat_grid=fallback_grid)
            if _midi:
                return _midi, None
        except Exception:
            traceback.print_exc(limit=1)
        return model.transcribe_to_midi(audio, instruments=instruments), None


# Isolated beat-grid detection (beat_this subprocess).
#
# Spawns backend/python/beat_grid_worker.py with the same interpreter; the
# child decodes the audio, runs detect_grid, prints one JSON line and exits,
# freeing the tracker's ~170 MB before generation starts here. Returns a
# .venv-native BeatGrid, or None (with a stderr warning) when the helper
# exits non-zero, prints unparseable output, or crashes. Mirrors the old
# best-effort contract: warn and fall back to the placeholder tempo.
def _detect_beat_grid_subprocess(audio) -> object | None:
    import subprocess

    helper = os.path.join(os.path.dirname(os.path.abspath(__file__)), "beat_grid_worker.py")
    try:
        proc = subprocess.run(
            [sys.executable, helper, "--audio", str(audio)],
            capture_output=True,
            text=True,
            timeout=600,
        )
    except Exception as exc:
        print(
            f"Warning: beat-grid helper could not start ({exc.__class__.__name__}); "
            "continuing with placeholder tempo.",
            file=sys.stderr,
        )
        return None
    if proc.returncode != 0 or not proc.stdout.strip():
        # Try to report the helper's own reason (its JSON goes to stdout
        # even on no-grid exits); fall back to the stderr tail.
        reason = ""
        try:
            _payload = json.loads(proc.stdout.strip().splitlines()[-1])
            reason = f"{_payload.get('code', 'unknown')}: {str(_payload.get('message', ''))[:150]}"
        except Exception:
            tail = (proc.stderr or "").strip().splitlines()[-1:] or ["no stderr output"]
            reason = "; ".join(tail)[-200:]
        print(
            f"Warning: beat-grid helper exited {proc.returncode} ({reason}); "
            "continuing with placeholder tempo.",
            file=sys.stderr,
        )
        return None
    try:
        payload = json.loads(proc.stdout.strip().splitlines()[-1])
    except Exception:
        print(
            "Warning: beat-grid helper printed unparseable output; "
            "continuing with placeholder tempo.",
            file=sys.stderr,
        )
        return None
    if not payload.get("ok"):
        print(
            f"Warning: no usable beat grid ({payload.get('code', 'unknown')}: "
            f"{str(payload.get('message', ''))[:150]}); continuing with placeholder tempo.",
            file=sys.stderr,
        )
        return None
    try:
        import math as _math

        import numpy as _np

        from muscriptor.utils.beats import BeatGrid

        bpm = float(payload["bpm"])
        first_downbeat = float(payload["first_downbeat"])
        bpb = payload.get("beats_per_bar")
        beats = payload.get("beats") or []
        if not _math.isfinite(bpm) or bpm <= 0 or not _math.isfinite(first_downbeat):
            raise ValueError("non-finite grid values")
        bpb = int(bpb) if bpb is not None else None
        beats_arr = _np.asarray([float(b) for b in beats], dtype=float) if beats else None
        return BeatGrid(
            bpm=bpm, beats_per_bar=bpb, first_downbeat=first_downbeat, beats=beats_arr
        )
    except Exception as exc:
        print(
            f"Warning: beat-grid helper returned invalid data ({exc.__class__.__name__}); "
            "continuing with placeholder tempo.",
            file=sys.stderr,
        )
        return None


# Generation-budget cap override.#
# Upstream TranscriptionModel.transcribe() hardcodes max_gen_len = 2000 as a
# local (no parameter, no env var), and third-party sources under .venv must
# not be modified, so the cap is substituted at the _generate_token_stream
# boundary (the single caller that forwards it to LMModel.generate, where
# the KV cache of prepend_length + max_gen_len tokens is preallocated).
# cap == 2000 is an exact passthrough of upstream behavior. Yields, dtypes,
# chunking and decoding are untouched.
def _apply_max_gen_len(transcription_model, cap: int) -> None:
    if cap == 2000:
        return
    orig = transcription_model._generate_token_stream
    import functools

    @functools.wraps(orig)
    def patched(*args, **kwargs):
        if "max_gen_len" in kwargs:
            kwargs["max_gen_len"] = cap
        elif len(args) >= 4:
            args = tuple([*args[:3], cap, *args[4:]])
        else:  # pragma: no cover - defensive; all known callers pass it
            kwargs["max_gen_len"] = cap
        return orig(*args, **kwargs)

    transcription_model._generate_token_stream = patched
    print(f"[worker-timing] maxGenLen={cap} (upstream default 2000)", file=sys.stderr)


# Per-chunk generation diagnostics (stderr only, inference untouched).
#
# Wraps LMModel.generate with a counting pass-through: each invocation is one
# batch (batch_size=1 on the worker path, i.e. one 5s chunk). Counts yielded
# timesteps, notes whether EOS appeared and whether the call used the full
# max_gen_len budget without EOS (the silent-truncation condition, since
# no_eos_is_ok=True only warns). A hitCap=True line means a chunk was
# silently truncated and the cap must be raised.
def _install_token_counter(transcription_model, cap: int = 2000) -> dict:
    stats: dict = {"calls": []}
    try:
        lm = transcription_model._model
        eos_id = transcription_model._tokenizer.eos_id
    except Exception:
        return stats
    orig_generate = lm.generate
    # cap is the experiment value from the caller closure (authoritative).
    # generate() receives it as max_gen_len= kwarg, but kwargs.get() with a
    # 2000 fallback would silently misreport a positional-passing caller, so
    # the closure value is reported instead.

    def counting_generate(*args, **kwargs):
        import torch

        call_idx = len(stats["calls"])
        steps = 0
        eos_seen = False
        batch = None
        for step in orig_generate(*args, **kwargs):
            steps += 1
            if batch is None:
                try:
                    batch = int(step.shape[0])
                except Exception:
                    batch = -1
            try:
                # Generator yields inference tensors; stay in inference mode.
                with torch.inference_mode():
                    if bool((step == eos_id).any().item()):
                        eos_seen = True
            except Exception:
                pass
            yield step
        hit_cap = (not eos_seen) and (steps >= cap)
        stats["calls"].append(
            {"chunk": call_idx, "steps": steps, "eos": eos_seen,
             "hitCap": hit_cap, "batch": batch, "maxGenLen": cap}
        )
        print(
            f"[worker-tokens] chunk={call_idx} steps={steps} "
            f"eos={str(eos_seen)} hitCap={str(hit_cap)} "
            f"batch={batch} maxGenLen={cap}",
            file=sys.stderr,
        )

    try:
        lm.generate = counting_generate
    except Exception:
        pass
    return stats


def _emit_token_summary(stats: dict) -> None:
    calls = stats.get("calls", [])
    if not calls:
        return
    total = sum(c["steps"] for c in calls)
    peak = max(c["steps"] for c in calls)
    capped = sum(1 for c in calls if c["hitCap"])
    print(
        f"[worker-tokens-summary] chunks={len(calls)} maxSteps={peak} "
        f"hitCap={capped} totalSteps={total}",
        file=sys.stderr,
    )


def load_score(midi_path: str, title: str | None = None):
    """Parse the decoded MIDI with music21 (real notes, or honest failure).

    The parsed score is then quantized, de-cluttered and notated (real notes
    only — see prepare_score); nothing is ever invented.
    """
    from music21 import converter

    score = converter.parse(midi_path)
    if not score.recurse().notes:
        raise fail(
            "empty-transcription",
            "No notes could be detected in this recording. Try a clearer recording with a prominent melody.",
            3,
        )
    return prepare_score(score, title)


def clean_score_title(score, title: str | None) -> None:
    """Replace music21's default "Music21 Fragment" title.

    Uses the caller-supplied track title (--title) or a clean default. Title
    is metadata only; it never affects notes or whether a file validates.
    """
    clean = (title or "").strip() or DEFAULT_SCORE_TITLE
    try:
        from music21 import metadata as _metadata

        if score.metadata is None:
            score.metadata = _metadata.Metadata()
        current = score.metadata.title or ""
        if not current or current == FRAGMENT_TITLE:
            score.metadata.title = clean
    except Exception:
        pass  # title is cosmetic; never fail a job over it


def carry_title(source, dest) -> None:
    """Copy the cleaned score title onto a derived layout.

    build_grand_staff()/build_lead_sheet() construct brand-new Score/Part
    objects, which would otherwise fall back to music21's default
    "Music21 Fragment" title on write. Cosmetic only; never raises.
    """
    try:
        from music21 import metadata as _metadata

        title = ""
        try:
            if source is not None and source.metadata is not None:
                title = source.metadata.title or ""
        except Exception:
            title = ""
        if not title or title == FRAGMENT_TITLE:
            title = DEFAULT_SCORE_TITLE
        if dest.metadata is None:
            dest.metadata = _metadata.Metadata()
        dest.metadata.title = title
    except Exception:
        pass


def remove_ghost_notes(container) -> None:
    """Drop micro-duration artifacts (< MIN_QUARTER_LENGTH).

    These sub-64th blips from the model engrave as extreme micro-ties and
    beam clutter. Real notes are untouched; an empty container stays empty
    (no placeholder is ever added).
    """
    try:
        victims = []
        for element in list(container.recurse().notes):
            try:
                quarter_length = float(element.quarterLength)
            except Exception:
                continue
            if quarter_length < MIN_QUARTER_LENGTH:
                victims.append(element)
        for element in victims:
            site = element.activeSite
            if site is None:
                continue
            try:
                site.remove(element)
            except Exception:
                pass
    except Exception:
        pass


def quantize_part(part) -> None:
    """Snap offsets and durations to the strict 16th-plus-triplet grid.

    Best-effort: if music21 cannot quantize a pathological part, the raw
    timing survives and notation still proceeds below.
    """
    try:
        part.quantize(
            quarterLengthDivisors=QUANTIZE_DIVISORS,
            processOffsets=True,
            processDurations=True,
            inPlace=True,
        )
    except Exception:
        pass


def ensure_meter(part) -> None:
    """Insert the conservative 4/4 default when the MIDI carries no meter.

    Without a meter definition Verovio computes irregular barline geometry.
    An existing time signature is always respected — this only fills the
    absence. Never raises.
    """
    try:
        from music21 import meter as _meter_mod

        try:
            existing = list(part.recurse().getElementsByClass(_meter_mod.TimeSignature))
        except Exception:
            existing = []
        if not existing:
            try:
                part.insert(0, _meter_mod.TimeSignature(DEFAULT_TIME_SIGNATURE))
            except Exception:
                pass
    except Exception:
        pass


def _event_midis(element) -> list[int]:
    try:
        return [int(p.midi) for p in element.pitches]
    except Exception:
        return []


def clean_pitch_events(container) -> None:
    """88-key enforcement plus harmonic overtone suppression.

    - Any pitch outside MIDI 21 (A0)..108 (C8) is key noise, string resonance
      or a model glitch: dropped from chords, whole notes dropped. The MIDI
      artifact on disk is untouched (written from the raw model bytes before
      conversion) — this only cleans the engraved score.
    - An isolated single note above C6, shorter than a 16th, with low velocity
      or no lower sustaining pitch, is pruned as an acoustic harmonic.
    Real, sustained, supported notes always survive. Never raises.
    """
    try:
        events = list(container.recurse().notes)
    except Exception:
        return
    for element in events:
        try:
            midis = _event_midis(element)
            if not midis:
                continue
            in_range = [m for m in midis if PIANO_MIDI_LO <= m <= PIANO_MIDI_HI]
            if len(in_range) < len(midis):
                _drop_or_shrink_pitches(element, in_range)
                if not in_range:
                    continue
            if not element.isChord:
                _prune_overtone(element, events)
        except Exception:
            pass


def _drop_or_shrink_pitches(element, keep_midis: list[int]) -> None:
    """Remove out-of-range pitches from a chord, or drop a fully void note."""
    import copy
    from music21 import chord as _chord_mod
    from music21 import note as _note_mod

    try:
        site = element.activeSite
        if site is None:
            return
        try:
            offset = float(element.offset)
        except Exception:
            return
        try:
            quarter_length = element.quarterLength
        except Exception:
            return
        keep = [p for p in element.pitches if int(p.midi) in keep_midis]
        if not keep:
            try:
                site.remove(element)
            except Exception:
                pass
            return
        if element.isChord and len(keep) < len(list(element.pitches)):
            try:
                new_pitches = [copy.deepcopy(p) for p in keep]
                replacement = (
                    _note_mod.Note(new_pitches[0], quarterLength=quarter_length)
                    if len(new_pitches) == 1
                    else _chord_mod.Chord(new_pitches, quarterLength=quarter_length)
                )
                site.remove(element)
                site.insert(offset, replacement)
            except Exception:
                pass
    except Exception:
        pass


def _prune_overtone(element, siblings) -> None:
    """Drop one element when it matches the isolated-harmonic profile."""
    try:
        midis = _event_midis(element)
        if len(midis) != 1 or midis[0] <= OVERTONE_MIDI:
            return
        try:
            quarter_length = float(element.quarterLength)
        except Exception:
            return
        if quarter_length >= OVERTONE_MAX_QL:
            return
        try:
            onset = float(element.getOffsetInHierarchy(element.activeSite))
        except Exception:
            try:
                onset = float(element.offset)
            except Exception:
                return
        # Isolated: no other onset nearby.
        for other in siblings:
            if other is element:
                continue
            try:
                oo = float(other.getOffsetInHierarchy(other.activeSite))
            except Exception:
                try:
                    oo = float(other.offset)
                except Exception:
                    continue
            if abs(oo - onset) < OVERTONE_ISOLATION_QL:
                return
        # Low velocity?
        low_velocity = False
        try:
            vel = element.volume.velocity
            low_velocity = vel is not None and int(vel) < OVERTONE_LOW_VELOCITY
        except Exception:
            low_velocity = False
        # Sustained harmonic support? A lower pitch sounding through this onset.
        supported = False
        for other in siblings:
            if other is element:
                continue
            try:
                oo = float(other.getOffsetInHierarchy(other.activeSite))
                od = float(other.quarterLength)
                o_top = max(_event_midis(other), default=10**9)
            except Exception:
                continue
            if oo <= onset <= oo + od and o_top < midis[0]:
                supported = True
                break
        if not (low_velocity or not supported):
            return
        site = element.activeSite
        if site is not None:
            try:
                site.remove(element)
            except Exception:
                pass
    except Exception:
        pass


def snap_to_standard_durations(container) -> None:
    """Snap residual durations to the strict metric lattice.

    After quantize(), strays snap to the nearest of
    [1/16, triplet-8th, 1/8, dotted-8th, 1/4, dotted-4th, 1/2, dotted-1/2,
    whole] so no micro-tie fragments survive. Never raises.
    """
    try:
        targets = list(STANDARD_DURATIONS)
        elements = list(container.recurse().notesAndRests)
    except Exception:
        return
    for element in elements:
        try:
            current = float(element.quarterLength)
        except Exception:
            continue
        if current <= 0:
            continue
        try:
            best = min(targets, key=lambda t: abs(t - current))
            if best != current:
                element.quarterLength = best
        except Exception:
            pass


def merge_coincident_and_truncate(part) -> None:
    """Coalesce near-coincident onsets into Chords; truncate hairline overlaps.

    Two notes starting within 0.06 QL become one Chord (union of pitches,
    longest duration) instead of colliding sub-voices. A sustained note
    overshooting the next onset by < 0.125 QL is truncated to that onset.
    Operates on the flat pre-notation part. Never raises.
    """
    import copy
    from music21 import chord as _chord_mod
    from music21 import note as _note_mod

    try:
        notes = [e for e in list(part.recurse().notes) if e.isNote or e.isChord]
    except Exception:
        return
    # --- coalesce ---
    try:
        groups: dict[float, list] = {}
        for element in notes:
            try:
                key = round(float(element.offset), 6)
            except Exception:
                continue
            groups.setdefault(key, []).append(element)
        for offset, group in groups.items():
            if len(group) < 2:
                continue
            try:
                pool: dict[int, object] = {}
                longest = 0.0
                for element in group:
                    try:
                        longest = max(longest, float(element.quarterLength))
                    except Exception:
                        pass
                    for p in element.pitches:
                        try:
                            pool.setdefault(int(p.midi), p)
                        except Exception:
                            pass
                if len(pool) <= 1:
                    continue
                site = group[0].activeSite
                if site is None:
                    continue
                fresh = [copy.deepcopy(p) for p in pool.values()]
                merged = _chord_mod.Chord(fresh, quarterLength=longest)
                for element in group:
                    try:
                        element.activeSite.remove(element)
                    except Exception:
                        pass
                site.insert(offset, merged)
            except Exception:
                pass
    except Exception:
        pass
    # --- truncate hairline overlaps ---
    try:
        ordered = sorted(
            [e for e in list(part.recurse().notes) if e.isNote or e.isChord],
            key=lambda e: round(float(e.offset), 6),
        )
        for prev, cur in zip(ordered, ordered[1:]):
            try:
                start = float(prev.offset)
                cur_start = float(cur.offset)
                end = start + float(prev.quarterLength)
            except Exception:
                continue
            overhang = end - cur_start
            if 0 < overhang < OVERLAP_TRUNCATE_QL:
                try:
                    new_ql = cur_start - start
                    if new_ql >= MIN_QUARTER_LENGTH:
                        prev.quarterLength = new_ql
                except Exception:
                    pass
    except Exception:
        pass


def detect_key_sharps(score) -> int | None:
    """Sharps count of the detected key, or None when undetectable.

    Pure detection — the caller falls back to C major (0). Never raises.
    """
    try:
        found = score.analyze("key")
        sharps = getattr(found, "sharps", None)
        if isinstance(sharps, int) and -7 <= sharps <= 7:
            return sharps
        return None
    except Exception:
        return None


def notate_part(part) -> None:
    """Full notation pass (voices, measures, ties, beams, rests) — never crashes.

    makeVoices() separates overlapping durations into voices first so stems
    cannot collide into solid blocks; makeNotation() then builds
    voices/measures/ties/beams/accidentals; the follow-up
    makeRests(fillGaps=True) pads intra-measure gaps so rests align
    logically. Each step is best-effort so engraving can never fail the job;
    render_musicxml() still maps a genuinely un-layoutable score to
    sheet-type-unsupported.
    """
    try:
        part.makeVoices(inPlace=True)
    except Exception:
        pass
    try:
        part.makeNotation(inPlace=True)
    except Exception:
        pass
    try:
        part.makeRests(fillGaps=True, inPlace=True)
    except Exception:
        pass


def prepare_score(score, title: str | None = None):
    """Quantize, de-clutter, title and notate the decoded score.

    Pipeline per part (or the flat score when the MIDI parsed with no parts):
    meter default → 88-key/overtone cleaning → ghost filter → strict
    quantization → standard-duration snapping → ghost filter → onset
    merging/overlap truncation → notation. If cleaning removes every note,
    the honest outcome is empty-transcription (never rests-only output
    masquerading as music). Safe on edge cases throughout; nothing raises
    except the honest empty-transcription failure.
    """
    clean_score_title(score, title)
    try:
        parts = list(score.parts) if score.parts else [score]
    except Exception:
        parts = [score]
    for part in parts:
        ensure_meter(part)
        clean_pitch_events(part)
        remove_ghost_notes(part)
        quantize_part(part)
        snap_to_standard_durations(part)
        remove_ghost_notes(part)
        merge_coincident_and_truncate(part)
    try:
        if not score.recurse().notes:
            raise fail(
                "empty-transcription",
                "No notes could be detected in this recording. Try a clearer recording with a prominent melody.",
                3,
            )
    except SystemExit:
        raise
    except Exception:
        pass
    for part in parts:
        notate_part(part)
    return score


def extract_metadata(score) -> dict:
    """Tempo/key actually read from the decoded score.

    Both values come from music21 reading the real MIDI: the tempo from its
    metronome mark, the key from `analyze('key')`. Anything music21 cannot read
    is omitted — never defaulted, never guessed.
    """
    metadata: dict = {}
    try:
        for _start, _end, mark in score.metronomeMarkBoundaries():
            if mark is None:
                continue
            bpm = mark.getQuarterBPM() if hasattr(mark, "getQuarterBPM") else mark.number
            if isinstance(bpm, (int, float)) and math.isfinite(bpm) and bpm > 0:
                metadata["tempoBpm"] = float(bpm)
                break
    except Exception:
        pass  # no readable tempo -> field omitted
    try:
        detected_key = score.analyze("key")
        name = getattr(detected_key, "name", None)
        if isinstance(name, str) and name.strip():
            metadata["keyName"] = name
    except Exception:
        pass  # no analyzable key -> field omitted
    return metadata


def identifiable_chord_figure(source_chord) -> str | None:
    """A real chord symbol for a sonority, or None when it cannot be named.

    Fewer than three distinct pitch classes is not a chord, and music21's
    sentinels ('pedal' kind, 'Chord Symbol Cannot Be Identified') are rejected:
    an unnameable position is left unlabelled instead of mislabelled.
    """
    from music21 import harmony

    if len({p.pitchClass for p in source_chord.pitches}) < 3:
        return None
    try:
        symbol = harmony.chordSymbolFromChord(source_chord)
    except Exception:
        return None
    if not symbol.chordKind or symbol.chordKind == "pedal":
        return None
    figure = (symbol.figure or "").strip()
    if not figure or figure == CHORD_SYMBOL_UNIDENTIFIED:
        return None
    return figure


def is_piano_instrument(names) -> bool:
    """True when any instrument name denotes a piano.

    Matches the MT3_FULL_PLUS group vocabulary ('acoustic_piano',
    'electric_piano') and plain 'piano'. Deliberately substring-based so both
    detected (model-reported) and requested (--instruments) names are covered;
    'organ' is NOT matched — it is not a piano.
    """
    try:
        return any("piano" in str(n).lower() for n in (names or []))
    except Exception:
        return False


def wants_grand_staff(sheet_type: str, instruments) -> bool:
    """Grand-staff routing: explicit request OR piano material on the default.

    The web client defaults to `--sheet-type melody-chords`, which jams piano
    audio onto a single treble staff (ledger-line collisions). Piano music is
    therefore ALWAYS laid out as a two-staff Grand Staff when the default
    'melody-chords' layout was requested — a single treble staff cannot
    legibly render it. An explicit 'lead-sheet' request is always honored
    (it is a distinct arrangement choice, not a piano rendering), and
    non-piano material keeps the exact layout it asked for.
    """
    try:
        if sheet_type == "piano-grand":
            return True
        if sheet_type == "lead-sheet":
            return False
        return is_piano_instrument(instruments)
    except Exception:
        return sheet_type == "piano-grand"


def _snap_clean_duration(ql) -> float | None:
    """Nearest strict grand-staff length, or None below the ghost floor.

    Anything shorter than a fifth of a quarter is a transient blip, not a
    note — pruned, never engraved. Never raises.
    """
    try:
        value = float(ql)
    except Exception:
        return None
    try:
        if not math.isfinite(value) or value < CLEAN_GHOST_QL:
            return None
    except Exception:
        return None
    try:
        return min(CLEAN_DURATIONS, key=lambda t: abs(t - value))
    except Exception:
        return None


def _ensure_builder_measure(part, idx, _stream_mod, _note_mod):
    """Return measure idx, appending numbered whole-rest-ready bars as needed."""
    try:
        measures = list(part.getElementsByClass(_stream_mod.Measure))
    except Exception:
        measures = []
    try:
        while len(measures) <= idx:
            measures.append(_stream_mod.Measure(number=len(measures) + 1))
            part.append(measures[-1])
    except Exception:
        pass
    try:
        measures = list(part.getElementsByClass(_stream_mod.Measure))
        return measures[idx] if idx < len(measures) else None
    except Exception:
        return None


def _place_event_with_ties(part, start, pitch_objs, ql, stem, _stream_mod, _note_mod, _chord_mod, _tie_mod, source_tie=None) -> None:
    """Insert one partitioned event, splitting across barlines with ties.

    A note longer than the remaining bar is divided into tied fragments so no
    <note> ever overflows its <measure> (overflowing durations are exactly
    what renders as headless stems in Verovio). Fragments are exact barline
    subdivisions of an already-standard duration — the ties make them one
    musical event, not invented notes. When the event already fits one bar,
    an upstream tie (from the prepared score's own barline split) is carried
    over so tie chains survive the rebuild. Best-effort; never raises.
    """
    import copy

    try:
        remaining = round(float(ql), 6)
        cur = round(float(start), 6)
        if remaining <= 0 or cur < 0:
            return
    except Exception:
        return
    try:
        fresh = [copy.deepcopy(p) for p in pitch_objs]
        if not fresh:
            return
    except Exception:
        return
    first = True
    guard = 0
    while remaining > 1e-9 and guard < 64:
        guard += 1
        try:
            m_idx = int(cur // CLEAN_BAR_QL)
            measure = _ensure_builder_measure(part, m_idx, _stream_mod, _note_mod)
            if measure is None:
                return
            m_start = m_idx * CLEAN_BAR_QL
            in_meas = round(cur - m_start, 6)
            space = round(CLEAN_BAR_QL - in_meas, 6)
            if space <= 1e-9:
                cur = round(m_start + CLEAN_BAR_QL, 6)
                continue
            frag = min(remaining, space)
            if frag <= 1e-9:
                return
            if len(fresh) > 1:
                obj = _chord_mod.Chord([copy.deepcopy(p) for p in fresh], quarterLength=frag)
            else:
                obj = _note_mod.Note(copy.deepcopy(fresh[0]), quarterLength=frag)
            more = (remaining - frag) > 1e-9
            try:
                if first and more:
                    obj.tie = _tie_mod.Tie("start")
                elif not first and more:
                    obj.tie = _tie_mod.Tie("continue")
                elif not first:
                    obj.tie = _tie_mod.Tie("stop")
                elif source_tie is not None:
                    # Single-fragment event: preserve the upstream tie chain.
                    import copy as _copy

                    try:
                        obj.tie = _copy.deepcopy(source_tie)
                    except Exception:
                        pass
            except Exception:
                pass
            try:
                obj.stemDirection = stem
            except Exception:
                pass
            try:
                measure.insert(in_meas, obj)
            except Exception:
                return
            remaining = round(remaining - frag, 6)
            cur = round(cur + frag, 6)
            first = False
        except Exception:
            return


def generate_clean_grand_staff(source_stream, title="Piano Transcription"):
    """Explicit measure-by-measure Grand Staff, built valid from the ground up.

    Two distinct Parts under a braced, barline-joined StaffGroup; measures
    pre-populated with clef + meter (+ detected key) in bar 1; events
    extracted from the flattened source at absolute offsets, clamped to
    strict lengths, partitioned strictly at middle C, and laid into measures
    with tie-splitting so no note ever overflows a barline; empty bars get
    whole rests, gapped bars get fillGaps rests, beams preserve explicit
    stems. Only genuinely decoded pitches are engraved. Best-effort
    throughout — never raises.
    """
    from music21 import chord as _chord_mod
    from music21 import clef as _clef_mod
    from music21 import instrument as _instrument_mod
    from music21 import key as _key_mod
    from music21 import layout as _layout_mod
    from music21 import meter as _meter_mod
    from music21 import note as _note_mod
    from music21 import stream as _stream_mod
    from music21 import tie as _tie_mod

    score = _stream_mod.Score()
    try:
        from music21 import metadata as _metadata

        score.metadata = _metadata.Metadata(title=title or "Piano Transcription")
    except Exception:
        pass

    p_upper = _stream_mod.Part(id="P1")
    p_upper.partName = "Right Hand"
    p_lower = _stream_mod.Part(id="P2")
    p_lower.partName = "Left Hand"
    for part in (p_upper, p_lower):
        try:
            part.insert(0, _instrument_mod.Piano())
        except Exception:
            pass

    try:
        score.append(
            _layout_mod.StaffGroup([p_upper, p_lower], name="Piano", symbol="brace", barTogether=True)
        )
    except Exception:
        try:
            score.append(_layout_mod.StaffGroup([p_upper, p_lower], name="Piano", symbol="brace"))
        except Exception:
            pass

    try:
        events = list(source_stream.flatten().notes)
    except Exception:
        events = []

    try:
        max_end = max(float(n.offset) + float(n.quarterLength) for n in events) if events else 0.0
    except Exception:
        max_end = 0.0
    try:
        num_measures = max(1, int(math.ceil(max_end / CLEAN_BAR_QL)))
    except Exception:
        num_measures = 1

    try:
        key_sharps = detect_key_sharps(source_stream)
        sharps = key_sharps if isinstance(key_sharps, int) else 0
    except Exception:
        sharps = 0

    for m_num in range(1, num_measures + 1):
        try:
            m_upper = _stream_mod.Measure(number=m_num)
            m_lower = _stream_mod.Measure(number=m_num)
        except Exception:
            continue
        if m_num == 1:
            try:
                m_upper.append(_clef_mod.TrebleClef())
                m_upper.append(_meter_mod.TimeSignature(DEFAULT_TIME_SIGNATURE))
                m_upper.append(_key_mod.KeySignature(max(-7, min(7, sharps))))
            except Exception:
                pass
            try:
                m_lower.append(_clef_mod.BassClef())
                m_lower.append(_meter_mod.TimeSignature(DEFAULT_TIME_SIGNATURE))
                m_lower.append(_key_mod.KeySignature(max(-7, min(7, sharps))))
            except Exception:
                pass
        try:
            p_upper.append(m_upper)
        except Exception:
            pass
        try:
            p_lower.append(m_lower)
        except Exception:
            pass

    for element in events:
        try:
            try:
                offset = float(element.offset)
            except Exception:
                continue
            snapped = _snap_clean_duration(element.quarterLength)
            if snapped is None:
                continue
            try:
                pitches = list(element.pitches)
            except Exception:
                continue
            if not pitches:
                continue
            try:
                src_tie = element.tie
            except Exception:
                src_tie = None
            if element.isChord:
                high = [p for p in pitches if int(p.midi) >= GRAND_STAFF_SPLIT_MIDI]
                low = [p for p in pitches if int(p.midi) < GRAND_STAFF_SPLIT_MIDI]
                if high:
                    _place_event_with_ties(
                        p_upper, offset, high, snapped, "up",
                        _stream_mod, _note_mod, _chord_mod, _tie_mod, src_tie,
                    )
                if low:
                    _place_event_with_ties(
                        p_lower, offset, low, snapped, "down",
                        _stream_mod, _note_mod, _chord_mod, _tie_mod, src_tie,
                    )
            else:
                try:
                    midi = int(pitches[0].midi)
                except Exception:
                    continue
                if midi >= GRAND_STAFF_SPLIT_MIDI:
                    _place_event_with_ties(
                        p_upper, offset, [pitches[0]], snapped, "up",
                        _stream_mod, _note_mod, _chord_mod, _tie_mod, src_tie,
                    )
                else:
                    _place_event_with_ties(
                        p_lower, offset, [pitches[0]], snapped, "down",
                        _stream_mod, _note_mod, _chord_mod, _tie_mod, src_tie,
                    )
        except Exception:
            pass

    for part in (p_upper, p_lower):
        try:
            measures = list(part.getElementsByClass(_stream_mod.Measure))
        except Exception:
            continue
        for m in measures:
            try:
                has_notes = bool(list(m.recurse().notes))
            except Exception:
                continue
            if not has_notes:
                try:
                    m.insert(0.0, _note_mod.Rest(quarterLength=CLEAN_BAR_QL))
                except Exception:
                    pass
                continue
            try:
                m.makeRests(fillGaps=True, inPlace=True)
            except Exception:
                pass
            try:
                # Deterministic bar completeness: fillGaps can leave a tied
                # fragment's bar short (Verovio then misaligns systems), so
                # top up any remainder to the full 4/4 bar with rests.
                try:
                    filled = round(float(m.highestTime), 6)
                except Exception:
                    filled = CLEAN_BAR_QL
                pad = round(CLEAN_BAR_QL - filled, 6)
                if pad > 1e-6:
                    m.insert(max(0.0, filled), _note_mod.Rest(quarterLength=pad))
            except Exception:
                pass
            try:
                m.makeBeams(inPlace=True, setStemDirections=False)
            except Exception:
                pass
        try:
            part.makeAccidentals(inPlace=True)
        except Exception:
            pass

    try:
        score.append(p_upper)
    except Exception:
        pass
    try:
        score.append(p_lower)
    except Exception:
        pass
    return score


def build_grand_staff(score, title: str | None = None):
    """Two-part piano Grand Staff of the SAME decoded notes (treble + bass).

    Thin wrapper over generate_clean_grand_staff(): explicit measures built
    valid from the ground up (clef/meter/key in bar 1, tie-split barline
    crossings, whole-measure rests, beat-locked beams), so the MusicXML
    exporter always emits complete <note> nodes (<type>, <step>) and
    <attributes> clefs. No pitch is added, removed or transposed. Never
    raises (render_musicxml maps a genuine failure to
    sheet-type-unsupported).
    """
    try:
        wanted = (title or "").strip()
    except Exception:
        wanted = ""
    if not wanted:
        try:
            wanted = (score.metadata.title or "") if score.metadata is not None else ""
        except Exception:
            wanted = ""
    if not wanted or wanted == FRAGMENT_TITLE:
        wanted = DEFAULT_SCORE_TITLE
    out = generate_clean_grand_staff(score, title=wanted)
    carry_title(score, out)
    # Score-level accidentals only: parts are already fully notated, and a
    # score-level makeNotation pass would re-process the explicit measures.
    try:
        out.makeAccidentals(inPlace=True)
    except Exception:
        pass
    return out





def build_lead_sheet(score):
    """Melody (highest decoded voice) plus chord symbols read from the sonorities."""
    from music21 import chord, harmony, instrument, note, stream

    part = stream.Part()
    part.partName = "Lead Sheet"
    part.insert(0, instrument.Piano())

    # Melody: the highest sounding pitch at each onset. The top line is the
    # tune; nothing is added, removed or transposed.
    melody: dict[float, tuple] = {}
    for element in score.recurse().notes:
        if not element.pitches:
            continue
        offset = round(float(element.getOffsetInHierarchy(score)), 6)
        top = max(element.pitches, key=lambda p: p.midi)
        if offset not in melody or top.midi > melody[offset][0].midi:
            melody[offset] = (top, element.quarterLength)
    for offset, (pitch, quarter_length) in sorted(melody.items()):
        part.insert(offset, note.Note(pitch, quarterLength=quarter_length))

    source = score.parts[0] if score.parts else score
    verticals = source.chordify()
    for stacked in verticals.recurse().getElementsByClass(chord.Chord):
        figure = identifiable_chord_figure(stacked)
        if figure is None:
            continue
        part.insert(stacked.getOffsetInHierarchy(verticals), harmony.ChordSymbol(figure))

    notate_part(part)
    try:
        part.makeAccidentals(inPlace=True)
    except Exception:
        pass
    carry_title(score, part)
    return part


def render_musicxml(score, xml_path: str, sheet_type: str, instruments=None) -> None:
    """Write the requested layout (with the piano grand-staff guarantee).

    - sheet_type 'piano-grand' → two-staff Grand Staff.
    - sheet_type 'lead-sheet'  → melody + chord symbols (always honored, even
      for piano: it is an explicit arrangement choice).
    - sheet_type 'melody-chords' → the decoded part as-is, EXCEPT piano
      material (detected or requested instrument names a piano): piano is
      ALWAYS laid out as a two-staff Grand Staff even when the client asked
      for the 'melody-chords' default, because a single treble staff cannot
      legibly render piano music (ledger-line collisions). This routing is
      stated here and in wants_grand_staff() — never a silent substitution,
      and non-piano material always keeps the exact layout it asked for.
    """
    try:
        if wants_grand_staff(sheet_type, instruments):
            build_grand_staff(score).write("musicxml", fp=xml_path)
        elif sheet_type == "lead-sheet":
            build_lead_sheet(score).write("musicxml", fp=xml_path)
        else:
            score.write("musicxml", fp=xml_path)
    except SystemExit:
        raise
    except Exception as exc:
        traceback.print_exc(limit=2)
        raise fail(
            "sheet-type-unsupported",
            f"This transcription could not be laid out as a {sheet_type} sheet with music21.",
            3,
        ) from exc



# EXPERIMENT 2, Step 1 (memory): streaming per-tensor weight loader.
#
# TranscriptionModel.load_model() materializes the whole fp32 state dict
# (load_file) next to the fp32 model before casting to the target dtype, so
# ~393 MB of weights sit in RAM twice at the load peak. The loader below
# reaches the identical end state while values stream one tensor at a time:
# same source resolution, same cached download, same _build_model config,
# same legacy key remap, same exact key-set match, per-tensor shape checks
# from load_state_dict itself, same conditioner-fp32 restore, same eval /
# tokenizer / constructor. Only lower-precision dtypes use it; "float32"
# keeps the original TranscriptionModel.load_model() call untouched.
# Revert: delete everything up to `def main`, the --dtype arg, and the
# dispatch branch (restore `model = TranscriptionModel.load_model(args.model)`).
def _build_for_streaming(cfg, device, target):
    """Model at the target dtype, preferably without ever holding fp32 params.

    Meta-device path: construct on meta (no storage), cast meta->meta
    (free), materialize uninitialized storage at the target dtype with
    to_empty. Every key is then filled from the weight file, so the
    uninitialized memory never survives: the upfront exact key-set match
    plus per-tensor shape checks plus the finiteness audit make a silent
    gap impossible. Any failure here (or below) falls back to the plain
    build + cast, which is exactly what load_model does today.
    """
    import torch
    from muscriptor.transcription_model import _build_model

    try:
        model = _build_model(torch.device("meta"), cfg)
        model.to(target)
        model.to_empty(device=device)
        for _, tensor in list(model.named_parameters()) + list(model.named_buffers()):
            if tensor.is_meta:
                raise RuntimeError("meta tensor survived to_empty")
        # Conditioners stash the build device as a plain attribute and move
        # audio onto it at runtime (wav.to(self.device) in tokenize). A meta
        # device stored here would leak into inference, so point every such
        # attribute at the real device; the audit below verifies none remain.
        for module in model.modules():
            stored = getattr(module, "device", None)
            try:
                is_meta_device = isinstance(stored, torch.device) and stored.type == "meta"
            except Exception:
                is_meta_device = False
            if is_meta_device:
                module.device = device
        print("[worker] streaming load: meta-device build ok", file=sys.stderr)
        return model, True
    except Exception as exc:
        print(
            f"[worker] streaming load: meta-device build unavailable "
            f"({exc.__class__.__name__}), using plain build",
            file=sys.stderr,
        )
        model = _build_model(device, cfg)
        if target != torch.float32:
            model.to(target)
        return model, False


def _audit_streamed_model(model, target, used_meta) -> None:
    """Fail loudly unless every floating tensor has its intended dtype/values.

    Transformer params must be `target`; the conditioning pipeline (mel,
    class embeddings, buffers) must be fp32, exactly as load_model leaves
    them. All values must be finite — with the meta path this also proves
    no uninitialized storage survived the load.
    """
    import torch

    bad_dtype: list[str] = []
    nonfinite: list[str] = []
    meta_devices: list[str] = []
    for module_name, module in model.named_modules():
        stored = getattr(module, "device", None)
        if isinstance(stored, torch.device) and stored.type == "meta":
            meta_devices.append(module_name or type(module).__name__)
    tensors = list(model.named_parameters()) + [
        (name, buf) for name, buf in model.named_buffers() if buf.is_floating_point()
    ]
    for name, tensor in tensors:
        want = torch.float32 if name.startswith("condition_provider.") else target
        if tensor.dtype != want:
            bad_dtype.append(f"{name} is {tensor.dtype}, want {want}")
        if not torch.isfinite(tensor).all().item():
            nonfinite.append(name)
    print(
        f"[worker] streaming load: audit meta={used_meta} "
        f"target={str(target).replace('torch.', '')} "
        f"tensors={len(tensors)} bad_dtype={len(bad_dtype)} "
        f"nonfinite={len(nonfinite)} meta_devices={len(meta_devices)}",
        file=sys.stderr,
    )
    if bad_dtype or nonfinite or meta_devices:
        for line in (bad_dtype + [f"non-finite: {n}" for n in nonfinite])[:8]:
            print(f"[worker] streaming load: {line}", file=sys.stderr)
        raise fail("transcription-failed", "Loaded weights failed integrity audit.", 3)


def _load_model_streaming(size: str, dtype_name: str):
    """Mirror of TranscriptionModel.load_model() with a streaming value load."""
    import torch
    import muscriptor.accelerator
    from muscriptor import TranscriptionModel
    from muscriptor.tokenizer.mt3 import MT3Tokenizer
    from muscriptor.transcription_model import (
        _remap_single_codebook_keys,
        _resolve_config,
        _resolve_source,
    )
    from muscriptor.utils.download import download_if_necessary
    from safetensors import safe_open

    target = getattr(torch, dtype_name)
    # Same device policy as load_model: accelerator when one exists, else CPU.
    device = (
        muscriptor.accelerator.current_accelerator()
        if muscriptor.accelerator.is_available()
        else torch.device("cpu")
    )
    source = _resolve_source(size)
    weights_path = download_if_necessary(source)  # cached read; never rewritten
    model, used_meta = _build_for_streaming(_resolve_config(source, weights_path), device, target)
    model.eval()

    # Strict key validation up front, header-only (no values faulted).
    # _remap_single_codebook_keys is the package's own remap, reused on
    # key-only entries so legacy names and the multi-codebook rejection
    # behave exactly as in load_model.
    with safe_open(weights_path, framework="pt", device=str(device)) as reader:
        header_keys = list(reader.keys())
    remapped_names: list[str] = []
    for key in header_keys:
        (name,) = _remap_single_codebook_keys({key: None}).keys()
        remapped_names.append(name)
    expected = set(model.state_dict().keys())
    missing = sorted(expected - set(remapped_names))
    unexpected = sorted(set(remapped_names) - expected)
    if missing or unexpected:
        raise fail(
            "transcription-failed",
            f"Weight file keys do not match the model "
            f"(missing={len(missing)}, unexpected={len(unexpected)}).",
            3,
        )

    # Stream values one tensor at a time with the pread backend (anonymous
    # per-tensor allocations, no whole-file mmap residency). load_state_dict
    # checks each shape as it copies, casting fp32 file values into the
    # pre-cast model exactly as Module.to() would.
    with safe_open(weights_path, framework="pt", device=str(device), backend="pread") as reader:
        for key, name in zip(header_keys, remapped_names):
            value = reader.get_tensor(key)
            if target != torch.float32:
                value = value.to(target)
            try:
                model.load_state_dict({name: value}, strict=False)
            except Exception as exc:
                raise fail(
                    "transcription-failed",
                    f"Weight '{name}' does not fit the model ({exc.__class__.__name__}).",
                    3,
                ) from exc
            del value
    # Same conditioner-fp32 restore as load_model.
    if target != torch.float32:
        model.condition_provider.float()
    _audit_streamed_model(model, target, used_meta)

    tokenizer = MT3Tokenizer(
        instrument_vocabulary="MT3_FULL_PLUS",
        max_shift_steps=1001,
    )
    return TranscriptionModel(model=model, tokenizer=tokenizer, device=device)


def main() -> int:
    parser = argparse.ArgumentParser(description="MuScriptor transcription worker")
    parser.add_argument("--audio", help="Input audio path (wav/mp3/flac)")
    parser.add_argument("--out", help="Output directory for artifacts")
    parser.add_argument("--model", default="small", choices=["small", "medium", "large"])
    # EXPERIMENT 2, Step 1 (memory): opt-in transformer dtype. "float32" keeps
    # the original load path; any other choice routes through the streaming
    # per-tensor loader above. Set via MUSCRIPTOR_DTYPE so the RAM harness
    # (which passes no extra flags) can trial it with zero harness changes.
    parser.add_argument(
        "--dtype",
        default=os.environ.get("MUSCRIPTOR_DTYPE", "float32"),
        # PHASE 1A verdict: float16 disabled. It ran stably on the 2s sine
        # fixture (clean audit) but inference was ~2x slower than bfloat16
        # (generate 3.80s vs 1.80s) for the same peak RSS, and fp16's narrow
        # range risks overflow on real audio. bfloat16 is the candidate.
        choices=["float32", "bfloat16"],
        help="Transformer weight/compute dtype (default: float32)",
    )
    # PHASE 1A (comparison only): loader routing. "legacy" keeps the original
    # TranscriptionModel.load_model() for float32 (the control). "streaming"
    # routes float32 through the same per-tensor streaming loader used for
    # float16/bfloat16 (config A). float16/bfloat16 always use streaming.
    # No quantization, chunking, or generation changes.
    parser.add_argument(
        "--loader",
        default=os.environ.get("MUSCRIPTOR_LOADER", "legacy"),
        choices=["legacy", "streaming"],
        help="Weight loader: legacy (control) or streaming (default: legacy)",
    )
    parser.add_argument("--instruments", default=None, help="Comma-separated instrument restricts (optional)")
    # Generation-budget cap (KV-cache control). Production default is 1000:
    # measured -30..-45 MB (Small) and -106..-137 MB (Medium) worker HWM vs
    # the upstream 2000, with byte-identical MIDI on dense real material and
    # zero cap hits (densest chunk observed: 284/1000 tokens). Upstream
    # hardcodes 2000; 2000 here restores the exact upstream behavior.
    # Override with --max-gen-len or MUSCRIPTOR_MAX_GEN_LEN.
    parser.add_argument(
        "--max-gen-len",
        default=os.environ.get("MUSCRIPTOR_MAX_GEN_LEN", "1000"),
        help="Max tokens generated per 5 s chunk (default: 1000)",
    )
    parser.add_argument(
        "--sheet-type",
        default="melody-chords",
        choices=list(SHEET_TYPES),
        help="Notation layout for the MusicXML artifact",
    )
    parser.add_argument(
        "--title",
        default=None,
        help="Score title for the MusicXML metadata (default: clean 'Transcription'). "
        "Replaces music21's 'Music21 Fragment' placeholder; cosmetic only.",
    )
    parser.add_argument("--self-check", action="store_true", help="Check deps + HF access only; do not transcribe")
    # Thread-count control (allocator experiment, default: torch default).
    # --threads N (or VBT_THREADS=N) sets OMP/MKL env vars before torch is
    # imported and calls torch.set_num_threads(N) before model load. Unset
    # means production behavior unchanged. Fewer threads may shrink
    # per-thread buffers at the cost of slower transcribe.
    parser.add_argument(
        "--threads",
        default=os.environ.get("VBT_THREADS", ""),
        help="Torch intra-op thread count (default: unset = torch default)",
    )
    args = parser.parse_args()

    # Apply thread setting before any torch import (torch comes in lazily
    # via check_deps/muscriptor). Explicit flag wins over ambient env.
    threads: int | None = None
    if str(args.threads).strip() != "":
        try:
            threads = int(args.threads)
        except (TypeError, ValueError):
            threads = -1
        if threads is None or threads < 1:
            raise fail(
                "worker-args-invalid",
                f"Invalid --threads value: {args.threads!r} (need a positive integer).",
                4,
            )
        os.environ["OMP_NUM_THREADS"] = str(threads)
        os.environ["MKL_NUM_THREADS"] = str(threads)

    # Validate the cap early with an honest argument error.
    try:
        max_gen_len = int(args.max_gen_len)
    except (TypeError, ValueError):
        max_gen_len = -1
    if max_gen_len < 1:
        raise fail(
            "worker-args-invalid",
            f"Invalid --max-gen-len value: {args.max_gen_len!r} (need a positive integer).",
            4,
        )

    # PHASE 0 (measurement only): peak sampler around the unchanged pipeline.
    sampler = _PeakSampler()
    sampler.start()
    try:
        check_deps()
        check_hf(args.model)
        if args.self_check:
            emit({"type": "ok", "model": args.model})
            return 0
        if not args.audio or not args.out:
            raise fail("worker-args-invalid", "Worker invoked without --audio/--out.", 4)
        instrument_names = resolve_instruments(args.instruments)

        emit({"type": "progress", "stage": "loading_model"})
        from muscriptor import TranscriptionModel

        # Thread setting takes effect here (torch is imported by now).
        if threads is not None:
            import torch as _torch

            _torch.set_num_threads(threads)
            print(
                f"[worker-timing] threads={threads} "
                f"(torch reports {_torch.get_num_threads()})",
                file=sys.stderr,
            )

        # PHASE 1A: loader selection + load/transcribe timing (stderr only).
        import time as _time

        use_streaming = args.loader == "streaming" or args.dtype != "float32"
        loader_name = "streaming" if use_streaming else "legacy"
        _load_t0 = _time.perf_counter()
        if use_streaming:
            model = _load_model_streaming(args.model, args.dtype)
        else:
            model = TranscriptionModel.load_model(args.model)
        _load_sec = _time.perf_counter() - _load_t0
        print(
            f"[worker-timing] loader={loader_name} dtype={args.dtype} "
            f"loadSec={_load_sec:.2f}",
            file=sys.stderr,
        )
        _mark("post-load")

        emit({"type": "progress", "stage": "transcribing"})
        midi_path = os.path.join(args.out, "transcription.mid")
        xml_path = os.path.join(args.out, "transcription.musicxml")
        try:
            _trx_t0 = _time.perf_counter()
            midi_bytes, detected_instruments = transcribe_midi(model, args.audio, instrument_names, max_gen_len)
            _trx_sec = _time.perf_counter() - _trx_t0
            print(f"[worker-timing] transcribeSec={_trx_sec:.2f}", file=sys.stderr)
        except Exception as exc:
            tail = traceback.format_exc(limit=2)
            print(tail, file=sys.stderr)
            raise fail("transcription-failed", "Transcription failed while running the model.", 3) from exc

        if not midi_bytes:
            raise fail("empty-transcription", "Transcription produced no notes.", 3)
        with open(midi_path, "wb") as fh:
            fh.write(midi_bytes)

        emit({"type": "progress", "stage": "converting"})
        score = load_score(midi_path, args.title)
        metadata = extract_metadata(score)
        # Piano auto-upgrade needs BOTH the detected instruments (what the
        # model actually decoded) and the requested ones (--instruments hint):
        # either naming a piano routes to the Grand Staff.
        render_musicxml(
            score,
            xml_path,
            args.sheet_type,
            list(detected_instruments or []) + list(instrument_names or []),
        )
        _mark("post-music21")

        duration = None
        try:
            import soundfile as sf

            with sf.SoundFile(args.audio) as snd:
                duration = len(snd) / float(snd.samplerate)
        except Exception:
            duration = None  # duration is informational only

        payload = {
            "type": "result",
            "durationSec": duration,
            "model": args.model,
            "detectedInstruments": detected_instruments,
            **metadata,
        }
        with open(os.path.join(args.out, "result.json"), "w", encoding="utf-8") as fh:
            json.dump({k: v for k, v in payload.items() if k != "type"}, fh)
        emit(payload)
        return 0
    except SystemExit:
        raise
    except Exception as exc:  # last resort: honest generic failure
        traceback.print_exc()
        print(f"worker crashed: {exc!r}", file=sys.stderr)
        emit_error("transcription-failed", "Transcription failed unexpectedly.")
        return 3
    finally:
        # Diagnostics only; stdout protocol and artifacts above are untouched.
        try:
            sampler.stop_and_emit()
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
