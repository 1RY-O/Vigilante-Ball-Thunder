import { useEffect, useState } from 'react'
import DOMPurify from 'dompurify'
import type { VerovioToolkit } from 'verovio/esm'

/**
 * Why the on-screen notation is missing. Reported so callers can log or
 * announce it, never as a claim about the backend.
 */
export type RenderFailureCode = 'verovio-score-rejected' | 'verovio-init-failed'

/**
 * Shown when the notation engine cannot produce an on-screen score.
 *
 * It states only what this component knows: the score was not rendered here,
 * and the downloads below are unaffected. It deliberately names NO cause —
 * the MusicXML reaching this component has already been validated upstream
 * (getMusicXML in api.ts checks for score-partwise/score-timewise), and a
 * failure here can equally come from the score or from this browser failing
 * to start the engraving engine. Both are covered by the same honest text.
 */
export const SCORE_RENDER_ERROR_TEXT = 'The notation could not be displayed for this recording. You can still download your files below.'

/** Thrown when Verovio itself refuses the score (as opposed to failing to start). */
class ScoreRejected extends Error {}

let modulePromise: Promise<unknown> | undefined
async function renderScore(xml: string) {
  const [{ default: createModule }, { VerovioToolkit }] = await Promise.all([import('verovio/wasm'), import('verovio/esm')])
  modulePromise ??= createModule().catch(error => { modulePromise = undefined; throw error })
  let toolkit: VerovioToolkit | undefined
  try {
    toolkit = new VerovioToolkit(await modulePromise)
    toolkit.setOptions({ inputFrom: 'musicxml', pageWidth: 2100, pageHeight: 2970, scale: 40, adjustPageHeight: true, footer: 'none' })
    if (!toolkit.loadData(xml) || !toolkit.getPageCount()) throw new ScoreRejected('Verovio rejected the score')
    return Array.from({ length: toolkit.getPageCount() }, (_, i) => DOMPurify.sanitize(toolkit!.renderToSVG(i + 1), { USE_PROFILES: { svg: true, svgFilters: true } }))
  } finally { toolkit?.destroy() }
}
export default function ScoreViewer({ xml, onReady, onRenderFailure }: { xml: string; onReady: () => void; onRenderFailure: (code: RenderFailureCode) => void }) {
  const [pages, setPages] = useState<string[]>([])
  const [failure, setFailure] = useState<RenderFailureCode | null>(null)
  const [zoom, setZoom] = useState(100)
  useEffect(() => {
    let active = true
    setPages([]); setFailure(null)
    renderScore(xml)
      .then(result => { if (active) { setPages(result); onReady() } })
      .catch((error: unknown) => {
        // A failure to engrave must not take over the whole page: it is
        // reported here, next to the manuscript, and the downloads stay live.
        if (!active) return
        const code: RenderFailureCode = error instanceof ScoreRejected ? 'verovio-score-rejected' : 'verovio-init-failed'
        setFailure(code)
        onRenderFailure(code)
      })
    return () => { active = false }
  }, [xml, onReady, onRenderFailure])
  return <>
    <div className="score-tools"><span>{pages.length ? `${pages.length} ${pages.length === 1 ? 'page' : 'pages'} · MusicXML notation` : failure ? 'Notation unavailable' : 'Engraving your manuscript…'}</span><div className="zoom"><button aria-label="Zoom out" disabled={zoom <= 60} onClick={() => setZoom(z => z - 10)}>−</button><output aria-label="Zoom level">{zoom}%</output><button aria-label="Zoom in" disabled={zoom >= 160} onClick={() => setZoom(z => z + 10)}>+</button></div></div>
    <div className="score-scroll" tabIndex={0} aria-label="Sheet music pages">
      {failure && <p className="score-error" role="alert" data-render-failure={failure}>{SCORE_RENDER_ERROR_TEXT}</p>}
      {pages.map((svg, i) => <div className="score-page" key={i} style={{ width: `${840 * zoom / 100}px` }} role="img" aria-label={`Sheet music, page ${i + 1}`} dangerouslySetInnerHTML={{ __html: svg }} />)}
    </div>
  </>
}
