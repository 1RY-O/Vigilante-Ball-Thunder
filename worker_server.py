"""VBT transcription worker bridge (async job API).

Long PyTorch/MuScriptor jobs must NOT stay attached to the original HTTP
request: Cloudflare times the request out (~120 s, HTTP 524) while the
transcription itself keeps running. This server therefore decouples upload
from inference:

  POST /transcribe  -> stage upload, register job, spawn background thread,
                       return 202 {"jobId", "status": "processing"} immediately
  GET  /jobs/{id}   -> {"status": "processing"} while running
                       {"status": "completed", "result": {...}} once done
                         (SAME result schema as the old synchronous API:
                          midiBase64 / musicXml / metadata)
                       {"status": "error", "message": "..."} on failure
                       404 {"status": "not_found"} for unknown/consumed ids

The completed/error payload is consume-on-read: the first GET that observes
a terminal state returns it and then deletes the job plus all temporary
files. Orphaned jobs (client vanished, e.g. user cancelled on the Node side
where there is no worker-cancel endpoint yet) are swept by TTL.

State is IN-MEMORY ONLY: jobs disappear if this process restarts (a poll
after restart honestly answers 404/not_found). No Redis/database/Celery.

Concurrency: inference runs on a dedicated daemon thread (plain
threading.Thread, never the event loop) so the server stays responsive to
polling, while the actual heavy lifting stays a single isolated subprocess
(same transcribe_worker.py as before). A lock serializes inference to one
MuScriptor process at a time (~690 MB peak for the Small model); concurrent
POSTs queue behind the lock WITHOUT holding any HTTP connection open.
"""

import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse
import uvicorn

app = FastAPI()

ROOT_DIR = Path(__file__).resolve().parent
PYTHON_BIN = sys.executable  # Uses the exact python running this worker
WORKER_SCRIPT = ROOT_DIR / "backend" / "python" / "transcribe_worker.py"

# Mirror the coordinator's upload cap so a giant body is rejected at staging
# instead of filling the temp disk while a job is "processing".
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
# Orphaned jobs (client never polls the terminal state) are swept after this.
JOB_TTL_SEC = 30 * 60

# NOTE: single-process only (uvicorn default workers=1). Do NOT run with
# --workers > 1: each process would own a disjoint registry and polls could
# land on a process that never saw the job (honest 404s, but broken UX).
active_jobs: dict = {}
_jobs_lock = threading.Lock()
# One expensive inference at a time (memory bound, not CPU bound).
_inference_lock = threading.Lock()


def _now() -> float:
    return time.time()


def _job_dir(job_id: str) -> Path:
    # job_id is a UUID we generated (never client filesystem input), so this
    # path cannot escape the temp dir via traversal.
    return Path(tempfile.gettempdir()) / f"vbt-worker-{job_id}"


def _cleanup_job_files(job: dict) -> None:
    try:
        job_dir = job.get("job_dir")
        if job_dir:
            shutil.rmtree(job_dir, ignore_errors=True)
    except Exception as exc:  # cleanup must never break a response
        print(f"[jobs] cleanup failed for {job.get('job_id')}: {exc!r}")


def _sweep_expired() -> None:
    """Delete TTL-expired jobs + their temp files. Cheap O(n); called per request."""
    try:
        now = _now()
        expired = []
        with _jobs_lock:
            for job_id, job in active_jobs.items():
                try:
                    if now - float(job.get("created_at", now)) > JOB_TTL_SEC:
                        expired.append(job_id)
                except Exception:
                    expired.append(job_id)
            for job_id in expired:
                job = active_jobs.pop(job_id, None)
                if job is not None:
                    _cleanup_job_files(job)
                    print(f"[jobs] swept expired job {job_id}")
    except Exception as exc:
        print(f"[jobs] sweep failed: {exc!r}")


def _run_transcription(input_path: str, out_dir: str, model: str, sheet_type: str,
                       instruments: str | None) -> dict:
    """Synchronous heavy work: subprocess + artifact read. Runs in a worker
    thread (never on the event loop). Factored out so tests can stub it
    without touching inference. Raises RuntimeError (never HTTPException —
    there is no request context in the background thread)."""
    cmd = [
        str(PYTHON_BIN), str(WORKER_SCRIPT),
        "--audio", input_path,
        "--out", out_dir,
        "--model", model,
        "--sheet-type", sheet_type,
        "--loader", "streaming",
        "--dtype", "bfloat16"
    ]
    if instruments and instruments not in ("undefined", "null", ""):
        cmd.extend(["--instruments", instruments])

    print(f"[*] Running command: {' '.join(cmd)}")
    res = subprocess.run(cmd, capture_output=True, text=True)

    if res.stdout:
        print("[worker stdout]:", res.stdout)
    if res.stderr:
        print("[worker stderr]:", res.stderr)

    if res.returncode != 0:
        error_msg = res.stderr.strip() or res.stdout.strip() or "Worker process failed without output."
        raise RuntimeError(error_msg[-2000:])

    midi_path = os.path.join(out_dir, "transcription.mid")
    xml_path = os.path.join(out_dir, "transcription.musicxml")
    res_json_path = os.path.join(out_dir, "result.json")

    if not os.path.exists(midi_path) or not os.path.exists(xml_path):
        raise RuntimeError(f"Worker did not produce required artifacts in {out_dir}.")

    with open(midi_path, "rb") as f:
        midi_b64 = base64.b64encode(f.read()).decode("ascii")
    with open(xml_path, "r", encoding="utf-8") as f:
        xml_str = f.read()

    meta = {}
    if os.path.exists(res_json_path):
        with open(res_json_path, "r", encoding="utf-8") as f:
            meta = json.load(f)

    # SAME schema as the old synchronous API (Node parses these exact keys).
    return {
        "midiBase64": midi_b64,
        "musicXml": xml_str,
        "metadata": meta
    }


def _execute_job(job_id: str) -> None:
    """Thread entry: serialize inference, record terminal state, keep temp
    files until the client consumes the result via GET. Catch-all: a job must
    settle as error, never die silently (or the client polls forever)."""
    with _jobs_lock:
        job = active_jobs.get(job_id)
    if job is None:
        return
    try:
        # One MuScriptor process at a time; the HTTP request is long gone, so
        # waiting here blocks no connection — only a worker thread.
        with _inference_lock:
            result = _run_transcription(
                job["input_path"], job["out_dir"],
                job["model"], job["sheet_type"], job["instruments"],
            )
    except Exception as exc:
        # Server-side diagnostics only; the client gets a safe message.
        print(f"[jobs] job {job_id} failed: {exc!r}")
        message = str(exc).strip() or "Transcription failed."
        with _jobs_lock:
            job = active_jobs.get(job_id)
            if job is not None:
                job["status"] = "error"
                job["message"] = message[:2000]
                job["completed_at"] = _now()
        return
    with _jobs_lock:
        job = active_jobs.get(job_id)
        if job is None:
            return  # swept while running; result has nowhere to go
        job["status"] = "completed"
        job["result"] = result
        job["completed_at"] = _now()
    print(f"[jobs] job {job_id} completed")


@app.get("/health")
def health():
    return {"status": "ok", "worker": "fedora-local"}


@app.post("/transcribe", status_code=202)
async def transcribe(
    audio: UploadFile = File(...),
    model: str = Form("small"),
    sheetType: str = Form("melody-chords"),
    instruments: str = Form(None)
):
    """Stage the upload, register the job, spawn background inference, and
    return 202 immediately. MUST NOT await inference (Cloudflare 524)."""
    _sweep_expired()
    try:
        data = await audio.read()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not read upload: {exc!r}"[:500])
    if not data:
        raise HTTPException(status_code=422, detail="Uploaded audio is empty.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"Audio exceeds {MAX_UPLOAD_BYTES} bytes.")

    job_id = uuid.uuid4().hex
    job_dir = _job_dir(job_id)
    try:
        job_dir.mkdir(parents=True, exist_ok=False)
        input_path = str(job_dir / "input.wav")
        out_dir = str(job_dir / "output")
        os.makedirs(out_dir, exist_ok=True)
        with open(input_path, "wb") as f:
            f.write(data)
    except Exception as exc:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail=f"Could not stage upload: {exc!r}"[:500])

    filename = (audio.filename or "audio")[:100]
    with _jobs_lock:
        active_jobs[job_id] = {
            "job_id": job_id,
            "status": "processing",
            "job_dir": str(job_dir),
            "input_path": input_path,
            "out_dir": out_dir,
            "model": model,
            "sheet_type": sheetType,
            "instruments": instruments,
            "filename": filename,
            "created_at": _now(),
            "completed_at": None,
        }
    print(f"[*] accepted job {job_id} ({filename}, {len(data)} bytes, model={model})")
    # Fire-and-forget BY DESIGN on a plain daemon thread (NOT asyncio
    # BackgroundTasks / create_task, which test harnesses and some servers
    # join before responding): _execute_job catch-alls internally, the work is
    # fully synchronous, and the event loop is never involved — so the 202
    # goes out immediately and GET /jobs/{id} stays responsive throughout.
    # _execute_job never touches the event loop, so a raw thread is safe.
    thread = threading.Thread(target=_execute_job, args=(job_id,), daemon=True)
    thread.start()
    return {"jobId": job_id, "status": "processing"}


@app.get("/jobs/{job_id}")
async def get_job(job_id: str):
    """Cheap registry read (never touches inference). Terminal states are
    consume-on-read: returned once, then the job + temp files are deleted."""
    _sweep_expired()
    with _jobs_lock:
        job = active_jobs.get(job_id)
    if job is None:
        # Exact {"status": "not_found"} schema (not FastAPI's {"detail": ...}
        # envelope) so the coordinator parses one shape for every outcome.
        return JSONResponse(status_code=404, content={"status": "not_found"})
    status = job.get("status")
    if status == "processing":
        return {"status": "processing"}
    # Terminal: pop first so a client retry/disconnect cannot double-consume,
    # then clean up, then answer from the in-memory snapshot.
    with _jobs_lock:
        job = active_jobs.pop(job_id, None)
    if job is None:
        return JSONResponse(status_code=404, content={"status": "not_found"})
    _cleanup_job_files(job)
    if status == "completed":
        return {"status": "completed", "result": job.get("result") or {}}
    return {"status": "error", "message": job.get("message") or "Transcription failed."}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
