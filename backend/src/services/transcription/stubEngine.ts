import fs from 'node:fs/promises';
import path from 'node:path';

import { CancelledError, MIDI_FILENAME, MUSICXML_FILENAME } from './engine.js';
import type {
  EngineAvailability,
  EngineResult,
  ProgressReporter,
  TranscribeRequest,
  TranscriptionEngine,
} from './engine.js';
import type { SheetType } from './sheetTypes.js';

/**
 * ⚠️  MOCK ENGINE — TEST/DEVELOPMENT ONLY, NEVER REAL TRANSCRIPTION  ⚠️
 *
 * Produces a fixed, synthetic MIDI + MusicXML fixture WITHOUT running any
 * model, so the API/job-manager/download stack can be exercised without the
 * MuScriptor weights. It is selected ONLY via TRANSCRIPTION_ENGINE=stub,
 * announces itself as mock in GET /api/capabilities (engine.mock === true),
 * is loudly labeled in server logs at startup, and must never be used to
 * claim a real transcription happened.
 */

/**
 * Fixed synthetic two-measure melody (G4, F4, rest, A4~tied, B4, rest).
 * Fixture data ONLY — NOT derived from audio. Mirrors the musical features
 * (rests, tie, tempo marking) the browser suite asserts on.
 */
const STUB_SEQUENCE = [
  { pitch: 67, ticks: 480 }, // G4 quarter
  { pitch: 65, ticks: 240 }, // F4 eighth
  { pitch: null, ticks: 240 }, // rest (eighth)
  { pitch: 69, ticks: 960 }, // A4 half (tied in the MusicXML fixture)
  { pitch: 71, ticks: 480 }, // B4 quarter
  { pitch: null, ticks: 480 }, // rest (quarter)
] as const;

export class StubEngine implements TranscriptionEngine {
  readonly name = 'stub';
  readonly isMock = true;
  /**
   * Honest capability declaration: the MOCK writes one fixed fixture and runs
   * no music21, so it can only serve the default layout. A request for a
   * richer layout on this engine is refused with 501 (`sheet-type-unsupported`)
   * rather than being answered with a fixture that pretends to be a grand
   * staff or a lead sheet.
   */
  readonly supportedSheetTypes: readonly SheetType[] = ['melody-chords'];

  async available(): Promise<EngineAvailability> {
    // The MOCK has no subprocess and no cache: it is always "available", and
    // every result it produces is labeled synthetic fixture data.
    return {
      ok: true,
      code: 'stub-mock',
      reason: 'MOCK engine: synthetic fixture results, not real transcription.',
    };
  }

  async transcribe(req: TranscribeRequest, onProgress: ProgressReporter): Promise<EngineResult> {
    await fs.mkdir(req.outDir, { recursive: true });
    onProgress('transcribing', 50);
    throwIfAborted(req.signal);
    const midiPath = path.join(req.outDir, MIDI_FILENAME);
    const musicXmlPath = path.join(req.outDir, MUSICXML_FILENAME);
    await fs.writeFile(midiPath, buildStubMidi());
    await fs.writeFile(musicXmlPath, buildStubMusicXml());
    onProgress('done', 100);
    return {
      midiPath,
      musicXmlPath,
      durationSec: 4.0,
      model: `stub-fixture (${req.model} requested; ignored by mock)`,
      // Provenance is the mock's own label: no reader may mistake this for a
      // real transcription, and no analysis is claimed (music21 never ran).
      engineUsed: 'stub (MOCK fixture — synthetic data, not a real transcription)',
      detectedInstruments: null,
    };
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new CancelledError();
}

// ---- Fixture writers (synthetic; only used by this mock engine) ----

function buildStubMidi(): Buffer {
  const header = Buffer.concat([
    Buffer.from('MThd'),
    u32(6),
    u16(1), // format 1
    u16(2), // 2 tracks
    u16(480), // 480 ticks/quarter
  ]);
  const t0 = Buffer.concat([
    Buffer.from('MTrk'),
    u32(0),
    varlen(0), meta(0x51, Buffer.from([0x07, 0xa1, 0x20])), // 120 bpm
    varlen(0), meta(0x58, Buffer.from([0x04, 0x02, 0x18, 0x08])), // 4/4
    varlen(0), meta(0x2f, Buffer.alloc(0)),
  ]);
  patchTrackLength(t0);
  const parts: Buffer[] = [Buffer.from('MTrk'), u32(0)];
  for (const item of STUB_SEQUENCE) {
    if (item.pitch === null) continue; // rest: no note events
    parts.push(varlen(0), event(0x90, item.pitch, 96));
    parts.push(varlen(item.ticks), event(0x80, item.pitch, 0));
  }
  parts.push(varlen(0), meta(0x2f, Buffer.alloc(0)));
  const t1 = Buffer.concat(parts);
  patchTrackLength(t1);
  return Buffer.concat([header, t0, t1]);
}

function buildStubMusicXml(): string {
  // Synthetic two-measure fixture with rest + tie + tempo marking, so the
  // engraving assertions of the browser suite apply to the MOCK path too.
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<score-partwise version="4.0">\n` +
    `  <work><work-title>Stub fixture (MOCK — not a real transcription)</work-title></work>\n` +
    `  <part-list><score-part id="P1"><part-name>Stub fixture (MOCK)</part-name></score-part></part-list>\n` +
    `  <part id="P1">\n` +
    `    <measure number="1">\n` +
    `      <attributes><divisions>2</divisions><key><fifths>1</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>\n` +
    `      <direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>96</per-minute></metronome></direction-type><sound tempo="96"/></direction>\n` +
    `      <note><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type><stem>up</stem></note>\n` +
    `      <note><pitch><step>F</step><alter>0</alter><octave>4</octave></pitch><duration>1</duration><type>eighth</type><accidental>natural</accidental><stem>up</stem></note>\n` +
    `      <note><rest/><duration>1</duration><type>eighth</type></note>\n` +
    `      <note><pitch><step>A</step><octave>4</octave></pitch><duration>4</duration><tie type="start"/><type>half</type><notations><tied type="start"/></notations></note>\n` +
    `    </measure>\n` +
    `    <measure number="2">\n` +
    `      <note><pitch><step>A</step><octave>4</octave></pitch><duration>4</duration><tie type="stop"/><type>half</type><notations><tied type="stop"/></notations></note>\n` +
    `      <note><pitch><step>B</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type></note>\n` +
    `      <note><rest/><duration>2</duration><type>quarter</type></note>\n` +
    `      <barline location="right"><bar-style>light-heavy</bar-style></barline>\n` +
    `    </measure>\n` +
    `  </part>\n` +
    `</score-partwise>\n`
  );
}

// ---- tiny MIDI byte helpers ----
function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n, 0);
  return b;
}
function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}
function varlen(v: number): Buffer {
  const bytes = [v & 0x7f];
  v >>= 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return Buffer.from(bytes);
}
function event(status: number, data: number, data2: number): Buffer {
  return Buffer.from([status, data, data2]);
}
function meta(type: number, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0xff, type]), varlen(data.length), data]);
}
function patchTrackLength(track: Buffer): void {
  track.writeUInt32BE(track.length - 8, 4);
}
