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
  melody-chords  the decoded part exactly as the model produced it
  piano-grand    the same notes laid out on a two-staff piano part (treble +
                 bass, split at middle C), with real <staves>2</staves>
  lead-sheet     highest voice as the melody line plus chord symbols read from
                 the decoded vertical sonorities
  The last two are music21 post-processing of the REAL decoded MIDI: no note,
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
        # Optional MUSCRIPTOR_BEAT_GRID=off override (testing/low-memory
        # mode): skip beat_this via the upstream-supported detect_tempo=False
        # path. Default (unset) keeps beat-grid detection enabled — quality
        # first. Skipped-grid MIDI lacks onset-delay snap, so such artifacts
        # are discarded, never quality-compared.
        beat_grid = None
        if os.environ.get("MUSCRIPTOR_BEAT_GRID", "") != "off":
            beat_grid = model.detect_beat_grid_for(audio)
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
        return model.transcribe_to_midi(audio, instruments=instruments), None


# Generation-budget cap override.
#
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


def load_score(midi_path: str):
    """Parse the decoded MIDI with music21 (real notes, or honest failure)."""
    from music21 import converter

    score = converter.parse(midi_path)
    if not score.recurse().notes:
        raise fail(
            "empty-transcription",
            "No notes could be detected in this recording. Try a clearer recording with a prominent melody.",
            3,
        )
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


def build_grand_staff(score):
    """Two-staff piano layout of the SAME decoded notes (treble + bass)."""
    from music21 import clef, instrument, layout, stream

    treble = stream.PartStaff()
    treble.partName = "Piano"
    bass = stream.PartStaff()
    bass.partName = "Piano"
    treble.insert(0, instrument.Piano())
    bass.insert(0, instrument.Piano())

    for element in score.recurse().notes:
        pitches = [p.midi for p in element.pitches]
        if not pitches:
            continue
        target = treble if max(pitches) >= GRAND_STAFF_SPLIT_MIDI else bass
        target.insert(element.getOffsetInHierarchy(score), element)

    treble.insert(0, clef.TrebleClef())
    bass.insert(0, clef.BassClef())
    for staff_part in (treble, bass):
        # Measures are required for music21 to join the two PartStaffs into one
        # MusicXML part with <staves>2</staves>; an empty staff gets its rests.
        staff_part.makeMeasures(inPlace=True)
        staff_part.makeAccidentals(inPlace=True)

    out = stream.Score()
    out.insert(0, treble)
    out.insert(0, bass)
    out.insert(0, layout.StaffGroup([treble, bass], name="Piano", symbol="brace"))
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

    part.makeMeasures(inPlace=True)
    part.makeAccidentals(inPlace=True)
    return part


def render_musicxml(score, xml_path: str, sheet_type: str) -> None:
    """Write the requested layout. Never substitutes a different layout."""
    try:
        if sheet_type == "piano-grand":
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
    parser.add_argument("--self-check", action="store_true", help="Check deps + HF access only; do not transcribe")
    args = parser.parse_args()

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
        score = load_score(midi_path)
        metadata = extract_metadata(score)
        render_musicxml(score, xml_path, args.sheet_type)
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
