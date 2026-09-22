#!/usr/bin/env node
/**
 * EXPERIMENT KV (reversible): max_gen_len sweep driver (Phase A).
 *
 * Runs measure-ram.mjs sequentially for each cap with streaming BF16 Small
 * and prints a comparison table. Each run writes its own
 * /tmp/vbt-ram/result-muscriptor-kv-<cap>.json; this script only aggregates.
 *
 * Usage:
 *   MUSCRIPTOR_LOADER=streaming MUSCRIPTOR_DTYPE=bfloat16 \
 *     node scripts/kv-sweep.mjs --audio-file /tmp/vbt-ram/dense-15s.wav [--caps 2000,1000,750,500]
 *
 * Revert: delete this file (measure-ram.mjs works unchanged without it).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
function argOf(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}
const CAPS = argOf('--caps', '2000,1000,750,500').split(',').map((s) => s.trim()).filter(Boolean);
// Phase B: comma-separated list (or single path via --audio-file).
const AUDIO_FILES = argOf('--audio-files', argOf('--audio-file', '/tmp/vbt-ram/dense-15s.wav'))
  .split(',').map((s) => s.trim()).filter(Boolean);
const PORT = argOf('--port', '4310');
const MODEL = argOf('--model', 'small');
// Thread sweep: comma-separated list; 'default' means no --threads flag.
const THREADS_LIST = argOf('--threads-list', 'default').split(',').map((s) => s.trim()).filter(Boolean);
const segTag = (p) => path.basename(p, path.extname(p)).replace(/[^A-Za-z0-9]+/g, '-');

for (const audioFile of AUDIO_FILES) {
for (const cap of CAPS) {
for (const th of THREADS_LIST) {
  const tag = `kv-${MODEL}-${segTag(audioFile)}-${cap}-t${th}`;
  console.log(`\n===== sweep model=${MODEL} seg=${audioFile} cap=${cap} threads=${th} =====`);
  const hargs = ['scripts/measure-ram.mjs', '--engine', 'muscriptor',
     '--audio-file', audioFile, '--max-gen-len', cap, '--tag', tag,
     '--port', PORT, '--model', MODEL];
  if (th !== 'default') hargs.push('--threads', th);
  const r = spawnSync('node', hargs,
    {
      cwd: path.resolve(HERE, '..'),
      stdio: 'inherit',
      env: {
        ...process.env,
        MUSCRIPTOR_LOADER: process.env.MUSCRIPTOR_LOADER ?? 'streaming',
        MUSCRIPTOR_DTYPE: process.env.MUSCRIPTOR_DTYPE ?? 'bfloat16',
      },
    },
  );
  if (r.status !== 0) console.error(`[kv-sweep] seg=${audioFile} cap=${cap} threads=${th} harness exited ${r.status}`);
}
}
}

console.log('\n===== SWEEP SUMMARY =====');
const rows = [];
for (const audioFile of AUDIO_FILES) {
for (const cap of CAPS) {
for (const th of THREADS_LIST) {
  const tag = `kv-${MODEL}-${segTag(audioFile)}-${cap}-t${th}`;
  const p = `/tmp/vbt-ram/result-muscriptor-${tag}.json`;
  let d;
  try {
    d = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    console.log(`seg=${segTag(audioFile)} cap=${cap} threads=${th}: MISSING ${p}`);
    continue;
  }
  const toks = (d.workerTimings ?? []).filter((t) => t.kind === 'tokens');
  const sum = (d.workerTimings ?? []).find((t) => t.kind === 'tokens-summary');
  const load = (d.workerTimings ?? []).find((t) => t.kind === 'load');
  const trx = (d.workerTimings ?? []).find((t) => t.kind === 'transcribe');
  const phases = (d.workerPhases ?? []).filter((e) => !e.gc).map((e) => `${e.phase}=${e.rssKb == null ? 'n/a' : Math.round(e.rssKb / 1024)}MB`).join(' ');
  rows.push({ cap, d, toks, sum, load, trx });
  const mb = (v) => (v == null ? 'n/a' : `${(v / 1024).toFixed(0)}MB`);
  console.log(
    `seg=${segTag(audioFile)} cap=${cap} threads=${th} job=${d.jobStatus} pyHWM=${mb(d.workerSelfPeakHwmKb)} ` +
    `total=${mb(d.peakTotalKb)} ` +
    `load=${load?.loadSec ?? '?'}s trx=${trx?.transcribeSec ?? '?'}s wall=${(d.jobWallMs / 1000).toFixed(1)}s ` +
    `chunks=${sum?.chunks ?? '?'} maxSteps=${sum?.maxSteps ?? '?'} hitCap=${sum?.hitCap ?? '?'} ` +
    `midi=${d.midiArtifact ? `${d.midiArtifact.bytes}B sha=${d.midiArtifact.sha256}` : 'none'}`,
  );
  if (phases) console.log(`    phases: ${phases}`);
  for (const t of toks) {
    console.log(`    chunk=${t.chunk} steps=${t.steps} eos=${t.eos} hitCap=${t.hitCap} maxGenLen=${t.maxGenLen}`);
  }
}
}
}
