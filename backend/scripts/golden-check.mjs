#!/usr/bin/env node
/**
 * Golden-set cap validation runner.
 *
 * For each clip in test/fixtures/golden-manifest.json x model x
 * {2000 control, 1000 candidate}: runs measure-ram.mjs and asserts the
 * acceptance bar — candidate MIDI byte-identical to control, hitCap == 0
 * on both, sane chunk counts. Prints a PASS/FAIL table; with --record,
 * writes control/candidate entries back into the manifest baselines.
 *
 * Usage:
 *   MUSCRIPTOR_LOADER=streaming MUSCRIPTOR_DTYPE=bfloat16 \
 *     node scripts/golden-check.mjs --model small [--clips segA-dense-15s,...] [--record]
 *
 * Exit 0 = all clips PASS. Result JSONs: /tmp/vbt-ram/result-muscriptor-golden-<clip>-<cap>.json
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MANIFEST_PATH = path.join(ROOT, 'test/fixtures/golden-manifest.json');
const args = process.argv.slice(2);
function argOf(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}
const hasFlag = (n) => args.includes(n);
const MODEL = argOf('--model', 'small');
const CLIPS = argOf('--clips', null)?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
const RECORD = hasFlag('--record');
const PORT = argOf('--port', '4310');
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
const clips = CLIPS ?? Object.keys(manifest.clips);

function run(clip, cap) {
  const audio = path.join(ROOT, 'test/fixtures', manifest.clips[clip].file);
  const tag = `golden-${MODEL}-${clip}-${cap}`;
  const r = spawnSync(
    'node',
    ['scripts/measure-ram.mjs', '--engine', 'muscriptor', '--audio-file', audio,
     '--max-gen-len', String(cap), '--tag', tag, '--port', PORT, '--model', MODEL],
    { cwd: ROOT, stdio: 'inherit', env: { ...process.env,
      MUSCRIPTOR_LOADER: process.env.MUSCRIPTOR_LOADER ?? 'streaming',
      MUSCRIPTOR_DTYPE: process.env.MUSCRIPTOR_DTYPE ?? 'bfloat16' } },
  );
  if (r.status !== 0) console.error(`[golden] ${clip} cap=${cap} harness exited ${r.status}`);
  return JSON.parse(fs.readFileSync(`/tmp/vbt-ram/result-muscriptor-${tag}.json`, 'utf8'));
}

const mb = (v) => (v == null ? 'n/a' : `${(v / 1024).toFixed(0)}MB`);
let pass = 0, fail = 0;
const failures = [];
for (const clip of clips) {
  const ctrl = run(clip, 2000);
  const cand = run(clip, 1000);
  const sum = (d) => (d.workerTimings ?? []).find((t) => t.kind === 'tokens-summary');
  const s0 = sum(ctrl), s1 = sum(cand);
  const m0 = ctrl.midiArtifact, m1 = cand.midiArtifact;
  const checks = {
    jobOk: ctrl.jobStatus === 'complete' && cand.jobStatus === 'complete',
    midiEqual: !!m0 && !!m1 && m0.sha256 === m1.sha256 && m0.bytes === m1.bytes,
    noCapHit: (s0?.hitCap ?? -1) === 0 && (s1?.hitCap ?? -1) === 0,
    chunksSane: (s0?.chunks ?? 0) > 0 && s0.chunks === s1.chunks,
  };
  const ok = Object.values(checks).every(Boolean);
  ok ? pass++ : fail++;
  if (!ok) failures.push(clip);
  const trx = (d) => { const t = (d.workerTimings ?? []).find((t) => t.kind === 'transcribe'); return t?.transcribeSec ?? '?'; };
  console.log(`${ok ? 'PASS' : 'FAIL'} ${clip} [${manifest.clips[clip].category}] ` +
    `ctrl midi=${m0 ? `${m0.bytes}B ${m0.sha256}` : 'none'} maxSteps=${s0?.maxSteps ?? '?'} hitCap=${s0?.hitCap ?? '?'} | ` +
    `cand midi=${m1 ? `${m1.bytes}B ${m1.sha256}` : 'none'} maxSteps=${s1?.maxSteps ?? '?'} hitCap=${s1?.hitCap ?? '?'} | ` +
    `pyHWM ${mb(ctrl.workerSelfPeakHwmKb)}->${mb(cand.workerSelfPeakHwmKb)} trx ${trx(ctrl)}s->${trx(cand)}s ` +
    `${ok ? '' : JSON.stringify(checks)}`);
  if (RECORD) {
    manifest.baselines[MODEL] ??= {};
    manifest.baselines[MODEL][clip] = {
      cap2000: m0 ? { midi: m0.sha256, bytes: m0.bytes, maxSteps: s0?.maxSteps ?? null } : null,
      cap1000: m1 ? { midi: m1.sha256, bytes: m1.bytes, maxSteps: s1?.maxSteps ?? null } : null,
    };
  }
}
if (RECORD) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  console.log('[golden] manifest baselines updated');
}
console.log(`\nGOLDEN ${MODEL}: ${pass} pass, ${fail} fail${failures.length ? ` (${failures.join(', ')})` : ''}`);
process.exit(fail ? 1 : 0);
