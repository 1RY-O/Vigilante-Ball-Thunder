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
const segTag = (p) => path.basename(p, path.extname(p)).replace(/[^A-Za-z0-9]+/g, '-');

for (const audioFile of AUDIO_FILES) {
for (const cap of CAPS) {
  const tag = `kv-${MODEL}-${segTag(audioFile)}-${cap}`;
  console.log(`\n===== sweep model=${MODEL} seg=${audioFile} cap=${cap} =====`);
  const r = spawnSync(
    'node',
    ['scripts/measure-ram.mjs', '--engine', 'muscriptor',
     '--audio-file', audioFile, '--max-gen-len', cap, '--tag', tag,
     '--port', PORT, '--model', MODEL],
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
  if (r.status !== 0) console.error(`[kv-sweep] seg=${audioFile} cap=${cap} harness exited ${r.status}`);
}
}

console.log('\n===== SWEEP SUMMARY =====');
const rows = [];
for (const audioFile of AUDIO_FILES) {
for (const cap of CAPS) {
  const tag = `kv-${MODEL}-${segTag(audioFile)}-${cap}`;
  const p = `/tmp/vbt-ram/result-muscriptor-${tag}.json`;
  let d;
  try {
    d = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    console.log(`seg=${segTag(audioFile)} cap=${cap}: MISSING ${p}`);
    continue;
  }
  const toks = (d.workerTimings ?? []).filter((t) => t.kind === 'tokens');
  const sum = (d.workerTimings ?? []).find((t) => t.kind === 'tokens-summary');
  const load = (d.workerTimings ?? []).find((t) => t.kind === 'load');
  const trx = (d.workerTimings ?? []).find((t) => t.kind === 'transcribe');
  rows.push({ cap, d, toks, sum, load, trx });
  const mb = (v) => (v == null ? 'n/a' : `${(v / 1024).toFixed(0)}MB`);
  console.log(
    `seg=${segTag(audioFile)} cap=${cap} job=${d.jobStatus} pyHWM=${mb(d.workerSelfPeakHwmKb)} ` +
    `total=${mb(d.peakTotalKb)} ` +
    `load=${load?.loadSec ?? '?'}s trx=${trx?.transcribeSec ?? '?'}s wall=${(d.jobWallMs / 1000).toFixed(1)}s ` +
    `chunks=${sum?.chunks ?? '?'} maxSteps=${sum?.maxSteps ?? '?'} hitCap=${sum?.hitCap ?? '?'} ` +
    `midi=${d.midiArtifact ? `${d.midiArtifact.bytes}B sha=${d.midiArtifact.sha256}` : 'none'}`,
  );
  for (const t of toks) {
    console.log(`    chunk=${t.chunk} steps=${t.steps} eos=${t.eos} hitCap=${t.hitCap} maxGenLen=${t.maxGenLen}`);
  }
}
}
