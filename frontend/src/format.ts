/**
 * Human formatting for values the frontend measures itself (file bytes, the
 * client-side duration probe, elapsed transcription time). Used only where
 * the number is real data, never to dress up invented metadata.
 */

/** "10 MB", "1.5 MB" — never more than one decimal, never a trailing ".0". */
export function formatBytes(bytes: number): string {
  const mb = bytes / 1024 / 1024
  const shown = Number.isInteger(mb) ? String(mb) : mb.toFixed(1)
  return `${shown} MB`
}

/** "45s", "1:00", "9:30" for a duration in seconds (truncated, not rounded up). */
export function formatDurationSec(totalSec: number): string {
  if (!Number.isFinite(totalSec) || totalSec < 0) return '—'
  const whole = Math.floor(totalSec)
  if (whole < 60) return `${whole}s`
  const minutes = Math.floor(whole / 60)
  const seconds = String(whole % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
}

/** "123 BPM" — integral when the value is integral, one decimal otherwise. */
export function formatTempoBpm(bpm: number): string {
  const shown = Number.isInteger(bpm) ? String(bpm) : bpm.toFixed(1)
  return `${shown} BPM`
}