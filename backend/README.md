# Vigilante Ball Thunder — backend

Express API that turns uploaded audio into MIDI + MusicXML using
[MuScriptor](https://github.com/kyutai/muscriptor) (open weights, CC BY-NC 4.0)
via a Python worker, with an honest job lifecycle and no fabricated results.

## Quick start

```bash
npm install

# Python worker environment (one-time):
python3 -m venv .venv
.venv/bin/pip install --index-url https://download.pytorch.org/whl/cpu torch
.venv/bin/pip install -r python/requirements.txt

# Hugging Face access (required for REAL transcription):
# 1. accept the license at https://huggingface.co/MuScriptor/muscriptor-small
# 2. create a token at https://huggingface.co/settings/tokens
# 3. cp .env.example .env   ->  set HF_TOKEN=hf_...   (never commit .env)

npm run dev   # http://127.0.0.1:4000
```

## Engines

| Engine | How to select | What it returns |
|---|---|---|
| `muscriptor` (default) | real deps + `HF_TOKEN` | real transcription of the uploaded audio |
| `stub` | `TRANSCRIPTION_ENGINE=stub` | **MOCK**: fixed synthetic fixture melody, clearly labeled in logs, capabilities (`engine.mock`), and the frontend UI. Development/testing only. |

If the `muscriptor` engine can't run (missing deps/token/license), the API
says so honestly: `GET /api/capabilities` → `engine.available: false` with a
safe reason; `POST /api/transcriptions` → `503 engine-unavailable`.

## API

See `../frontend/BACKEND_CONTRACT.md` (implemented, tested contract).

## Tests

```bash
npm run typecheck   # tsc --noEmit (strict)
npm test            # vitest + supertest — 27 tests incl. blocked-engine 503 honesty
npm run build       # emits dist/
```

Tests exercise the REAL subprocess engine path through a protocol-faithful
fake worker (`test/fixtures/fake_worker.py`, clearly labeled) so no gated
weights or network are needed in CI.

## Data/storage

Uploads and artifacts live under `data/` (gitignored), in unguessable
per-job directories. Uploads are deleted as soon as a job settles; artifacts
survive until the TTL sweeper (`JOB_TTL_SEC`, default 30 min). Cancellation
(`DELETE /api/transcriptions/:id`) kills the worker and removes files
immediately.
