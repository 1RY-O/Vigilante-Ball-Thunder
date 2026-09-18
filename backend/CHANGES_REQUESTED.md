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

