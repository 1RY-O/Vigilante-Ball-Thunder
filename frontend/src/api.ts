export interface EngineInfo { name?: string; mock?: boolean; available?: boolean; reason?: string; model?: string }
export interface Capabilities { formats: string[]; maxUploadBytes: number; engine?: EngineInfo; maxAudioDurationSec?: number }
export interface Result { musicxmlUrl: string; midiUrl: string; audioUrl?: string }
export interface Job { id: string; status: 'queued' | 'transcribing' | 'complete' | 'error'; progress?: number; result?: Result; error?: { code: string; message: string } }
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
  // Honesty gate: an engine that reports itself unavailable (e.g. missing
  // HF token / gated MuScriptor weights) must surface as an error, not as
  // an enabled upload flow.
  if (data.engine && data.engine.available === false) {
    throw new ServiceError(typeof data.engine.reason === 'string' && data.engine.reason ? data.engine.reason : unavailable)
  }
  const caps: Capabilities = { formats: supported, maxUploadBytes: data.maxUploadBytes }
  if (data.engine && typeof data.engine === 'object') caps.engine = data.engine
  if (Number.isSafeInteger(data.maxAudioDurationSec) && (data.maxAudioDurationSec ?? 0) > 0) caps.maxAudioDurationSec = data.maxAudioDurationSec
  return caps
}
export function validateFile(file: File, caps: Capabilities): string | null {
  if (!caps.formats.includes(file.name.split('.').pop()?.toLowerCase() ?? '')) return `Choose a ${caps.formats.map(f => f.toUpperCase()).join(', ')} recording.`
  if (!file.size) return 'This file is empty. Please choose a recording with audio.'
  if (file.size > caps.maxUploadBytes) return `This recording is too large. The limit is ${Math.floor(caps.maxUploadBytes / 1024 / 1024)} MB.`
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
  if (durationSec > caps.maxAudioDurationSec) {
    const min = Math.round(caps.maxAudioDurationSec / 60)
    return `This recording is too long. The limit is ${min} minute${min === 1 ? '' : 's'}.`
  }
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
  }
  if (data.status === 'error') {
    const err = (data as { error?: unknown }).error as { code?: unknown; message?: unknown } | undefined
    if (err && typeof err.code === 'string' && safeErrorCodes.includes(err.code) && typeof err.message === 'string' && err.message) {
      job.error = { code: err.code, message: err.message }
    }
  }
  return job
}
export function upload(file: File, signal: AbortSignal, onProgress: (progress: number) => void): Promise<Job> {
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
    xhr.send(form)
  })
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
