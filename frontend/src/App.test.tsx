import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { it, expect, vi } from 'vitest'
import App from './App'
import Playback from './Playback'

// jsdom never fires audio metadata events; stub a decoder that reports
// duration immediately (this is a test stub for the DOM API, not a mock of
// backend data).
function stubAudioDecoder(duration: number | null = 60) {
  class FakeAudio {
    onloadedmetadata: (() => void) | null = null
    onerror: (() => void) | null = null
    preload = ''
    readonly duration = duration ?? 0
    set src(_value: string) {
      queueMicrotask(() => { if (duration === null) this.onerror?.(); else this.onloadedmetadata?.() })
    }
  }
  vi.stubGlobal('Audio', FakeAudio)
}
it('shows an honest error for a 503 without leaking a stack-trace body', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('private stack trace', { status: 503 })))
  render(<App />)
  expect(await screen.findByText('Transcription isn’t connected yet')).toBeInTheDocument()
  expect(screen.queryByText(/private stack trace/)).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Choose a recording' })).toBeDisabled()
})
it('keeps uploads disabled when the backend is unavailable', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('internal path')))
  render(<App />)
  expect(await screen.findByText('Transcription isn’t connected yet')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Choose a recording' })).toBeDisabled()
  expect(screen.queryByText('Transcribing your recording')).not.toBeInTheDocument()
})
it('validates dropped files and selects a recording without uploading', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ formats: ['mp3', 'wav', 'flac'], maxUploadBytes: 1024 * 1024 }))
  vi.stubGlobal('fetch', fetch)
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:recording'), revokeObjectURL: vi.fn() }))
  stubAudioDecoder(42)
  render(<App />)
  const input = screen.getByLabelText('Choose audio recording')
  await waitFor(() => expect(input).toBeEnabled())
  fireEvent.change(input, { target: { files: [new File(['x'], 'bad.txt')] } })
  expect(screen.getByRole('alert')).toHaveTextContent('Choose a MP3, WAV, FLAC')
  fireEvent.drop(screen.getByText('Let your music begin here').parentElement!, { dataTransfer: { files: [new File(['audio'], 'melody.wav')] } })
  await screen.findByText('Recording selected')
  expect(screen.getByRole('button', { name: 'Create sheet music' })).toBeEnabled()
  expect(fetch).toHaveBeenCalledTimes(1)
})
it('rejects recordings longer than the advertised duration limit', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ formats: ['wav'], maxUploadBytes: 1024 * 1024, maxAudioDurationSec: 60 }))
  vi.stubGlobal('fetch', fetch)
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:recording'), revokeObjectURL: vi.fn() }))
  stubAudioDecoder(600)
  render(<App />)
  const input = screen.getByLabelText('Choose audio recording')
  await waitFor(() => expect(input).toBeEnabled())
  fireEvent.change(input, { target: { files: [new File(['audio'], 'epic.wav')] } })
  expect(await screen.findByRole('alert')).toHaveTextContent('too long')
  expect(screen.getByRole('button', { name: 'Create sheet music' })).toBeDisabled()
})
it('surfaces the backend reason when the transcription engine is unavailable', async () => {
  const reason = 'HF_TOKEN is missing. Create backend/.env with HF_TOKEN and accept the MuScriptor model license on Hugging Face.'
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
    formats: ['wav', 'mp3', 'flac'],
    maxUploadBytes: 1024 * 1024,
    engine: { name: 'muscriptor', mock: false, available: false, reason },
  })))
  render(<App />)
  // The notice renders the reason followed by "No recording has been uploaded."
  expect(await screen.findByText(reason, { exact: false })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Choose a recording' })).toBeDisabled()
})
it('labels results honestly when the backend runs its labeled mock engine', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
    formats: ['wav'],
    maxUploadBytes: 1024 * 1024,
    engine: { name: 'stub', mock: true, available: true },
  })))
  render(<App />)
  expect(await screen.findByText('Demo engine active')).toBeInTheDocument()
  expect(screen.getByText(/synthetic fixture data/i)).toBeInTheDocument()
})
it('reflects audio play/pause, seeking, restart and volume events', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function(this: HTMLMediaElement) { this.dispatchEvent(new Event('play')); return Promise.resolve() })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function(this: HTMLMediaElement) { this.dispatchEvent(new Event('pause')) })
  const { container } = render(<Playback src="/api/audio" generated />)
  const audio = container.querySelector('audio')!
  Object.defineProperty(audio, 'duration', { value: 90 })
  fireEvent.loadedMetadata(audio)
  fireEvent.click(screen.getByRole('button', { name: 'Play' }))
  await screen.findByRole('button', { name: 'Pause' })
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
  expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Playback position'), { target: { value: '30' } })
  expect(audio.currentTime).toBe(30)
  expect(screen.getByLabelText('Current position')).toHaveTextContent('0:30 / 1:30')
  fireEvent.change(screen.getByLabelText('Volume'), { target: { value: '0.3' } })
  expect(audio.volume).toBe(0.3)
  fireEvent.click(screen.getByRole('button', { name: 'Restart' }))
  expect(audio.currentTime).toBe(0)
  fireEvent.error(audio)
  expect(screen.getByRole('alert')).toHaveTextContent('cannot be played')
})
it('stop waiting cancels the job and stops polling', async () => {
  const pollCycleMs = 1500
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(Response.json({ formats: ['mp3', 'wav', 'flac'], maxUploadBytes: 1024 * 1024 }))
    .mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Response(JSON.stringify({ id: 'job-1', status: 'error', error: { code: 'cancelled', message: 'cancelled' } }), { status: 200 })
      return Response.json({ id: 'job-1', status: 'transcribing', progress: 40 })
    }))
  const xhr = { open: vi.fn(), upload: {} as { onprogress: (e: object) => void }, send: vi.fn(), abort: vi.fn(), status: 202, responseText: '{"id":"job-1","status":"queued"}', onload: () => {}, onloadend: () => {} }
  vi.stubGlobal('XMLHttpRequest', class { constructor() { return xhr } })
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:recording'), revokeObjectURL: vi.fn() }))
  stubAudioDecoder(30)
  render(<App />)
  const input = screen.getByLabelText('Choose audio recording')
  await waitFor(() => expect(input).toBeEnabled())
  fireEvent.change(input, { target: { files: [new File(['audio'], 'melody.wav')] } })
  await screen.findByText('Recording selected')
  fireEvent.click(screen.getByRole('button', { name: 'Create sheet music' }))
  xhr.onload(); xhr.onloadend()
  await screen.findByText(/Transcribing your recording/, {}, { timeout: 5000 })
  fireEvent.click(screen.getByRole('button', { name: 'Stop waiting' }))
  await screen.findByText('Recording selected')
  expect(screen.getByText(/Stopped waiting here/)).toBeInTheDocument()
  const fetchMock = fetch as ReturnType<typeof vi.fn>
  expect(fetchMock).toHaveBeenCalledWith('/api/transcriptions/job-1', expect.objectContaining({ method: 'DELETE' }))
  const pollCalls = () => fetchMock.mock.calls.filter(([url, init]) => url === '/api/transcriptions/job-1' && (!init || (init as RequestInit).method === undefined)).length
  const before = pollCalls()
  await new Promise(resolve => setTimeout(resolve, pollCycleMs + 200))
  expect(pollCalls()).toBe(before)
}, 15000)
