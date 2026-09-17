# Frontend integration handoff — OpenCode

## Repository inspection

The original checkout (`d985ff9`) contained only README, LICENSE and .gitignore. There was no package.json, frontend, router, backend, API contract or notation renderer. This frontend is isolated in `frontend/`; no backend implementation was added or changed. Verovio was selected because there was no existing renderer to preserve.

**The endpoints below are proposed, not verified backend capabilities.** Adapt `frontend/src/api.ts` to the actual contract when OpenCode provides it. The app currently shows service-unavailable rather than fabricating results. No fixtures or fake jobs are served in production.

## Proposed same-origin contract

All requests use `/api`. Configure your local/reverse proxy to route `/api` to the backend; Vite preview does not implement it. No keys or secrets belong in frontend configuration.

### GET /api/capabilities

```json
{ "formats": ["mp3", "wav", "flac"], "maxUploadBytes": 52428800 }
```

Advertise only formats the deployed pipeline accepts. The UI enables only the intersection with MP3/WAV/FLAC. The byte limit must be a positive safe integer. Frontend extension/size checks are UX only: backend must independently validate content, size, decoding and authorization. Until capabilities succeed, file selection/upload is disabled.

### POST /api/transcriptions

Multipart form field **file**, one audio recording. Return 200/201/202 JSON:

```json
{ "id": "opaque-job-id", "status": "queued" }
```

### GET /api/transcriptions/{encoded-id}

Poll every 1.5 seconds while queued/transcribing:

```json
{ "id": "opaque-job-id", "status": "transcribing", "progress": 35 }
```

Statuses: `queued`, `transcribing`, `complete`, `error`. Optional `progress` is actual percent 0–100, never an estimated timer. An immediate complete response to POST is also accepted.

```json
{
  "id": "opaque-job-id",
  "status": "complete",
  "result": {
    "musicxmlUrl": "/api/artifacts/opaque-score-id/musicxml",
    "midiUrl": "/api/artifacts/opaque-score-id/midi",
    "audioUrl": "/api/artifacts/opaque-score-id/audio"
  }
}
```

MusicXML and MIDI are required. Audio is optional **browser-playable transcribed audio**, not a MIDI URL. Without it, playback explicitly says “Original recording” and uses a revocable local object URL. No synthesized MIDI playback or inferred audio/notation synchronization is claimed.

### Artifact GETs

Return same-origin `/api/…` paths. External/signed-storage URLs and internal filesystem paths are deliberately not accepted. Serve raw uncompressed MusicXML (`score-partwise` or `score-timewise`, not MXL ZIP), MIDI bytes, and optional browser-playable audio. Use appropriate Content-Type and Content-Disposition download filenames. Support audio range requests when practical. Protect artifacts using the existing server authorization scheme; opaque IDs alone are not authorization.

Errors may return any body: frontend does not display raw server text. HTTP 413/415/429/401/403 get safe user-facing messages; other failures are generic. Transcription error bodies are never surfaced. Provide safe structured error codes in a future agreed contract if more precise recovery is needed.

## State semantics / limitations

- Selected files are not uploaded until Create sheet music is pressed.
- Upload percent comes from XHR transport events, not transcription progress.
- Queued/transcribing are shown only after server confirmation.
- Rendering means a completed backend score is being fetched/engraved locally.
- Complete means Verovio produced notation pages.
- Stop waiting aborts frontend requests only; it is **not** server-job cancellation. The UI says so. Polling stops after 30 minutes; no job persistence or resume endpoint is assumed.
- Invalid MusicXML/render failures preserve available export links.
- No PDF, editing, note-following or artificial sample score in production.
- Timing data is absent. To add score-following, agree on stable MusicXML element IDs and a time-to-element mapping aligned to the returned playback audio; do not derive it from unrelated recording time.

## Backend work still needed

1. Confirm or supply the real routes/schema; wire MuScriptor jobs and artifact storage.
2. Provide truthful format/limit capabilities and independent upload validation.
3. Provide generated MusicXML/MIDI and optionally playable synthesized audio.
4. Configure same-origin routing, artifact authorization, retention and user-facing privacy policy.
5. Agree on job cancellation/resume, structured errors, timing and PDF only if supported.

Browser tests intercept this proposed contract with a clearly labelled test-only MusicXML fixture. They validate frontend integration, **not** transcription quality or a live MuScriptor pipeline.
