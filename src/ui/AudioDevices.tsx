import { useEffect, useRef, useState } from 'react'
import { engine } from '../audio/engine'
import { midi, type MidiDeviceInfo } from '../audio/midi'
import { getPatch, allPatches } from '../audio/patch'
import { installedBytes, loadCatalog, packState, subscribePacks } from '../data/packStore'
import { setUi, toast } from '../state/store'

function fmtMs(sec: number): string {
  return `${(sec * 1000).toFixed(1)} ms`
}

export function AudioDiagnostics() {
  const [state, setState] = useState(() => engine.ctx?.state ?? 'closed')
  const [ir, setIr] = useState<string | null>(engine.irName)
  const [packs, setPacks] = useState(0)
  const irInput = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const tick = () => setState(engine.ctx?.state ?? 'closed')
    tick()
    const id = window.setInterval(tick, 800)
    void loadCatalog()
      .then(() => setPacks(allPatches().length))
      .catch(() => setPacks(allPatches().length))
    return () => window.clearInterval(id)
  }, [])

  const latency = engine.ctx ? (engine.ctx.baseLatency || 0) + (engine.ctx.outputLatency || 0) : 0

  return (
    <div className="audio-diag">
      <div className="row gap space-between">
        <span className={`audio-led ${state === 'running' ? 'on' : 'off'}`} title={state === 'running' ? 'Audio engine running' : 'Audio engine suspended'}>
          <i />
          {state === 'running' ? 'AUDIO RUNNING' : state === 'suspended' ? 'AUDIO SUSPENDED' : 'AUDIO OFF'}
        </span>
        <span className="mono small dim">
          {engine.sampleRate ? `${(engine.sampleRate / 1000).toFixed(1)} kHz` : '—'} · {fmtMs(latency)} · {packs} sampled instruments
        </span>
      </div>
      <div className="row gap wrap">
        <button
          className="btn accent"
          onClick={async () => {
            await engine.start()
            const ok = engine.testTone()
            toast(ok ? 'Test tone playing — you should hear a C major chord' : 'Audio engine is not ready yet', ok ? 'ok' : 'err')
          }}
        >
          Play test tone
        </button>
        <button
          className="btn"
          onClick={async () => {
            const ctx = await engine.start()
            if (ctx.state !== 'running') toast('The browser still has audio suspended. Click anywhere, then try again.', 'warn', 5000)
            else toast('Audio context is running', 'ok')
          }}
        >
          Resume audio
        </button>
        <button className="chip" onClick={() => setUi({ libraryOpen: true })}>
          Sound packs
        </button>
      </div>
      <label className="row gap space-between">
        <span>Convolution reverb impulse</span>
        <span className="row gap">
          <span className="mono small dim">{ir ?? 'generated IR'}</span>
          <button className="chip" onClick={() => irInput.current?.click()}>
            Load IR
          </button>
        </span>
        <input
          ref={irInput}
          type="file"
          accept="audio/*"
          style={{ display: 'none' }}
          onChange={async (e) => {
            const f = e.target.files?.[0]
            if (!f) return
            const res = await engine.importImpulseResponse(f)
            toast(res.message, res.ok ? 'ok' : 'err', 5000)
            if (res.ok) setIr(engine.irName)
            e.target.value = ''
          }}
        />
      </label>
    </div>
  )
}

export function InputDevices() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [active, setActive] = useState<string>(engine.micDeviceId ?? '')
  const [status, setStatus] = useState<string>('')

  const refresh = async () => {
    const list = await engine.listInputDevices()
    setDevices(list)
    if (!engine.micDeviceId && list[0]) setActive(list[0].deviceId)
  }

  useEffect(() => {
    void refresh()
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh)
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refresh)
  }, [])

  return (
    <div className="input-devices">
      <label className="row gap space-between">
        <span>Audio input</span>
        <select
          value={active}
          onChange={async (e) => {
            const id = e.target.value
            setActive(id)
            const res = await engine.switchMic(id || null)
            setStatus(res.ready ? 'Microphone ready' : (res.error ?? 'Microphone unavailable'))
            if (res.ready) await refresh()
          }}
        >
          <option value="">System default</option>
          {devices.map((d, i) => (
            <option key={d.deviceId || i} value={d.deviceId}>
              {d.label || `Input ${i + 1}`}
            </option>
          ))}
        </select>
      </label>
      <div className="row gap">
        <button
          className="chip"
          onClick={async () => {
            const res = await engine.enableMic(active || null)
            setStatus(res.ready ? 'Microphone ready' : (res.error ?? 'Microphone unavailable'))
            if (res.ready) await refresh()
          }}
        >
          Enable mic
        </button>
        <span className="dim small">{status}</span>
      </div>
    </div>
  )
}

export function MidiDevices() {
  const [state, setState] = useState(() => ({
    supported: midi.supported,
    enabled: midi.enabled,
    devices: midi.devices as MidiDeviceInfo[],
    error: midi.error,
    connecting: midi.connecting,
  }))

  useEffect(() => {
    const un = midi.subscribe(() =>
      setState({
        supported: midi.supported,
        enabled: midi.enabled,
        devices: [...midi.devices],
        error: midi.error,
        connecting: midi.connecting,
      }),
    )
    return () => {
      un()
    }
  }, [])

  return (
    <div className="midi-devices">
      <div className="row gap space-between">
        <span>MIDI keyboards</span>
        <span className={`badge ${state.enabled ? 'on' : state.supported ? '' : 'err'}`}>
          {!state.supported ? 'NO WEB MIDI' : state.enabled ? `${state.devices.length} CONNECTED` : 'NOT CONNECTED'}
        </span>
      </div>
      {state.devices.length > 0 && (
        <ul className="device-list">
          {state.devices.map((d) => (
            <li key={d.id} className="mono small">
              {d.name} {d.manufacturer ? <span className="dim">· {d.manufacturer}</span> : null}
            </li>
          ))}
        </ul>
      )}
      <div className="row gap">
        <button
          className="chip"
          disabled={!state.supported || state.connecting}
          onClick={async () => {
            const ok = await midi.enable()
            toast(ok ? 'MIDI connected — play your keyboard' : (midi.error ?? 'MIDI unavailable'), ok ? 'ok' : 'warn', 4500)
          }}
        >
          {state.connecting ? 'Connecting…' : state.enabled ? 'Rescan' : 'Connect MIDI'}
        </button>
        {!state.supported && <span className="dim small">Use Chrome or Edge for Web MIDI. The on-screen pads still work.</span>}
      </div>
    </div>
  )
}

export function PackSummary() {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const un = subscribePacks(() => setTick((n) => n + 1))
    void loadCatalog()
    return () => {
      un()
    }
  }, [])
  const bytes = installedBytes()
  const core = ['salamander', 'drums'].map((id) => packState(id).status === 'installed')
  void tick
  return (
    <span className="dim small">
      {(bytes / 1024 / 1024).toFixed(1)} MB of sampled instruments installed
      {core.every(Boolean) ? '' : ' · starter packs still installing'}
    </span>
  )
}

/** Resolve a patch name for UI labels without importing the store everywhere. */
export function patchLabel(id?: string): string | null {
  return getPatch(id)?.name ?? null
}
