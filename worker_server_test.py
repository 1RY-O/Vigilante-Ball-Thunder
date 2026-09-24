"""Async job API tests for worker_server.py (no model download).

The expensive transcription (_run_transcription) is stubbed per test, so the
suite exercises ONLY the HTTP/job/cleanup architecture: 202 submit speed,
poll lifecycle, result schema compatibility with the Node coordinator,
consume-on-read cleanup, error paths, and event-loop responsiveness. Run:

    backend/.venv/bin/python -m unittest worker_server_test -v
"""

import os
import re
import tempfile
import time
import unittest
from pathlib import Path

import worker_server as W
from fastapi.testclient import TestClient

FAKE_RESULT = {
    "midiBase64": "TVRo",
    "musicXml": '<?xml version="1.0"?><score-partwise version="4.0"><part id="P1"/></score-partwise>',
    "metadata": {"durationSec": 10.0, "detectedInstruments": ["acoustic_piano"],
                 "tempoBpm": 120.0, "keyName": "C minor"},
}

UUID_RE = re.compile(r"^[0-9a-f]{32}$")


def _wav(n=512):
    return b"RIFF" + os.urandom(n)


class JobApiTest(unittest.TestCase):
    def setUp(self):
        self._real_run = W._run_transcription
        W._run_transcription = lambda *a: dict(FAKE_RESULT)
        with W._jobs_lock:
            W.active_jobs.clear()
        self.client = TestClient(W.app)

    def tearDown(self):
        W._run_transcription = self._real_run
        with W._jobs_lock:
            for job_id, job in list(W.active_jobs.items()):
                W._cleanup_job_files(job)
            W.active_jobs.clear()

    def _post(self, **kw):
        return self.client.post("/transcribe",
                                files={"audio": ("t.wav", _wav())},
                                data={"model": "small", "sheetType": "melody-chords"},
                                **kw)

    def _wait_for(self, job_id, status, timeout=15.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            r = self.client.get(f"/jobs/{job_id}")
            body = r.json()
            if body.get("status") == status:
                return r
            time.sleep(0.1)
        self.fail(f"job {job_id} never reached {status}")

    def test_post_returns_202_with_valid_job_id(self):
        r = self._post()
        self.assertEqual(r.status_code, 202)
        body = r.json()
        self.assertEqual(body.get("status"), "processing")
        self.assertTrue(UUID_RE.match(body.get("jobId", "")),
                        f"jobId is not a UUID4 hex: {body}")

    def test_post_returns_quickly_while_inference_runs(self):
        # A 6 s "transcription" must NOT hold the POST open (Cloudflare 524).
        W._run_transcription = lambda *a: (time.sleep(6), dict(FAKE_RESULT))[1]
        t0 = time.time()
        r = self._post()
        dt = time.time() - t0
        self.assertEqual(r.status_code, 202)
        self.assertLess(dt, 3.0, f"POST blocked on inference ({dt:.1f}s)")
        # ...and the job genuinely keeps running afterwards.
        self.assertEqual(self.client.get(f"/jobs/{r.json()['jobId']}").json()["status"],
                         "processing")

    def test_poll_reports_processing_then_completed_with_node_schema(self):
        started = []
        orig = W._run_transcription

        def slow(*a):
            started.append(True)
            time.sleep(1.5)
            return dict(FAKE_RESULT)
        W._run_transcription = slow
        job_id = self._post().json()["jobId"]
        self.assertEqual(self.client.get(f"/jobs/{job_id}").json(),
                         {"status": "processing"})
        done = self._wait_for(job_id, "completed")
        result = done.json()["result"]
        # SAME keys the Node coordinator parses (midiBase64/musicXml/metadata).
        self.assertEqual(set(result.keys()), {"midiBase64", "musicXml", "metadata"})
        self.assertTrue(result["midiBase64"])
        self.assertIn("<score-partwise", result["musicXml"])
        self.assertEqual(result["metadata"]["durationSec"], 10.0)
        self.assertTrue(started, "background transcription never ran")

    def test_completed_result_consumed_once_then_404(self):
        job_id = self._post().json()["jobId"]
        self._wait_for(job_id, "completed")
        again = self.client.get(f"/jobs/{job_id}")
        self.assertEqual(again.status_code, 404)
        self.assertEqual(again.json(), {"status": "not_found"})

    def test_temp_audio_deleted_after_consumption(self):
        job_id = self._post().json()["jobId"]
        job_dir = Path(tempfile.gettempdir()) / f"vbt-worker-{job_id}"
        self.assertTrue(job_dir.exists(), "staged temp dir missing")
        self._wait_for(job_id, "completed")
        self.assertFalse(job_dir.exists(), "temp files accumulated after consume")

    def test_failed_job_reports_error_and_cleans_up(self):
        W._run_transcription = lambda *a: (_ for _ in ()).throw(RuntimeError("boom subprocess died"))
        job_id = self._post().json()["jobId"]
        err = self._wait_for(job_id, "error")
        self.assertIn("boom subprocess died", err.json().get("message", ""))
        job_dir = Path(tempfile.gettempdir()) / f"vbt-worker-{job_id}"
        self.assertFalse(job_dir.exists(), "failed job left temp files")
        self.assertEqual(self.client.get(f"/jobs/{job_id}").status_code, 404)

    def test_unknown_job_id_is_404(self):
        r = self.client.get("/jobs/" + "0" * 32)
        self.assertEqual(r.status_code, 404)
        self.assertEqual(r.json(), {"status": "not_found"})

    def test_empty_upload_rejected_without_job(self):
        r = self.client.post("/transcribe", files={"audio": ("t.wav", b"")})
        self.assertIn(r.status_code, (400, 422))
        with W._jobs_lock:
            self.assertEqual(len(W.active_jobs), 0)

    def test_no_blocking_work_inside_request_handler(self):
        # The handler must return while inference is still in-flight: submit,
        # then immediately observe "processing" (not completed, not hanging).
        gate = []
        orig = W._run_transcription

        def gated(*a):
            gate.append(True)
            time.sleep(4)
            return dict(FAKE_RESULT)
        W._run_transcription = gated
        t0 = time.time()
        job_id = self._post().json()["jobId"]
        self.assertLess(time.time() - t0, 3.0)
        first = self.client.get(f"/jobs/{job_id}").json()
        self.assertEqual(first["status"], "processing")
        self.assertTrue(gate, "inference thread never started")


if __name__ == "__main__":
    unittest.main()
