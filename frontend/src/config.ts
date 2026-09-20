/**
 * Frontend feature flags.
 */

/**
 * Timemap-driven note highlighting: notes light up in the score as the audio
 * plays.
 *
 * OFF by default, deliberately. Highlighting is only honest when the audio
 * being played shares a timebase with the notation. Playback currently plays
 * the user's ORIGINAL recording (the backend never sets `audioUrl`), while
 * Verovio's timemap follows the SCORE's own tempo — so driving highlights from
 * `audio.currentTime` would light up the wrong notes, faking an alignment that
 * does not exist. This project does not ship fabricated results.
 *
 * Flip this to `true` only once playback is driven by audio derived from the
 * same rendition as the score (e.g. the backend supplies an aligned `audioUrl`
 * or a real timemap). No other code changes are needed: the pipeline below is
 * complete and tested, it simply stays dormant while this is false.
 *
 * While false:
 *   - no time source is attached to the audio element,
 *   - the timemap is never sampled (no getElementsAtTime calls),
 *   - no `.playing` class is ever applied to the rendered score,
 *   - the UI keeps saying "No note-following data available", which is true.
 */
export const ENABLE_NOTE_HIGHLIGHTING = false

/**
 * Score-aligned playback generation (POST /api/artifacts/:id/playback).
 *
 * OFF: the backend does not implement this endpoint yet (see
 * BACKEND_CONTRACT.md "Not implemented" and BACKEND_REQUESTS.md), so the
 * "Generate playback" control is hidden — showing it would imply a feature
 * that cannot actually produce a score-aligned audioUrl.
 *
 * Flip this to `true` only once the backend accepts the playback request and
 * returns an audioUrl whose timebase IS the score's. That is the ONLY
 * condition under which note-following highlighting is honest for generated
 * playback (see the ENABLE_NOTE_HIGHLIGHTING note above); while this flag is
 * false, playback uses the user's ORIGINAL recording and highlights stay off.
 */
export const PLAYBACK_GENERATION_ENABLED = false