import { useEffect, useRef, useState } from 'react'
import { ENABLE_NOTE_HIGHLIGHTING } from './config'
const clock = (time: number) => `${Math.floor(time / 60)}:${String(Math.floor(time % 60)).padStart(2, '0')}`
/**
 * `onTimeMs` is the time source for note highlighting. It is optional and is
 * only passed by the parent when ENABLE_NOTE_HIGHLIGHTING is true; when it is
 * absent, no listener and no animation frame loop are attached.
 */
export default function Playback({ src, generated, onTimeMs }: { src: string; generated: boolean; onTimeMs?: (ms: number) => void }) {
  const audio = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [duration, setDuration] = useState(0)
  const [position, setPosition] = useState(0)
  const [volume, setVolume] = useState(0.8)
  const [error, setError] = useState('')
  useEffect(() => {
    setPlaying(false); setDuration(0); setPosition(0); setError('')
    if (audio.current) audio.current.volume = 0.8
    setVolume(0.8)
    onTimeMs?.(0)
  }, [src, onTimeMs])
  // Drives smooth highlighting while playing. Dormant when onTimeMs is absent.
  useEffect(() => {
    if (!onTimeMs || !playing) return
    let frame = requestAnimationFrame(function tick() {
      const element = audio.current
      if (element) onTimeMs(element.currentTime * 1000)
      frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  }, [onTimeMs, playing])
  async function toggle() {
    if (!audio.current) return
    if (playing) audio.current.pause()
    else { try { await audio.current.play(); setError('') } catch { setError('Playback could not start. Your browser may not support this audio format.') } }
  }
  return <section className="playback" aria-label="Playback">
    <audio ref={audio} src={src} preload="metadata" onLoadedMetadata={() => setDuration(Number.isFinite(audio.current!.duration) ? audio.current!.duration : 0)} onTimeUpdate={() => { const current = audio.current!.currentTime; setPosition(current); onTimeMs?.(current * 1000) }} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onError={() => { setPlaying(false); setError('This audio cannot be played in your browser. Your score and exports are still available.') }} />
    <div className="playback-heading"><strong>{generated ? 'Transcribed playback' : 'Original recording'}</strong><span>{ENABLE_NOTE_HIGHLIGHTING ? 'Note highlighting enabled' : 'No note-following data available'}</span></div>
    <div className="transport"><button className="primary play" aria-label={playing ? 'Pause' : 'Play'} onClick={toggle}>{playing ? 'Ⅱ' : '▶'}</button><button onClick={() => { if (audio.current) { audio.current.currentTime = 0; setPosition(0) } }} aria-label="Restart">↺</button><label className="seek"><span className="sr-only">Playback position</span><input type="range" min="0" max={duration || 1} step="0.1" value={position} disabled={!duration} onChange={event => { const time = Number(event.target.value); if (audio.current) audio.current.currentTime = time; setPosition(time) }} /></label><output className="time" aria-label="Current position">{clock(position)} / {clock(duration)}</output><label className="volume">Volume<input type="range" min="0" max="1" step="0.01" value={volume} onChange={event => { const next = Number(event.target.value); setVolume(next); if (audio.current) audio.current.volume = next }} /></label></div>
    {error && <p role="alert" className="error-text">{error}</p>}
  </section>
}

