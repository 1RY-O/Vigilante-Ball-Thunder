import { formatBytes, formatDurationSec } from './format'

export interface EngineInfo { name?: string; mock?: boolean; available?: boolean; checking?: boolean; code?: string; reason?: string; model?: string }
export interface Capabilities { formats: string[]; maxUploadBytes: number; engine?: EngineInfo; maxAudioDurationSec?: number }
/** Audio analysis the backend genuinely extracted (music21 reading the real
 *  transcription). A field the engine could not read is absent — never guessed. */
export interface ResultMeta { tempoBpm?: number; keyName?: string }
export interface Result {
  musicxmlUrl: string
  midiUrl: string
  audioUrl?: string
  /** Engine + model that produced this result, e.g. "muscriptor (small)". */
  engineUsed?: string
  /** Audio duration reported by the engine, or null when it did not. */
  durationSec?: number | null
  /** Measured wall clock from job start to completion (ms). */
  transcriptionMs?: number
  /** Instruments the engine actually decoded, or null when it did not report any. */
  detectedInstruments?: string[] | null
  /** Tempo/key, only when the engine genuinely extracted them. */
  metadata?: ResultMeta
}
export interface Job { id: string; status: 'queued' | 'transcribing' | 'complete' | 'error'; progress?: number; result?: Result; error?: { code: string; message: string; cause?: string } }
// Curated failure codes the backend may attach to a job; a message is only
// surfaced when its code is one of these, so a misbehaving backend can never
// leak internals through the UI.
const safeErrorCodes: readonly string[] = ['transcription-failed', 'engine-unavailable', 'empty-transcription', 'cancelled']
const base = '/api'
const formats = ['mp3', 'wav', 'flac']
const unavailable = 'The transcription service is unavailable. Please try again in a moment.'
export class ServiceError extends Error {}
function message(status: number) {
  if (status === 413) return 'This recording is too large. Please choose a smaller file.'
  if (status === 415) return 'This audio format is not supported. Please choose another recording.'
  if (status === 429) return 'The service is busy. Please wait a moment before trying again.'
  if (status === 401 || status === 403) return 'This recording is not accessible. Please try uploading again.'
  return unavailable
}
export function artifactUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/api/')) throw new ServiceError('The service returned an incomplete result. Please try again.')
  const url = new URL(value, window.location.origin)
  if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/') || url.username || url.password) throw new ServiceError(unavailable)
  return url.href
}
async function json(path: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { signal, headers: { Accept: 'application/json' } })
  if (!response.ok) throw new ServiceError(message(response.status))
  return response.json()
}
export async function capabilities(signal?: AbortSignal): Promise<Capabilities> {
  const data = await json(`${base}/capabilities`, signal) as Capabilities
  if (!Array.isArray(data?.formats) || !Number.isSafeInteger(data.maxUploadBytes) || data.maxUploadBytes <= 0) throw new ServiceError(unavailable)
  const supported = formats.filter(format => data.formats.includes(format))
  if (!supported.length) throw new ServiceError('No supported recording formats are available yet.')
  // The engine state is returned as-is so the caller can distinguish
  // "warming up" (available:false + checking:true / code engine-warming-up)
  // from a settled failure (available:false + checking:false). Throwing
  // here would freeze the UI on the first probe after a backend restart.
  const caps: Capabilities = { formats: supported, maxUploadBytes: data.maxUploadBytes }
  if (data.engine && typeof data.engine === 'object') caps.engine = data.engine
  if (Number.isSafeInteger(data.maxAudioDurationSec) && (data.maxAudioDurationSec ?? 0) > 0) caps.maxAudioDurationSec = data.maxAudioDurationSec
  return caps
}
export function validateFile(file: File, caps: Capabilities): string | null {
  if (!caps.formats.includes(file.name.split('.').pop()?.toLowerCase() ?? '')) return `Choose a ${caps.formats.map(f => f.toUpperCase()).join(', ')} recording.`
  if (!file.size) return 'This file is empty. Please choose a recording with audio.'
  if (file.size > caps.maxUploadBytes) return `This recording is too large: your file is ${formatBytes(file.size)}, the limit is ${formatBytes(caps.maxUploadBytes)} — ${formatBytes(file.size - caps.maxUploadBytes)} over the limit.`
  return null
}
/** Best-effort duration probe via the browser's audio decoder. Returns null
 *  when undecidable; the backend still enforces duration independently. */
export function probeDurationSec(file: File, timeoutMs = 8000): Promise<number | null> {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file)
    const audio = new Audio()
    let settled = false
    const finish = (value: number | null) => { if (!settled) { settled = true; clearTimeout(timer); URL.revokeObjectURL(url); resolve(value) } }
    const timer = setTimeout(() => finish(null), timeoutMs)
    audio.preload = 'metadata'
    audio.onloadedmetadata = () => finish(Number.isFinite(audio.duration) ? audio.duration : null)
    audio.onerror = () => finish(null)
    audio.src = url
  })
}
export function validateDuration(durationSec: number | null, caps: Capabilities): string | null {
  if (durationSec === null || !caps.maxAudioDurationSec) return null
  if (durationSec > caps.maxAudioDurationSec) return `This recording is too long: your recording is ${formatDurationSec(durationSec)}, the limit is ${formatDurationSec(caps.maxAudioDurationSec)} — ${formatDurationSec(durationSec - caps.maxAudioDurationSec)} over the limit.`
  return null
}
export function parseJob(value: unknown): Job {
  const data = value as Job
  if (!data || typeof data.id !== 'string' || !data.id || !['queued', 'transcribing', 'complete', 'error'].includes(data.status)) throw new ServiceError('The service returned an unexpected response. Please try again.')
  const job: Job = { id: data.id, status: data.status }
  if (typeof data.progress === 'number' && Number.isFinite(data.progress) && data.progress >= 0 && data.progress <= 100) job.progress = data.progress
  if (data.status === 'complete') {
    if (!data.result) throw new ServiceError('The score is missing from the result. Please try again.')
    job.result = { musicxmlUrl: artifactUrl(data.result.musicxmlUrl), midiUrl: artifactUrl(data.result.midiUrl), ...(data.result.audioUrl ? { audioUrl: artifactUrl(data.result.audioUrl) } : {}) }
    // Richer metadata is copied only when genuinely present and well-formed;
    // anything missing or malformed is omitted, never invented. (Backend
    // contract: backend/CHANGES_REQUESTED.md 2026-09-20.)
    const raw = data.result as unknown as Record<string, unknown>
    if (typeof raw.engineUsed === 'string' && raw.engineUsed) job.result.engineUsed = raw.engineUsed
    if (typeof raw.durationSec === 'number' && Number.isFinite(raw.durationSec) && raw.durationSec >= 0) job.result.durationSec = raw.durationSec
    else if (raw.durationSec === null) job.result.durationSec = null
    if (typeof raw.transcriptionMs === 'number' && Number.isFinite(raw.transcriptionMs) && raw.transcriptionMs >= 0) job.result.transcriptionMs = Math.round(raw.transcriptionMs)
    if (Array.isArray(raw.detectedInstruments)) {
      const names = raw.detectedInstruments.filter((v): v is string => typeof v === 'string' && v !== '')
      job.result.detectedInstruments = names.length ? names : null
    } else if (raw.detectedInstruments === null) job.result.detectedInstruments = null
    if (raw.metadata && typeof raw.metadata === 'object') {
      const meta = raw.metadata as Record<string, unknown>
      const out: ResultMeta = {}
      if (typeof meta.tempoBpm === 'number' && Number.isFinite(meta.tempoBpm) && meta.tempoBpm > 0) out.tempoBpm = meta.tempoBpm
      if (typeof meta.keyName === 'string' && meta.keyName.trim()) out.keyName = meta.keyName.trim()
      if (Object.keys(out).length) job.result.metadata = out
    }
  }
  if (data.status === 'error') {
    const err = (data as { error?: unknown }).error as { code?: unknown; message?: unknown } | undefined
    if (err && typeof err.code === 'string' && safeErrorCodes.includes(err.code) && typeof err.message === 'string' && err.message) {
      job.error = { code: err.code, message: err.message }
    }
  }
  return job
}
export function upload(file: File, signal: AbortSignal, onProgress: (progress: number) => void, hints?: { instrument?: string; instrumentDetail?: string }): Promise<Job> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const abort = () => xhr.abort()
    xhr.open('POST', `${base}/transcriptions`)
    xhr.timeout = 120000
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100)) }
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) return reject(new ServiceError(message(xhr.status)))
      try { resolve(parseJob(JSON.parse(xhr.responseText))) } catch { reject(new ServiceError('The service returned an unexpected response. Please try again.')) }
    }
    xhr.onerror = xhr.ontimeout = () => reject(new ServiceError(unavailable))
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'))
    xhr.onloadend = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return }
    const form = new FormData()
    form.append('file', file)
    // The chosen instrument hint is always sent (auto = "no hint"). The
    // deployed backend currently ignores unknown fields; the requested shape
    // is documented in BACKEND_REQUESTS.md.
    if (hints?.instrument) form.append('instrument', hints.instrument)
    if (hints?.instrumentDetail) form.append('instrumentDetail', hints.instrumentDetail)
    xhr.send(form)
  })
}
/** Score-aligned playback for a completed job. The deployed backend does not
 *  implement POST /api/artifacts/:id/playback yet (BACKEND_REQUESTS.md), so
 *  the UI keeps the generate-playback control hidden behind
 *  config.PLAYBACK_GENERATION_ENABLED. */
export async function generatePlayback(id: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(`${base}/artifacts/${encodeURIComponent(id)}/playback`, { method: 'POST', signal, headers: { Accept: 'application/json' } })
  if (!response.ok) throw new ServiceError(unavailable)
  return artifactUrl((await response.json() as { audioUrl?: unknown }).audioUrl)
}
export async function getJob(id: string, signal: AbortSignal) { return parseJob(await json(`${base}/transcriptions/${encodeURIComponent(id)}`, signal)) }
export async function cancelJob(id: string): Promise<void> {
  const response = await fetch(`${base}/transcriptions/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Accept: 'application/json' } })
  if (!response.ok) throw new ServiceError(unavailable)
}
export async function getMusicXML(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal, headers: { Accept: 'application/vnd.recordare.musicxml+xml, application/xml' } })
  if (!response.ok) throw new ServiceError('The score could not be loaded. Please try again.')
  const xml = await response.text()
  const parsed = new DOMParser().parseFromString(xml, 'application/xml')
  if (parsed.querySelector('parsererror') || !['score-partwise', 'score-timewise'].includes(parsed.documentElement.tagName)) throw new ServiceError('The score is not valid MusicXML. Please try another recording.')
  return xml
}
export function friendlyError(error: unknown) { return error instanceof ServiceError ? error.message : unavailable }
