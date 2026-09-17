// TEST ONLY: minimal implementation of frontend/BACKEND_CONTRACT.md so the
// browser suite can exercise the real HTTP path. This is NOT the product
// backend and serves no purpose outside `npm run test:e2e`.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
const xml = readFileSync(new URL('./fixtures/score.musicxml', import.meta.url))
const wav = () => {
  const data = Buffer.alloc(44 + 16000 * 2 * 4)
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(data.length - 44, 40)
  return data
}
let polls = 0
createServer((req, res) => {
  const path = new URL(req.url, 'http://mock').pathname
  const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type }); res.end(body) }
  if (req.method === 'GET' && path === '/api/capabilities') return send(200, JSON.stringify({ formats: ['mp3', 'wav', 'flac'], maxUploadBytes: 20 * 1024 * 1024 }))
  if (req.method === 'POST' && path === '/api/transcriptions') {
    req.resume()
    return req.on('end', () => setTimeout(() => send(202, JSON.stringify({ id: 'mock-job-1', status: 'queued' })), 250))
  }
  if (path === '/api/transcriptions/mock-job-1') {
    if (++polls === 1) return send(200, JSON.stringify({ id: 'mock-job-1', status: 'transcribing', progress: 40 }))
    return send(200, JSON.stringify({ id: 'mock-job-1', status: 'complete', result: { musicxmlUrl: '/api/artifacts/mock-job-1/musicxml', midiUrl: '/api/artifacts/mock-job-1/midi', audioUrl: '/api/artifacts/mock-job-1/audio' } }))
  }
  if (path.endsWith('/musicxml')) return send(200, xml, 'application/vnd.recordare.musicxml+xml')
  if (path.endsWith('/midi')) return send(200, Buffer.from('4d546864000000060000000100604d54726b0000000400ff2f00', 'hex'), 'audio/midi')
  if (path.endsWith('/audio')) return send(200, wav(), 'audio/wav')
  send(404, '{}')
}).listen(8791, '127.0.0.1', () => console.log('mock contract server on http://127.0.0.1:8791'))
