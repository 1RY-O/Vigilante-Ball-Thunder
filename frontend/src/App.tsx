import { useCallback, useEffect, useRef, useState } from 'react'
import { capabilities, cancelJob, friendlyError, getJob, getMusicXML, probeDurationSec, upload, validateDuration, validateFile, ServiceError } from './api'
import type { Capabilities, EngineInfo, Result } from './api'
import ScoreViewer, { activeNoteAt } from './ScoreViewer'
import type { NoteSpan } from './ScoreViewer'
import Playback from './Playback'
import { ENABLE_NOTE_HIGHLIGHTING } from './config'
import './App.css'

export const WARM_POLL_FIRST_MS = 2000
export const WARM_POLL_MAX_MS = 5000
export const WARM_POLL_BUDGET_MS = 5 * 60 * 1000
const KNOWN_ENGINE_CODES: readonly string[] = ['engine-warming-up', 'engine-unavailable', 'hf-token-missing', 'weights-gated', 'hf-unreachable', 'worker-deps-missing', 'python-not-found', 'worker-args-invalid']
export function isEngineWarming(engine?: EngineInfo | null): boolean {
  if (!engine || engine.available !== false) return false
  return engine.checking === true || engine.code === 'engine-warming-up'
}
export function isEngineFailed(engine?: EngineInfo | null): boolean {
  if (!engine || engine.available !== false) return false
  return !isEngineWarming(engine)
}

type Stage = 'idle' | 'selected' | 'uploading' | 'queued' | 'transcribing' | 'rendering' | 'complete' | 'error'
const labels: Record<Stage, string> = { idle: 'Ready for a recording', selected: 'Recording selected', uploading: 'Uploading recording', queued: 'Waiting for transcription', transcribing: 'Transcribing your recording', rendering: 'Engraving your sheet music', complete: 'Your score is ready', error: 'Something needs attention' }
function wait(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, 1500)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}
export default function App() {
  const [caps, setCaps] = useState<Capabilities | null>(null)
  const [serviceError, setServiceError] = useState('')
  const [checking, setChecking] = useState(true)
  const [warmingTimedOut, setWarmingTimedOut] = useState(false)
  const [retry, setRetry] = useState(0)
  const [file, setFile] = useState<File | null>(null)
  const [source, setSource] = useState('')
  const [stage, setStage] = useState<Stage>('idle')
  const [progress, setProgress] = useState<number>()
  const [error, setError] = useState('')
  const [result, setResult] = useState<Result | null>(null)
  const [xml, setXml] = useState('')
  const [dragging, setDragging] = useState(false)
  // True when the transcription itself succeeded but Verovio could not draw
  // the score. Kept separate from `error` so the page stays usable.
  const [scoreFailed, setScoreFailed] = useState(false)
  // Note-following state. Only ever populated when ENABLE_NOTE_HIGHLIGHTING
  // (config.ts) is true — see the gate on activeNoteId below.
  const [spans, setSpans] = useState<NoteSpan[]>([])
  const [timeMs, setTimeMs] = useState(0)
  const [highlightedNote, setHighlightedNote] = useState<string | null>(null)
  const operation = useRef<AbortController | null>(null)
  const jobId = useRef<string | null>(null)
  const selection = useRef(0)
  const picker = useRef<HTMLInputElement>(null)
  const busy = ['uploading', 'queued', 'transcribing', 'rendering'].includes(stage)
  const engine = caps?.engine
  const warming = isEngineWarming(engine) && !warmingTimedOut
  const warmingExpired = isEngineWarming(engine) && warmingTimedOut
  const engineFailed = isEngineFailed(engine)
  const engineBlocked = engine?.available === false
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancelled = false
    const started = Date.now()
    let delay = WARM_POLL_FIRST_MS
    setChecking(true); setServiceError(''); setWarmingTimedOut(false)
    async function load() {
      if (cancelled || controller.signal.aborted) return
      try {
        const result = await capabilities(controller.signal)
        if (cancelled || controller.signal.aborted) return
        if (isEngineWarming(result.engine)) {
          setCaps(result)
          setChecking(false)
          if (Date.now() - started > WARM_POLL_BUDGET_MS) {
            setWarmingTimedOut(true)
            return
          }
          timer = setTimeout(load, delay)
          delay = Math.min(WARM_POLL_MAX_MS, Math.round(delay * 1.5))
          return
        }
        setCaps(result)
        setChecking(false)
      } catch (e) {
        if (cancelled || controller.signal.aborted) return
        // Fetch/validation failures are terminal for this attempt; the user
        // retries manually. Only warm-up (above) polls automatically.
        if (e instanceof DOMException && e.name === 'AbortError') return
        setServiceError(friendlyError(e))
        setChecking(false)
      }
    }
    load()
    return () => { cancelled = true; controller.abort(); if (timer) clearTimeout(timer) }
  }, [retry])
  useEffect(() => {
    if (!file) { setSource(''); return }
    const url = URL.createObjectURL(file)
    setSource(url)
    return () => URL.revokeObjectURL(url)
  }, [file])
  useEffect(() => () => operation.current?.abort(), [])
  async function select(files: File[]) {
    if (busy || !caps || engineBlocked) return
    const token = ++selection.current
    if (files.length !== 1) { setError('Please choose one recording at a time.'); return }
    const issue = validateFile(files[0], caps)
    if (issue) { setError(issue); return }
    // Best-effort duration gate, only when the service advertises a limit
    // (browsers that cannot decode the file return null; the backend still
    // enforces duration independently).
    if (caps.maxAudioDurationSec) {
      const duration = await probeDurationSec(files[0])
      if (token !== selection.current) return
      const tooLong = validateDuration(duration, caps)
      if (tooLong) { setError(tooLong); return }
    }
    operation.current?.abort()
    setFile(files[0]); setError(''); setResult(null); setXml(''); setStage('selected'); setProgress(undefined)
  }
  async function transcribe() {
    if (!file || !caps || busy || engineBlocked) return
    operation.current?.abort()
    const controller = new AbortController()
    operation.current = controller
    setError(''); setResult(null); setXml(''); setStage('uploading'); setProgress(undefined)
    try {
      let job = await upload(file, controller.signal, setProgress)
      jobId.current = job.id
      const started = Date.now()
      while (job.status === 'queued' || job.status === 'transcribing') {
        setStage(job.status); setProgress(job.progress)
        if (Date.now() - started > 30 * 60 * 1000) throw new ServiceError('This transcription is taking longer than expected. We stopped checking; the service may still be processing it.')
        await wait(controller.signal)
        job = await getJob(job.id, controller.signal)
      }
      if (job.status === 'error' || !job.result) throw new ServiceError(job.error?.message ?? 'Transcription could not be completed. Try a shorter, clearer recording in a supported format.')
      setResult(job.result); setStage('rendering'); setProgress(undefined)
      const notation = await getMusicXML(job.result.musicxmlUrl, controller.signal)
      if (!controller.signal.aborted) setXml(notation)
    } catch (e) { if (!controller.signal.aborted) { setStage('error'); setError(friendlyError(e)) } }
  }
  const ready = useCallback(() => setStage('complete'), [])
  // A notation failure is surfaced inside the manuscript panel by ScoreViewer.
  // It must NOT become the page-level error: the transcription completed and
  // the MIDI/MusicXML downloads above still work, so the page stays at
  // 'complete' and only the on-screen engraving is reported as unavailable.
  const handleRenderFailure = useCallback(() => { setScoreFailed(true); setStage('complete') }, [])
  const handleTimelineChange = useCallback((next: NoteSpan[]) => setSpans(next), [])
  const handleNoteHighlight = useCallback((noteId: string | null) => setHighlightedNote(noteId), [])
  // A new score clears the previous notation failure and any old timeline.
  useEffect(() => { setScoreFailed(false); setSpans([]); setTimeMs(0) }, [xml])
  // The highlighted note is derived from the score's own timemap plus the
  // audio clock. While ENABLE_NOTE_HIGHLIGHTING is false this is always null,
  // so nothing is highlighted and the audio clock is never even read.
  const activeNoteId = ENABLE_NOTE_HIGHLIGHTING ? activeNoteAt(spans, timeMs) : null
  function stop() {
    operation.current?.abort()
    const id = jobId.current
    jobId.current = null
    if (id) cancelJob(id).catch(() => {})
    setStage(file ? 'selected' : 'idle'); setProgress(undefined); setError('Stopped waiting here. The service was asked to cancel the transcription.')
  }

  return <div className="app-shell">
    <header className="site-header"><a className="brand" href="/" aria-label="Vigilante Ball Thunder home"><span className="brand-mark" aria-hidden="true">♫</span><span>Vigilante Ball Thunder<small>A recording. A manuscript.</small></span></a><span className="header-note">Made for the music you make</span></header>
    <main>
      <section className="intro"><p className="eyebrow">YOUR MUSIC, IN WRITING</p><h1>Turn recordings into<br /> readable sheet music.</h1><p>Give a melody a place on the page.<br />Upload a recording, follow its transcription, and take your score with you.</p></section>
      <div className="workspace">
        <section className="upload-section" aria-labelledby="upload-title"><div className="section-heading"><span className="section-number">01</span><h2 id="upload-title">Start with a recording</h2></div>
          {checking && !warming && <p className="service-note" role="status">Checking available audio formats…</p>}
          {serviceError && <div className="notice" role="alert"><strong>Transcription isn’t connected yet</strong><p>{serviceError} No recording has been uploaded.</p><button onClick={() => setRetry(n => n + 1)}>Check connection</button></div>}
          {!serviceError && warming && <div className="notice warming-notice" role="status"><strong>Transcription engine is warming up<span className="warming-ellipsis" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span></strong><p>Transcription engine is warming up — this can take up to a minute on first start. Your uploads will unlock automatically, no need to reload.</p></div>}
          {!serviceError && warmingExpired && <div className="notice" role="status"><strong>Still warming up</strong><p>Transcription engine is still warming up — try reloading the page.</p><button onClick={() => setRetry(n => n + 1)}>Check connection</button></div>}
          {!serviceError && engineFailed && <div className="notice" role="alert"><strong>Transcription isn’t available</strong><p>Transcription isn’t available: {typeof engine?.reason === 'string' && engine.reason ? engine.reason : 'The transcription service is unavailable.'}{typeof engine?.code === 'string' && engine.code && KNOWN_ENGINE_CODES.includes(engine.code) ? ` (${engine.code})` : ''}</p><button onClick={() => setRetry(n => n + 1)}>Check connection</button></div>}
          {!serviceError && !engineBlocked && caps?.engine?.mock && <div className="notice" role="note"><strong>Demo engine active</strong><p>The backend is running its MOCK test engine: results are synthetic fixture data, not a real transcription.</p></div>}
          <div className={`drop-zone ${dragging ? 'dragging' : ''}`} onDragOver={e => { e.preventDefault(); if (caps && !engineBlocked && !busy) setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); select(Array.from(e.dataTransfer.files)) }}>
            <span className="upload-symbol" aria-hidden="true">↑</span><h3>{file ? file.name : 'Let your music begin here'}</h3><p>{file ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : 'Drag a recording into this space'}</p>
            <input ref={picker} className="sr-only" type="file" aria-label="Choose audio recording" accept={caps?.formats.map(f => `.${f}`).join(',') ?? '.mp3,.wav,.flac'} disabled={!caps || engineBlocked || busy} onChange={e => { if (e.target.files?.length) select(Array.from(e.target.files)); e.target.value = '' }} />
            <button onClick={() => picker.current?.click()} disabled={!caps || engineBlocked || busy}>{file ? 'Choose another file' : 'Choose a recording'}</button>
            <small>{caps ? `${caps.formats.map(f => f.toUpperCase()).join(' · ')} · Up to ${Math.floor(caps.maxUploadBytes / 1024 / 1024)} MB` : 'Supported formats will appear when the service connects.'}</small>
          </div>
          <p className="upload-help">For a clearer score, try a clean recording with one prominent melody. Review the transcription before performing.</p>
          <div className="upload-actions"><button className="primary" disabled={!file || busy || !caps || engineBlocked} onClick={transcribe}>{stage === 'error' ? 'Try transcription again' : 'Create sheet music'}<span aria-hidden="true"> →</span></button>{busy && stage !== 'rendering' && <button onClick={stop}>Stop waiting</button>}</div>
          <div className={`status ${stage}`} role="status" aria-live="polite"><span className="status-dot" /><span>{labels[stage]}{progress !== undefined && busy ? ` · ${progress}%` : ''}</span></div>
          {busy && <progress aria-label={labels[stage]} max="100" value={progress} />}
          {error && <p className="error-text" role="alert">{error}</p>}
          <aside className="process-note"><span aria-hidden="true">✧</span><div><h3>From sound to score</h3><p>MuScriptor transcribes your audio. Real MusicXML becomes staff notation, ready to read and export.</p></div></aside>
        </section>
        <section className="manuscript" aria-labelledby="score-title" aria-busy={stage === 'rendering'}><div className="section-heading manuscript-heading"><span className="section-number">02</span><h2 id="score-title">Your manuscript</h2>{stage === 'complete' && !scoreFailed && <span className="ready-badge">Ready to read</span>}</div>
          {ENABLE_NOTE_HIGHLIGHTING && highlightedNote && <p className="sr-only" aria-live="polite">Following the highlighted note.</p>}
          {xml ? <ScoreViewer xml={xml} onReady={ready} onRenderFailure={handleRenderFailure} activeNoteId={activeNoteId} onNoteHighlight={handleNoteHighlight} onTimelineChange={handleTimelineChange} /> : <div className="empty-score"><span className="manuscript-seal" aria-hidden="true">♫</span><p className="eyebrow">A LITTLE SPACE FOR YOUR NEXT MELODY</p><h3>{stage === 'rendering' ? 'Preparing your manuscript…' : 'Your score starts with a sound.'}</h3><p>Once your recording is transcribed,<br />your sheet music will appear here.</p><div className="empty-divider" /><small>Staff notation · Playback · MIDI & MusicXML</small></div>}
          {result && <><div className="exports"><div><h3>Keep making music</h3><p>Open your score in your favourite music editor.</p></div><div className="export-buttons"><a className="button" href={result.midiUrl} download="transcription.mid">↓ Download MIDI</a><a className="button" href={result.musicxmlUrl} download="transcription.musicxml">↓ Download MusicXML</a></div></div>{(result.audioUrl || source) && <Playback src={result.audioUrl || source} generated={!!result.audioUrl} onTimeMs={ENABLE_NOTE_HIGHLIGHTING ? setTimeMs : undefined} />}</>}
        </section>
      </div>
    </main>
    <footer><span>Vigilante Ball Thunder</span><span>Transcription by MuScriptor · Notation by Verovio</span><a href="https://github.com/1RY-O/Vigilante-Ball-Thunder" target="_blank" rel="noreferrer">Open source ↗</a></footer>
  </div>
}
