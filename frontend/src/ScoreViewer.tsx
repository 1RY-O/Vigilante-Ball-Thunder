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

/**
 * Production Verovio engraving options: a wide workspace page (not a
 * shrunken fit-to-card) with wrapped systems (`breaks: 'auto'` — never a
 * single endless line), generously sized glyphs, and height fitted to the
 * content. Pages are deliberately allowed to exceed the viewport: the
 * surrounding `.score-scroll` container scrolls both axes instead of the
 * application shrinking the notation to fit.
 */
export const NOTATION_RENDER_OPTIONS = {
  inputFrom: 'musicxml',
  pageWidth: 2200,
  pageHeight: 2970,
  scale: 50,
  breaks: 'auto',
  adjustPageHeight: true,
  footer: 'none',
} as const

/**
 * The exact DOMPurify configuration applied to Verovio's SVG output.
 *
 * Verovio 6.3.0 engraves every SMuFL glyph (noteheads, clefs, accidentals,
 * rest symbols) as `<use xlink:href="#…">` sprite references into `<defs>`.
 * DOMPurify's stock `svg` profile strips those references, which renders as
 * intact staff lines and labels but headless, clefless floating stems. The
 * `ADD_TAGS`/`ADD_ATTR` below re-allow exactly the sprite mechanism and
 * nothing else: event-handler attributes, `<script>`, and dangerous URI
 * schemes (e.g. `javascript:`) are still removed by DOMPurify's defaults.
 */
export const NOTATION_SANITIZE_CONFIG: {
  USE_PROFILES: { svg: boolean; svgFilters: boolean }
  ADD_TAGS: string[]
  ADD_ATTR: string[]
} = {
  USE_PROFILES: { svg: true, svgFilters: true },
  ADD_TAGS: ['use'],
  ADD_ATTR: ['href', 'xlink:href'],
}

/** Sanitize one Verovio SVG page with the production configuration. Exported for tests. */
export function sanitizeNotationSVG(svg: string): string {
  return DOMPurify.sanitize(svg, { ...NOTATION_SANITIZE_CONFIG })
}

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
    toolkit.setOptions({ ...NOTATION_RENDER_OPTIONS })
    if (!toolkit.loadData(xml) || !toolkit.getPageCount()) throw new ScoreRejected('Verovio rejected the score')
    const pages = Array.from({ length: toolkit.getPageCount() }, (_, i) => sanitizeNotationSVG(toolkit!.renderToSVG(i + 1)))
    // Natural page width in px, read from the engraved SVG itself so zoom
    // scales the real notation size (never a hardcoded guess). Falls back to
    // the theoretical width (pageWidth * scale / 100) when unparseable.
    let pageWidthPx = (NOTATION_RENDER_OPTIONS.pageWidth * NOTATION_RENDER_OPTIONS.scale) / 100
    const widthMatch = pages[0]?.match(/<svg[^>]*\swidth="([\d.]+)px"/)
    if (widthMatch) {
      const parsed = Number.parseFloat(widthMatch[1])
      if (Number.isFinite(parsed) && parsed > 0) pageWidthPx = parsed
    }
    const timeline = ENABLE_NOTE_HIGHLIGHTING ? buildTimeline(toolkit) : []
    return { pages, timeline, pageWidthPx }
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
  const [pageWidthPx, setPageWidthPx] = useState<number | null>(null)
  const [failure, setFailure] = useState<RenderFailureCode | null>(null)
  const [zoom, setZoom] = useState(100)
  const scroll = useRef<HTMLDivElement>(null)
  // Click/touch-drag panning state. Mouse drags pan via scrollLeft/Top;
  // touch and wheel/trackpad keep their native scrolling behavior.
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  useEffect(() => {
    let active = true
    setPages([]); setPageWidthPx(null); setFailure(null)
    renderScore(xml)
      .then(result => {
        if (!active) return
        setPages(result.pages)
        setPageWidthPx(result.pageWidthPx)
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
  // Drag-to-pan handlers (mouse only; touch keeps native scrolling).
  const onPanStart = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return
    const root = scroll.current
    if (!root) return
    pan.current = { x: event.clientX, y: event.clientY, left: root.scrollLeft, top: root.scrollTop }
    root.classList.add('panning')
    root.setPointerCapture?.(event.pointerId)
  }
  const onPanMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = pan.current
    const root = scroll.current
    if (!gesture || !root) return
    root.scrollLeft = gesture.left - (event.clientX - gesture.x)
    root.scrollTop = gesture.top - (event.clientY - gesture.y)
  }
  const onPanEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    pan.current = null
    scroll.current?.classList.remove('panning')
    try { scroll.current?.releasePointerCapture?.(event.pointerId) } catch { /* already released */ }
  }

  return <>
    <div className="score-tools"><span className={pages.length || failure ? undefined : 'pulse'}>{pages.length ? `${pages.length} ${pages.length === 1 ? 'page' : 'pages'} · MusicXML notation` : failure ? 'Notation unavailable' : 'Engraving your manuscript…'}</span><div className="zoom"><button aria-label="Zoom out" disabled={zoom <= 60} onClick={() => setZoom(z => z - 10)}>−</button><output aria-label="Zoom level">{zoom}%</output><button aria-label="Zoom in" disabled={zoom >= 160} onClick={() => setZoom(z => z + 10)}>+</button></div></div>
    <div
      className="score-scroll"
      ref={scroll}
      tabIndex={0}
      aria-label="Sheet music workspace. Drag to pan."
      onPointerDown={onPanStart}
      onPointerMove={onPanMove}
      onPointerUp={onPanEnd}
      onPointerCancel={onPanEnd}
    >
      {failure && <p className="score-error" role="alert" data-render-failure={failure}>{failure === 'wasm-unavailable' ? WASM_UNAVAILABLE_TEXT : SCORE_RENDER_ERROR_TEXT}</p>}
      {pages.map((svg, i) => <div className="score-page" key={i} style={pageWidthPx ? { width: `${(pageWidthPx * zoom) / 100}px` } : undefined} role="img" aria-label={`Sheet music, page ${i + 1}`} dangerouslySetInnerHTML={{ __html: svg }} />)}
    </div>
  </>
}
