import os, subprocess, tempfile, base64, json, sys
from pathlib import Path
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
import uvicorn

app = FastAPI()

ROOT_DIR = Path(__file__).resolve().parent
PYTHON_BIN = sys.executable  # Uses the exact python running this worker
WORKER_SCRIPT = ROOT_DIR / "backend" / "python" / "transcribe_worker.py"

@app.get("/health")
def health():
    return {"status": "ok", "worker": "fedora-local"}

@app.post("/transcribe")
async def transcribe(
    audio: UploadFile = File(...),
    model: str = Form("small"),
    sheetType: str = Form("melody-chords"),
    instruments: str = Form(None)
):
    with tempfile.TemporaryDirectory() as tmpdir:
        input_path = os.path.join(tmpdir, "input.wav")
        out_dir = os.path.join(tmpdir, "output")
        os.makedirs(out_dir, exist_ok=True)

        with open(input_path, "wb") as f:
            f.write(await audio.read())

        cmd = [
            str(PYTHON_BIN), str(WORKER_SCRIPT),
            "--audio", input_path,
            "--out", out_dir,
            "--model", model,
            "--sheet-type", sheetType,
            "--loader", "streaming",
            "--dtype", "bfloat16"
        ]
        if instruments and instruments not in ("undefined", "null", ""):
            cmd.extend(["--instruments", instruments])

        print(f"[*] Running command: {' '.join(cmd)}")
        res = subprocess.run(cmd, capture_output=True, text=True)

        # Print full output to your VS Code terminal so you can monitor it live
        if res.stdout:
            print("[worker stdout]:", res.stdout)
        if res.stderr:
            print("[worker stderr]:", res.stderr)

        if res.returncode != 0:
            error_msg = res.stderr.strip() or res.stdout.strip() or "Worker process failed without output."
            raise HTTPException(status_code=500, detail=error_msg)

        midi_path = os.path.join(out_dir, "transcription.mid")
        xml_path = os.path.join(out_dir, "transcription.musicxml")
        res_json_path = os.path.join(out_dir, "result.json")

        if not os.path.exists(midi_path) or not os.path.exists(xml_path):
            raise HTTPException(
                status_code=500,
                detail=f"Artifacts missing in {out_dir}. Stderr: {res.stderr}"
            )

        with open(midi_path, "rb") as f:
            midi_b64 = base64.b64encode(f.read()).decode("ascii")
        with open(xml_path, "r", encoding="utf-8") as f:
            xml_str = f.read()

        meta = {}
        if os.path.exists(res_json_path):
            with open(res_json_path, "r", encoding="utf-8") as f:
                meta = json.load(f)

        return {
            "midiBase64": midi_b64,
            "musicXml": xml_str,
            "metadata": meta
        }

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)