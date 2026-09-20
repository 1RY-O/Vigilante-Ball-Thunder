/**
 * Transcription-policy options offered in the upload UI. Values are the
 * stable string codes the backend validates; labels are the user-facing copy.
 * The codes mirror the backend's own enums (instrumentHints.ts / sheetTypes.ts).
 */

export const INSTRUMENT_OPTIONS = [
  { value: 'auto', label: 'Auto-detect', hint: 'Let the engine try without hints.' },
  { value: 'piano', label: 'Piano / keyboard' },
  { value: 'guitar', label: 'Guitar' },
  { value: 'bass', label: 'Bass' },
  { value: 'vocals', label: 'Vocals / lead melody' },
  { value: 'drums', label: 'Drums (rhythm-only)' },
  { value: 'multi', label: 'Multi-instrument (full mix)' },
  { value: 'other', label: 'Other' },
] as const
export type InstrumentValue = (typeof INSTRUMENT_OPTIONS)[number]['value']
export const INSTRUMENT_OTHER: InstrumentValue = 'other'
export const DEFAULT_INSTRUMENT: InstrumentValue = 'auto'

export const SHEET_TYPE_OPTIONS = [
  { value: 'melody-chords', label: 'Melody + chords' },
  { value: 'piano-grand', label: 'Piano (grand staff)' },
  { value: 'lead-sheet', label: 'Lead sheet (melody + chord symbols)' },
] as const
export type SheetTypeValue = (typeof SHEET_TYPE_OPTIONS)[number]['value']
export const DEFAULT_SHEET_TYPE: SheetTypeValue = 'melody-chords'

/**
 * The backend may not be able to produce a requested layout (the engine
 * declares only what it genuinely can). Until a deployed engine serves more
 * than `melody-chords`, the selector stays disabled with a "Coming soon" note
 * instead of pretending a choice affects the output.
 */
export const SHEET_TYPE_SUPPORTED = false