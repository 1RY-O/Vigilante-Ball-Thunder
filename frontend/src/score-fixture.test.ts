import { expect, it } from 'vitest'
import createModule from 'verovio/wasm'
import { VerovioToolkit } from 'verovio/esm'
import xml from '../e2e/fixtures/score.musicxml?raw'

// Proof against the REAL engraving engine (nothing mocked here) that the
// checked-in fixture renders: Verovio 6.3.0 loads it, engraves a page whose
// SVG carries <g class="note"> groups, and answers per-time note ids via
// getElementsAtTime — while renderToTimemap entries carry timing only.
it('renders the checked-in MusicXML fixture to SVG with real Verovio', async () => {
  expect(xml).toContain('<score-partwise')

  const toolkit = new VerovioToolkit(await createModule())
  try {
    toolkit.setOptions({ inputFrom: 'musicxml' })
    expect(toolkit.loadData(xml)).toBeTruthy()
    expect(toolkit.getPageCount()).toBeGreaterThan(0)

    const svg = toolkit.renderToSVG(1)
    expect(svg).toMatch(/<g[^>]*class="note"/)

    const timemap = toolkit.renderToTimemap()
    expect(Array.isArray(timemap)).toBe(true)
    expect(timemap.length).toBeGreaterThan(0)
    for (const entry of timemap) expect(entry).not.toHaveProperty('notes')

    const atStart = toolkit.getElementsAtTime(0)
    expect(atStart.notes?.length).toBeGreaterThan(0)
  } finally {
    toolkit.destroy()
  }
}, 60000)
