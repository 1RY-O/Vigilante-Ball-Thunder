/**
 * Sheet types (notation layouts) that a transcription can be requested in.
 *
 * `melody-chords` is the original pipeline output: one part exactly as the
 * MIDI decodes (chords preserved, no re-arrangement). The two richer layouts
 * are produced by music21 post-processing of the REAL transcription MIDI —
 * `piano-grand` splits the decoded voices across a two-staff piano part
 * (treble + bass), `lead-sheet` reduces to a melody line plus chord symbols
 * derived from the decoded vertical sonorities. Nothing is invented: when
 * music21 cannot identify a sonority, that chord position simply carries no
 * symbol.
 *
 * Engines declare what they can genuinely produce
 * (`TranscriptionEngine.supportedSheetTypes`). Requesting a layout the engine
 * cannot produce is refused honestly with HTTP 501 and code
 * `sheet-type-unsupported` — never silently downgraded to another layout.
 */
export const SHEET_TYPES = ['melody-chords', 'piano-grand', 'lead-sheet'] as const;

export type SheetType = (typeof SHEET_TYPES)[number];

/** The layout used when the request does not ask for anything else. */
export const DEFAULT_SHEET_TYPE: SheetType = 'melody-chords';

export function isSheetType(value: string): value is SheetType {
  return (SHEET_TYPES as readonly string[]).includes(value);
}
