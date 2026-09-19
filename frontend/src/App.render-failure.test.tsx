import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import App from './App'

// End-to-end (component-level) proof that a notation failure stays INSIDE the
// manuscript panel: the transcription completed, so the page must not fall
// back to the global error state and the downloads must stay available.
// Only the engraving engine is mocked; the app's own flow is the real one.

vi.mock('verovio/wasm', () => ({ default: vi.fn(async () => ({})) }))
vi.mock('verovio/esm', () => ({
  VerovioToolkit: class {
    setOptions() { return true }
    loadData() { return false } // Verovio refuses the score
    getPageCount() { return 1 }
    renderToSVG() { return '<svg class="definition-scale"/>' }
    getElementsAtTime() { return {} }
    destroy() {}
  },
}))

const MUSIC_XML = "<?xml version='1.0'?><score-partwise version='4.0'><part id='P1'/></score-partwise>"

function stubAudioDecoder(duration = 30) {
  class FakeAudio {
    onloadedmetadata: (() => void) | null = null
    onerror: (() => void) | null = null
    preload = ''
    readonly duration = duration
    set src(_value: string) { queueMicrotask(() => this.onloadedmetadata?.()) }
  }
  vi.stubGlobal('Audio', FakeAudio)
}

it('keeps the page usable and skips the global error when the score cannot be engraved', async () => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
    if (url === '/api/capabilities') {
      return Response.json({ formats: ['mp3', 'wav', 'flac'], maxUploadBytes: 1024 * 1024, engine: { name: 'stub', mock: true, available: true } })
    }
    if (url === '/api/transcriptions/job-1') {
      return Response.json({ id: 'job-1', status: 'complete', progress: 100, result: { musicxmlUrl: '/api/artifacts/job-1/musicxml', midiUrl: '/api/artifacts/job-1/midi' } })
    }
    return new Response(MUSIC_XML, { status: 200, headers: { 'Content-Type': 'application/vnd.recordare.musicxml+xml' } })
  }))

  const xhr = { open: vi.fn(), upload: {} as { onprogress: (e: object) => void }, send: vi.fn(), abort: vi.fn(), status: 202, responseText: '{"id":"job-1","status":"queued"}', onload: () => {}, onloadend: () => {} }
  vi.stubGlobal('XMLHttpRequest', class { constructor() { return xhr } })
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:recording'), revokeObjectURL: vi.fn() }))
  stubAudioDecoder()

  render(<App />)
  const input = screen.getByLabelText('Choose audio recording')
  await waitFor(() => expect(input).toBeEnabled())
  fireEvent.change(input, { target: { files: [new File(['audio'], 'melody.wav')] } })
  await screen.findByText('Recording selected')
  fireEvent.click(screen.getByRole('button', { name: 'Create sheet music' }))
  xhr.onload()
  xhr.onloadend()

  // The inline, cause-free message appears inside the manuscript panel...
  expect(await screen.findByRole('alert', {}, { timeout: 8000 })).toHaveTextContent(
    'The notation could not be displayed for this recording. You can still download your files below.',
  )
  // ...and the page-level error state is NOT triggered.
  expect(screen.queryByText('Something needs attention')).not.toBeInTheDocument()
  expect(screen.queryByText(/invalid score format/i)).not.toBeInTheDocument()
  // Downloads survive a rendering failure, and the "Ready to read" badge is not claimed.
  expect(screen.getByRole('link', { name: /Download MIDI/ })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: /Download MusicXML/ })).toBeInTheDocument()
  expect(screen.queryByText('Ready to read')).not.toBeInTheDocument()
}, 20000)