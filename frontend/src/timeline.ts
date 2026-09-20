/** One stretch of time during which a single note is sounding. */
export interface NoteSpan { id: string; startMs: number; endMs: number }

/**
 * The note sounding at `timeMs`, or null during a gap/rest. Spans are ordered
 * and contiguous, so this is a binary search for the last span that started.
 *
 * Lives in its own module (no engraving dependencies) so callers that only
 * need the lookup never pull the ScoreViewer chunk into the initial bundle.
 */
export function activeNoteAt(spans: readonly NoteSpan[], timeMs: number): string | null {
  let low = 0
  let high = spans.length - 1
  let found = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    const span = spans[mid]!
    if (span.startMs <= timeMs) { found = mid; low = mid + 1 } else high = mid - 1
  }
  const span = found >= 0 ? spans[found] : undefined
  return span && timeMs < span.endMs ? span.id : null
}
