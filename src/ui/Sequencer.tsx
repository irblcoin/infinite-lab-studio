import { useEffect, useMemo, useRef, useState } from 'react'
import type { Clip, Track } from '../state/types'
import { clamp, makeClip } from '../state/types'
import { getState, mutate, pushHistory, setUi, useProject, useUi, toast } from '../state/store'
import {
  addClip,
  addMarker,
  addTrack,
  deleteClip,
  deleteTrack,
  duplicateClip,
  duplicateTrack,
  findClip,
  findTrack,
  freezeTrack,
  importAudioFile,
  moveTrack,
  quantizeClip,
  removeMarker,
  renameTrack,
  reorderTrack,
  setLoop,
  splitClipAt,
  toggleArm,
  toggleMute,
  toggleSolo,
  dropLibraryItem,
  updateClip,
} from '../state/actions'
import { engine } from '../audio/engine'
import { getBuffer, peaksFor, onBuffer } from '../audio/assets'
import { useBeat } from './beatTicker'
import EditorPane from './Editor'

const HEADER_W = 216
const ROW_H = 92

function Playhead({ zoom }: { zoom: number }) {
  const beat = useBeat()
  const project = useProject()
  return (
    <div
      className="playhead"
      style={{ left: HEADER_W + beat * zoom, height: `calc(100% - 30px)`, top: 30 }}
      title={`Playhead beat ${beat.toFixed(2)}`}
    >
      <div className="playhead-head" />
      <div className="playhead-line" />
      <span className="playhead-label">{Math.floor(Math.max(0, beat) / (project.timeSig[0] || 4)) + 1}</span>
    </div>
  )
}

function Waveform({ clip, width }: { clip: Clip; width: number }) {
  const [, force] = useState(0)
  const id = clip.takes?.length && clip.activeTake != null ? clip.takes[clip.activeTake]?.assetId : clip.assetId || clip.libId
  const buf = getBuffer(id)
  useMemo(() => {
    if (!buf && id) {
      const off = onBuffer(id, () => force((v) => v + 1))
      return off
    }
    return undefined
  }, [id, buf])
  if (!buf) return <div className="clip-wave-empty">audio</div>
  const peaks = peaksFor(buf, Math.max(40, Math.min(400, Math.round(width / 3))))
  const mid = 24
  return (
    <svg className="clip-wave" width={width} height={52} preserveAspectRatio="none" viewBox={`0 0 ${width} 52`}>
      {peaks.map((p, i) => {
        const h = Math.max(1, p * 46)
        return <rect key={i} x={(i / peaks.length) * width} y={mid - h / 2} width={Math.max(1, width / peaks.length - 0.5)} height={h} fill="rgba(255,255,255,0.5)" />
      })}
    </svg>
  )
}

function ClipView({ track, clip }: { track: Track; clip: Clip }) {
  const ui = useUi()
  const width = Math.max(12, clip.len * ui.zoom)
  const selected = ui.selectedClipIds.includes(clip.id)
  const dragRef = useRef<{ mode: 'move' | 'left' | 'right'; x: number; y: number; start: number; len: number; trackId: string } | null>(null)

  const beginDrag = (e: React.PointerEvent, mode: 'move' | 'left' | 'right') => {
    e.stopPropagation()
    if (e.button !== 0) return
    pushHistory()
    const ids = e.shiftKey ? Array.from(new Set([...ui.selectedClipIds, clip.id])) : [clip.id]
    setUi({ selectedClipIds: ids, selectedTrackId: track.id })
    dragRef.current = { mode, x: e.clientX, y: e.clientY, start: clip.start, len: clip.len, trackId: track.id }
    const snap = (v: number) => (ui.snap > 0 ? Math.round(v / ui.snap) * ui.snap : v)
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      const dx = (ev.clientX - d.x) / ui.zoom
      if (mode === 'move') {
        const newStart = Math.max(0, snap(d.start + dx))
        updateClip(clip.id, { start: newStart })
        const rows = document.querySelectorAll('.tl-row')
        let target: string | null = null
        rows.forEach((row, i) => {
          const r = row.getBoundingClientRect()
          if (ev.clientY >= r.top && ev.clientY <= r.bottom) {
            const t = getState().project.tracks[i]
            if (t && (t.kind !== 'group')) target = t.id
          }
        })
        if (target && target !== d.trackId) {
          const newTrackId = target
          const state = getState()
          const found = findClip(state.project, clip.id)
          if (found && found.track.kind !== 'group') {
            mutate((p) => {
              const src = p.tracks.find((t) => t.id === found.track.id)
              const dst = p.tracks.find((t) => t.id === newTrackId)
              if (!src || !dst) return
              src.clips = src.clips.filter((c) => c.id !== clip.id)
              dst.clips.push(found.clip)
            })
            d.trackId = newTrackId
            setUi({ selectedTrackId: newTrackId })
          }
        }
      } else if (mode === 'right') {
        const len = Math.max(0.25, snap(d.len + dx))
        updateClip(clip.id, {
          len,
          loop: clip.kind === 'midi' ? len > clip.contentLen + 0.01 || clip.loop : clip.loop,
        })
      } else {
        const newStart = clamp(snap(d.start + dx), 0, d.start + d.len - 0.25)
        const len = Math.max(0.25, d.len - (newStart - d.start))
        updateClip(clip.id, { start: newStart, len })
      }
    }
    const onUp = () => {
      dragRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  const openMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setUi({
      selectedClipIds: [clip.id],
      selectedTrackId: track.id,
      contextMenu: {
        x: e.clientX,
        y: e.clientY,
        items: [
          { label: 'Open in editor', action: () => setUi({ editor: track.kind === 'drum' ? 'drum' : 'piano' }) },
          { label: 'Split at playhead', action: () => splitClipAt(clip.id, engine.getBeat()) },
          { label: 'Duplicate', action: () => duplicateClip(clip.id) },
          { label: `Quantize 1/16`, action: () => quantizeClip(clip.id, 0.25) },
          { label: 'Loop clip', action: () => updateClip(clip.id, { loop: !clip.loop }, true) },
          {
            label: clip.reverse ? 'Un-reverse' : 'Reverse',
            action: () => updateClip(clip.id, { reverse: !clip.reverse }, true),
          },
          { label: 'Pitch +12', action: () => updateClip(clip.id, { pitch: clip.pitch + 12 }, true) },
          { label: 'Pitch -12', action: () => updateClip(clip.id, { pitch: clip.pitch - 12 }, true) },
          { label: 'Fade in 1 beat', action: () => updateClip(clip.id, { fadeIn: 1 }, true) },
          { label: 'Fade out 1 beat', action: () => updateClip(clip.id, { fadeOut: 1 }, true) },
          { label: 'Clear fades', action: () => updateClip(clip.id, { fadeIn: 0, fadeOut: 0 }, true) },
          ...(clip.kind === 'audio' && clip.takes?.length ? [{ label: 'Takes & comping', action: () => setUi({ modal: 'takes' }) }] : []),
          { label: 'Delete clip', action: () => deleteClip(clip.id), danger: true },
        ],
      },
    })
  }

  return (
    <div
      className={`clip ${selected ? 'selected' : ''} ${clip.kind}`}
      style={{
        left: clip.start * ui.zoom,
        width,
        borderColor: selected ? '#f2e3bf' : track.color,
        background: `linear-gradient(180deg, ${track.color}3d, ${track.color}14)`,
      }}
      onPointerDown={(e) => beginDrag(e, 'move')}
      onContextMenu={openMenu}
      onDoubleClick={(e) => {
        e.stopPropagation()
        setUi({ selectedClipIds: [clip.id], selectedTrackId: track.id, editor: track.kind === 'drum' ? 'drum' : 'piano' })
      }}
      title={`${clip.name} — ${clip.len.toFixed(2)} beats${clip.loop ? ' (looped)' : ''}`}
    >
      <div className="clip-title">
        <span className="clip-name">{clip.name}</span>
        {clip.loop && <span className="clip-flag">loop</span>}
      </div>
      <div className="clip-content">
        {clip.kind === 'midi' ? (
          <div className="clip-notes">
            {(() => {
              const pitches = clip.notes.map((n) => n.pitch)
              const lo = pitches.length ? Math.min(...pitches) : 36
              const hi = pitches.length ? Math.max(...pitches) : 60
              const span = Math.max(7, hi - lo)
              const content = Math.max(0.25, clip.contentLen)
              return clip.notes.slice(0, 260).map((n) => {
                const left = (n.start / content) * 100
                if (left > 99) return null
                return (
                  <span
                    key={n.id}
                    className="clip-note"
                    style={{
                      left: `${left}%`,
                      width: `${Math.max(0.6, (n.len / content) * 100)}%`,
                      top: `${clamp(88 - ((n.pitch - lo) / span) * 78, 3, 92)}%`,
                      opacity: 0.3 + n.vel * 0.6,
                    }}
                  />
                )
              })
            })()}
          </div>
        ) : (
          <Waveform clip={clip} width={Math.max(20, width - 8)} />
        )}
      </div>
      {clip.fadeIn > 0 && <div className="clip-fade in" style={{ width: Math.min(50, (clip.fadeIn / clip.len) * 100) + '%' }} />}
      {clip.fadeOut > 0 && <div className="clip-fade out" style={{ width: Math.min(50, (clip.fadeOut / clip.len) * 100) + '%' }} />}
      <div className="clip-handle left" onPointerDown={(e) => beginDrag(e, 'left')} title="Trim clip start" />
      <div className="clip-handle right" onPointerDown={(e) => beginDrag(e, 'right')} title="Resize / loop clip" />
    </div>
  )
}

function TrackHead({ track, index }: { track: Track; index: number }) {
  const ui = useUi()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(track.name)
  const selected = ui.selectedTrackId === track.id
  const inst = track.devices[0]

  return (
    <div
      className={`tl-track-head ${selected ? 'selected' : ''}`}
      style={{ borderLeftColor: track.color }}
      onPointerDown={() => setUi({ selectedTrackId: track.id, selectedClipIds: [] })}
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/ils-track', String(index))}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        const from = Number(e.dataTransfer.getData('text/ils-track'))
        if (!Number.isNaN(from) && e.dataTransfer.getData('text/ils-track')) reorderTrack(from, index)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        setUi({
          contextMenu: {
            x: e.clientX,
            y: e.clientY,
            items: [
              { label: 'Rename track', action: () => setEditing(true) },
              { label: 'Duplicate track', action: () => duplicateTrack(track.id) },
              { label: 'Move up', action: () => moveTrack(track.id, -1) },
              { label: 'Move down', action: () => moveTrack(track.id, 1) },
              { label: track.frozenAssetId ? 'Unfreeze' : 'Freeze to audio', action: () => void freezeTrack(track.id) },
              {
                label: 'Cycle colour',
                action: () =>
                  import('../state/actions').then((m) =>
                    m.setTrackProp(track.id, { color: ['#d7a951', '#4fd1c5', '#8f7bf7', '#f2777a', '#63b3ed', '#68d391', '#f6ad55'][Math.floor(Math.random() * 7)] }),
                  ),
              },
              { label: 'Delete track', action: () => deleteTrack(track.id), danger: true },
            ],
          },
        })
      }}
    >
      <div className="th-top">
        {editing ? (
          <input
            autoFocus
            className="th-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              renameTrack(track.id, name)
              setEditing(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                renameTrack(track.id, name)
                setEditing(false)
              }
              if (e.key === 'Escape') setEditing(false)
            }}
          />
        ) : (
          <span className="th-name" onDoubleClick={() => setEditing(true)} title="Double-click to rename">
            {track.name}
          </span>
        )}
        <span className="th-kind">{track.kind === 'audio' ? 'AUDIO' : track.kind === 'group' ? 'GROUP' : track.kind === 'drum' ? 'DRUM' : 'MIDI'}</span>
      </div>
      <div className="th-sub">
        {track.kind === 'audio' ? 'Input: ' + (track.input === 'none' ? 'Mic / Line' : track.input) : inst ? inst.name : 'No instrument'}
        {track.frozenAssetId ? ' · frozen' : ''}
      </div>
      <div className="th-buttons">
        <button className={`mini ${track.mute ? 'on mute' : ''}`} onClick={(e) => { e.stopPropagation(); toggleMute(track.id) }} title="Mute">
          M
        </button>
        <button className={`mini ${track.solo ? 'on solo' : ''}`} onClick={(e) => { e.stopPropagation(); toggleSolo(track.id) }} title="Solo">
          S
        </button>
        <button className={`mini ${track.armed ? 'on rec' : ''}`} onClick={(e) => { e.stopPropagation(); toggleArm(track.id) }} title="Record arm">
          ●
        </button>
        <button className="mini ghost" onClick={(e) => { e.stopPropagation(); void freezeTrack(track.id) }} title="Freeze / unfreeze this track">
          ❄
        </button>
        <span className="th-meter-wrap">
          <TrackMeterInline id={track.id} />
        </span>
      </div>
    </div>
  )
}

function TrackMeterInline({ id }: { id: string }) {
  const [level, setLevel] = useState(0)
  useEffect(() => {
    let raf = 0
    let held = 0
    const tick = () => {
      const m = engine.trackMeter(id)
      held = Math.max(m.peak, held * 0.92)
      setLevel(held)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [id])
  return (
    <span className="inline-meter" title="Track level">
      <span style={{ width: `${Math.min(100, level * 100)}%` }} />
    </span>
  )
}

function SessionView() {
  const project = useProject()
  const ui = useUi()
  const [launched, setLaunched] = useState<string[]>([])
  const scenes = Math.max(4, project.scenes)
  return (
    <div className="session-view">
      <div className="session-toolbar">
        <strong>Session</strong>
        <span className="dim small">Launch clips and scenes like Ableton. Clips loop until stopped.</span>
        <button
          className="chip"
          onClick={() => {
            engine.stopAllLaunches()
            setLaunched([])
          }}
        >
          Stop all
        </button>
        <button className="chip" onClick={() => setUi({ session: false })}>
          Back to arrangement
        </button>
      </div>
      <div className="session-grid" style={{ gridTemplateColumns: `${HEADER_W}px repeat(${project.tracks.length}, minmax(130px, 1fr))` }}>
        <div className="sg-corner">Scenes</div>
        {project.tracks.map((t) => (
          <div key={t.id} className="sg-head" style={{ borderTopColor: t.color }}>
            {t.name}
          </div>
        ))}
        {Array.from({ length: scenes }, (_, scene) => (
          <FragmentRow
            key={scene}
            scene={scene}
            tracks={project.tracks}
            launched={launched}
            setLaunched={setLaunched}
          />
        ))}
      </div>
      <div className="session-footer dim small">
        Rows are scenes · {project.tracks.length} tracks · {project.tracks.reduce((n, t) => n + t.clips.length, 0)} clips
        {ui.session ? '' : ''}
      </div>
    </div>
  )
}

function FragmentRow({
  scene,
  tracks,
  launched,
  setLaunched,
}: {
  scene: number
  tracks: Track[]
  launched: string[]
  setLaunched: (v: string[]) => void
}) {
  return (
    <>
      <div className="sg-scene">
        <button
          className="scene-launch"
          title={`Launch scene ${scene + 1}`}
          onClick={() => {
            const ids: string[] = []
            tracks.forEach((t) => {
              const clip = [...t.clips].sort((a, b) => a.start - b.start)[scene]
              if (clip) {
                engine.launchClip(clip, t.id)
                ids.push(clip.id)
              }
            })
            setLaunched(Array.from(new Set([...launched, ...ids])))
          }}
        >
          ▶
        </button>
        <span>Scene {scene + 1}</span>
      </div>
      {tracks.map((t) => {
        const clip = [...t.clips].sort((a, b) => a.start - b.start)[scene]
        const on = clip ? launched.includes(clip.id) : false
        return (
          <div key={t.id} className="sg-cell">
            {clip ? (
              <button
                className={`sg-clip ${on ? 'on' : ''}`}
                style={{ borderColor: t.color, background: on ? `${t.color}55` : `${t.color}18` }}
                onClick={() => {
                  if (on) {
                    engine.stopLaunch(clip.id)
                    setLaunched(launched.filter((x) => x !== clip.id))
                  } else {
                    engine.launchClip(clip, t.id)
                    setLaunched([...launched, clip.id])
                  }
                }}
                title={`${clip.name} · click to ${on ? 'stop' : 'launch'}`}
              >
                <span>{clip.name}</span>
                <span className="sg-trigger">{on ? '■' : '▶'}</span>
              </button>
            ) : (
              <div className="sg-empty">·</div>
            )}
          </div>
        )
      })}
    </>
  )
}

export default function Sequencer() {
  const ui = useUi()
  const project = useProject()
  const selectedTrack = findTrack(project, ui.selectedTrackId) ?? project.tracks[0]
  const selectedClip = useMemo(() => {
    const id = ui.selectedClipIds[0]
    return id ? findClip(project, id)?.clip ?? null : null
  }, [ui.selectedClipIds, project])
  const [addOpen, setAddOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const rowsRef = useRef<HTMLDivElement | null>(null)
  const [view, setView] = useState({ left: 0, width: 1400 })

  // Virtualisation: only clips intersecting the visible beat window render.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = () => setView({ left: el.scrollLeft, width: el.clientWidth })
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    window.addEventListener('resize', measure)
    return () => {
      el.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
    }
  }, [])
  const viewStartBeat = (view.left - HEADER_W) / ui.zoom - 8
  const viewEndBeat = viewStartBeat + view.width / ui.zoom + 16
  const inView = (clip: Clip) => clip.start + clip.len > viewStartBeat && clip.start < viewEndBeat

  useEffect(() => {
    const onScrollTo = (e: Event) => {
      const el = scrollRef.current
      if (!el) return
      const beat = Number((e as CustomEvent<number>).detail) || 0
      el.scrollTo({ left: Math.max(0, beat * getState().ui.zoom - 40), behavior: 'smooth' })
    }
    window.addEventListener('ils:scroll-to-beat', onScrollTo)
    return () => window.removeEventListener('ils:scroll-to-beat', onScrollTo)
  }, [])

  const totalBeats = Math.max(project.length, 64)
  const width = totalBeats * ui.zoom
  const bars = Math.ceil(totalBeats / 4)
  const beatAt = (clientX: number, el: HTMLElement) => {
    const rect = el.getBoundingClientRect()
    const raw = (clientX - rect.left + el.scrollLeft) / ui.zoom
    return Math.max(0, ui.snap > 0 ? Math.round(raw / ui.snap) * ui.snap : raw)
  }

  const startLoopDrag = (e: React.PointerEvent) => {
    const strip = e.currentTarget as HTMLElement
    const rect = strip.getBoundingClientRect()
    const compute = (clientX: number) => clamp((clientX - rect.left) / ui.zoom, 0, totalBeats)
    const anchor = compute(e.clientX)
    const move = (ev: PointerEvent) => {
      const b = compute(ev.clientX)
      const start = Math.min(anchor, b)
      const end = Math.max(anchor, b)
      if (end - start > 0.5) setLoop(Math.round(start * 4) / 4, Math.round(end * 4) / 4, true)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div className="sequencer">
      <div className="seq-toolbar">
        <div className="toolbar-group">
          <div className="add-wrap">
            <button className="btn accent" onClick={() => setAddOpen((v) => !v)} title="Add a track">
              + Track
            </button>
            {addOpen && (
              <div className="add-menu" onPointerLeave={() => setAddOpen(false)}>
                {[
                  { label: 'Instrument (MIDI)', kind: 'midi' as const, device: 'synth' as const },
                  { label: 'Drum machine', kind: 'drum' as const, device: 'drums' as const },
                  { label: 'Audio / vocal', kind: 'audio' as const },
                  { label: 'Group bus', kind: 'group' as const },
                  { label: 'Bass', kind: 'midi' as const, device: 'bass' as const },
                  { label: 'Keys', kind: 'midi' as const, device: 'keys' as const },
                  { label: 'Pad', kind: 'midi' as const, device: 'pad' as const },
                ].map((o) => (
                  <button
                    key={o.label}
                    onClick={() => {
                      addTrack(o.kind, o.device ? { device: o.device } : {})
                      setAddOpen(false)
                    }}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="btn" onClick={() => selectedTrack && duplicateTrack(selectedTrack.id)} disabled={!selectedTrack} title="Duplicate selected track">
            Duplicate
          </button>
          <button className="btn" onClick={() => selectedTrack && duplicateClip(ui.selectedClipIds[0] ?? '')} disabled={!ui.selectedClipIds[0]} title="Duplicate selected clip">
            Duplicate clip
          </button>
          <button className="btn danger" onClick={() => selectedTrack && deleteTrack(selectedTrack.id)} disabled={!selectedTrack} title="Delete selected track">
            Delete track
          </button>
        </div>

        <div className="toolbar-group">
          <label className="inline-field" title="Grid snapping">
            Snap
            <select value={ui.snap} onChange={(e) => setUi({ snap: Number(e.target.value) })}>
              <option value={0}>Off</option>
              <option value={0.125}>1/32</option>
              <option value={0.25}>1/16</option>
              <option value={0.5}>1/8</option>
              <option value={1}>1/4</option>
              <option value={4}>Bar</option>
            </select>
          </label>
          <div className="zoom-controls">
            <button className="icon-btn" title="Zoom out" onClick={() => setUi({ zoom: Math.max(8, ui.zoom * 0.8) })}>
              −
            </button>
            <span className="mono small">{Math.round(ui.zoom)}px</span>
            <button className="icon-btn" title="Zoom in" onClick={() => setUi({ zoom: Math.min(220, ui.zoom * 1.25) })}>
              +
            </button>
          </div>
          <button className={`chip ${ui.session ? 'on' : ''}`} onClick={() => setUi({ session: !ui.session })} title="Toggle Session clip launcher">
            Session
          </button>
          <button className="chip" onClick={() => addMarker(engine.getBeat())} title="Add a marker at the playhead (M)">
            + Marker
          </button>
          <button className="chip gold-chip" onClick={() => setUi({ modal: 'export' })} title="Export WAV, MP3, stems or MIDI (Ctrl+E)">
            Export
          </button>
        </div>
      </div>

      {ui.session ? (
        <SessionView />
      ) : (
        <div
          className="seq-scroll"
          ref={scrollRef}
          onWheel={(e) => {
            if (e.ctrlKey || e.metaKey) {
              e.preventDefault()
              setUi({ zoom: clamp(ui.zoom * (e.deltaY < 0 ? 1.12 : 0.89), 8, 220) })
            }
          }}
        >
          <div className="tl-content" style={{ width: HEADER_W + width }}>
            <div className="tl-ruler-row">
              <div className="tl-corner" style={{ width: HEADER_W }}>
                <span className="mono small dim">Bar / Beat</span>
              </div>
              <div
                className="ruler"
                style={{ width }}
                onPointerDown={(e) => {
                  if (e.button !== 0) return
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  const beat = Math.max(0, (e.clientX - rect.left) / ui.zoom)
                  engine.seek(ui.snap > 0 ? Math.round(beat / ui.snap) * ui.snap : beat)
                  setUi({ positionBeat: beat })
                }}
              >
                {Array.from({ length: bars }, (_, b) => (
                  <div key={b} className="ruler-bar" style={{ left: b * 4 * ui.zoom, width: 4 * ui.zoom }}>
                    {(ui.zoom >= 20 || b % 4 === 0) && <span className="ruler-label">{b + 1}</span>}
                    {Array.from({ length: 3 }, (_, q) => (
                      <div key={q} className="ruler-beat" style={{ left: (q + 1) * ui.zoom }} />
                    ))}
                  </div>
                ))}
                <div
                  className={`loop-strip ${project.loop.enabled ? 'on' : ''}`}
                  style={{ left: project.loop.start * ui.zoom, width: Math.max(4, (project.loop.end - project.loop.start) * ui.zoom) }}
                  onPointerDown={startLoopDrag}
                  title="Drag to set the loop region"
                >
                  <span className="loop-handle" />
                  <span className="loop-handle right" />
                </div>
                {project.markers.map((m) => (
                  <div
                    key={m.id}
                    className="marker"
                    style={{ left: m.beat * ui.zoom, borderColor: m.color }}
                    title={`${m.name} — click to jump, right-click to remove`}
                    onPointerDown={(e) => {
                      e.stopPropagation()
                      engine.seek(m.beat)
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      removeMarker(m.id)
                    }}
                  >
                    <span>{m.name}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="tl-rows" ref={rowsRef}>
              {project.tracks.map((track, i) => (
                <div className="tl-row" key={track.id} style={{ height: ROW_H }}>
                  <TrackHead track={track} index={i} />
                  <div
                    className="tl-lane"
                    style={{ width, background: ui.selectedTrackId === track.id ? 'rgba(215,169,81,0.035)' : undefined }}
                    onPointerDown={(e) => {
                      if (e.target !== e.currentTarget) return
                      const beat = beatAt(e.clientX, e.currentTarget as HTMLElement)
                      engine.seek(beat)
                      setUi({ selectedClipIds: [], selectedTrackId: track.id })
                    }}
                    onDoubleClick={(e) => {
                      if (e.target !== e.currentTarget) return
                      const beat = beatAt(e.clientX, e.currentTarget as HTMLElement)
                      if (track.kind === 'audio') {
                        toast('Drag an audio file here or record with the mic', 'warn')
                        return
                      }
                      addClip(track.id, makeClip({ name: 'New Clip', start: beat, len: 4, contentLen: 4, kind: 'midi', notes: [] }))
                    }}
                    onDragOver={(e) => {
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'copy'
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      const beat = beatAt(e.clientX, e.currentTarget as HTMLElement)
                      const libId = e.dataTransfer.getData('text/ils-library')
                      if (libId) {
                        void dropLibraryItem(libId, track.id, beat)
                        return
                      }
                      const file = e.dataTransfer.files?.[0]
                      if (file) void importAudioFile(file, track.id, beat)
                    }}
                  >
                    {track.clips.length === 0 && project.tracks.every((t) => t.clips.length === 0) && (
                      <span className="lane-hint">
                        {track.kind === 'audio' ? 'Drop audio here, or arm and hit record' : 'Double-click to add a clip, or drag a sound from the library'}
                      </span>
                    )}
                    {track.clips.filter(inView).map((clip) => (
                      <ClipView key={clip.id} track={track} clip={clip} />
                    ))}
                    {Array.from({ length: bars }, (_, b) => (
                      <div key={b} className="lane-barline" style={{ left: b * 4 * ui.zoom }} />
                    ))}
                  </div>
                </div>
              ))}
              {project.tracks.length === 0 && (
                <div className="tl-empty">
                  <h3>No tracks yet</h3>
                  <p>Add a track, drag a loop from the Sound Library, or generate an arrangement in the Create panel.</p>
                  <button className="btn accent" onClick={() => addTrack('midi', { device: 'synth' })}>
                    + Add your first track
                  </button>
                </div>
              )}
            </div>
            <Playhead zoom={ui.zoom} />
          </div>
        </div>
      )}

      {selectedTrack && <EditorPane track={selectedTrack} clip={selectedClip} />}
    </div>
  )
}
