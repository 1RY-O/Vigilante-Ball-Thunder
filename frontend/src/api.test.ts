import { describe, expect, it, vi } from 'vitest'
import { artifactUrl, cancelJob, capabilities, friendlyError, getMusicXML, parseJob, upload, validateDuration, validateFile } from './api'
const caps = { formats: ['mp3', 'wav', 'flac'], maxUploadBytes: 1024 * 1024 }
describe('recording validation', () => {
  it.each(['mp3', 'WAV', 'flac'])('accepts supported %s files', extension => { expect(validateFile(new File(['sound'], `melody.${extension}`), caps)).toBeNull() })
  it('rejects empty, unsupported, and oversized files', () => {
    expect(validateFile(new File([], 'empty.mp3'), caps)).toMatch(/empty/)
    expect(validateFile(new File(['x'], 'song.exe'), caps)).toMatch(/Choose a/)
    expect(validateFile(new File([new Uint8Array(caps.maxUploadBytes + 1)], 'long.wav'), caps)).toMatch(/too large/)
  })
})
describe('API boundary', () => {
  it('uses only formats confirmed by the service', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...caps, formats: ['wav', 'ogg'] })))
    expect((await capabilities()).formats).toEqual(['wav'])
  })
  it('does not expose server errors or internal paths', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('secret /srv/private traceback', { status: 500 })))
    await expect(capabilities()).rejects.toThrow('service is unavailable')
    expect(friendlyError(new Error('secret'))).not.toContain('secret')
  })
  it('returns settled engine failures to the caller instead of throwing (App renders them)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...caps, engine: { name: 'muscriptor', mock: false, available: false, checking: false, reason: 'HF_TOKEN is missing. Accept the model license and configure .env.' } })))
    const result = await capabilities()
    expect(result.engine?.available).toBe(false)
    expect(result.engine?.reason).toMatch('HF_TOKEN is missing')
  })
  it('returns warming-up state to the caller instead of throwing (App polls)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...caps, engine: { name: 'muscriptor', mock: false, available: false, checking: true, code: 'engine-warming-up', reason: 'Engine is warming up.' } })))
    const result = await capabilities()
    expect(result.engine?.available).toBe(false)
    expect(result.engine?.checking).toBe(true)
    expect(result.engine?.code).toBe('engine-warming-up')
  })
  it('passes through mock-engine labeling and duration limits', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...caps, engine: { name: 'stub', mock: true, available: true }, maxAudioDurationSec: 600 })))
    const result = await capabilities()
    expect(result.engine?.mock).toBe(true)
    expect(result.maxAudioDurationSec).toBe(600)
  })
  it('duration gate: over-limit recordings rejected, undecodable allowed (backend enforces)', () => {
    const withLimit = { ...caps, maxAudioDurationSec: 60 }
    expect(validateDuration(600, withLimit)).toMatch(/too long/)
    expect(validateDuration(30, withLimit)).toBeNull()
    expect(validateDuration(null, withLimit)).toBeNull()
    expect(validateDuration(600, caps)).toBeNull() // no advertised limit -> no client gate
  })
  it('surfaces a curated job-error message only for known safe codes', () => {
    expect(parseJob({ id: '1', status: 'error', error: { code: 'engine-unavailable', message: 'The engine could not run.' } }).error?.message).toBe('The engine could not run.')
    expect(parseJob({ id: '1', status: 'error', error: { code: 'cancelled', message: 'The transcription was cancelled.' } }).error?.message).toBe('The transcription was cancelled.')
    // Unknown codes must NOT leak their payload through the UI.
    expect(parseJob({ id: '1', status: 'error', error: { code: 'weird', message: '/srv/private traceback' } }).error).toBeUndefined()
  })
  it('cancels a job via DELETE', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(cancelJob('job-1')).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith('/api/transcriptions/job-1', { method: 'DELETE', headers: { Accept: 'application/json' } })
  })
  it('validates complete results and optional progress', () => {
    expect(parseJob({ id: '1', status: 'transcribing', progress: 25 })).toEqual({ id: '1', status: 'transcribing', progress: 25 })
    expect(parseJob({ id: '1', status: 'queued', progress: 200 }).progress).toBeUndefined()
    expect(parseJob({ id: '1', status: 'complete', result: { musicxmlUrl: '/api/files/score', midiUrl: '/api/files/midi' } }).result?.musicxmlUrl).toContain('/api/files/score')
    expect(() => parseJob({ id: '1', status: 'complete' })).toThrow()
    expect(() => parseJob({ id: '1', status: 'invented' })).toThrow()
  })
  it.each(['https://example.com/secret', 'javascript:alert(1)', '/api/../../secret', '//evil.test/a'])('rejects unsafe artifact URL %s', url => { expect(() => artifactUrl(url)).toThrow() })
  it('rejects malformed notation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>not music</html>')))
    await expect(getMusicXML('/api/score', new AbortController().signal)).rejects.toThrow('not valid MusicXML')
  })
  it('sends multipart audio and reports actual upload progress', async () => {
    const xhr = { open: vi.fn(), upload: {} as { onprogress: (e: object) => void }, send: vi.fn(), abort: vi.fn(), status: 202, responseText: '{"id":"1","status":"queued"}', onload: () => {}, onloadend: () => {} }
    vi.stubGlobal('XMLHttpRequest', class { constructor() { return xhr } })
    const progress = vi.fn()
    const promise = upload(new File(['audio'], 'song.wav'), new AbortController().signal, progress)
    expect(xhr.open).toHaveBeenCalledWith('POST', '/api/transcriptions')
    expect(xhr.send.mock.calls[0][0].get('file').name).toBe('song.wav')
    xhr.upload.onprogress({ lengthComputable: true, loaded: 5, total: 10 })
    expect(progress).toHaveBeenCalledWith(50)
    xhr.onload(); xhr.onloadend()
    await expect(promise).resolves.toEqual({ id: '1', status: 'queued' })
  })
})
