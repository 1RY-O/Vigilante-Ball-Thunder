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
