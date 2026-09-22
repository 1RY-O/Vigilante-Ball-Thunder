#!/usr/bin/env node
/**
 * RAM measurement harness for the backend (Render free-tier sizing).
 *
 * Spawns the real server as a child process (node dist/index.js), samples
 * RSS every 250 ms from /proc/<pid>/status (VmRSS = current, VmHWM = peak),
 * walks /proc/<pid>/task/<pid>/children to find spawned python workers and
 * sums their RSS, tracks each child's VmHWM plus the worker's self-reported
 * `[worker-mem]` peak line on server stderr, then drives one real job over
 * HTTP and reports:
 *
 *   idle RSS            (before availability probe)
 *   peak during warm-up (muscriptor: torch import + gated-weight probe)
 *   peak during job     (node RSS + python child RSS, separately)
 *   steady-state        (does the memory come back after the job?)
 *
 * No npm dependencies; Node 22 built-ins only (fetch/FormData/Blob).
 *
 * Usage:
 *   node scripts/measure-ram.mjs --engine stub
 *   node scripts/measure-ram.mjs --engine muscriptor [--warmup-only]
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- CLI ----
const args = process.argv.slice(2);
function argOf(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}
const hasFlag = (name) => args.includes(name);
const ENGINE = argOf('--engine', 'stub');
const PORT = Number(argOf('--port', '4310'));
const WAV_SEC = Number(argOf('--wav-sec', '2'));
const WARMUP_ONLY = hasFlag('--warmup-only');
const UPLOAD_DIR = argOf('--upload-dir', '/tmp/vbt-ram-uploads');
// PHASE 0: sampling interval override; default 250 ms preserves prior behavior.
const SAMPLE_MS = Number(argOf('--sample-ms', '250')) || 250;
// EXPERIMENT KV (reversible): dense-fixture + cap overrides for the KV sweep.
// --audio-file <path> uses a real WAV instead of the synthesized sine.
// --max-gen-len <n> exports MUSCRIPTOR_MAX_GEN_LEN to the server (forwarded
//   to the worker; unset keeps the worker default of 1000). --tag <s> suffixes the
//   result filename so sweep runs don't overwrite each other.
const AUDIO_FILE = argOf('--audio-file', null);
const MAX_GEN_LEN = argOf('--max-gen-len', null);
const TAG = argOf('--tag', '');
// EXPERIMENT KV Phase B (Medium): --model sets MUSCRIPTOR_MODEL for the server.
const MODEL = argOf('--model', null);

// ---- /proc sampling ----
function readStatusField(pid, field) {
  try {
    const txt = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = txt.match(new RegExp(`^${field}:\\s+(\\d+) kB`, 'm'));
    return m ? Number(m[1]) : null; // kB
  } catch {
    return null;
  }
}
function childPids(pid) {
  try {
    const txt = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8');
    return txt.trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}
function descendantPids(pid) {
  // Direct children plus one grandchild level (python workers are direct
  // children today; the extra level only guards against a wrapper fork).
  const out = [];
  for (const c of childPids(pid)) {
    out.push(c);
    for (const g of childPids(c)) out.push(g);
  }
  return [...new Set(out)];
}
function sampleTree(pid) {
  // Node RSS + VmHWM (peak), plus the summed RSS of spawned python children.
  // childHwm is the max VmHWM seen among live children this sample (kernel
  // peak per child, so a short-lived --self-check still leaves its HWM while
  // alive). Retained/extinct-child peaks are tracked by the caller.
  const own = { rss: readStatusField(pid, 'VmRSS'), hwm: readStatusField(pid, 'VmHWM') };
  let childRss = 0;
  let childHwm = 0;
  const children = [];
  for (const c of descendantPids(pid)) {
    const r = readStatusField(c, 'VmRSS');
    const h = readStatusField(c, 'VmHWM');
    if (r !== null) {
      childRss += r;
      children.push({ pid: c, rss: r, hwm: h });
    }
    if (h !== null) childHwm = Math.max(childHwm, h);
  }
  return { ...own, childRss, childHwm, children };
}
// PHASE 0: parse the worker's self-reported stderr peak line:
//   [worker-mem] peakRssKb=123 peakHwmKb=456
function parseWorkerMemPeak(text) {
  const peaks = [];
  const re = /\[worker-mem\]\s+peakRssKb=(\S+)\s+peakHwmKb=(\S+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const rss = m[1] === 'n/a' ? null : Number(m[1]);
    const hwm = m[2] === 'n/a' ? null : Number(m[2]);
    peaks.push({
      rss: Number.isFinite(rss) ? rss : null,
      hwm: Number.isFinite(hwm) ? hwm : null,
    });
  }
  return peaks;
}
// PHASE 1A: parse worker timing + streaming-audit lines forwarded on stderr:
//   [worker-timing] loader=streaming dtype=bfloat16 loadSec=12.34
//   [worker-timing] transcribeSec=5.67
//   [worker] streaming load: audit meta=true target=bfloat16 tensors=.. bad_dtype=.. nonfinite=.. meta_devices=..
function parseWorkerTiming(text) {
  const out = [];
  let m;
  const reLoad = /\[worker-timing\]\s+loader=(\S+)\s+dtype=(\S+)\s+loadSec=([\d.]+)/g;
  while ((m = reLoad.exec(text)) !== null) {
    out.push({ kind: 'load', loader: m[1], dtype: m[2], loadSec: Number(m[3]) });
  }
  const reTrx = /\[worker-timing\]\s+transcribeSec=([\d.]+)/g;
  while ((m = reTrx.exec(text)) !== null) {
    out.push({ kind: 'transcribe', transcribeSec: Number(m[1]) });
  }
  const reAudit = /\[worker\]\s+streaming load:\s+audit\s+(\S[^\n]*)/g;
  while ((m = reAudit.exec(text)) !== null) {
    out.push({ kind: 'audit', audit: m[1].trim().slice(0, 300) });
  }
  // EXPERIMENT 2A: per-chunk token diagnostics.
  const reTok = /\[worker-tokens\]\s+chunk=(\d+)\s+steps=(\d+)\s+eos=(\S+)\s+hitCap=(\S+)\s+batch=(\S+)\s+maxGenLen=(\d+)/g;
  while ((m = reTok.exec(text)) !== null) {
    out.push({ kind: 'tokens', chunk: Number(m[1]), steps: Number(m[2]), eos: m[3], hitCap: m[4], batch: m[5], maxGenLen: Number(m[6]) });
  }
  const reTokSum = /\[worker-tokens-summary\]\s+chunks=(\d+)\s+maxSteps=(\d+)\s+hitCap=(\d+)\s+totalSteps=(\d+)/g;
  while ((m = reTokSum.exec(text)) !== null) {
    out.push({ kind: 'tokens-summary', chunks: Number(m[1]), maxSteps: Number(m[2]), hitCap: Number(m[3]), totalSteps: Number(m[4]) });
  }
  return out;
}

const kb = (v) => (v === null ? 'n/a' : `${(v / 1024).toFixed(1)} MB`);

// EXPERIMENT KV: locate the newest transcription.mid produced by this run.
function findNewestMidi(dir) {
  let best = null;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'transcription.mid') {
        let st;
        try {
          st = fs.statSync(p);
        } catch {
          continue;
        }
        if (!best || st.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: st.mtimeMs };
      }
    }
  };
  walk(dir);
  if (!best) return null;
  const bytes = fs.readFileSync(best.path);
  return {
    path: best.path,
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16),
  };
}

// ---- tiny WAV fixture (real audio: 440 Hz sine, 8 kHz mono 16-bit) ----
function writeWav(p, seconds) {
  const sr = 8000;
  const frames = Math.floor(seconds * sr);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const t = i / sr;
    data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * t) * 0.2 * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(p, Buffer.concat([h, data]));
}

async function main() {
  fs.mkdirSync('/tmp/vbt-ram', { recursive: true });
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const wavPath = '/tmp/vbt-ram/fixture.wav';
  if (AUDIO_FILE) {
    // Dense-fixture mode: byte-copy the operator-supplied WAV (validated).
    const st = fs.statSync(AUDIO_FILE);
    if (!st.isFile() || st.size === 0) throw new Error(`--audio-file is not a readable file: ${AUDIO_FILE}`);
    fs.copyFileSync(AUDIO_FILE, wavPath);
  } else {
    writeWav(wavPath, WAV_SEC);
  }

  const env = {
    ...process.env,
    TRANSCRIPTION_ENGINE: ENGINE,
    UPLOAD_DIR,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    // measurement budgets (torch import is slow on a loaded machine)
    MUSCRIPTOR_SELFCHECK_TIMEOUT_MS: '600000',
    WORKER_TIMEOUT_MS: '1800000',
  };
  if (MAX_GEN_LEN !== null) env.MUSCRIPTOR_MAX_GEN_LEN = String(MAX_GEN_LEN);
  if (MODEL !== null) env.MUSCRIPTOR_MODEL = String(MODEL);
  const server = spawn('node', ['dist/index.js'], { cwd: BACKEND, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const errTail = [];
  // PHASE 0: full stderr buffer for [worker-mem] parsing (tail kept for log).
  let errAll = '';
  const workerSelfPeaks = [];
  const workerTimings = [];
  server.stderr.on('data', (d) => {
    const t = String(d);
    errTail.push(t); if (errTail.length > 40) errTail.shift();
    errAll += t;
    if (errAll.length > 1_000_000) errAll = errAll.slice(-500_000);
    for (const p of parseWorkerMemPeak(t)) workerSelfPeaks.push(p);
    for (const q of parseWorkerTiming(t)) workerTimings.push(q);
  });
  server.stdout.on('data', () => {});

  const samples = [];
  let peakNode = 0, peakChild = 0, peakTotal = 0, peakWarmupNode = 0;
  // PHASE 0 (additive): child HWM + retained-after-exit peaks. Existing
  // peakNode/peakChild/peakTotal computations are unchanged.
  let peakChildHwm = 0, peakChildRetained = 0, peakTotalWithHwm = 0;
  const childPeakByPid = new Map();
  let jobWindow = false;
  const sampler = setInterval(() => {
    const s = sampleTree(server.pid);
    if (s.rss === null) return;
    samples.push({ t: Date.now(), ...s });
    peakNode = Math.max(peakNode, s.rss);
    peakChild = Math.max(peakChild, s.childRss);
    peakTotal = Math.max(peakTotal, s.rss + s.childRss);
    if (!jobWindow) peakWarmupNode = Math.max(peakWarmupNode, s.rss);
    for (const c of s.children) {
      childPeakByPid.set(c.pid, Math.max(childPeakByPid.get(c.pid) ?? 0, c.rss));
    }
    for (const v of childPeakByPid.values()) peakChildRetained = Math.max(peakChildRetained, v);
    peakChildHwm = Math.max(peakChildHwm, s.childHwm);
    peakTotalWithHwm = Math.max(peakTotalWithHwm, s.rss + s.childHwm);
  }, SAMPLE_MS);

  const base = `http://127.0.0.1:${PORT}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const report = { engine: ENGINE, wavSec: WAV_SEC };

  try {
    // ---- idle (server up, before first availability probe completes) ----
    await sleep(1200);
    const idle = sampleTree(server.pid);
    report.idleNodeRssKb = idle.rss;

    // ---- wait for the engine's availability probe (this IS the warm-up) ----
    let caps = null;
    const warmDeadline = Date.now() + (ENGINE === 'muscriptor' ? 600_000 : 30_000);
    while (Date.now() < warmDeadline) {
      try {
        const res = await fetch(`${base}/api/capabilities`);
        caps = await res.json();
        if (caps?.engine?.checking === false) break;
      } catch { /* not listening yet */ }
      await sleep(1000);
    }
    report.capabilities = caps ? {
      mock: caps.engine?.mock, available: caps.engine?.available,
      code: caps.engine?.code, checking: caps.engine?.checking,
    } : 'unreachable';
    const afterWarm = sampleTree(server.pid);
    report.postWarmupNodeRssKb = afterWarm.rss;
    report.peakDuringWarmupNodeRssKb = peakWarmupNode;

    if (!WARMUP_ONLY && caps?.engine) {
      // ---- drive one real job ----
      jobWindow = true;
      const fd = new FormData();
      fd.append('file', new Blob([fs.readFileSync(wavPath)], { type: 'audio/wav' }), 'fixture.wav');
      const started = Date.now();
      const post = await fetch(`${base}/api/transcriptions`, { method: 'POST', body: fd });
      const created = await post.json().catch(() => ({}));
      report.postStatus = post.status;
      if (post.status === 202 && created.id) {
        const jobDeadline = Date.now() + 1_500_000;
        for (;;) {
          const r = await fetch(`${base}/api/transcriptions/${created.id}`);
          const j = await r.json().catch(() => ({}));
          if (j.status === 'complete' || j.status === 'error') {
            report.jobStatus = j.status;
            if (j.status === 'error') report.jobError = j.error?.code;
            break;
          }
          if (Date.now() > jobDeadline) { report.jobStatus = 'timeout'; break; }
          await sleep(1500);
        }
        report.jobWallMs = Date.now() - started;
        // EXPERIMENT KV: hash the newest transcription.mid under UPLOAD_DIR
        // so sweep runs can compare MIDI equivalence across caps. Also stash
        // a per-tag copy for note-level comparison (Phase B).
        try {
          report.midiArtifact = findNewestMidi(UPLOAD_DIR);
          if (report.midiArtifact && TAG) {
            const dest = `/tmp/vbt-ram/midi-${TAG}.mid`;
            fs.copyFileSync(report.midiArtifact.path, dest);
            report.midiArtifact.savedAs = dest;
          }
        } catch {
          report.midiArtifact = null;
        }
        // ---- steady state: sample 12 s after the job settles ----
        await sleep(12_000);
        const steady = sampleTree(server.pid);
        report.steadyNodeRssKb = steady.rss;
        report.steadyChildRssKb = steady.childRss;
        report.nodeHwmKb = steady.hwm;
      } else {
        report.postBody = created;
      }
      jobWindow = false;
    }

    report.peakNodeRssKb = peakNode;
    report.peakChildRssKb = peakChild;
    report.peakTotalKb = peakTotal;
    // PHASE 0 (additive, existing fields above untouched):
    report.peakChildHwmKb = peakChildHwm;
    report.peakChildRetainedKb = peakChildRetained;
    report.peakTotalWithChildHwmKb = peakTotalWithHwm;
    const selfRss = workerSelfPeaks.map((p) => p.rss).filter((v) => v !== null);
    const selfHwm = workerSelfPeaks.map((p) => p.hwm).filter((v) => v !== null);
    report.workerSelfPeakCount = workerSelfPeaks.length;
    report.workerSelfPeakRssKb = selfRss.length ? Math.max(...selfRss) : null;
    report.workerSelfPeakHwmKb = selfHwm.length ? Math.max(...selfHwm) : null;
    // PHASE 1A (additive): timing + audit lines forwarded on server stderr.
    report.workerTimings = workerTimings;
    report.loaderEnv = env.MUSCRIPTOR_LOADER ?? null;
    report.dtypeEnv = env.MUSCRIPTOR_DTYPE ?? null;
    // EXPERIMENT KV (additive): cap + fixture identity for the sweep table.
    report.maxGenLen = env.MUSCRIPTOR_MAX_GEN_LEN ?? '1000 (worker default)';
    report.model = env.MUSCRIPTOR_MODEL ?? 'small';
    report.audioFile = AUDIO_FILE ?? `synth-sine-${WAV_SEC}s`;
  } catch (e) {
    report.error = String(e);
  } finally {
    clearInterval(sampler);
    server.kill('SIGTERM');
    await sleep(500);
    server.kill('SIGKILL');
  }

  console.log('\n===== MEASUREMENT =====');
  console.log(JSON.stringify(report, null, 2));
  console.log('----- human summary -----');
  console.log(`idle node RSS:            ${kb(report.idleNodeRssKb)}`);
  console.log(`peak during warm-up node: ${kb(report.peakDuringWarmupNodeRssKb)}`);
  console.log(`post-warmup node RSS:     ${kb(report.postWarmupNodeRssKb)}`);
  console.log(`peak node RSS (overall):  ${kb(report.peakNodeRssKb)}`);
  console.log(`peak python child RSS:    ${kb(report.peakChildRssKb)}`);
  console.log(`peak total (node+py):     ${kb(report.peakTotalKb)}`);
  console.log(`peak python child HWM:    ${kb(report.peakChildHwmKb)}`);
  console.log(`peak child retained:      ${kb(report.peakChildRetainedKb)}`);
  console.log(`peak total w/ child HWM:  ${kb(report.peakTotalWithChildHwmKb)}`);
  console.log(`worker self peak RSS:     ${kb(report.workerSelfPeakRssKb)} (${report.workerSelfPeakCount ?? 0} report(s))`);
  console.log(`worker self peak HWM:     ${kb(report.workerSelfPeakHwmKb)}`);
  for (const t of (report.workerTimings ?? []).filter((e) => e.kind === 'tokens' || e.kind === 'tokens-summary')) {
    console.log(`worker tokens:              ${JSON.stringify(t)}`);
  }
  console.log(`steady node RSS:          ${kb(report.steadyNodeRssKb)}`);
  if (report.midiArtifact) {
    console.log(`midi artifact:            ${report.midiArtifact.bytes} bytes sha=${report.midiArtifact.sha256}`);
  } else {
    console.log('midi artifact:            none (job produced no MIDI)');
  }
  if (errTail.length) {
    console.log('server stderr tail:', errTail.join('').slice(-1200));
  }
  const suffix = `${ENGINE}${WARMUP_ONLY ? '-warmup' : ''}${TAG ? `-${TAG}` : ''}`;
  fs.writeFileSync(`/tmp/vbt-ram/result-${suffix}.json`, JSON.stringify(report, null, 2));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

