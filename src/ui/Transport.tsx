import { useEffect, useState } from 'react'
import { engine } from '../audio/engine'
import { getState, setSettings, setUi, useProject, useSettings, useUi } from '../state/store'
import { setBpm, setKey, stopTransport, toggleLoop, togglePlay } from '../state/actions'
import { startRecording, stopRecording } from '../state/record'
import { useBeat } from './beatTicker'
import { MasterMeter } from './bits'
import { KEY_ROOT_NAMES, SCALES, beatToBar, clamp } from '../state/types'
import { addTempoPoint, addTimeSignature, applyMasterPreset, startVocalBooth } from '../state/features'
import { MASTER_PRESETS } from '../data/presets'


function TempoField() {
  const project = useProject()
  const [dragging, setDragging] = useState<{ y: number; bpm: number } | null>(null)
  const [editing, setEditing] = useState(false)
  return (
    <div
      className="tempo-field"
      title="Tempo — drag up/down to change, click to type"
      onPointerDown={(e) => {
        if (editing) return
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        setDragging({ y: e.clientY, bpm: project.bpm })
      }}
      onPointerMove={(e) => {
        if (!dragging) return
        setBpm(clamp(dragging.bpm + Math.round((dragging.y - e.clientY) / 3), 30, 300))
      }}
      onPointerUp={() => setDragging(null)}
      onDoubleClick={() => setEditing(true)}
    >
      {editing ? (
        <input
          autoFocus
          className="tempo-input"
          type="number"
          min={30}
          max={300}
          defaultValue={project.bpm}
          onBlur={(e) => {
            setBpm(Number(e.target.value))
            setEditing(false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              setBpm(Number((e.target as HTMLInputElement).value))
              setEditing(false)
            }
          }}
        />
      ) : (
        <>
          <span className="tempo-value">{project.bpm}</span>
          <span className="tempo-label">BPM</span>
        </>
      )}
    </div>
  )
}

function CpuClock() {
  const [cpu, setCpu] = useState(0)
  const [clock, setClock] = useState(() => new Date())
  useEffect(() => {
    const t = window.setInterval(() => {
      setCpu(engine.cpuLoad)
      setClock(new Date())
    }, 500)
    return () => window.clearInterval(t)
  }, [])
  return (
    <div className="cpu-block" title="Scheduler load, sample rate and local time">
      <div className="cpu-row">
        <span>DSP</span>
        <div className="cpu-bar">
          <div style={{ width: `${Math.min(100, cpu * 100)}%` }} />
        </div>
        <span className="mono">{Math.round(cpu * 100)}%</span>
      </div>
      <div className="cpu-row small mono">
        <span>{engine.sampleRate / 1000} kHz</span>
        <span>{clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
    </div>
  )
}

function Position() {
  const beat = useBeat()
  const project = useProject()
  const recording = useUi().recording
  const display = beat < 0 ? `-${Math.ceil(-beat)}` : beatToBar(beat, project.timeSig)
  const seconds = Math.max(0, (beat * 60) / project.bpm)
  return (
    <div className={`position ${recording ? 'recording' : ''}`} title="Playhead position (bar.beat)">
      <span className="pos-main">{display}</span>
      <span className="pos-sub mono">
        {Math.floor(seconds / 60)}:{String(Math.floor(seconds % 60)).padStart(2, '0')}
      </span>
    </div>
  )
}

export default function Transport({ onVoiceToggle, voiceListening }: { onVoiceToggle: () => void; voiceListening: boolean }) {
  const ui = useUi()
  const project = useProject()
  const settings = useSettings()
  const playing = engine.isPlaying

  const views: { id: 'seq' | 'mix' | 'rack' | 'home'; label: string; key: string }[] = [
    { id: 'seq', label: 'Sequencer', key: '1' },
    { id: 'mix', label: 'Mixer', key: '2' },
    { id: 'rack', label: 'Racks', key: '3' },
    { id: 'home', label: 'Room', key: '4' },
  ]

  return (
    <header className="transport">
      <div className="transport-left">
        <button className="brand" onClick={() => setUi({ view: 'home' })} title="Back to the control room">
          <span className="brand-mark">ILS</span>
          <span className="brand-sub">Infinite Lab Studio</span>
        </button>
        <nav className="view-tabs">
          {views.map((v) => (
            <button
              key={v.id}
              className={ui.view === v.id ? 'active' : ''}
              onClick={() => setUi({ view: v.id })}
              title={`${v.label} — press ${v.key}`}
            >
              {v.label}
            </button>
          ))}
        </nav>
      </div>

      <div className="transport-center">
        <div className="transport-buttons">
          <button className="tbtn" title="Return to start (Home)" onClick={() => { engine.seek(0); setUi({ positionBeat: 0 }) }}>
            ⏮
          </button>
          <button
            className="tbtn"
            title="Stop (0)"
            onClick={() => {
              if (ui.recording) void stopRecording()
              else stopTransport()
            }}
          >
            ⏹
          </button>
          <button
            className={`tbtn play ${playing ? 'active' : ''}`}
            title="Play / pause (Space)"
            onClick={() => void togglePlay()}
          >
            {playing ? '⏸' : '▶'}
          </button>
          <button
            className={`tbtn rec ${ui.recording ? 'active' : ''}`}
            title="Record (R) — arm a track first"
            onClick={() => {
              if (ui.recording) void stopRecording()
              else void startRecording()
            }}
          >
            ●
          </button>
          <button
            className={`tbtn ${project.loop.enabled ? 'active' : ''}`}
            title="Loop (L) — drag the loop strip in the ruler"
            onClick={() => toggleLoop()}
          >
            ⟲
          </button>
          <button
            className={`tbtn ${settings.metronome ? 'active' : ''}`}
            title="Metronome (M)"
            onClick={() => setSettings({ metronome: !settings.metronome })}
          >
            ♩
          </button>
        </div>

        <TempoField />

        <div className="transport-extra">
          <button
            className="chip"
            title="Arm a vocal track, load a vocal chain and start recording"
            onClick={() => void startVocalBooth()}
          >
            🎤 Vocal Booth
          </button>
          <button
            className="chip"
            title="Add a tempo change at the playhead"
            onClick={() => addTempoPoint(project.bpm, Math.round(engine.getBeat()))}
          >
            + Tempo
          </button>
          <button
            className="chip"
            title="Add a time-signature change at the playhead"
            onClick={() => {
              const bar = Math.floor(Math.max(0, engine.getBeat()) / (project.timeSig[0] || 4))
              addTimeSignature(bar, project.timeSig[0] === 4 ? 3 : 4, 4)
            }}
          >
            + Sig
          </button>
          <select
            className="mini-field"
            title="Master chain and loudness target"
            value={project.masterChain?.target === -9 ? 'club' : project.master.limiterOn ? 'streaming' : 'off'}
            onChange={(e) => applyMasterPreset(e.target.value)}
          >
            {MASTER_PRESETS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <details className="pro-menu">
            <summary className="chip" title="Pro production tools">Pro ▾</summary>
            <div className="pro-menu-body">
              <button onClick={() => setUi({ modal: 'mastering' })}>Mastering assistant</button>
              <button onClick={() => setUi({ modal: 'mixassistant' })}>Mix assistant</button>
              <button onClick={() => setUi({ modal: 'stems' })}>Separate stems</button>
              <button onClick={() => setUi({ modal: 'sample' })}>Sample editor</button>
              <button onClick={() => setUi({ modal: 'midifx' })}>MIDI effects</button>
              <button onClick={() => setUi({ modal: 'drumrack' })}>Drum Rack</button>
              <button onClick={() => setUi({ modal: 'templates' })}>Templates</button>
              <button onClick={() => setUi({ modal: 'storage' })}>Storage & cleanup</button>
              <button onClick={() => setUi({ modal: 'account' })}>Account & cloud</button>
              <button onClick={() => setUi({ modal: 'share' })}>Share project</button>
              <button onClick={() => setUi({ modal: 'export' })}>Export audio</button>
            </div>
          </details>
        </div>

        <div className="transport-meta">
          <label className="mini-field" title="Time signature (beats per bar)">
            <select
              value={project.timeSig[0]}
              onChange={(e) => {
                const beats = Number(e.target.value)
                import('../state/store').then(({ commit }) =>
                  commit('Time signature', (p) => {
                    p.timeSig = [beats, 4]
                  }),
                )
              }}
            >
              {[2, 3, 4, 5, 6, 7].map((b) => (
                <option key={b} value={b}>
                  {b}/4
                </option>
              ))}
            </select>
          </label>
          <label className="mini-field" title="Project key">
            <select value={project.keyRoot} onChange={(e) => setKey(e.target.value)}>
              {KEY_ROOT_NAMES.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <select value={project.keyScale} onChange={(e) => setKey(project.keyRoot, e.target.value)}>
              {Object.keys(SCALES).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        </div>

        <Position />
      </div>

      <div className="transport-right">
        <div className="history-buttons">
          <button className="icon-btn" title="Undo (Ctrl+Z)" onClick={() => import('../state/store').then((m) => m.undo())}>
            ↶
          </button>
          <button className="icon-btn" title="Redo (Ctrl+Shift+Z)" onClick={() => import('../state/store').then((m) => m.redo())}>
            ↷
          </button>
          <button className="icon-btn" title="Save project (Ctrl+S)" onClick={() => import('../state/store').then((m) => m.saveProjectNow())}>
            ⤓
          </button>
        </div>
        <CpuClock />
        <div className="master-block" title="Master output">
          <span className="master-label">MASTER</span>
          <MasterMeter />
        </div>
        <button
          className={`voice-btn ${voiceListening ? 'listening' : ''}`}
          title="Voice control (V) — say “Hey ILS” commands"
          onClick={onVoiceToggle}
        >
          <span className="mic-dot" />
          VOICE
        </button>
        <button
          className="icon-btn"
          title="Voice, Create and Help panel"
          onClick={() => setUi({ rightPanel: ui.rightPanel === 'none' ? 'voice' : 'none' })}
        >
          ✦
        </button>
        <button className="icon-btn" title="Command palette (Ctrl/Cmd+K)" onClick={() => setUi({ palette: true })}>
          ⌘K
        </button>
        <button className="icon-btn" title="Settings" onClick={() => setUi({ modal: 'settings' })}>
          ⚙
        </button>
        <button className="icon-btn" title="Keyboard shortcuts (?)" onClick={() => setUi({ modal: 'shortcuts' })}>
          ?
        </button>
      </div>
    </header>
  )
}
