import { useEffect, useState } from 'react'
import DOMPurify from 'dompurify'
import type { VerovioToolkit } from 'verovio/esm'

let modulePromise: Promise<unknown> | undefined
async function renderScore(xml: string) {
  const [{ default: createModule }, { VerovioToolkit }] = await Promise.all([import('verovio/wasm'), import('verovio/esm')])
  modulePromise ??= createModule().catch(error => { modulePromise = undefined; throw error })
  let toolkit: VerovioToolkit | undefined
  try {
    toolkit = new VerovioToolkit(await modulePromise)
    toolkit.setOptions({ inputFrom: 'musicxml', pageWidth: 2100, pageHeight: 2970, scale: 40, adjustPageHeight: true, footer: 'none' })
    if (!toolkit.loadData(xml) || !toolkit.getPageCount()) throw new Error('Invalid score')
    return Array.from({ length: toolkit.getPageCount() }, (_, i) => DOMPurify.sanitize(toolkit!.renderToSVG(i + 1), { USE_PROFILES: { svg: true, svgFilters: true } }))
  } finally { toolkit?.destroy() }
}
export default function ScoreViewer({ xml, onReady, onError }: { xml: string; onReady: () => void; onError: () => void }) {
  const [pages, setPages] = useState<string[]>([])
  const [zoom, setZoom] = useState(100)
  useEffect(() => {
    let active = true
    setPages([])
    renderScore(xml).then(result => { if (active) { setPages(result); onReady() } }).catch(() => { if (active) onError() })
    return () => { active = false }
  }, [xml, onReady, onError])
  return <>
    <div className="score-tools"><span>{pages.length ? `${pages.length} ${pages.length === 1 ? 'page' : 'pages'} · MusicXML notation` : 'Engraving your manuscript…'}</span><div className="zoom"><button aria-label="Zoom out" disabled={zoom <= 60} onClick={() => setZoom(z => z - 10)}>−</button><output aria-label="Zoom level">{zoom}%</output><button aria-label="Zoom in" disabled={zoom >= 160} onClick={() => setZoom(z => z + 10)}>+</button></div></div>
    <div className="score-scroll" tabIndex={0} aria-label="Sheet music pages">
      {pages.map((svg, i) => <div className="score-page" key={i} style={{ width: `${840 * zoom / 100}px` }} role="img" aria-label={`Sheet music, page ${i + 1}`} dangerouslySetInnerHTML={{ __html: svg }} />)}
    </div>
  </>
}
