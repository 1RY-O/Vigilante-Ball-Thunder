# Backend contract — Vigilante Ball Thunder

**Status: implemented** (`backend/`, this repo). Earlier revisions of this
document described a *proposed* contract; the endpoints below are now the
real, tested backend. Frontend code lives in `frontend/src/api.ts`.

## Honesty guarantees (hard rules, enforced by tests)

- No fabricated results: the backend only serves MuScriptor output (or the
  clearly-labeled stub engine, below). There is no hidden "fake success" path.
- If MuScriptor cannot run (missing `HF_TOKEN`, license not accepted on Hugging
  Face, deps missing, HF unreachable), `GET /api/capabilities` reports
  `engine.available: false` with a safe `reason`, and `POST /api/transcriptions`
  answers **503** `{ "error": "engine-unavailable", "code", "message" }`.
  Covered by `backend/test/blocked.test.ts`.
- `HF_TOKEN` and other env secrets are never logged or returned in responses.
  Covered by a dedicated token-leak test.

## Endpoints

### GET /api/capabilities

```json
{
  "formats": ["wav", "mp3", "flac"],
  "maxUploadBytes": 26214400,
  "maxAudioDurationSec": 600,
  "engine": {
    "name": "muscriptor",
    "mock": false,
    "available": true,
    "model": "small"
  }
}
```

- `formats` is exactly what the deployed pipeline accepts (libsndfile-backed
  decoding). The frontend intersects this with its own MP3/WAV/FLAC support.
- `maxAudioDurationSec` is advertised so the client can gate over-long files
  optimistically; the backend enforces independently (WAV header check).
- `engine.mock` is `true` ONLY for the stub engine (see below); the frontend
  displays a "Demo engine active — synthetic fixture data" notice whenever
  this is true.
- `engine.available: false` MUST surface as an unavailable service in the UI,
  using the safe `reason` string.
- `engine.checking` (optional boolean): `true` while a fresh availability
  probe is in flight. `available: false` + `checking: true` is warm-up in
  progress, NOT a final verdict; `checking: false` (or absent) means settled.
- `engine.code` (optional string): may be `"engine-warming-up"` before the
  first probe finishes (first ~60 s after backend start/restart). Other
  settled codes use the curated worker vocabulary (`hf-token-missing`,
  `weights-gated`, `hf-unreachable`, `worker-deps-missing`,
  `python-not-found`, `worker-args-invalid`, `engine-unavailable`).
- Rule: `available: false` + `checking: true` (or `code:
  "engine-warming-up"`) MUST render as "warming up", never as a final
  "unavailable" failure. `available: false` + `checking: false` MUST render
  as `Transcription isn't available: <reason>` with the code shown when it
  is a known curated value.
- Frontend polling-while-warming: while the engine reports warming-up, the
  UI re-fetches `GET /api/capabilities` starting after 2 s with exponential
  backoff capped at 5 s, stopping when `available` becomes `true` (ready),
  when `checking` becomes `false` with `available` still `false` (honest
  failure with the real code), on unmount (timer cleared, no leaked
  intervals), or after ~5 minutes (shows "still warming up — try reloading"
  and stops).

### POST /api/transcriptions

Multipart form field **file** (one recording) → `202 { "id", "status": "queued" }`.

- Validation: magic-byte sniffing (RIFF/WAVE, ID3/MPEG-sync, fLaC),
  extension/content agreement, non-empty, `<= maxUploadBytes`, WAV duration
  `<= maxAudioDurationSec`. Failures: 400 (no file), 413 (too large),
  415 (type/mismatch/duration).
- Optional text field `model`: `small | medium | large` (validated).
- 503 when the engine is unavailable (see honesty guarantees).
- 429 when the per-IP rate limit trips (`RATE_LIMIT_MAX` per
  `RATE_LIMIT_WINDOW_MS`).

### GET /api/transcriptions/:id

```json
{ "id": "…", "status": "transcribing", "progress": 35 }
```

Statuses: `queued → transcribing → complete | error`.
`progress` is a real percent reported by the engine, or absent — never
estimated. On `complete`:

```json
{
  "id": "…", "status": "complete",
  "result": {
    "musicxmlUrl": "/api/artifacts/<id>/musicxml",
    "midiUrl": "/api/artifacts/<id>/midi"
  }
}
```

On failure: `{ "id", "status": "error", "error": { "code", "message", "cause" } }` with
a curated safe message (codes: `transcription-failed`, `engine-unavailable`,
`empty-transcription`, `cancelled`). Internal stderr/paths are never exposed.
`cause` is an optional curated worker code (allow-list: `hf-token-missing`,
`weights-gated`, `hf-unreachable`, `worker-deps-missing`, `python-not-found`,
`worker-args-invalid`). Never carries paths, tokens, or stderr. The frontend
MAY use it for precise operator-facing copy; ignoring it is safe.
Polling: 1.5 s interval; clients should stop on `complete`, `error`, or
after 30 minutes (frontend implements all three). When the user chooses to
stop waiting, the frontend calls `DELETE /api/transcriptions/:id` so the
server-side job is cancelled (not just the local poll loop).

### DELETE /api/transcriptions/:id

Safe cancellation → `200` with the resulting job view:

- queued job: dequeued, settles as `error { code: "cancelled" }`;
- running job: worker process is killed (SIGTERM → SIGKILL), settles as
  `error { code: "cancelled" }`;
- already-terminal job: safe no-op (returns current state; finished artifacts
  are NOT destroyed);
- unknown id: `404`.

Cancelled jobs' files are removed immediately; records stay until the TTL
sweeper so the terminal state remains inspectable.

### GET /api/artifacts/:id/musicxml

`200` body: raw uncompressed MusicXML (`score-partwise`),
`Content-Type: application/vnd.recordare.musicxml+xml`,
`Content-Disposition: attachment; filename="transcription.musicxml"`.
`404` unknown job, `409` job not complete.

### GET /api/artifacts/:id/midi

`200` body: MIDI bytes, `Content-Type: audio/midi`,
`Content-Disposition: attachment; filename="transcription.mid"`.
Same 404/409 semantics.

### GET /api/health

Liveness only (`{ "status": "ok" }`). Not needed by the UI.

## Not implemented (honest gaps)

- `result.audioUrl` (server-rendered playback of the transcription): not
  available yet — the UI plays the user's original recording instead and says
  "Original recording". MuScriptor's auralization needs FluidSynth + a
  soundfont download; deliberately out of this milestone.
- Job persistence across restarts; auth/user accounts; PDF export.

## Engines

- **muscriptor** (default): `backend/python/transcribe_worker.py` runs
  `muscriptor` (MIDI) + `music21` (MIDI→MusicXML) in a subprocess. Streams
  real progress over stdout JSONL. Requires `backend/.venv`
  (see `backend/python/requirements.txt`) and `HF_TOKEN` in `backend/.env`
  after accepting the model license (weights are CC BY-NC 4.0 gated).
- **stub** (`TRANSCRIPTION_ENGINE=stub`): ⚠️ MOCK. Emits a fixed synthetic
  fixture (constant C–E–G–C melody) with NO model involvement. Labeled as
  mock in code (`StubEngine.isMock`), startup logs, `GET /api/capabilities`
  (`engine.mock: true`), and the UI ("Demo engine active"). Never use for
  real output. Exists so the full backend/frontend path can be exercised
  offline and in CI.

## E2E test doubles

`frontend/e2e/mock-server.mjs` is a TEST-ONLY, protocol-level mock server
used by `npm run test:e2e`. It does not run any of the backend. The same
browser suite can run against the real backend via
`playwright.live.config.ts` (typically with `TRANSCRIPTION_ENGINE=stub`,
which keeps outputs synthetic but exercises the real backend code).
