import { render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import ScoreViewer, { SCORE_RENDER_ERROR_TEXT, WASM_UNAVAILABLE_TEXT } from './ScoreViewer'

// The engraving engine is the only thing mocked here: these tests drive the
// REAL ScoreViewer component and the REAL error handling, and the fixture SVG
// mirrors what Verovio actually emits (verified against verovio 6.3.0).
const verovio = vi.hoisted(() => ({ loadData: true, pageCount: 1 }))

vi.mock('verovio/wasm', () => ({ default: vi.fn(async () => ({})) }))
vi.mock('verovio/esm', () => ({
  VerovioToolkit: class {
    setOptions() { return true }
    loadData() { return verovio.loadData }
    getPageCount() { return verovio.pageCount }
    renderToSVG() { return '<svg class="definition-scale"><g class="note" id="n1"></g></svg>' }
    getElementsAtTime() { return {} }
    destroy() {}
  },
}))

afterEach(() => { verovio.loadData = true; verovio.pageCount = 1 })

it('engraves a valid score and reports readiness', async () => {
  const onReady = vi.fn()
  const onRenderFailure = vi.fn()
  render(<ScoreViewer xml="<score-partwise version='4.0'/>" onReady={onReady} onRenderFailure={onRenderFailure} />)
  expect(await screen.findByText(/1 page · MusicXML notation/)).toBeInTheDocument()
  expect(screen.getByRole('img', { name: 'Sheet music, page 1' })).toBeInTheDocument()
  expect(onReady).toHaveBeenCalledTimes(1)
  expect(onRenderFailure).not.toHaveBeenCalled()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('shows an inline message when Verovio refuses the score, without blaming the backend', async () => {
  verovio.loadData = false
  const onReady = vi.fn()
  const onRenderFailure = vi.fn()
  render(<ScoreViewer xml="<score-partwise version='4.0'/>" onReady={onReady} onRenderFailure={onRenderFailure} />)

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent(SCORE_RENDER_ERROR_TEXT)
  expect(alert).toHaveAttribute('data-render-failure', 'verovio-score-rejected')
  expect(onRenderFailure).toHaveBeenCalledWith('verovio-score-rejected')
  expect(onReady).not.toHaveBeenCalled()
  // The message must stay cause-free: no invented diagnosis, no mock-engine blame.
  expect(screen.queryByText(/mock engine/i)).not.toBeInTheDocument()
  expect(screen.queryByText(/invalid score format/i)).not.toBeInTheDocument()
  expect(screen.getByText('Notation unavailable')).toBeInTheDocument()
})

it('reports an engine that cannot start and still renders an inline message', async () => {
  verovio.pageCount = 0
  const onRenderFailure = vi.fn()
  render(<ScoreViewer xml="<score-partwise version='4.0'/>" onReady={vi.fn()} onRenderFailure={onRenderFailure} />)
  expect(await screen.findByRole('alert')).toHaveTextContent(SCORE_RENDER_ERROR_TEXT)
  expect(onRenderFailure).toHaveBeenCalledWith('verovio-score-rejected')
})

it('names the real cause when the browser has no WebAssembly, before Verovio is even used', async () => {
  vi.stubGlobal('WebAssembly', undefined)
  // A score Verovio would refuse: the WASM check must still win, proving it
  // runs before any import, load, or engraving attempt.
  verovio.loadData = false
  const onReady = vi.fn()
  const onRenderFailure = vi.fn()
  render(<ScoreViewer xml="<score-partwise version='4.0'/>" onReady={onReady} onRenderFailure={onRenderFailure} />)

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent(WASM_UNAVAILABLE_TEXT)
  expect(alert).toHaveAttribute('data-render-failure', 'wasm-unavailable')
  expect(onRenderFailure).toHaveBeenCalledWith('wasm-unavailable')
  expect(onReady).not.toHaveBeenCalled()
  // The generic message must not appear anywhere: this failure has a known,
  // actionable cause and says so.
  expect(screen.queryByText(SCORE_RENDER_ERROR_TEXT)).not.toBeInTheDocument()
})
