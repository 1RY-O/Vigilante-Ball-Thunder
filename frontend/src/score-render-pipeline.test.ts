import { expect, it } from 'vitest'
import createModule from 'verovio/wasm'
import { VerovioToolkit } from 'verovio/esm'
import { sanitizeNotationSVG } from './ScoreViewer'
import minimalXml from '../e2e/fixtures/minimal-grand.musicxml?raw'
import realXml from '../e2e/fixtures/grand-staff.real.musicxml?raw'

// End-to-end through the EXACT production path: real MusicXML -> real Verovio
// 6.3.0 wasm -> the production DOMPurify configuration in ScoreViewer.
// Regression guard for the headless-stem outbreak: Verovio engraves every
// SMuFL glyph (noteheads, clefs, accidentals, rests) as `<use xlink:href>`
// sprite references, and DOMPurify's stock `svg` profile strips them —
// leaving staff lines and labels intact but notation without heads or clefs.
const CASES = [
  ['minimal hand-written grand staff', minimalXml],
  ['real backend-generated grand staff', realXml],
] as const

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

for (const [name, xml] of CASES) {
  it(`renders ${name}: valid MusicXML, glyphs survive sanitization`, async () => {
    // 1. The backend artifact is valid MusicXML with real notation content.
    expect(xml).toContain('<score-partwise')
    expect(xml).toContain('<clef>')
    expect(xml).toContain('<pitch>')
    expect(xml).toContain('<type>')

    // 2. Real Verovio engraves it through the production options.
    const toolkit = new VerovioToolkit(await createModule())
    try {
      toolkit.setOptions({ inputFrom: 'musicxml', pageWidth: 2100, pageHeight: 2970, scale: 40, adjustPageHeight: true, footer: 'none' })
      expect(toolkit.loadData(xml)).toBeTruthy()
      expect(toolkit.getPageCount()).toBeGreaterThan(0)
      const raw = toolkit.renderToSVG(1)
      expect(raw).toMatch(/<g[^>]*class="note"/)
      expect(count(raw, '<use')).toBeGreaterThan(0)

      // 3. The production sanitizer MUST keep every glyph reference while
      // still removing genuinely dangerous markup.
      const clean = sanitizeNotationSVG(raw)
      expect(count(clean, '<use')).toBe(count(raw, '<use'))
      expect(count(clean, 'xlink:href')).toBe(count(raw, 'xlink:href'))
      expect(clean).toMatch(/<g[^>]*class="note"/)
      // Clef glyphs (not just their wrappers) survive.
      expect(clean).toMatch(/class="clef"/)
    } finally {
      toolkit.destroy()
    }
  }, 60000)
}

it('sanitization still neutralizes hostile markup (not disabled)', () => {
  const clean = sanitizeNotationSVG(
    '<svg><use href="javascript:alert(1)"/><script>alert(1)</script>' +
    '<g class="notehead" onclick="evil()"><use xlink:href="#a"/></g></svg>',
  )
  expect(clean).not.toContain('<script')
  expect(clean).not.toContain('onclick')
  expect(clean).not.toContain('javascript:')
  // ...while the legitimate same-document sprite reference passes through.
  expect(clean).toContain('xlink:href="#a"')
})
