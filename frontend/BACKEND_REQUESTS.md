# Backend requests (frontend → backend outbox)

The frontend owns this file (like `frontend/BACKEND_CONTRACT.md`). Requests
are recorded here when the frontend needs a backend capability that does not
exist yet. The backend owner picks these up; nothing here has been promised.

## 2026-09-20 — `instrument` + `instrumentDetail` on POST /api/transcriptions

Status: the backend working tree now accepts and validates `instrument`
(see `backend/src/services/transcription/instrumentHints.ts`); commits the
frontend expects.

The upload UI ships an instrument picker (default **Auto-detect**). The
frontend **always** sends the chosen value as an optional multipart form
field:

- `instrument` — string enum:
  `auto | piano | guitar | bass | vocals | drums | multi | other`
  (`auto` is always sent and means "no hint"). `other` is the free-text case.
- `instrumentDetail` — optional free text, sent ONLY when
  `instrument=other` (e.g. `"saxophone solo"`). The backend currently reads
  only `instrument`; the detail text is ignored until it is consumed.

Backend behavior implemented (mirroring the optional `model` field):
- Accept and validate the enum; invalid value → 400 with the allowed list.
- `auto`, `multi` and `other` send no group constraint (parity with the
  pre-hint API); the named instruments map to muscriptor group names.

## 2026-09-20 — `sheetType` on POST /api/transcriptions

Status: the backend now knows the field and refuses layouts its engine cannot
genuinely produce with 501 `sheet-type-unsupported`; the frontend still ships
the selector **disabled** ("Coming soon") and does NOT send the field until
`SHEET_TYPE_SUPPORTED` flips.

Field vocabulary, matching `backend/src/services/transcription/sheetTypes.ts`:
- `sheetType` — string enum:
  `melody-chords | piano-grand | lead-sheet`
  (`melody-chords` is the UI default, the UI-only value intended for switch).

## 2026-09-20 — Score-aligned playback: POST /api/artifacts/:id/playback

Status: implemented in the backend working tree
(`backend/src/services/playback/playbackService.ts`); the frontend wiring is
written but dormant — the generate-playback button stays hidden while
`PLAYBACK_GENERATION_ENABLED` is false.

Endpoint shape the frontend calls (`generatePlayback()`):
- `POST /api/artifacts/:id/playback`
- 200 → `{ "audioUrl": "/api/artifacts/<id>/audio", "durationSec": <number> }`;
  `audioUrl` points at audio whose timebase IS the transcription's (MuScriptor
  MIDI auralization with FluidSynth), served by `GET /api/artifacts/:id/audio`.
- 404 unknown job, 409 job not complete, and a
  `playback-unavailable`/playback-failed code for missing FluidSynth or the
  soundfont — same honest failure semantics as the rest of the API.

Until the backend commit lands and a deployment advertises generated playback,
the UI plays the user's ORIGINAL recording and keeps note highlighting
permanently off (that is the honest behavior today).