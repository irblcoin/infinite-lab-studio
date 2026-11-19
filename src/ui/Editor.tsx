import { useMemo, useRef, useState } from 'react'
import type { AutoPoint, Clip, Note, Track } from '../state/types'
import { DEVICE_DEFS } from '../data/deviceDefs'
import { SCALES, clamp, makeClip, midiName, uid } from '../state/types'
import { getState, mutate, pushHistory, setUi, useProject, useUi } from '../state/store'
import {
  addAutoPoint,
  editClipNotes,
  ensureLane,
  quantizeNotes,
  removeAutoPoint,
  updateAutoPoint,
} from '../state/actions'
import { DRUM_PADS } from '../audio/drums'
import { snapToScale } from '../music/theory'
import { Knob } from './bits'
import { ClipTools } from './ClipTools'
import { applyGrooveToClip, consolidateClip } from '../state/features'

const BLACK = [1, 3, 6, 8, 10]
const isBlack = (p: number) => BLACK.includes(((p % 12) + 12) % 12)

function targetRange(track: Track, target: string): { min: number; max: number; label: string } {
  if (target === 'volume') return { min: 0, max: 1.5, label: 'Volume' }
  if (target === 'pan') return { min: -1, max: 1, label: 'Pan' }
  if (target === 'sendA') return { min: 0, max: 1, label: 'Reverb send' }
  if (target === 'sendB') return { min: 0, max: 1, label: 'Delay send' }
  if (target.startsWith('dev:')) {
    const [, devId, key] = target.split(':')
    const dev = track.devices.find((d) => d.id === devId)
    const def = dev ? DEVICE_DEFS[dev.type].params.find((p) => p.key === key) : undefined
    return { min: def?.min ?? 0, max: def?.max ?? 1, label: `${dev?.name ?? 'Device'} · ${def?.label ?? key}` }
  }
  return { min: 0, max: 1, label: 'Value' }
}

export function automationTargets(track: Track): { value: string; label: string }[] {
  const out = [
    { value: 'volume', label: 'Volume' },
    { value: 'pan', label: 'Pan' },
    { value: 'sendA', label: 'Reverb Send' },
    { value: 'sendB', label: 'Delay Send' },
  ]
  for (const d of track.devices) {
    if (DEVICE_DEFS[d.type].category !== 'effect' || d.bypass) continue
    for (const p of DEVICE_DEFS[d.type].params) {
      if (p.key === 'mix') continue
      out.push({ value: `dev:${d.id}:${p.key}`, label: `${d.name} · ${p.label}` })
    }
  }
  return out
}

function PianoRoll({ track, clip, zoom }: { track: Track; clip: Clip; zoom: number }) {
  const cellW = Math.max(22, zoom)
  const rowH = 13
  const [scaleLock, setScaleLock] = useState(false)
  const [grid, setGrid] = useState(0.25)
  const noteAreaRef = useRef<HTMLDivElement | null>(null)

  const pitches = clip.notes.map((n) => n.pitch)
  const low = clamp(Math.min(...(pitches.length ? pitches : [48])) - 5, 21, 96)
  const high = clamp(Math.max(...(pitches.length ? pitches : [72])) + 5, low + 24, 108)
  const rows = high - low + 1
  const width = Math.max(200, clip.contentLen * cellW)
  const project = getState().project
  const rootPc = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].indexOf(project.keyRoot)
  const scale = SCALES[project.keyScale] ?? SCALES.Major
  const inScale = (p: number) => scale.includes((((p - (rootPc < 0 ? 0 : rootPc)) % 12) + 12) % 12)

  const drag = useRef<{ mode: 'move' | 'len'; id: string; startX: number; startY: number; orig: Note } | null>(null)

  const posFromEvent = (e: React.PointerEvent | PointerEvent) => {
    const el = noteAreaRef.current
    if (!el) return { beat: 0, pitch: low }
    const rect = el.getBoundingClientRect()
    const beat = clamp((e.clientX - rect.left) / cellW, 0, clip.contentLen)
    const pitch = clamp(high - Math.floor((e.clientY - rect.top) / rowH), 0, 127)
    return { beat, pitch }
  }

  const snapBeat = (b: number) => (grid > 0 ? Math.round(b / grid) * grid : b)

  const addNoteAt = (e: React.PointerEvent) => {
    const { beat, pitch } = posFromEvent(e)
    const snapped = snapToScale(pitch, rootPc < 0 ? 0 : rootPc, project.keyScale)
    const finalPitch = scaleLock ? snapped : pitch
    const note: Note = { id: uid('nt'), pitch: finalPitch, start: snapBeat(beat), len: Math.max(grid, 0.25), vel: 0.85 }
    editClipNotes(clip.id, (notes) => [...notes, note])
    setUi({ selectedNoteIds: [note.id] })
  }

  const startNoteDrag = (e: React.PointerEvent, note: Note, mode: 'move' | 'len') => {
    e.stopPropagation()
    pushHistory()
    drag.current = { mode, id: note.id, startX: e.clientX, startY: e.clientY, orig: { ...note } }
    setUi({ selectedNoteIds: [note.id] })
    const onMove = (ev: PointerEvent) => {
      const d = drag.current
      if (!d) return
      const dxBeats = (ev.clientX - d.startX) / cellW
      const dyPitch = Math.round((d.startY - ev.clientY) / rowH)
      editClipNotes(clip.id, (notes) =>
        notes.map((n) => {
          if (n.id !== d.id) return n
          if (d.mode === 'len') return { ...n, len: Math.max(grid, d.orig.len + dxBeats) }
          let pitch = clamp(d.orig.pitch + dyPitch, 0, 127)
          if (scaleLock) pitch = snapToScale(pitch, rootPc < 0 ? 0 : rootPc, project.keyScale)
          return { ...n, start: Math.max(0, d.orig.start + dxBeats), pitch }
        }),
      )
    }
    const onUp = () => {
      drag.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const removeNote = (id: string) => {
    pushHistory()
    editClipNotes(clip.id, (notes) => notes.filter((n) => n.id !== id))
  }

  return (
    <div className="piano-roll">
      <div className="editor-toolbar">
        <span className="tag">{clip.name}</span>
        <label className="inline-field">
          Grid
          <select value={grid} onChange={(e) => setGrid(Number(e.target.value))}>
            <option value={1}>1/4</option>
            <option value={0.5}>1/8</option>
            <option value={0.25}>1/16</option>
            <option value={0.125}>1/32</option>
          </select>
        </label>
        <button className={`chip ${scaleLock ? 'on' : ''}`} onClick={() => setScaleLock((v) => !v)} title="Snap drawn notes to the project scale">
          Scale lock
        </button>
        <button className="chip" onClick={() => quantizeNotes(clip.id, grid)} title="Quantize all notes in this clip">
          Quantize
        </button>
        <button
          className="chip"
          onClick={() => {
            pushHistory()
            editClipNotes(clip.id, (notes) => notes.map((n) => ({ ...n, vel: 0.9 })))
          }}
        >
          Vel 90
        </button>
        <span className="dim small">Double-click the grid to draw · drag to move · right edge to resize · double-click a note to delete</span>
      </div>
      <div className="pr-scroll">
        <div className="pr-body">
          <div className="pr-keys" style={{ height: rows * rowH }}>
            {Array.from({ length: rows }, (_, i) => {
              const pitch = high - i
              return (
                <div
                  key={pitch}
                  className={`pr-key ${isBlack(pitch) ? 'black' : ''} ${inScale(pitch) ? 'scale' : ''}`}
                  style={{ height: rowH }}
                  onPointerDown={() => getState().ui.selectedTrackId && import('../state/record').then((m) => m.liveNoteOn(pitch, 0.8))}
                  title={midiName(pitch)}
                >
                  {pitch % 12 === 0 ? midiName(pitch) : ''}
                </div>
              )
            })}
          </div>
          <div
            className="pr-grid"
            ref={noteAreaRef}
            style={{ width, height: rows * rowH }}
            onPointerDown={(e) => {
              if (e.target === e.currentTarget) addNoteAt(e)
            }}
          >
            {Array.from({ length: rows }, (_, i) => {
              const pitch = high - i
              return (
                <div
                  key={pitch}
                  className={`pr-row ${isBlack(pitch) ? 'black' : ''} ${inScale(pitch) ? 'scale' : ''}`}
                  style={{ top: i * rowH, height: rowH }}
                />
              )
            })}
            {Array.from({ length: Math.ceil(clip.contentLen / 4) + 1 }, (_, i) => (
              <div key={`bar${i}`} className="pr-barline" style={{ left: i * 4 * cellW }} />
            ))}
            {Array.from({ length: Math.ceil(clip.contentLen / grid) + 1 }, (_, i) =>
              i % 4 === 0 ? null : <div key={`g${i}`} className="pr-gridline" style={{ left: i * grid * cellW }} />,
            )}
            {clip.notes.map((note) => (
              <div
                key={note.id}
                className={`pr-note ${getState().ui.selectedNoteIds.includes(note.id) ? 'selected' : ''}`}
                style={{
                  left: note.start * cellW,
                  top: (high - note.pitch) * rowH,
                  width: Math.max(6, note.len * cellW),
                  height: rowH - 1,
                  background: `linear-gradient(90deg, ${track.color}, ${track.color}99)`,
                  opacity: 0.45 + note.vel * 0.55,
                }}
                onPointerDown={(e) => startNoteDrag(e, note, 'move')}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  removeNote(note.id)
                }}
                title={`${midiName(note.pitch)} · vel ${Math.round(note.vel * 127)}`}
              >
                <span className="pr-note-handle" onPointerDown={(e) => startNoteDrag(e, note, 'len')} />
              </div>
            ))}
          </div>
        </div>
      </div>
      <VelocityLane clip={clip} cellW={cellW} />
    </div>
  )
}

function VelocityLane({ clip, cellW }: { clip: Clip; cellW: number }) {
  const ref = useRef<HTMLDivElement | null>(null)
  return (
    <div className="velocity-lane">
      <span className="vl-label">Velocity</span>
      <div className="vl-area" ref={ref}>
        {clip.notes.map((note) => (
          <div
            key={note.id}
            className="vl-bar"
            style={{
              left: note.start * cellW,
              height: `${note.vel * 100}%`,
              width: Math.max(4, Math.min(10, note.len * cellW)),
              background: `linear-gradient(180deg, ${note.vel > 0.8 ? '#e8c67a' : '#5eead4'}, #2b6f6a)`,
            }}
            title={`Velocity ${Math.round(note.vel * 127)}`}
            onPointerDown={(e) => {
              e.stopPropagation()
              pushHistory()
              const el = ref.current
              if (!el) return
              const rect = el.getBoundingClientRect()
              const update = (clientY: number) => {
                const vel = clamp(1 - (clientY - rect.top) / rect.height, 0.05, 1)
                editClipNotes(clip.id, (notes) => notes.map((n) => (n.id === note.id ? { ...n, vel } : n)))
              }
              update(e.clientY)
              const move = (ev: PointerEvent) => update(ev.clientY)
              const up = () => {
                window.removeEventListener('pointermove', move)
                window.removeEventListener('pointerup', up)
              }
              window.addEventListener('pointermove', move)
              window.addEventListener('pointerup', up)
            }}
          />
        ))}
      </div>
    </div>
  )
}

function DrumGrid({ clip, zoom }: { clip: Clip; zoom: number }) {
  const [steps, setSteps] = useState(16)
  const [swing, setSwing] = useState(0)
  const cellW = Math.max(24, zoom * 0.75)
  const stepDur = 0.25
  const totalSteps = steps
  const project = getState().project
  const beats = totalSteps * stepDur

  const hasNote = (pitch: number, step: number) =>
    clip.notes.find((n) => n.pitch === pitch && Math.abs(n.start - step * stepDur) < 0.02)

  const toggle = (pitch: number, step: number) => {
    pushHistory()
    const existing = hasNote(pitch, step)
    editClipNotes(clip.id, (notes) =>
      existing
        ? notes.filter((n) => n.id !== existing.id)
        : [...notes, { id: uid('nt'), pitch, start: step * stepDur, len: 0.2, vel: 0.85 }],
    )
  }

  const cycleVel = (pitch: number, step: number) => {
    const existing = hasNote(pitch, step)
    if (!existing) return
    pushHistory()
    const next = existing.vel >= 0.95 ? 0.4 : existing.vel >= 0.65 ? 1 : 0.7
    editClipNotes(clip.id, (notes) => notes.map((n) => (n.id === existing.id ? { ...n, vel: next } : n)))
  }

  const applySwing = (value: number) => {
    setSwing(value)
    const snapshot = clip.notes.map((n) => ({ ...n }))
    editClipNotes(clip.id, () =>
      snapshot.map((n) => {
        const step = Math.round(n.start / stepDur)
        const isOff = step % 2 === 1
        return { ...n, start: Math.max(0, step * stepDur + (isOff ? value * 0.12 * stepDur * 4 : 0)) }
      }),
    )
  }

  return (
    <div className="drum-grid">
      <div className="editor-toolbar">
        <span className="tag">{clip.name}</span>
        <div className="seg">
          <button className={steps === 16 ? 'on' : ''} onClick={() => setSteps(16)}>
            16 steps
          </button>
          <button className={steps === 32 ? 'on' : ''} onClick={() => setSteps(32)}>
            32 steps
          </button>
        </div>
        <label className="inline-field">
          Swing
          <input
            type="range"
            min={0}
            max={1}
            step={0.02}
            value={swing}
            onChange={(e) => applySwing(Number(e.target.value))}
          />
        </label>
        <button className="chip" onClick={() => quantizeNotes(clip.id, 0.25)}>
          Quantize
        </button>
        <span className="dim small">Click toggles a step · right-click cycles velocity · pitch lanes are the 16 drum pads</span>
      </div>
      <div className="dg-scroll">
        <div className="dg-body">
          <div className="dg-labels">
            {DRUM_PADS.map((pad) => (
              <div key={pad.kind} className="dg-label" title={`${pad.label} (${midiName(36 + DRUM_PADS.indexOf(pad))})`}>
                {pad.label}
              </div>
            ))}
          </div>
          <div className="dg-steps" style={{ width: totalSteps * cellW }}>
            <div className="dg-steps-header">
              {Array.from({ length: totalSteps }, (_, i) => (
                <div key={i} className={`dg-stepnum ${i % 4 === 0 ? 'beat' : ''}`} style={{ width: cellW }}>
                  {i % 4 === 0 ? i / 4 + 1 : ''}
                </div>
              ))}
            </div>
            {DRUM_PADS.map((pad, row) => {
              const pitch = 36 + row
              return (
                <div key={pad.kind} className="dg-row">
                  {Array.from({ length: totalSteps }, (_, step) => {
                    const note = hasNote(pitch, step)
                    const inBeat = Math.floor(step / 4) % 2 === 0
                    return (
                      <button
                        key={step}
                        className={`dg-cell ${note ? 'on' : ''} ${inBeat ? 'light' : ''} ${step % 4 === 0 ? 'bar' : ''}`}
                        style={{
                          width: cellW - 2,
                          background: note ? trackColor(row, note.vel) : undefined,
                        }}
                        onClick={() => toggle(pitch, step)}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          cycleVel(pitch, step)
                        }}
                        title={`${pad.label} · step ${step + 1}${note ? ` · vel ${Math.round(note.vel * 127)}` : ''}`}
                      >
                        {note && <span className="dg-vel" style={{ height: `${note.vel * 100}%` }} />}
                      </button>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </div>
      </div>
      <div className="dim small pad-note">
        Tip: play the pads from the Rack browser or your MIDI keyboard. Clip length {clip.len} · grid {beats} beats.
      </div>
    </div>
  )
}

function trackColor(row: number, vel: number): string {
  const palette = ['#f2777a', '#f2777a', '#e8c67a', '#e8c67a', '#5eead4', '#5eead4', '#8f7bf7', '#8f7bf7', '#4fd1c5', '#f6ad55', '#d7a951', '#7ea6ff', '#63b3ed', '#68d391', '#e17bd8', '#a78bfa']
  const c = palette[row % palette.length]
  const alpha = 0.45 + vel * 0.55
  return `${c}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`
}

function AutomationEditor({ track, zoom }: { track: Track; zoom: number }) {
  const ui = useUi()
  const project = getState().project
  const target = ui.automationTarget
  const lane = track.automation.find((a) => a.target === target)
  const range = targetRange(track, target)
  const width = Math.max(600, project.length * zoom)
  const height = 170
  const ref = useRef<HTMLDivElement | null>(null)
  const targets = automationTargets(track)

  const toY = (v: number) => (1 - (v - range.min) / (range.max - range.min || 1)) * (height - 24) + 12
  const fromY = (y: number) => clamp(range.min + (1 - (y - 12) / (height - 24)) * (range.max - range.min), range.min, range.max)

  const points = lane ? [...lane.points].sort((a, b) => a.beat - b.beat) : []

  const startPointDrag = (e: React.PointerEvent, pt: AutoPoint) => {
    e.stopPropagation()
    pushHistory()
    const el = ref.current
    if (!el || !lane) return
    const rect = el.getBoundingClientRect()
    const move = (ev: PointerEvent) => {
      const beat = Math.max(0, (ev.clientX - rect.left) / zoom)
      updateAutoPoint(track.id, lane.id, pt.id, beat, fromY(ev.clientY - rect.top))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div className="automation-editor">
      <div className="editor-toolbar">
        <label className="inline-field">
          Parameter
          <select value={target} onChange={(e) => setUi({ automationTarget: e.target.value })}>
            {targets.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        {!lane && (
          <button className="chip" onClick={() => ensureLane(track.id, target)}>
            Create lane
          </button>
        )}
        {lane && (
          <>
            <span className="dim small">
              {lane.points.length} points · range {range.min.toFixed(2)} to {range.max.toFixed(2)}
            </span>
            <button className="chip" onClick={() => import('../state/actions').then((m) => m.removeLane(track.id, lane.id))}>
              Delete lane
            </button>
          </>
        )}
        <span className="dim small">Click to add · drag points · double-click removes</span>
      </div>
      <div
        className="auto-canvas"
        ref={ref}
        style={{ height }}
        onPointerDown={(e) => {
          if (e.target !== e.currentTarget) return
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
          const beat = Math.max(0, Math.round(((e.clientX - rect.left) / zoom) * 4) / 4)
          addAutoPoint(track.id, target, beat, fromY(e.clientY - rect.top))
        }}
      >
        <svg width={width} height={height} className="auto-svg">
          {Array.from({ length: Math.ceil(project.length / 4) + 1 }, (_, i) => (
            <line key={i} x1={i * 4 * zoom} y1={0} x2={i * 4 * zoom} y2={height} className="auto-grid" />
          ))}
          <line x1={0} y1={toY(range.min + (range.max - range.min) * 0.5)} x2={width} y2={toY(range.min + (range.max - range.min) * 0.5)} className="auto-mid" />
          {points.length > 1 && (
            <polyline
              points={points.map((p) => `${p.beat * zoom},${toY(p.value)}`).join(' ')}
              fill="none"
              stroke={track.color}
              strokeWidth="2"
            />
          )}
          {points.length > 1 && (
            <polygon
              points={`${points[0].beat * zoom},${height} ${points
                .map((p) => `${p.beat * zoom},${toY(p.value)}`)
                .join(' ')} ${points[points.length - 1].beat * zoom},${height}`}
              fill={track.color}
              opacity="0.12"
            />
          )}
        </svg>
        {points.map((pt) => (
          <div
            key={pt.id}
            className="auto-point"
            style={{ left: pt.beat * zoom - 6, top: toY(pt.value) - 6, borderColor: track.color }}
            onPointerDown={(e) => startPointDrag(e, pt)}
            onDoubleClick={() => lane && removeAutoPoint(track.id, lane.id, pt.id)}
            title={`${pt.value.toFixed(2)} @ beat ${pt.beat.toFixed(2)}`}
          />
        ))}
        {lane && lane.points.length === 0 && (
          <div className="auto-empty">Click anywhere to place your first automation point</div>
        )}
      </div>
    </div>
  )
}

export default function EditorPane({ track, clip }: { track: Track; clip: Clip | null }) {
  const ui = useUi()
  const project = useProject()
  const isDrum = track.kind === 'drum'
  const mode = ui.editor === 'none' ? (isDrum ? 'drum' : 'piano') : ui.editor

  return (
    <section className="editor-pane">
      <div className="editor-tabs">
        <button className={mode === 'piano' ? 'active' : ''} onClick={() => setUi({ editor: 'piano' })} title="Piano roll editor">
          Piano Roll
        </button>
        <button className={mode === 'drum' ? 'active' : ''} onClick={() => setUi({ editor: 'drum' })} title="Drum step sequencer">
          Drum Steps
        </button>
        <button className={mode === 'automation' ? 'active' : ''} onClick={() => setUi({ editor: 'automation' })} title="Automation lanes">
          Automation
        </button>
        <div className="spacer" />
        <span className="dim small mono">{track.name}</span>
        <button className="icon-btn" title="Collapse editor" onClick={() => setUi({ editor: 'none' })}>
          ▾
        </button>
      </div>
      {mode === 'automation' && <AutomationEditor track={track} zoom={ui.zoom} />}
      {mode !== 'automation' && !clip && (
        <div className="editor-empty">
          <p>Select a MIDI or drum clip to edit its notes.</p>
          <button
            className="chip"
            onClick={() => {
              const p = getState().project
              const t = p.tracks.find((x) => x.kind === 'midi' || x.kind === 'drum')
              if (t) {
                import('../state/actions').then((m) => {
                  m.addClip(t.id, makeClip({ name: 'New Clip', start: 0, len: 4, contentLen: 4, kind: 'midi', notes: [] }))
                  setUi({ selectedTrackId: t.id })
                })
              }
            }}
          >
            Create a 1-bar clip
          </button>
        </div>
      )}
      {mode !== 'automation' && clip && clip.kind === 'midi' && (mode === 'drum' || isDrum ? <DrumGrid clip={clip} zoom={ui.zoom} /> : <PianoRoll track={track} clip={clip} zoom={ui.zoom} />)}
      {mode !== 'automation' && clip && clip.kind === 'audio' && (
        <div className="audio-clip-editor">
          <ClipTools clip={clip} track={track} />
          <div className="row gap">
            <button className="chip" onClick={() => setUi({ modal: 'takes' })}>
              Takes & comping
            </button>
            <button className="chip" onClick={() => setUi({ editor: 'automation' })}>
              Automate this track
            </button>
          </div>
        </div>
      )}
      {mode !== 'automation' && clip && clip.kind === 'midi' && (
        <div className="row gap clip-quick-tools">
          <button className="chip" onClick={() => void consolidateClip(clip.id)}>
            Consolidate
          </button>
          <button className="chip" onClick={() => applyGrooveToClip(clip.id, project.groove?.preset ?? 'mpc16')}>
            Apply groove
          </button>
        </div>
      )}
    </section>
  )
}
