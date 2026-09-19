import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

// This file proves the dormant pipeline actually works when switched on: the
// config flag is forced true here (the sibling highlighting.test.tsx covers
// the shipped false default), while the engraving engine stays mocked.
vi.mock('./config', () => ({ ENABLE_NOTE_HIGHLIGHTING: true }))
vi.mock('verovio/wasm', () => ({ default: vi.fn(async () => ({})) }))
vi.mock('verovio/esm', () => ({
  VerovioToolkit: class {
    setOptions() { return true }
    loadData() { return true }
    getPageCount() { return 1 }
    renderToSVG() { return '<svg class="definition-scale"><g class="note" id="n1"></g><g class="note" id="n2"></g></svg>' }
    getElementsAtTime(ms: number) {
      if (ms >= 1000) return {}
      return ms < 500 ? { notes: ['n1'], measure: 'm1' } : { notes: ['n2'], measure: 'm1' }
    }
    destroy() {}
  },
}))

import ScoreViewer from './ScoreViewer'

it('with the flag on: the timemap is sampled and the sounding note gets .playing', async () => {
  const onTimelineChange = vi.fn()
  const onNoteHighlight = vi.fn()
  const { container, rerender } = render(
    <ScoreViewer xml="<score-partwise version='4.0'/>" onReady={vi.fn()} onRenderFailure={vi.fn()} activeNoteId="n1" onNoteHighlight={onNoteHighlight} onTimelineChange={onTimelineChange} />,
  )
  expect(await screen.findByText(/1 page · MusicXML notation/)).toBeInTheDocument()

  // Sampling happened: the published timeline names the mocked notes in order.
  expect(onTimelineChange).toHaveBeenCalledTimes(1)
  const spans = onTimelineChange.mock.calls[0]![0] as { id: string }[]
  expect(spans.map(span => span.id)).toEqual(['n1', 'n2'])

  // The first notes[0] id matches its SVG group and is marked playing.
  expect(container.querySelector('g#n1.playing')).not.toBeNull()
  expect(container.querySelector('g#n2.playing')).toBeNull()
  expect(onNoteHighlight).toHaveBeenCalledWith('n1')

  // Crossing a note boundary moves the highlight, it never doubles up.
  rerender(
    <ScoreViewer xml="<score-partwise version='4.0'/>" onReady={vi.fn()} onRenderFailure={vi.fn()} activeNoteId="n2" onNoteHighlight={onNoteHighlight} onTimelineChange={onTimelineChange} />,
  )
  expect(await screen.findByText(/1 page · MusicXML notation/)).toBeInTheDocument()
  expect(container.querySelector('g#n1.playing')).toBeNull()
  expect(container.querySelector('g#n2.playing')).not.toBeNull()
})
