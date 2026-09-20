# Backend change requests for the frontend agent (opencode)

This file is the BACKEND OWNER's outbox. The frontend agent owns
`frontend/` and `frontend/BACKEND_CONTRACT.md`; this backend task must NOT
edit those paths. Pending contract clarifications are recorded here instead.

## 2026-09-18 — Optional `cause` on job errors (backward-compatible)

- Backend now includes an optional `cause` string on `error` payloads when
  the failure came from the MuScriptor worker environment:
  `{ "id", "status": "error", "error": { "code": "engine-unavailable",
  "message": "...", "cause": "weights-gated" } }`.
- `cause` is a curated worker code only (`hf-token-missing`,
  `weights-gated`, `hf-unreachable`, `worker-deps-missing`,
  `python-not-found`, `worker-args-invalid`). It never carries paths,
  tokens, or stderr text.
- Frontend action (optional): if `error.cause` is present, it MAY be used
  for precise UI copy (e.g. link to the Hugging Face license page when
  `cause === "weights-gated"`). Ignoring it is safe — `code`/`message`
  semantics are unchanged.
- No endpoint, MIME, or status-code changes.

## 2026-09-18 — Cold-start warm-up: `engine.checking` + `engine-warming-up`

MuScriptor's availability check imports torch and probes the gated weights
(45-60s on an 8GB CPU-only laptop), so `/api/capabilities` no longer waits for
a live check. It now answers **instantly** from the last known state and a
background warm-up keeps that state fresh.

- New optional field: `engine.checking` (boolean) — a fresh probe is in flight
  right now. `engine.available === false` **with** `checking: true` means
  "warm-up in progress, not a verdict"; `checking: false` means the value is
  settled.
- New possible `engine.code` value: `engine-warming-up`. It appears only
  before the first probe finishes, i.e. during the first ~60s after backend
  start-up (or right after a restart).
- `POST /api/transcriptions` during that window returns the unchanged
  envelope `503 { error: "engine-unavailable", code: "engine-warming-up",
  message: "..." }` instead of blocking. Nothing is queued, so no fake job.
- Everything else is unchanged: same endpoints, same MIME types, same
  `503 { error: "engine-unavailable", code, message }` shape, same
  `engine.available/model/mock/name/reason`.
- Frontend action (recommended, not required): the current UI fetches
  capabilities once on mount and throws on `available === false`, so a user
  who opens the app within seconds of a backend restart sees the honest
  "warming up" message and no upload flow until a reload. A better experience
  is to re-fetch `/api/capabilities` (e.g. every 2-3s, with backoff) while
  `engine.checking === true` or `code === "engine-warming-up"`, then stop
  polling once `available === true`. Ignoring this is safe — no contract
  breakage, only a longer wait for the user.

## 2026-09-18 — Findings from the deployed "notation could not be displayed" bug

The backend owner reproduced the deployed pipeline end-to-end (uploaded a WAV
to https://vigilante-ball-thunder.onrender.com, downloaded the completed
stub-engine artifact, ran it through Verovio 4.x wasm locally). Evidence
backed conclusions; frontend fixes are requested, not implemented here.

### 1. The deployed stub MusicXML is VALID — do not blame the engine

The artifact served by `GET /api/artifacts/:id/musicxml` (Render, stub
engine) **loads and renders correctly in Verovio**:

```
LOAD_DATA=1
renderToSVG → 89801 chars of SVG, contains <g class="note" id="note-0000..">
renderToTimemap → entries {on, qstamp, tempo, tstamp}
getElementsAtTime(ms) → e.g. [ 'note-0000' ]
```

So "The notation could not be displayed" on Vercel is a **frontend Verovio
usage bug**, not bad backend output.

### 2. `setOptions({ svgView: 'score', timemap: true })` does not exist

Verovio logs `Unsupported option` for both keys — there is no `svgView` and
no `timemap` render option. The real API is:

```js
tk.loadData(musicxmlString);
tk.renderToSVG();          // page SVG
const timemap = tk.renderToTimemap();   // array, NOT a setOptions flag
const idsAtMs  = tk.getElementsAtTime(ms); // ['note-0000', ...] | []
```
(Requested in the feature ticket as `tk.setOptions({..., timemap:true})` +
`tk.getElementsAtTime(...)` — keep `getElementsAtTime`, drop the setOptions.)

### 3. Timemap entries have NO `notes` arrays in this build

Each entry is `{ on, qstamp, tempo?, tstamp }`. Any code reading
`entry.notes` to get active note ids always gets `undefined` → highlighting
silently never fires. Use `tk.getElementsAtTime(ms)` per animation frame
instead (it accepts milliseconds directly; no manual tempo/qstamp math
needed).

### 4. Proposed user-facing copy is factually wrong — please change it

The planned catch-all message ("This is a known issue with the mock engine.
Please try the local backend for real transcription.") is **false**: the
mock engine's score demonstrably renders (finding 1). Per the project's
no-fabrication rule, on a Verovio exception show something honest and
actionable, e.g. "The score could not be displayed. Please try again." plus
`console.error(originalError)` for diagnosis — and keep it out of the
top-level error state, as planned.

### 5. (already recorded above) poll capabilities while `engine.checking`
Render's free tier sleeps instances; the very first capabilities response
after a cold boot can legitimately be `engine-warming-up` for ~1 tick. A
mount-time single fetch turns that into a hard error for the user.

## 2026-09-20 — New contract surface: instrument hints, sheetType, playback, richer result metadata

All additive and backward-compatible: existing clients that send nothing new
get exactly the old behavior. Field names are load-bearing (the frontend
already aligns to them) — do not rename without a new entry here.

### 1. Optional form field `instrument` (+ `instrumentDetail` when `other`)

`POST /api/transcriptions` accepts multipart text field:

- `instrument` — enum `auto | piano | guitar | bass | vocals | drums | multi | other`
  (default when absent: `auto` = no hint; `multi`/`other` likewise send no
  constraint — inventing groups for them would forbid the real instruments).
- `instrumentDetail` — free text, accepted only as documentation for
  `instrument=other` (e.g. `"saxophone solo"`); currently **accepted and
  ignored** (no consumer yet). Never an error.
- Unknown `instrument` value → `400 { error: "Unsupported instrument hint
  \"<value>\". Use one of: auto, piano, guitar, bass, vocals, drums, multi,
  other." }`.
- Named hints constrain the MuScriptor decode to its MT3 group names
  (piano→acoustic/electric_piano, guitar→acoustic/clean/distorted_electric,
  bass→acoustic/electric_bass, vocals→voice, drums→drums).

### 2. Optional form field `sheetType`

- `sheetType` — enum `melody-chords | piano-grand | lead-sheet`
  (default when absent: `melody-chords` = current behavior, unchanged).
- Unknown value → `400 { error: "Unsupported sheet type \"<value>\". Use one
  of: melody-chords, piano-grand, lead-sheet" }`.
- Layout the engine cannot produce → `501 { error: "not-implemented", code:
  "sheet-type-unsupported", message: "The \"<type>\" sheet layout is not
  implemented by the <engine> engine on this deployment. Available layouts:
  <...>" }`. Never silently downgraded. (Render's stub engine serves only
  `melody-chords`; the local MuScriptor engine serves all three via music21
  post-processing of the real decoded MIDI.)
- A mid-job worker-side layout failure settles the job as
  `error { code: "not-implemented", cause: "sheet-type-unsupported" }` with no
  artifact written (`GET` artifact → 409).

### 3. Playback: `POST /api/artifacts/:id/playback` + `GET /api/artifacts/:id/audio`

- `POST /api/artifacts/:id/playback` — renders the job's OWN transcription
  MIDI to WAV with FluidSynth (idempotent; re-request reuses the render):
  - unknown job → `404 { error: "Job not found." }`
  - job not complete → `409 { error: "Playback is only available once the transcription is complete." }`
  - FluidSynth missing → `503 { error: "playback-unavailable", code: "fluidsynth-missing", message: "..." }`
  - no SoundFont (`SOUNDFONT_PATH` unset and no bundled copy) → `503
    { error: "playback-unavailable", code: "soundfont-missing", message: "..." }`
  - render produced no readable audio → `500 { error: "playback-failed", code: "render-failed", message: "..." }`
  - success → `200 { "audioUrl": "/api/artifacts/<id>/audio", "durationSec": <number> }`
- `GET /api/artifacts/:id/audio` — serves the WAV: `Content-Type: audio/wav`,
  exact `Content-Length`, `Cache-Control: private`; 404 unknown job, 409 not
  generated yet. Until `POST` succeeds, the job's `result` carries **no**
  `audioUrl`.
- Frontend action: gate the "Generate playback" button on
  `GET /api/capabilities → playback.available` (see below) instead of a
  hardcoded flag.

### 4. Richer `result` on `GET /api/transcriptions/:id` (complete jobs)

Added only when genuinely available — absent values are omitted/`null`,
never guessed:

```json
{
  "result": {
    "musicxmlUrl": "/api/artifacts/<id>/musicxml",
    "midiUrl": "/api/artifacts/<id>/midi",
    "audioUrl": "/api/artifacts/<id>/audio",
    "engineUsed": "muscriptor (small)",
    "durationSec": 1.0,
    "transcriptionMs": 834,
    "detectedInstruments": ["acoustic_piano"],
    "metadata": { "tempoBpm": 123.0, "keyName": "C major" }
  }
}
```

- `engineUsed` (string, always): e.g. `"muscriptor (small)"`, or the stub's
  `"stub (MOCK fixture — synthetic data, not a real transcription)"`.
- `durationSec` (number | null): worker-measured; `null` when unreported.
- `transcriptionMs` (integer, always): measured wall clock job-start → complete.
- `detectedInstruments` (string[] | null): the model's own decoded instrument
  names; `null` when the engine cannot report them (always `null` for stub).
- `metadata` (object, optional): present only when ≥1 field extracted —
  `tempoBpm` (finite BPM from the metronome mark), `keyName` (music21
  `analyze("key")` name, e.g. `"C major"`). Unreadable → field omitted.
- Frontend action: render only the fields present; never invent
  instruments/tempo/key from these being absent.

### 5. New `GET /api/capabilities` sections (drive UI gates from these)

```json
{
  "sheetTypes": { "default": "melody-chords", "supported": ["melody-chords"] },
  "instrumentHints": {
    "values": ["auto","piano","guitar","bass","vocals","drums","multi","other"],
    "mapped": { "piano": ["acoustic_piano","electric_piano"], "...": ["..."] }
  },
  "playback": { "available": false, "code": "fluidsynth-missing", "reason": "..." }
}
```

- `sheetTypes.supported` is engine-aware (`["melody-chords"]` on stub/Render,
  all three locally) — enable the sheet-type selector from this, not a flag.
- `instrumentHints.mapped` lists only hints that actually constrain the
  decode (`auto`/`multi`/`other` intentionally absent).
- `playback` mirrors the server's real FluidSynth+SoundFont probe
  (`available`, plus `code`/`reason` only when unavailable).


