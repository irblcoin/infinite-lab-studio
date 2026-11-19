import { useMemo, useState } from 'react'
import type { Device, DeviceType, Params } from '../state/types'
import { clamp, midiName } from '../state/types'
import { addSamplerInstrument, previewPackInstrument } from '../state/actions'
import { allPatches, type Patch } from '../audio/patch'
import { loadCatalog, packInstruments } from '../data/packStore'
import WamPanel from './WamPanel'
import { commit, getState, pushHistory, setUi, toast, useProject, useUi } from '../state/store'
import {
  addDevice,
  applyDevicePreset,
  findTrack,
  moveDevice,
  removeDevice,
  setDeviceParam,
  setDeviceProps,
} from '../state/actions'
import { DEVICE_DEFS, EFFECT_TYPES, INSTRUMENT_TYPES, PRESETS, presetsFor } from '../data/deviceDefs'
import { DRUM_PADS } from '../audio/drums'
import { engine } from '../audio/engine'
import { dropLibraryItem, previewLibraryItem } from '../state/actions'
import { EqGraph, Knob } from './bits'
import { ensureLibraryBuffer, libById } from '../data/library'
import { db } from '../state/db'
import { registerBuffer, storedFromBuffer } from '../audio/assets'

interface UserPreset {
  id: string
  type: DeviceType
  name: string
  params: Params
}

function loadUserPresets(): UserPreset[] {
  try {
    return JSON.parse(localStorage.getItem('ils.userPresets') || '[]') as UserPreset[]
  } catch {
    return []
  }
}

function saveUserPreset(device: Device): void {
  const list = loadUserPresets()
  const preset: UserPreset = { id: `u_${Date.now()}`, type: device.type, name: `${device.name} custom`, params: { ...device.params } }
  list.unshift(preset)
  localStorage.setItem('ils.userPresets', JSON.stringify(list.slice(0, 80)))
  toast(`Preset "${preset.name}" saved`, 'ok')
}

function ParamControl({
  trackId,
  device,
  def,
}: {
  trackId: string
  device: Device
  def: { key: string; label: string; min: number; max: number; def: number; step?: number; unit?: string; options?: string[] }
}) {
  const value = device.params[def.key] ?? def.def
  if (def.options) {
    return (
      <label className="param param-select">
        <span>{def.label}</span>
        <select
          value={Math.round(value)}
          onChange={(e) => {
            pushHistory()
            setDeviceParam(trackId, device.id, def.key, Number(e.target.value))
          }}
        >
          {def.options.map((o, i) => (
            <option key={o} value={i}>
              {o}
            </option>
          ))}
        </select>
      </label>
    )
  }
  return (
    <div className="param">
      <Knob
        value={value}
        min={def.min}
        max={def.max}
        def={def.def}
        label={def.label}
        unit={def.unit}
        onChange={(v) => setDeviceParam(trackId, device.id, def.key, v)}
        onStart={pushHistory}
        format={(v) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v * 100) / 100}${def.unit ?? ''}`)}
      />
    </div>
  )
}

function MacroKnobs({ trackId, device }: { trackId: string; device: Device }) {
  const params = DEVICE_DEFS[device.type].params
  const macros = device.macroTargets ?? {}
  return (
    <div className="macros">
      <span className="section-label">Macros</span>
      <div className="macro-row">
        {[0, 1, 2, 3].map((i) => {
          const key = macros[`m${i + 1}`] ?? params[Math.min(i, params.length - 1)]?.key
          const def = params.find((p) => p.key === key)
          const raw = def ? device.params[def.key] ?? def.def : 0
          const norm = def ? (raw - def.min) / (def.max - def.min || 1) : 0
          return (
            <div key={i} className="macro">
              <Knob
                value={norm}
                min={0}
                max={1}
                def={0.5}
                size={36}
                label={`M${i + 1}`}
                onChange={(v) => {
                  if (!def) return
                  setDeviceParam(trackId, device.id, def.key, def.min + v * (def.max - def.min))
                }}
                onStart={pushHistory}
                format={() => (def ? `${Math.round(clamp(norm, 0, 1) * 100)}%` : '—')}
              />
              <select
                value={key ?? ''}
                onChange={(e) => {
                  commit('Map macro', (p) => {
                    const t = findTrack(p, trackId)
                    const d = t?.devices.find((x) => x.id === device.id)
                    if (d) {
                      d.macroTargets = { ...(d.macroTargets ?? {}), [`m${i + 1}`]: e.target.value }
                    }
                  })
                }}
                title="Macro target"
              >
                {params.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function DrumPads({ trackId }: { trackId: string }) {
  return (
    <div className="drum-pads">
      {DRUM_PADS.map((pad, i) => (
        <button
          key={pad.kind}
          className="drum-pad"
          onClick={() => engine.audition(trackId, 36 + i, 0.9, 0.4, true)}
          title={`${pad.label} — pad ${i + 1} (${midiName(36 + i)})`}
        >
          <span className="pad-name">{pad.label}</span>
          <span className="pad-note">{midiName(36 + i)}</span>
        </button>
      ))}
      <div className="row gap wrap">
        <button className="chip" onClick={() => setUi({ modal: 'drumrack' })}>
          Open Drum Rack — per-pad chains & choke
        </button>
      </div>
      <p className="dim small pad-help">
        Click pads or play C1–D#2 on your MIDI keyboard / computer keys. The Drum Steps editor writes to these pitches.
      </p>
    </div>
  )
}

function SamplerDrop({ trackId, device }: { trackId: string; device: Device }) {
  const [busy, setBusy] = useState(false)
  const handleFile = async (file: File) => {
    setBusy(true)
    try {
      const ctx = engine.ctx ?? (await engine.start())
      const buffer = await ctx.decodeAudioData(await file.arrayBuffer())
      const asset = storedFromBuffer(file.name, buffer)
      await db.putAsset(asset)
      registerBuffer(asset.id, buffer)
      setDeviceProps(trackId, device.id, { sampleId: asset.id })
      toast(`Loaded ${file.name} into the sampler`, 'ok')
    } catch {
      toast('Could not read that audio file', 'err')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      className="sampler-drop"
      onDragOver={(e) => e.preventDefault()}
      onDrop={async (e) => {
        e.preventDefault()
        const libId = e.dataTransfer.getData('text/ils-library')
        if (libId) {
          const buf = await ensureLibraryBuffer(libId)
          if (buf) {
            setDeviceProps(trackId, device.id, { sampleId: libId })
            toast(`${libById(libId)?.name ?? 'Sample'} loaded`, 'ok')
          }
          return
        }
        const file = e.dataTransfer.files?.[0]
        if (file) await handleFile(file)
      }}
    >
      <span>{busy ? 'Decoding…' : device.sampleId ? `Sample: ${libById(device.sampleId)?.name ?? 'loaded'}` : 'Drop a sample or audio file here'}</span>
      <label className="chip file-chip">
        Browse
        <input
          type="file"
          accept="audio/*"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void handleFile(f)
          }}
        />
      </label>
      {device.sampleId && (
        <button
          className="chip"
          onClick={async () => {
            const buf = await ensureLibraryBuffer(device.sampleId!)
            if (buf) engine.previewBuffer(buf)
          }}
        >
          Audition
        </button>
      )}
    </div>
  )
}

export default function Racks() {
  const project = useProject()
  const ui = useUi()
  const track = findTrack(project, ui.selectedTrackId) ?? project.tracks[0]
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null)
  const [browserTab, setBrowserTab] = useState<'sampled' | 'instruments' | 'effects' | 'presets'>('sampled')
  const [search, setSearch] = useState('')
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [userPresets, setUserPresets] = useState<UserPreset[]>(() => loadUserPresets())

  const devices = track?.devices ?? []
  const device = devices.find((d) => d.id === selectedDeviceId) ?? devices[0] ?? null

  const browserList = useMemo(() => {
    const q = search.toLowerCase()
    if (browserTab === 'sampled') {
      const list = [...packInstruments(), ...allPatches().filter((p) => p.packId === 'user')]
      return list
        .filter((p) => !q || p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q))
        .map((p) => ({ key: p.id, label: p.name, type: 'sampler' as DeviceType, sub: `${p.category} · ${p.zones.length} zones` }))
    }
    if (browserTab === 'presets') {
      const all = [
        ...PRESETS.map((p) => ({ key: p.id, label: p.name, type: p.type, sub: DEVICE_DEFS[p.type].name })),
        ...userPresets.map((p) => ({ key: p.id, label: p.name, type: p.type, sub: 'user preset' })),
      ]
      return all.filter((p) => !q || p.label.toLowerCase().includes(q) || p.sub.toLowerCase().includes(q))
    }
    const types = browserTab === 'instruments' ? INSTRUMENT_TYPES : EFFECT_TYPES
    return types
      .filter((t) => !q || DEVICE_DEFS[t].name.toLowerCase().includes(q) || DEVICE_DEFS[t].blurb.toLowerCase().includes(q))
      .map((t) => ({ key: t, label: DEVICE_DEFS[t].name, type: t, sub: DEVICE_DEFS[t].blurb }))
  }, [browserTab, search, userPresets])

  if (!track) {
    return (
      <div className="racks empty">
        <p>No tracks yet — add one in the Sequencer to start building racks.</p>
        <button className="btn accent" onClick={() => setUi({ view: 'seq' })}>
          Go to Sequencer
        </button>
      </div>
    )
  }

  return (
    <div className="racks">
      <aside className="rack-chain">
        <div className="panel-head">
          <div>
            <span className="section-label">Device chain</span>
            <h3 style={{ color: track.color }}>{track.name}</h3>
          </div>
          <span className="badge ghost">{track.kind}</span>
        </div>
        <div className="chain-list">
          {devices.map((d, i) => (
            <div
              key={d.id}
              className={`device-card ${device?.id === d.id ? 'selected' : ''} ${d.bypass ? 'bypassed' : ''} ${dragIdx === i ? 'dragging' : ''}`}
              draggable
              onDragStart={() => setDragIdx(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                if (dragIdx != null && dragIdx !== i) moveDevice(track.id, dragIdx, i)
                setDragIdx(null)
              }}
              onClick={() => setSelectedDeviceId(d.id)}
              style={{ borderLeftColor: DEVICE_DEFS[d.type].color }}
            >
              <div className="dc-main">
                <span className="dc-name">{d.name}</span>
                <span className="dc-kind">{DEVICE_DEFS[d.type].category === 'instrument' ? 'INSTRUMENT' : 'EFFECT'}</span>
              </div>
              <div className="dc-buttons">
                <button
                  className={`mini ghost ${d.bypass ? '' : 'on-led'}`}
                  title={d.bypass ? 'Enable' : 'Bypass'}
                  onClick={(e) => {
                    e.stopPropagation()
                    setDeviceProps(track.id, d.id, { bypass: !d.bypass })
                  }}
                >
                  ◉
                </button>
                <button
                  className="mini ghost"
                  title="Remove device"
                  onClick={(e) => {
                    e.stopPropagation()
                    removeDevice(track.id, d.id)
                  }}
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
          <div
            className="chain-drop"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              const libId = e.dataTransfer.getData('text/ils-library')
              const deviceSpec = e.dataTransfer.getData('text/ils-device')
              if (deviceSpec) {
                const [type, presetName] = deviceSpec.split('|')
                const preset = PRESETS.find((p) => p.type === type && p.name === presetName)
                addDevice(track.id, type as DeviceType, preset?.params, presetName || undefined)
              } else if (libId) {
                void dropLibraryItem(libId, track.id)
              }
              setDragIdx(null)
            }}
          >
            Drag effects here, or use the browser →
          </div>
        </div>
        <div className="chain-quick">
          <button className="btn" onClick={() => addDevice(track.id, track.kind === 'drum' ? 'drums' : 'synth')} title="Add an instrument">
            + Instrument
          </button>
          <button className="btn" onClick={() => addDevice(track.id, 'eq3')} title="Add EQ">
            + EQ
          </button>
          <button className="btn" onClick={() => addDevice(track.id, 'comp')} title="Add compressor">
            + Comp
          </button>
          <button className="btn" onClick={() => addDevice(track.id, 'reverb')} title="Add reverb">
            + Reverb
          </button>
        </div>
      </aside>

      <section className="rack-device">
        {!device && (
          <div className="device-empty">
            <h3>This track has no devices</h3>
            <p>Add an instrument to play notes, then stack effects after it. Drag devices to reorder the chain.</p>
          </div>
        )}
        {device && (
          <>
            <div className="device-head">
              <div>
                <span className="section-label">{DEVICE_DEFS[device.type].category}</span>
                <h2 style={{ color: DEVICE_DEFS[device.type].color }}>{device.name}</h2>
                <p className="dim small">{DEVICE_DEFS[device.type].blurb}</p>
              </div>
              <div className="device-actions">
                <select
                  value=""
                  onChange={(e) => {
                    if (e.target.value) applyDevicePreset(track.id, device.id, e.target.value)
                  }}
                  title="Load preset"
                >
                  <option value="">Load preset…</option>
                  {presetsFor(device.type).map((p) => (
                    <option key={p.id} value={p.name}>
                      {p.name}
                    </option>
                  ))}
                  {userPresets
                    .filter((p) => p.type === device.type)
                    .map((p) => (
                      <option key={p.id} value={p.name}>
                        {p.name}
                      </option>
                    ))}
                </select>
                <button
                  className="chip"
                  onClick={() => {
                    saveUserPreset(device)
                    setUserPresets(loadUserPresets())
                  }}
                >
                  Save preset
                </button>
                <button className={`chip ${device.bypass ? 'on' : ''}`} onClick={() => setDeviceProps(track.id, device.id, { bypass: !device.bypass })}>
                  {device.bypass ? 'Bypassed' : 'Active'}
                </button>
              </div>
            </div>

            {device.type === 'eq3' && <EqGraph params={device.params} />}
            {device.type === 'drums' && <DrumPads trackId={track.id} />}
            {device.type === 'sampler' && <SamplerDrop trackId={track.id} device={device} />}

            <div className="param-grid">
              {DEVICE_DEFS[device.type].params.map((def) => (
                <ParamControl key={def.key} trackId={track.id} device={device} def={def} />
              ))}
            </div>
            <MacroKnobs trackId={track.id} device={device} />
          </>
        )}
      </section>

      <aside className="rack-browser">
        <div className="browser-tabs">
          {(['sampled', 'instruments', 'effects', 'presets'] as const).map((t) => (
            <button key={t} className={browserTab === t ? 'active' : ''} onClick={() => setBrowserTab(t)}>
              {t === 'sampled' ? 'Sampled' : t === 'instruments' ? 'Synths' : t === 'effects' ? 'Effects' : 'Presets'}
            </button>
          ))}
        </div>
        <input
          className="text-input"
          placeholder="Search devices and presets"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="browser-list">
          {browserList.map((item) => (
            <button
              key={item.key}
              className="browser-item"
              draggable
              onDragStart={(e) => {
                if (browserTab === 'sampled') {
                  e.dataTransfer.setData('text/ils-library', `patch:${item.key}`)
                  e.dataTransfer.effectAllowed = 'copy'
                  return
                }
                const preset = browserTab === 'presets' ? PRESETS.find((p) => p.id === item.key) : null
                const spec = preset ? `${preset.type}|${preset.name}` : `${item.type}|`
                e.dataTransfer.setData('text/ils-device', spec)
                e.dataTransfer.effectAllowed = 'copy'
              }}
              onClick={() => {
                if (browserTab === 'sampled') {
                  addSamplerInstrument(item.key, track.id)
                  void previewPackInstrument(item.key)
                  return
                }
                if (browserTab === 'presets') {
                  const preset = PRESETS.find((p) => p.id === item.key)
                  if (preset && device && preset.type === device.type) applyDevicePreset(track.id, device.id, preset.name)
                  else if (preset) addDevice(track.id, preset.type, preset.params, preset.name)
                  else {
                    const up = userPresets.find((p) => p.id === item.key)
                    if (up) addDevice(track.id, up.type, up.params, up.name)
                  }
                } else {
                  addDevice(track.id, item.type as DeviceType)
                }
              }}
              title={`${item.label} — ${item.sub}`}
            >
              <span className="bi-label">{item.label}</span>
              <span className="bi-sub">{item.sub}</span>
              <span className="bi-add">＋</span>
            </button>
          ))}
          {browserList.length === 0 && <p className="dim small">No matches. Try another search.</p>}
        </div>
        <div className="browser-hint dim small">Click to add to “{track.name}” · effects can be dragged into the chain</div>
        {browserTab === 'effects' && <WamPanel />}
      </aside>
    </div>
  )
}
