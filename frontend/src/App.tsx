import { useCallback, useEffect, useRef, useState } from 'react'
import { capabilities, cancelJob, friendlyError, generatePlayback, getJob, getMusicXML, probeDurationSec, upload, validateDuration, validateFile, ServiceError } from './api'
import type { Capabilities, EngineInfo, Result } from './api'
import ScoreViewer, { activeNoteAt } from './ScoreViewer'
import type { NoteSpan } from './ScoreViewer'
import Playback from './Playback'
import { ENABLE_NOTE_HIGHLIGHTING, PLAYBACK_GENERATION_ENABLED } from './config'
import { DEFAULT_INSTRUMENT, DEFAULT_SHEET_TYPE, INSTRUMENT_OPTIONS, INSTRUMENT_OTHER, SHEET_TYPE_OPTIONS, SHEET_TYPE_SUPPORTED } from './options'
import type { InstrumentValue, SheetTypeValue } from './options'
import { formatBytes, formatDurationSec } from './format'
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
  const [instrument, setInstrument] = useState<InstrumentValue>(DEFAULT_INSTRUMENT)
  const [instrumentDetail, setInstrumentDetail] = useState('')
  const [sheetType, setSheetType] = useState<SheetTypeValue>(DEFAULT_SHEET_TYPE)
  // A selected-but-blocked file (larger or longer than the service allows).
  // Kept separate from `error` so the file card can stay visible with the
  // exact limit and overflow shown before the user clicks "Create sheet music".
  const [selectionIssue, setSelectionIssue] = useState('')
  const [probedDuration, setProbedDuration] = useState<number | null>(null)
  // Client-measured wall time for the metadata panel (upload → complete).
  const [transcriptionMs, setTranscriptionMs] = useState<number | null>(null)
  const [generatingPlayback, setGeneratingPlayback] = useState(false)
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
  // True when the pressed file is over a limit: the file stays listed so its
  // size/duration and the exact overflow are visible, but upload is disabled.
  const instrumentBlocked = !!selectionIssue
  // Metadata panel values, all sourced from what the backend actually returns
  // (capabilities) or from measurements of the user's own upload — never invented.
  const metadataEngine = caps?.engine ? (caps.engine.mock ? `${caps.engine.name ?? 'stub'} (MOCK)` : caps.engine.name ?? null) : null
  const metadataModel = caps?.engine?.model
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
    const file = files[0]
    const issue = validateFile(file, caps)
    const oversized = file.size > caps.maxUploadBytes
    // Format/empty problems reject the file outright. An oversized file stays
    // SELECTED so the exact limit and overflow are shown next to it, and the
    // "Create sheet music" button stays disabled until a fitting file is chosen.
    if (issue && !oversized) { setSelectionIssue(''); setError(issue); return }
    const duration = caps.maxAudioDurationSec ? await probeDurationSec(file) : null
    if (token !== selection.current) return
    setProbedDuration(duration)
    const durationIssue = validateDuration(duration, caps)
    const block = durationIssue ?? (oversized ? issue : null)
    setSelectionIssue(block ?? '')
    setError(block ?? '')
    operation.current?.abort()
    setFile(file); setResult(null); setXml(''); setStage('selected'); setProgress(undefined)
  }
  async function transcribe() {
    if (!file || !caps || busy || engineBlocked || selectionIssue) return
    operation.current?.abort()
    const controller = new AbortController()
    operation.current = controller
    setError(''); setResult(null); setXml(''); setStage('uploading'); setProgress(undefined)
    const started = performance.now()
    try {
      let job = await upload(file, controller.signal, setProgress, {
        instrument,
        // Free text only travels when the user actually picked "Other".
        instrumentDetail: instrument === INSTRUMENT_OTHER && instrumentDetail.trim() ? instrumentDetail.trim() : undefined,
      })
      jobId.current = job.id
      const jobStarted = Date.now()
      while (job.status === 'queued' || job.status === 'transcribing') {
        setStage(job.status); setProgress(job.progress)
        if (Date.now() - jobStarted > 30 * 60 * 1000) throw new ServiceError('This transcription is taking longer than expected. We stopped checking; the service may still be processing it.')
        await wait(controller.signal)
        job = await getJob(job.id, controller.signal)
      }
      if (job.status === 'error' || !job.result) throw new ServiceError(job.error?.message ?? 'Transcription could not be completed. Try a shorter, clearer recording in a supported format.')
      setResult(job.result); setStage('rendering'); setProgress(undefined); setTranscriptionMs(Math.round(performance.now() - started))
      const notation = await getMusicXML(job.result.musicxmlUrl, controller.signal)
      if (!controller.signal.aborted) setXml(notation)
    } catch (e) { if (!controller.signal.aborted) { setStage('error'); setError(friendlyError(e)) } }
  }
  // Score-aligned playback generation. Reachable only while
  // PLAYBACK_GENERATION_ENABLED is true (otherwise the button is hidden), so
  // this wiring is dormant until the backend implements the endpoint.
  async function startGeneratedPlayback() {
    if (!result || !jobId.current || generatingPlayback || result.audioUrl) return
    setGeneratingPlayback(true); setError('')
    try {
      const url = await generatePlayback(jobId.current)
      setResult(prev => (prev ? { ...prev, audioUrl: url } : prev))
    } catch (e) { setError(friendlyError(e)) } finally { setGeneratingPlayback(false) }
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
          <ol className="how-it-works" aria-label="How it works">
            <li><strong>1. Upload a recording</strong><span>WAV, MP3, or FLAC, within the service limits.</span></li>
            <li><strong>2. Choose your setup</strong><span>Pass an instrument hint to the transcription engine — or let it auto-detect.</span></li>
            <li><strong>3. Transcribe &amp; review</strong><span>Follow the progress and keep your MusicXML and MIDI downloads.</span></li>
          </ol>
          <div className={`drop-zone ${dragging ? 'dragging' : ''}`} onDragOver={e => { e.preventDefault(); if (caps && !engineBlocked && !busy) setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); select(Array.from(e.dataTransfer.files)) }}>
            <span className="upload-symbol" aria-hidden="true">↑</span><h3>{file ? file.name : 'Let your music begin here'}</h3>{file ? <div className="file-details"><span>Format {file.name.split('.').pop()?.toUpperCase() ?? '—'}</span><span>{formatBytes(file.size)}</span>{probedDuration != null && <span>{formatDurationSec(probedDuration)}</span>}</div> : <p>Drag a recording into this space</p>}
            <input ref={picker} className="sr-only" type="file" aria-label="Choose audio recording" accept={caps?.formats.map(f => `.${f}`).join(',') ?? '.mp3,.wav,.flac'} disabled={!caps || engineBlocked || busy} onChange={e => { if (e.target.files?.length) select(Array.from(e.target.files)); e.target.value = '' }} />
            <button onClick={() => picker.current?.click()} disabled={!caps || engineBlocked || busy}>{file ? 'Choose another file' : 'Choose a recording'}</button>
            <small>{caps ? `${caps.formats.map(f => f.toUpperCase()).join(' · ')} · Up to ${formatBytes(caps.maxUploadBytes)}` : 'Supported formats will appear when the service connects.'}</small>
          </div>
          <div className="transcription-options">
            <fieldset className="option-field" disabled={!caps || engineBlocked || busy}>
              <legend>Instrument</legend>
              <select aria-label="Instrument" value={instrument} onChange={e => { setInstrument(e.target.value as InstrumentValue); if (e.target.value !== INSTRUMENT_OTHER) setInstrumentDetail('') }}>
                {INSTRUMENT_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              {instrument === INSTRUMENT_OTHER && <label className="instrument-detail">Describe the instrument<input type="text" value={instrumentDetail} maxLength={120} placeholder="e.g. saxophone solo" onChange={e => setInstrumentDetail(e.target.value)} /></label>}
              <small className="option-hint">Sent to the transcription engine as a hint; Auto-detect sends no hint.</small>
            </fieldset>
            <fieldset className="option-field" aria-label="Sheet type" title="Coming soon">
              <legend>Sheet type <span className="coming-soon">Coming soon</span></legend>
              <select aria-label="Sheet type" value={sheetType} disabled={!SHEET_TYPE_SUPPORTED} onChange={e => setSheetType(e.target.value as SheetTypeValue)}>
                {SHEET_TYPE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              <small className="option-hint">Not available yet — the transcription backend does not accept sheet-type selection.</small>
            </fieldset>
          </div>
          <p className="upload-help">For a clearer score, try a clean recording with one prominent melody. Review the transcription before performing.</p>
          <div className="upload-actions"><button className="primary" disabled={!file || busy || !caps || engineBlocked || instrumentBlocked} onClick={transcribe}>{stage === 'error' ? 'Try transcription again' : 'Create sheet music'}<span aria-hidden="true"> →</span></button>{busy && stage !== 'rendering' && <button onClick={stop}>Stop waiting</button>}</div>
          <div className={`status ${stage}`} role="status" aria-live="polite"><span className="status-dot" /><span>{labels[stage]}{progress !== undefined && busy ? ` · ${progress}%` : ''}</span></div>
          {busy && <progress aria-label={labels[stage]} max="100" value={progress} />}
          {error && <p className="error-text" role="alert">{error}{stage === 'error' && file && <button className="retry" onClick={transcribe}>Retry</button>}</p>}
          <aside className="process-note"><span aria-hidden="true">✧</span><div><h3>From sound to score</h3><p>MuScriptor transcribes your audio. Real MusicXML becomes staff notation, ready to read and export.</p></div></aside>
        </section>
        <section className="manuscript" aria-labelledby="score-title" aria-busy={stage === 'rendering'}><div className="section-heading manuscript-heading"><span className="section-number">02</span><h2 id="score-title">Your manuscript</h2>{stage === 'complete' && !scoreFailed && <span className="ready-badge">Ready to read</span>}</div>
          {ENABLE_NOTE_HIGHLIGHTING && highlightedNote && <p className="sr-only" aria-live="polite">Following the highlighted note.</p>}
          {xml ? <ScoreViewer xml={xml} onReady={ready} onRenderFailure={handleRenderFailure} activeNoteId={activeNoteId} onNoteHighlight={handleNoteHighlight} onTimelineChange={handleTimelineChange} /> : <div className="empty-score"><span className="manuscript-seal" aria-hidden="true">♫</span><p className="eyebrow">A LITTLE SPACE FOR YOUR NEXT MELODY</p><h3>{stage === 'rendering' ? 'Preparing your manuscript…' : 'Your score starts with a sound.'}</h3><p>Once your recording is transcribed,<br />your sheet music will appear here.</p><div className="empty-divider" /><small>Staff notation · Playback · MIDI & MusicXML</small></div>}
          {result && <><div className="exports"><div><h3>Keep making music</h3><p>Open your score in your favourite music editor.</p></div><div className="export-buttons"><a className="button" href={result.midiUrl} download="transcription.mid">↓ Download MIDI</a><a className="button" href={result.musicxmlUrl} download="transcription.musicxml">↓ Download MusicXML</a></div></div><div className="result-meta" aria-label="Transcription details">{metadataEngine && <span className="meta-item">Engine: <strong>{metadataEngine}</strong></span>}{metadataModel && <span className="meta-item">Model: <strong>{metadataModel}</strong></span>}{probedDuration != null && <span className="meta-item">Duration: <strong>{formatDurationSec(probedDuration)}</strong></span>}{transcriptionMs != null && <span className="meta-item">Transcription time: <strong>{formatDurationSec(Math.ceil(transcriptionMs / 1000))}</strong></span>}</div>{PLAYBACK_GENERATION_ENABLED && <div className="exports playback-generation"><div><h3>Score-aligned playback</h3><p>Generate audio that follows your transcribed notation instead of the original recording.</p></div><button className="button" disabled={generatingPlayback || !!result.audioUrl} onClick={startGeneratedPlayback}>{generatingPlayback ? 'Generating…' : result.audioUrl ? 'Playback ready ✓' : 'Generate playback'}</button></div>}{(result.audioUrl || source) && <Playback src={result.audioUrl || source} generated={!!result.audioUrl} onTimeMs={ENABLE_NOTE_HIGHLIGHTING ? setTimeMs : undefined} />}</>}
        </section>
      </div>
    </main>
    <footer><span>Vigilante Ball Thunder</span><span>Transcription by MuScriptor · Notation by Verovio</span><a href="https://github.com/1RY-O/Vigilante-Ball-Thunder" target="_blank" rel="noreferrer">Open source ↗</a></footer>
  </div>
}
