import { useEffect, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import type { VerovioTimemap, VerovioToolkit } from 'verovio/esm'
import { ENABLE_NOTE_HIGHLIGHTING } from './config'
import type { NoteSpan } from './timeline'

/**
 * Why the on-screen notation is missing. Reported so callers can log or
 * announce it, never as a claim about the backend.
 */
export type RenderFailureCode = 'verovio-score-rejected' | 'verovio-init-failed' | 'wasm-unavailable'

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

/**
 * Shown ONLY when this browser has no WebAssembly at all (e.g. Cromite with
 * JavaScript JIT disabled). Unlike SCORE_RENDER_ERROR_TEXT this one names a
 * cause, because renderScore checks `typeof WebAssembly` before touching
 * Verovio — reaching this message proves the engine was never at fault, the
 * browser simply cannot run it. The per-site remedy is Cromite-specific
 * because that is the browser family known to gate WASM behind its JIT
 * switch; every other case is covered by "try a different browser".
 */
export const WASM_UNAVAILABLE_TEXT = 'This browser does not have WebAssembly enabled, which is required to engrave sheet music. On Cromite, you can enable it per-site via the lock icon → Site settings → JavaScript JIT. Alternatively, try a different browser.'

/** Sampling step used to turn Verovio's timemap into note spans. */
export const TIMEMAP_STEP_MS = 50
/** Safety cap, so a pathological score cannot make the scan run forever. */
export const TIMEMAP_MAX_MS = 20 * 60 * 1000

/** True when the span already open is the note sounding at this sample. */
function isContinuing(open: NoteSpan | null, id: string): open is NoteSpan {
  return open?.id === id
}

/**
 * Walk Verovio's timemap and record when each note starts and stops.
 *
 * Verovio is the only source of truth: every span comes from a real
 * getElementsAtTime answer, nothing is interpolated or invented, and the scan
 * stops as soon as the timemap reports nothing at all (past the score's end).
 */
export function buildTimeline(toolkit: VerovioToolkit): NoteSpan[] {
  const spans: NoteSpan[] = []
  let open: NoteSpan | null = null
  for (let ms = 0; ms <= TIMEMAP_MAX_MS; ms += TIMEMAP_STEP_MS) {
    const elements: VerovioTimemap = toolkit.getElementsAtTime(ms)
    const notes = elements?.notes ?? []
    const rests = elements?.rests ?? []
    if (!notes.length && !rests.length && !elements?.measure) break
    const id = notes[0] ?? null
    if (!id) { open = null; continue }
    if (isContinuing(open, id)) { open.endMs = ms + TIMEMAP_STEP_MS; continue }
    open = { id, startMs: ms, endMs: ms + TIMEMAP_STEP_MS }
    spans.push(open)
  }
  return spans
}

/** Thrown when Verovio itself refuses the score (as opposed to failing to start). */
class ScoreRejected extends Error {}

/** Thrown before Verovio is even loaded: this browser cannot run WebAssembly. */
class WasmUnavailable extends Error {}

let modulePromise: Promise<unknown> | undefined
async function renderScore(xml: string) {
  // Hardened browsers (e.g. Cromite with JavaScript JIT off) expose no
  // WebAssembly global at all. Detect that here — before importing or
  // instantiating Verovio, which would fail later with a bare "WebAssembly
  // is not defined" ReferenceError from inside the wasm glue.
  if (typeof WebAssembly === 'undefined') throw new WasmUnavailable('WebAssembly is not available in this browser')
  const [{ default: createModule }, { VerovioToolkit }] = await Promise.all([import('verovio/wasm'), import('verovio/esm')])
  modulePromise ??= createModule().catch(error => { modulePromise = undefined; throw error })
  let toolkit: VerovioToolkit | undefined
  try {
    toolkit = new VerovioToolkit(await modulePromise)
    // Note highlighting reads live answers from getElementsAtTime(ms), which
    // needs no render option: Verovio 6.3.0 has no `svgView` or `timemap`
    // setOptions keys (both are reported as unsupported), and
    // renderToTimemap() entries carry onset timing only ({ on/off, qstamp,
    // tstamp, tempo }) — never note ids. Sampling happens solely through
    // buildTimeline below, and only while the feature flag is on.
    toolkit.setOptions({ inputFrom: 'musicxml', pageWidth: 2100, pageHeight: 2970, scale: 40, adjustPageHeight: true, footer: 'none' })
    if (!toolkit.loadData(xml) || !toolkit.getPageCount()) throw new ScoreRejected('Verovio rejected the score')
    const pages = Array.from({ length: toolkit.getPageCount() }, (_, i) => DOMPurify.sanitize(toolkit!.renderToSVG(i + 1), { USE_PROFILES: { svg: true, svgFilters: true } }))
    const timeline = ENABLE_NOTE_HIGHLIGHTING ? buildTimeline(toolkit) : []
    return { pages, timeline }
  } finally { toolkit?.destroy() }
}
export default function ScoreViewer({ xml, onReady, onRenderFailure, activeNoteId, onNoteHighlight, onTimelineChange }: {
  xml: string
  onReady: () => void
  onRenderFailure: (code: RenderFailureCode) => void
  /** Note to highlight, computed by the parent from the timemap + audio time. */
  activeNoteId?: string | null
  /** Fires when the highlighted note changes (a note boundary was crossed). */
  onNoteHighlight?: (noteId: string | null) => void
  /** Publishes the note timeline (id <-> ms) after a successful engraving. */
  onTimelineChange?: (spans: NoteSpan[]) => void
}) {
  const [pages, setPages] = useState<string[]>([])
  const [failure, setFailure] = useState<RenderFailureCode | null>(null)
  const [zoom, setZoom] = useState(100)
  const scroll = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let active = true
    setPages([]); setFailure(null)
    renderScore(xml)
      .then(result => {
        if (!active) return
        setPages(result.pages)
        onTimelineChange?.(result.timeline)
        onReady()
      })
      .catch((error: unknown) => {
        // A failure to engrave must not take over the whole page: it is
        // reported here, next to the manuscript, and the downloads stay live.
        if (!active) return
        // Keep the cause-free inline message for the user; the original
        // error goes to the console for diagnosis, never to the UI.
        console.error('ScoreViewer: the notation could not be rendered.', error)
        const code: RenderFailureCode = error instanceof WasmUnavailable ? 'wasm-unavailable' : error instanceof ScoreRejected ? 'verovio-score-rejected' : 'verovio-init-failed'
        setFailure(code)
        onRenderFailure(code)
      })
    return () => { active = false }
  }, [xml, onReady, onRenderFailure, onTimelineChange])

  // Note highlighting is DORMANT until ENABLE_NOTE_HIGHLIGHTING is true. With
  // the flag off both effects below return before touching anything, so no
  // class is ever applied and no highlight event is ever emitted.
  useEffect(() => {
    if (!ENABLE_NOTE_HIGHLIGHTING) return
    onNoteHighlight?.(activeNoteId ?? null)
  }, [activeNoteId, onNoteHighlight])

  useEffect(() => {
    if (!ENABLE_NOTE_HIGHLIGHTING) return
    const root = scroll.current
    if (!root) return
    const notes = Array.from(root.querySelectorAll<SVGGElement>('g.note'))
    // Match on the element id itself rather than a selector, so no id value
    // can ever be interpreted as CSS.
    const next = activeNoteId ? notes.find(note => note.id === activeNoteId) ?? null : null
    for (const note of notes) if (note !== next) note.classList.remove('playing')
    next?.classList.add('playing')
  }, [activeNoteId, pages])
  return <>
    <div className="score-tools"><span className={pages.length || failure ? undefined : 'pulse'}>{pages.length ? `${pages.length} ${pages.length === 1 ? 'page' : 'pages'} · MusicXML notation` : failure ? 'Notation unavailable' : 'Engraving your manuscript…'}</span><div className="zoom"><button aria-label="Zoom out" disabled={zoom <= 60} onClick={() => setZoom(z => z - 10)}>−</button><output aria-label="Zoom level">{zoom}%</output><button aria-label="Zoom in" disabled={zoom >= 160} onClick={() => setZoom(z => z + 10)}>+</button></div></div>
    <div className="score-scroll" ref={scroll} tabIndex={0} aria-label="Sheet music pages">
      {failure && <p className="score-error" role="alert" data-render-failure={failure}>{failure === 'wasm-unavailable' ? WASM_UNAVAILABLE_TEXT : SCORE_RENDER_ERROR_TEXT}</p>}
      {pages.map((svg, i) => <div className="score-page" key={i} style={{ width: `${840 * zoom / 100}px` }} role="img" aria-label={`Sheet music, page ${i + 1}`} dangerouslySetInnerHTML={{ __html: svg }} />)}
    </div>
  </>
}
