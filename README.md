# Vigilante-Ball-Thunder
Open-source web app that turns audio recordings into editable sheet music, MIDI, and MusicXML.

## Layout

- `frontend/` — React + Vite + Verovio app (upload → engraving → playback → export). See `frontend/README.md`.
- `backend/` — Express API + job manager + MuScriptor Python worker (real audio→MIDI via the open MuScriptor model, MIDI→MusicXML via music21). See `backend/README.md`.
- `frontend/BACKEND_CONTRACT.md` — the implemented, tested API contract between the two.

Honesty rules are hard constraints: no fabricated transcription output; when the
real engine is unavailable the API answers 503 and the UI says so plainly; when
the stub engine is used it is labeled as a mock in the API, logs, and UI.
