import { useEffect, useMemo, useRef, useState } from 'react'
import type { Project } from '../state/types'
import { engine } from '../audio/engine'
import { setUi } from '../state/store'
import { audioBufferToWav, downloadBlob, renderProject } from '../audio/render'
import { exportProjectZip } from '../state/projectFiles'
import { toast } from '../state/store'
import { formatBytes } from '../state/storage'

/**
 * Read-only shared project player: play/pause, per-track mute & solo and
 * downloads. Rendering happens locally, so a link works with no server.
 */
export default function SharedPlayer({ project, onExit }: { project: Project; onExit: () => void }) {
  const [mutes, setMutes] = useState<Record<string, boolean>>({})
  const [solo, setSolo] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const [busy, setBusy] = useState('')
  const [mixUrl, setMixUrl] = useState<string | null>(null)
  const [mixSize, setMixSize] = useState(0)
  const raf = useRef(0)

  const view = useMemo<Project>(() => {
    const tracks = project.tracks.map((t) => ({
      ...t,
      mute: mutes[t.id] ?? t.mute,
      solo: solo ? t.id === solo : false,
    }))
    return { ...project, tracks, loop: { ...project.loop, enabled: false } }
  }, [project, mutes, solo])

  useEffect(() => {
    void engine.start().then(() => {
      engine.sync(view)
      engine.seek(0)
    })
    return () => {
      engine.stop()
      cancelAnimationFrame(raf.current)
    }
  }, [])

  useEffect(() => {
    engine.sync(view)
  }, [view])

  useEffect(() => {
    const tick = () => {
      setPosition(engine.getBeat())
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [])

  const toggle = async () => {
    if (playing) {
      engine.stop()
      setPlaying(false)
    } else {
      await engine.start()
      engine.play()
      setPlaying(true)
    }
  }

  const beatToTime = (beat: number) => {
    const s = (beat * 60) / project.bpm
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
  }

  const downloadMix = async () => {
    setBusy('mix')
    try {
      const buf = await renderProject(view)
      const blob = audioBufferToWav(buf, { bitDepth: 24 })
      if (mixUrl) URL.revokeObjectURL(mixUrl)
      setMixUrl(URL.createObjectURL(blob))
      setMixSize(blob.size)
      downloadBlob(blob, `${project.name.replace(/\W+/g, '_')} - mix.wav`)
      toast('Mix rendered and downloaded', 'ok')
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Render failed', 'err')
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="share-player">
      <header className="share-head">
        <div>
          <span className="badge">Shared project · read only</span>
          <h1>{project.name}</h1>
          <p className="dim">
            {project.bpm} BPM · {project.keyRoot} {project.keyScale} · {project.tracks.length} tracks · made with ILS
          </p>
        </div>
        <button className="btn" onClick={onExit}>
          Open in the studio
        </button>
      </header>
      <div className="share-transport">
        <button className="btn gold" onClick={() => void toggle()} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <span className="mono">
          {beatToTime(position)} / {beatToTime(project.length)}
        </span>
        <input
          type="range"
          min={0}
          max={project.length}
          value={position}
          aria-label="Seek"
          onChange={(e) => engine.seek(Number(e.target.value))}
        />
      </div>
      <div className="share-tracks">
        {project.tracks.map((t) => (
          <div key={t.id} className="share-track">
            <span className="share-track-name" style={{ color: t.color }}>
              {t.name}
            </span>
            <div className="row gap">
              <button
                className={`chip tiny ${mutes[t.id] ? 'on' : ''}`}
                aria-pressed={!!mutes[t.id]}
                onClick={() => setMutes((m) => ({ ...m, [t.id]: !m[t.id] }))}
              >
                M
              </button>
              <button
                className={`chip tiny ${solo === t.id ? 'on' : ''}`}
                aria-pressed={solo === t.id}
                onClick={() => setSolo((s) => (s === t.id ? null : t.id))}
              >
                S
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="share-downloads">
        <button className="btn" onClick={() => void downloadMix()} disabled={!!busy}>
          {busy === 'mix' ? 'Rendering mix…' : 'Download mix (WAV)'}
        </button>
        <button
          className="btn"
          disabled={!!busy}
          onClick={async () => {
            setBusy('zip')
            try {
              await exportProjectZip({ stems: true, mix: true, midi: true })
            } finally {
              setBusy('')
            }
          }}
        >
          {busy === 'zip' ? 'Packing stems…' : 'Download stems + MIDI (zip)'}
        </button>
        {mixUrl && (
          <a className="link" href={mixUrl} download={`${project.name}.wav`}>
            Mix ready · {formatBytes(mixSize)}
          </a>
        )}
      </div>
      <footer className="dim small">
        <p>
          ILS – Infinite Lab Studio is a product of <strong>Building Billions LLC</strong>.
        </p>
        <p>Playback uses the instruments in this browser — install the sound packs once and the player works offline too.</p>
        <p>© 2026 Building Billions LLC. All rights reserved.</p>
      </footer>
    </div>
  )
}

export function enterStudioFromShare(): void {
  setUi({ modal: null })
}
