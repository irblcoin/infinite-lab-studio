import { useEffect, useRef, useState } from 'react'
import type { Track } from '../state/types'
import { clamp } from '../state/types'
import { engine } from '../audio/engine'
import { commit, mutate, pushHistory, setUi, useProject, useUi } from '../state/store'
import {
  addTrack,
  recallMixSnapshot,
  saveMixSnapshot,
  setTrackPan,
  setTrackProp,
  setTrackSend,
  setTrackVolume,
  toggleArm,
  toggleMute,
  toggleSolo,
} from '../state/actions'
import { CanvasScope, Fader, Knob, Meter } from './bits'
import { MixerMeters } from './MeterPanels'
import { applyReturnPreset, clearSidechain, setSidechain, sidechainPreset } from '../state/features'
import { RETURN_PRESETS, SIDECHAIN_PRESETS } from '../data/presets'
import { DEVICE_DEFS } from '../data/deviceDefs'

function InsertSlots({ track }: { track: Track }) {
  const effects = track.devices.filter((d) => DEVICE_DEFS[d.type].category === 'effect')
  const open = () => setUi({ view: 'rack' })
  return (
    <div className="inserts" title="Insert chain — click to edit in the Rack browser">
      {Array.from({ length: 6 }).map((_, i) => {
        const dev = effects[i]
        if (!dev) {
          return (
            <button key={i} className="insert empty" onClick={open} title="Add an effect in the Rack browser">
              ＋
            </button>
          )
        }
        return (
          <div key={dev.id} className={`insert ${dev.bypass ? 'bypassed' : ''}`}>
            <button className="insert-name" onClick={open} title={`${DEVICE_DEFS[dev.type].name} — open in Racks`}>
              {dev.name}
            </button>
            <button
              className="insert-power"
              title={dev.bypass ? 'Enable' : 'Bypass'}
              onClick={() =>
                commit('Bypass device', (p) => {
                  const t = p.tracks.find((x) => x.id === track.id)
                  const d = t?.devices.find((x) => x.id === dev.id)
                  if (d) d.bypass = !d.bypass
                })
              }
            >
              {dev.bypass ? '○' : '●'}
            </button>
          </div>
        )
      })}
    </div>
  )
}

function Reduction({ trackId, deviceId }: { trackId: string; deviceId: string }) {
  const [gain, setGain] = useState(0)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      setGain(engine.effectReduction(trackId, deviceId))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [trackId, deviceId])
  return (
    <span className="reduction" title="Gain reduction (dB)">
      {gain.toFixed(1)}
    </span>
  )
}

function ChannelStrip({ track, groups, width }: { track: Track; groups: Track[]; width: number }) {
  const ui = useUi()
  const project = useProject()
  const selected = ui.selectedTrackId === track.id
  const compressor = track.devices.find((d) => d.type === 'comp' || d.type === 'limiter')
  return (
    <div
      className={`strip ${selected ? 'selected' : ''}`}
      style={{ width }}
      onPointerDown={() => setUi({ selectedTrackId: track.id })}
    >
      <div className="strip-head" style={{ borderTopColor: track.color }}>
        <span className="strip-name" title={track.name}>
          {track.name}
        </span>
        <span className="strip-kind">{track.kind}</span>
      </div>

      <div className="strip-input">
        <select
          value={track.input}
          onChange={(e) => setTrackProp(track.id, { input: e.target.value }, true)}
          title="Input source"
        >
          {track.kind === 'audio' ? (
            <>
              <option value="none">Mic / Line 1</option>
              <option value="mic">Mic</option>
              <option value="line">Line</option>
            </>
          ) : (
            <>
              <option value="none">MIDI In</option>
              <option value="all">All MIDI</option>
            </>
          )}
        </select>
      </div>

      <InsertSlots track={track} />
      {compressor && (
        <div className="strip-meta">
          GR <Reduction trackId={track.id} deviceId={compressor.id} />
        </div>
      )}

      <div className="strip-sends">
        <Knob
          value={track.sends[0]}
          min={0}
          max={1}
          def={0}
          size={34}
          label="A"
          onChange={(v) => setTrackSend(track.id, 0, v)}
          onStart={pushHistory}
          format={(v) => `${Math.round(v * 100)}`}
        />
        <Knob
          value={track.sends[1]}
          min={0}
          max={1}
          def={0}
          size={34}
          label="B"
          onChange={(v) => setTrackSend(track.id, 1, v)}
          onStart={pushHistory}
          format={(v) => `${Math.round(v * 100)}`}
        />
      </div>

      <Knob
        value={track.pan}
        min={-1}
        max={1}
        def={0}
        label="Pan"
        size={40}
        onChange={(v) => setTrackPan(track.id, v)}
        onStart={pushHistory}
        format={(v) => (Math.abs(v) < 0.02 ? 'C' : `${v < 0 ? 'L' : 'R'}${Math.round(Math.abs(v) * 100)}`)}
      />

      <div className="strip-fader">
        <Fader
          value={track.volume}
          onChange={(v) => setTrackVolume(track.id, v)}
          onStart={pushHistory}
          height={150}
          label={track.name}
        />
        <Meter read={() => engine.trackMeter(track.id)} height={150} />
      </div>

      <div className="strip-buttons">
        <button className={`mini ${track.mute ? 'on mute' : ''}`} onClick={() => toggleMute(track.id)} title="Mute">
          M
        </button>
        <button className={`mini ${track.solo ? 'on solo' : ''}`} onClick={() => toggleSolo(track.id)} title="Solo">
          S
        </button>
        <button className={`mini ${track.armed ? 'on rec' : ''}`} onClick={() => toggleArm(track.id)} title="Record arm">
          ●
        </button>
      </div>

      <select
        className="strip-output"
        value={track.output}
        onChange={(e) => setTrackProp(track.id, { output: e.target.value }, true)}
        title="Output routing"
      >
        <option value="master">Master</option>
        {groups
          .filter((g) => g.id !== track.id)
          .map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
      </select>
      <span className="strip-db mono">{track.volume <= 0.001 ? '-∞' : (20 * Math.log10(track.volume)).toFixed(1)}</span>
      {ui.recording && <span className="strip-auto">automating</span>}
      <span className="strip-index mono">{project.tracks.indexOf(track) + 1}</span>
    </div>
  )
}

function LufsReadout() {
  const [v, setV] = useState(-70)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const m = engine.masterMeter()
      const lufs = m.rms > 0.00001 ? -0.691 + 10 * Math.log10(m.rms * m.rms) : -70
      setV(lufs)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <div className="lufs" title="Momentary loudness estimate from the master RMS">
      <span className="mono">{v <= -69 ? '-∞' : v.toFixed(1)}</span>
      <span className="dim small">LUFS≈</span>
    </div>
  )
}

function MasterStrip() {
  const project = useProject()
  const [peak, setPeak] = useState(0)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const m = engine.masterMeter()
      setPeak((p) => Math.max(m.peak, p * 0.92))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <div className="strip master" style={{ width: 132 }}>
      <div className="strip-head master-head">
        <span className="strip-name">MASTER</span>
        <span className="strip-kind">out 1·2</span>
      </div>
      <CanvasScope height={64} />
      <button
        className={`chip ${project.master.limiterOn ? 'on' : ''}`}
        title="Master limiter"
        onClick={() => commit('Master limiter', (p) => (p.master.limiterOn = !p.master.limiterOn))}
      >
        Limiter
      </button>
      <Knob
        value={project.master.ceiling}
        min={-24}
        max={0}
        def={-0.3}
        label="Ceil"
        unit="dB"
        onChange={(v) =>
          mutate((p) => {
            p.master.ceiling = v
          })
        }
        onStart={pushHistory}
      />
      <div className="strip-fader">
        <Fader
          value={project.master.volume}
          min={0}
          max={1.5}
          height={150}
          onChange={(v) =>
            mutate((p) => {
              p.master.volume = clamp(v, 0, 1.5)
            })
          }
          onStart={pushHistory}
          label="Master"
        />
        <Meter read={() => engine.masterMeter()} height={150} />
      </div>
      <LufsReadout />
      <div className={`clip-led ${peak > 0.995 ? 'on' : ''}`} title="Master clipping indicator">
        CLIP
      </div>
      <div className="strip-footer mono dim">{(20 * Math.log10(Math.max(0.0001, project.master.volume))).toFixed(1)} dB</div>
    </div>
  )
}

function SidechainBar() {
  const project = useProject()
  const ui = useUi()
  const track = project.tracks.find((t) => t.id === ui.selectedTrackId) ?? project.tracks[0]
  const sources = project.tracks.filter((t) => t.id !== track?.id)
  if (!track) return null
  const sc = track.sidechain
  return (
    <div className="sidechain-bar">
      <span className="dim small">Sidechain</span>
      <select
        className="text-input small"
        value={sc?.enabled ? sc.sourceId : ''}
        onChange={(e) => (e.target.value ? setSidechain(track.id, e.target.value) : clearSidechain(track.id))}
        title="Pick the track that ducks this one"
      >
        <option value="">Off</option>
        {sources.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <span className="dim small">{track.name}</span>
      {sc?.enabled && (
        <>
          {SIDECHAIN_PRESETS.map((p) => (
            <button
              key={p.id}
              className="chip tiny"
              onClick={() => sidechainPreset(track.id, sc.sourceId, p.id)}
              title={`${p.name}: ${(p.depth * 100).toFixed(0)}% duck, ${(p.attack * 1000).toFixed(0)} ms attack`}
            >
              {p.name}
            </button>
          ))}
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={sc.depth}
            onChange={(e) => setSidechain(track.id, sc.sourceId, { depth: Number(e.target.value) })}
            title="Duck amount"
          />
          <span className="mono small">{(sc.depth * 100).toFixed(0)}%</span>
          <button className="chip tiny" onClick={() => clearSidechain(track.id)}>
            Remove
          </button>
        </>
      )}
    </div>
  )
}

export default function Mixer() {
  const project = useProject()
  const ui = useUi()
  const [width, setWidth] = useState(116)
  const [snapName, setSnapName] = useState('')
  const groups = project.tracks.filter((t) => t.kind === 'group')
  const dragRef = useRef<{ x: number; w: number } | null>(null)

  return (
    <div className="mixer">
      <div className="mixer-toolbar">
        <div className="toolbar-group">
          <strong>Mixer</strong>
          <label className="inline-field" title="Return chain A (reverb) — applies its send level to the selected track">
            Return A
            <select
              className="text-input small"
              defaultValue="plate"
              onChange={(e) => applyReturnPreset(ui.selectedTrackId ?? project.tracks[0]?.id ?? null, e.target.value)}
            >
              {RETURN_PRESETS.map((p) => (
                <option key={p.id} value={p.id} title={p.description}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <span className="dim small">B: tempo delay</span>
        </div>
        <div className="toolbar-group">
          <button className="chip" onClick={() => addTrack('group', { name: `Group ${groups.length + 1}` })} title="Add a group bus">
            + Group bus
          </button>
          <label className="inline-field">
            Strip width
            <input type="range" min={92} max={200} value={width} onChange={(e) => setWidth(Number(e.target.value))} />
          </label>
        </div>
        <div className="toolbar-group snapshots">
          <input
            className="text-input small"
            placeholder="Snapshot name"
            value={snapName}
            onChange={(e) => setSnapName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                saveMixSnapshot(snapName)
                setSnapName('')
              }
            }}
          />
          <button
            className="chip"
            onClick={() => {
              saveMixSnapshot(snapName)
              setSnapName('')
            }}
          >
            Save mix
          </button>
          {project.snapshots.map((s) => (
            <button key={s.id} className="chip snapshot" onClick={() => recallMixSnapshot(s.id)} title={`Recall ${s.name}`}>
              {s.name}
            </button>
          ))}
        </div>
      </div>
      <SidechainBar />
      <MixerMeters />
      <div className="mixer-strips">
        {project.tracks.map((t) => (
          <ChannelStrip key={t.id} track={t} groups={groups} width={width} />
        ))}
        <div
          className="strip-resizer"
          onPointerDown={(e) => {
            dragRef.current = { x: e.clientX, w: width }
            const move = (ev: PointerEvent) => {
              if (!dragRef.current) return
              setWidth(clamp(dragRef.current.w + (ev.clientX - dragRef.current.x), 92, 200))
            }
            const up = () => {
              dragRef.current = null
              window.removeEventListener('pointermove', move)
              window.removeEventListener('pointerup', up)
            }
            window.addEventListener('pointermove', move)
            window.addEventListener('pointerup', up)
          }}
          title="Drag to resize channel strips"
        />
        <MasterStrip />
      </div>
      {project.tracks.length === 0 && (
        <div className="mixer-empty">
          <p>No channels yet.</p>
          <button className="btn accent" onClick={() => addTrack('midi', { device: 'synth' })}>
            + Add a track
          </button>
        </div>
      )}
    </div>
  )
}
