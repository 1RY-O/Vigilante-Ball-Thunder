/**
 * Instrument hints accepted by `POST /api/transcriptions` (`instrument` field).
 *
 * A hint is translated into muscriptor instrument group names and passed to
 * the Python worker as `--instruments` (comma-separated). Per muscriptor 0.3.0
 * that argument is a HARD CONSTRAINT: "every instrument not in the list is
 * forbidden from being decoded at all" — so a hint is only sent when it
 * genuinely names the instruments that should be allowed. `auto` (the
 * default), `multi` and `other` therefore send NO constraint at all:
 * `multi` means "several instruments" and `other` means "an instrument we
 * cannot name", and inventing a group list for either would silently forbid
 * the very instruments the recording contains.
 *
 * The group names below are exactly the keys of `MT3_FULL_PLUS_GROUP_NAMES`
 * in the pinned dependency (muscriptor 0.3.0, `muscriptor/tokenizer/mt3.py`);
 * muscriptor raises on any unknown name, so this table is not guesswork.
 */
export const INSTRUMENT_HINTS = [
  'auto',
  'piano',
  'guitar',
  'bass',
  'vocals',
  'drums',
  'multi',
  'other',
] as const;

export type InstrumentHint = (typeof INSTRUMENT_HINTS)[number];

/** Default hint: no constraint (what the API did before hints existed). */
export const DEFAULT_INSTRUMENT_HINT: InstrumentHint = 'auto';

export function isInstrumentHint(value: string): value is InstrumentHint {
  return (INSTRUMENT_HINTS as readonly string[]).includes(value);
}

/**
 * Hint → muscriptor instrument group names (`--instruments` values).
 * An empty list means "no constraint", NOT "empty allowed set".
 */
export const INSTRUMENT_HINT_GROUPS: Readonly<Record<InstrumentHint, readonly string[]>> = {
  auto: [],
  // Piano-family groups as published by the MT3 vocabulary.
  piano: ['acoustic_piano', 'electric_piano'],
  guitar: ['acoustic_guitar', 'clean_electric_guitar', 'distorted_electric_guitar'],
  bass: ['acoustic_bass', 'electric_bass'],
  vocals: ['voice'],
  drums: ['drums'],
  multi: [],
  other: [],
};

/** Groups to send to the worker for a hint (empty array = send no hint). */
export function instrumentGroupsForHint(hint: InstrumentHint): readonly string[] {
  return INSTRUMENT_HINT_GROUPS[hint];
}
