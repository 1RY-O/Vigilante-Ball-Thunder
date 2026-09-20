import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { VerovioToolkit } from 'verovio/esm'
import Playback from './Playback'
import ScoreViewer, { TIMEMAP_STEP_MS, buildTimeline } from './ScoreViewer'
import { activeNoteAt } from './timeline'
import type { NoteSpan } from './timeline'
import { ENABLE_NOTE_HIGHLIGHTING } from './config'

// The engraving engine is mocked; the counted `samples` value is what proves
// the feature flag keeps the timemap untouched at runtime.
const verovio = vi.hoisted(() => ({ samples: 0 }))
vi.mock('verovio/wasm', () => ({ default: vi.fn(async () => ({})) }))
vi.mock('verovio/esm', () => ({
  VerovioToolkit: class {
    setOptions() { return true }
    loadData() { return true }
    getPageCount() { return 1 }
    renderToSVG() { return '<svg class="definition-scale"><g class="note" id="n1"></g><g class="note" id="n2"></g></svg>' }
    getElementsAtTime() { verovio.samples += 1; return { notes: ['n1'], measure: 'm1' } }
    destroy() {}
  },
}))

it('ships with note highlighting disabled', () => {
  expect(ENABLE_NOTE_HIGHLIGHTING).toBe(false)
})

it('activeNoteAt maps a time to the sounding note and reports gaps honestly', () => {
  const spans: NoteSpan[] = [
    { id: 'a', startMs: 0, endMs: 500 },
    { id: 'b', startMs: 500, endMs: 1000 },
  ]
  expect(activeNoteAt(spans, 0)).toBe('a')
  expect(activeNoteAt(spans, 499)).toBe('a')
  expect(activeNoteAt(spans, 500)).toBe('b')
  expect(activeNoteAt(spans, 999)).toBe('b')
  expect(activeNoteAt(spans, 1000)).toBe(null)
  expect(activeNoteAt([], 10)).toBe(null)
})

it('buildTimeline records only real timemap spans and stops past the end', () => {
  // Answers shaped exactly like Verovio's: a held note, a rest, a second note,
  // then an empty object once the score has ended.
  const answers: Record<number, { notes?: string[]; rests?: string[]; measure?: string }> = {
    0: { notes: ['a'], measure: 'm1' },
    50: { notes: ['a'], measure: 'm1' },
    100: { rests: ['r1'], measure: 'm1' },
    150: { notes: ['b'], measure: 'm2' },
    200: {},
  }
  expect(TIMEMAP_STEP_MS).toBe(50)
  const toolkit = { getElementsAtTime: (ms: number) => answers[ms] ?? {} } as unknown as VerovioToolkit
  expect(buildTimeline(toolkit)).toEqual([
    { id: 'a', startMs: 0, endMs: 100 },
    { id: 'b', startMs: 150, endMs: 200 },
  ])
})

it('with the flag off: no timemap sampling and no highlighted note, even when given one', async () => {
  verovio.samples = 0
  const { container } = render(
    <ScoreViewer xml="<score-partwise version='4.0'/>" onReady={vi.fn()} onRenderFailure={vi.fn()} activeNoteId="n1" onNoteHighlight={vi.fn()} />,
  )
  expect(await screen.findByText(/1 page · MusicXML notation/)).toBeInTheDocument()
  // The note groups are engraved and carry ids (the pipeline's contract)...
  expect(container.querySelectorAll('g.note')).toHaveLength(2)
  // ...but nothing was sampled and nothing was ever marked as playing.
  expect(verovio.samples).toBe(0)
  expect(container.querySelector('g.note.playing')).toBeNull()
})

it('with the flag off: the playback panel keeps its true "no note-following" text', () => {
  render(<Playback src="/api/audio" generated />)
  expect(screen.getByText('No note-following data available')).toBeInTheDocument()
})

it('time source plumbing works when supplied, so the feature can be switched on without a rewrite', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    this.dispatchEvent(new Event('play'))
    return Promise.resolve()
  })
  const onTimeMs = vi.fn()
  render(<Playback src="/api/audio" generated onTimeMs={onTimeMs} />)
  expect(onTimeMs).toHaveBeenCalledWith(0) // reported on load
  fireEvent.click(screen.getByRole('button', { name: 'Play' }))
  await screen.findByRole('button', { name: 'Pause' })
  await waitFor(() => expect(onTimeMs.mock.calls.length).toBeGreaterThan(1)) // frame loop running
})
