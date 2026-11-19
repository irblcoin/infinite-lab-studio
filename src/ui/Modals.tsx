import { useEffect, useRef, useState } from 'react'
import type { Project } from '../state/types'
import { clamp } from '../state/types'
import { db, type StoredProject } from '../state/db'
import { commit, exportProjectFile, getState, importProjectFile, newProject, openProjectById, persistProject, saveProjectNow, setSettings, setUi, toast, useProject, useSettings, useUi } from '../state/store'
import { engine } from '../audio/engine'
import { audioBufferToMp3, audioBufferToWav, downloadBlob, projectToMidi, renderProject } from '../audio/render'
import { setActiveTake, stopRecording } from '../state/record'
import { findClip, importAudioFile } from '../state/actions'
import { VOICE_HELP } from '../voice/commands'
import { Modal } from './bits'
import { latencyFromMeasurement } from '../state/record'
import { AudioDiagnostics, InputDevices, MidiDevices } from './AudioDevices'
import { getCatalog, packMeta } from '../data/packStore'
import {
  AccountModal,
  DrumRackModal,
  MasteringModal,
  MidiFxModal,
  MixAssistModal,
  SampleEditorModal,
  ShareModal,
  StemsModal,
  StorageModal,
  TemplatesModal,
} from './ProTools'

function ExportModal() {
  const project = useProject()
  const ui = useUi()
  const [busy, setBusy] = useState<string | null>(null)
  const [loopOnly, setLoopOnly] = useState(false)
  const [progress, setProgress] = useState(0)
  const [format, setFormat] = useState<'wav' | 'mp3'>('wav')
  const [bitDepth, setBitDepth] = useState<16 | 24 | 32>(24)
  const close = () => setUi({ modal: null })
  const safeName = project.name.replace(/[^\w-]+/g, '_') || 'ils-project'

  const opts = loopOnly ? { startBeat: project.loop.start, endBeat: project.loop.end, masterLimiter: true } : {}

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label)
    setProgress(0)
    try {
      await fn()
      toast(`${label} complete`, 'ok')
    } catch (err) {
      console.warn(err)
      toast(`${label} failed: ${err instanceof Error ? err.message : 'unknown error'}`, 'err', 5000)
    } finally {
      setBusy(null)
      setProgress(0)
    }
  }

  const exportMix = () =>
    run(`Rendering ${format.toUpperCase()}`, async () => {
      setProgress(0.15)
      const buf = await renderProject(project, opts)
      setProgress(0.7)
      if (format === 'wav') {
        downloadBlob(
          audioBufferToWav(buf, { bitDepth, dither: true }),
          `${safeName}${loopOnly ? '_loop' : ''}_${bitDepth}bit.wav`,
        )
      } else {
        const blob = await audioBufferToMp3(buf, 192)
        downloadBlob(blob, `${safeName}${loopOnly ? '_loop' : ''}.mp3`)
      }
      setProgress(1)
    })

  const exportStems = () =>
    run('Rendering stems', async () => {
      const tracks = project.tracks.filter((t) => t.kind !== 'group' && t.clips.length > 0)
      if (!tracks.length) throw new Error('No tracks with clips to render')
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i]
        setProgress(i / tracks.length)
        const buf = await renderProject(project, { ...opts, tracks: [t.id], masterLimiter: false })
        downloadBlob(
          audioBufferToWav(buf, { bitDepth, dither: true }),
          `${safeName}_stem_${String(i + 1).padStart(2, '0')}_${t.name.replace(/[^\w-]+/g, '_')}.wav`,
        )
        await new Promise((r) => setTimeout(r, 220))
      }
      setProgress(1)
    })

  return (
    <Modal title="Export" onClose={close} wide>
      <div className="export-grid">
        <div className="export-card">
          <h3>Mixdown</h3>
          <p className="dim small">Full offline render through the mixer, sends and master limiter.</p>
          <div className="seg">
            <button className={format === 'wav' ? 'on' : ''} onClick={() => setFormat('wav')}>
              WAV {format === 'wav' ? `${bitDepth}-bit` : ''}
            </button>
            <button className={format === 'mp3' ? 'on' : ''} onClick={() => setFormat('mp3')}>
              MP3 192k
            </button>
          </div>
          {format === 'wav' && (
            <div className="row gap wrap">
              {([16, 24, 32] as const).map((d) => (
                <button
                  key={d}
                  className={`chip ${bitDepth === d ? 'on' : ''}`}
                  onClick={() => setBitDepth(d)}
                  title={d === 32 ? '32-bit float — no dither needed' : `${d}-bit integer with TPDF dither`}
                >
                  {d === 32 ? '32-bit float' : `${d}-bit + dither`}
                </button>
              ))}
            </div>
          )}
          <label className="row gap small">
            <input type="checkbox" checked={loopOnly} onChange={(e) => setLoopOnly(e.target.checked)} />
            Only the loop region ({project.loop.start / 4 + 1} – {project.loop.end / 4} bars)
          </label>
          <button className="btn gold wide" onClick={() => void exportMix()} disabled={!!busy}>
            {busy ?? `Export ${format === 'wav' ? `WAV ${bitDepth}-bit` : 'MP3'}`}
          </button>
          {progress > 0 && <div className="progress"><div style={{ width: `${progress * 100}%` }} /></div>}
        </div>
        <div className="export-card">
          <h3>Stems & MIDI</h3>
          <p className="dim small">One WAV per track, plus a Standard MIDI File of every MIDI clip.</p>
          <button className="btn wide" onClick={() => void exportStems()} disabled={!!busy}>
            Export stems (WAV per track)
          </button>
          <button
            className="btn wide"
            onClick={() => {
              downloadBlob(projectToMidi(project), `${safeName}.mid`)
              toast('MIDI exported', 'ok')
            }}
            disabled={!!busy}
          >
            Export MIDI (.mid)
          </button>
          <p className="dim small">Tempo {project.bpm} BPM · {project.tracks.length} tracks · length {Math.round((project.length * 60) / project.bpm)}s</p>
        </div>
        <div className="export-card">
          <h3>Project file</h3>
          <p className="dim small">A .ils.json file with the arrangement and every recorded asset, so it opens on any device.</p>
          <button className="btn wide" onClick={() => void exportProjectFile()}>
            Export project file
          </button>
          <label className="btn wide file-chip">
            Import project file
            <input
              type="file"
              accept=".json,.ils,application/json"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void importProjectFile(f)
              }}
            />
          </label>
          <button className="btn wide" onClick={() => void saveProjectNow()}>
            Save to this browser
          </button>
        </div>
      </div>
      <p className="dim small">Rendering happens offline in your browser — nothing is uploaded. {ui.recording ? 'Stop recording before exporting.' : ''}</p>
    </Modal>
  )
}

function ProjectsModal() {
  const [list, setList] = useState<StoredProject[]>([])
  const [loading, setLoading] = useState(true)
  const close = () => setUi({ modal: null })
  const refresh = async () => {
    const all = await db.allProjects()
    setList((all || []).sort((a, b) => b.updatedAt - a.updatedAt))
    setLoading(false)
  }
  useEffect(() => {
    void refresh()
  }, [])
  return (
    <Modal title="Projects" onClose={close} wide>
      <div className="row gap space-between">
        <p className="dim small">Projects live in this browser's IndexedDB. Export a project file to move it between devices.</p>
        <div className="row gap">
          <button
            className="btn accent"
            onClick={() => {
              newProject(`Session ${new Date().toLocaleDateString()}`)
              close()
            }}
          >
            + New project
          </button>
          <label className="btn file-chip">
            Import
            <input
              type="file"
              accept=".json,.ils,application/json"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void importProjectFile(f).then(() => { void refresh(); close() })
              }}
            />
          </label>
        </div>
      </div>
      {loading && <p className="dim">Loading…</p>}
      <div className="project-grid">
        {list.map((p) => (
          <div key={p.id} className="project-card">
            <button
              className="project-open"
              onClick={async () => {
                const ok = await openProjectById(p.id)
                if (ok) {
                  toast(`Opened "${p.name}"`, 'ok')
                  close()
                }
              }}
              title={`Open ${p.name}`}
            >
              {p.thumbnail ? <img src={p.thumbnail} alt="" /> : <div className="thumb-empty">ILS</div>}
              <span className="project-name">{p.name}</span>
              <span className="dim small">{new Date(p.updatedAt).toLocaleString()}</span>
            </button>
            <div className="project-actions">
              <button className="chip" onClick={() => setUi({ modal: 'versions' })} title="Version history">
                Versions
              </button>
              <button
                className="chip danger"
                onClick={async () => {
                  await db.deleteProject(p.id)
                  void refresh()
                  toast('Project deleted', 'ok')
                }}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
        {!loading && list.length === 0 && <p className="dim">No saved projects yet. Save one from the transport bar.</p>}
      </div>
    </Modal>
  )
}

function VersionsModal() {
  const [versions, setVersions] = useState<{ key: string; savedAt: number; label: string; data: string }[]>([])
  const project = useProject()
  const close = () => setUi({ modal: 'projects' })
  useEffect(() => {
    void db.versionsFor(project.id).then(setVersions)
  }, [project.id])
  return (
    <Modal title="Version history" onClose={close} wide>
      <p className="dim small">Every save keeps a snapshot (last 20). Restoring replaces your current arrangement.</p>
      <div className="versions">
        {versions.map((v) => (
          <div key={v.key} className="version-row">
            <span>{new Date(v.savedAt).toLocaleString()}</span>
            <button
              className="chip"
              onClick={async () => {
                const { adoptProject } = await import('../state/store')
                await adoptProject(JSON.parse(v.data) as Project)
                toast('Version restored', 'ok')
                close()
              }}
            >
              Restore
            </button>
            <button
              className="chip danger"
              onClick={async () => {
                await db.deleteVersion(v.key)
                setVersions(versions.filter((x) => x.key !== v.key))
              }}
            >
              Delete
            </button>
          </div>
        ))}
        {versions.length === 0 && <p className="dim">No versions yet — press save (Ctrl+S).</p>}
      </div>
    </Modal>
  )
}

function SettingsModal() {
  const settings = useSettings()
  const ui = useUi()
  const audioRef = useRef<HTMLDivElement | null>(null)
  const latencyRef = useRef<HTMLLabelElement | null>(null)
  const close = () => setUi({ modal: null, settingsFocus: null })
  // A homepage hotspot asks for the audio interface or the latency block.
  useEffect(() => {
    const target =
      ui.settingsFocus === 'latency' ? latencyRef.current : ui.settingsFocus === 'audio' ? audioRef.current : null
    if (!target) return
    target.scrollIntoView({ block: 'center', behavior: 'smooth' })
    target.classList.add('flash')
    const timer = window.setTimeout(() => target.classList.remove('flash'), 2000)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <Modal title="Settings" onClose={close}>
      <div className="settings-grid">
        <div ref={audioRef} className="settings-anchor">
          <h3>Audio engine</h3>
          <AudioDiagnostics />
          <InputDevices />
          <MidiDevices />
        </div>
        <h3>Recording</h3>
        <label className="row gap space-between">
          <span>Count-in bars</span>
          <input
            type="number"
            min={0}
            max={4}
            value={settings.countIn}
            onChange={(e) => setSettings({ countIn: clamp(Number(e.target.value), 0, 4) })}
          />
        </label>
        <label ref={latencyRef} className="row gap space-between settings-anchor">
          <span>Latency compensation (ms)</span>
          <input
            type="number"
            min={0}
            max={500}
            value={Math.round(settings.latencyComp * 1000)}
            onChange={(e) => setSettings({ latencyComp: clamp(Number(e.target.value), 0, 500) / 1000 })}
          />
        </label>
        <label className="row gap space-between">
          <span>Input monitoring</span>
          <input type="checkbox" checked={settings.monitoring} onChange={(e) => setSettings({ monitoring: e.target.checked })} />
        </label>
        <label className="row gap space-between">
          <span>Punch in / out</span>
          <input type="checkbox" checked={settings.punch.enabled} onChange={(e) => setSettings({ punch: { ...settings.punch, enabled: e.target.checked } })} />
        </label>
        <div className="row gap">
          <button className="chip" onClick={() => setSettings({ latencyComp: 0.02 })}>20 ms</button>
          <button className="chip" onClick={() => setSettings({ latencyComp: 0.04 })}>40 ms</button>
          <button className="chip" onClick={() => setSettings({ latencyComp: 0.08 })}>80 ms</button>
          <button className="chip" onClick={latencyFromMeasurement}>Measure device latency</button>
        </div>
        <h3>Workflow</h3>
        <label className="row gap space-between">
          <span>Autosave</span>
          <input type="checkbox" checked={settings.autosave} onChange={(e) => setSettings({ autosave: e.target.checked })} />
        </label>
        <label className="row gap space-between">
          <span>Metronome</span>
          <input type="checkbox" checked={settings.metronome} onChange={(e) => setSettings({ metronome: e.target.checked })} />
        </label>
        <label className="row gap space-between">
          <span>Follow playhead</span>
          <input type="checkbox" checked={settings.followPlayhead} onChange={(e) => setSettings({ followPlayhead: e.target.checked })} />
        </label>
        <label className="row gap space-between">
          <span>Tooltips</span>
          <input type="checkbox" checked={settings.tooltips} onChange={(e) => setSettings({ tooltips: e.target.checked })} />
        </label>
        <label className="row gap space-between">
          <span>Wake word “Hey ILS”</span>
          <input type="checkbox" checked={settings.wakeWord} onChange={(e) => setSettings({ wakeWord: e.target.checked })} />
        </label>
        <h3>Storage</h3>
        <p className="dim small">Projects and recordings are stored locally in this browser. Nothing leaves your machine.</p>
        <div className="row gap">
          <button className="chip" onClick={() => void persistProject(getState().project, true).then(() => toast('Snapshot saved', 'ok'))}>
            Snapshot now
          </button>
          <button
            className="chip danger"
            onClick={() =>
              setUi({
                confirm: {
                  title: 'Clear local projects?',
                  text: 'This deletes every saved project, version and recording in this browser. Export anything you want to keep first.',
                  action: async () => {
                    const all = (await db.allProjects()) ?? []
                    for (const p of all) await db.deleteProject(p.id)
                    const assets = (await db.allAssets()) ?? []
                    for (const a of assets) await db.deleteAsset(a.id)
                    toast('Local storage cleared', 'ok')
                  },
                },
              })
            }
          >
            Clear local data
          </button>
        </div>
      </div>
    </Modal>
  )
}

function RecordModal() {
  const settings = useSettings()
  const ui = useUi()
  const project = useProject()
  const [level, setLevel] = useState(0)
  const [micState, setMicState] = useState<'idle' | 'ready' | 'error'>('idle')
  const [message, setMessage] = useState('')
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const close = () => setUi({ modal: null })
  const armed = project.tracks.find((t) => t.armed)

  useEffect(() => {
    let raf = 0
    const tick = () => {
      const lvl = engine.micLevel()
      setLevel(lvl)
      const canvas = canvasRef.current
      if (canvas) {
        const ctx = canvas.getContext('2d')
        if (ctx) {
          const w = canvas.clientWidth
          const h = canvas.clientHeight
          if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w
            canvas.height = h
          }
          ctx.clearRect(0, 0, w, h)
          ctx.strokeStyle = '#5eead4'
          ctx.lineWidth = 1.6
          ctx.beginPath()
          const data = new Float32Array(1024)
          if (engine.micWaveform(data)) {
            for (let i = 0; i < data.length; i++) {
              const x = (i / data.length) * w
              const y = h / 2 + data[i] * h * 0.45
              if (i === 0) ctx.moveTo(x, y)
              else ctx.lineTo(x, y)
            }
            ctx.stroke()
          }
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <Modal title="Record" onClose={close}>
      <div className="row gap space-between">
        <span className="dim small">
          {armed ? `Armed: ${armed.name} (${armed.kind})` : 'No track armed — arm a track in the sequencer or mixer.'}
        </span>
        <span className={`badge ${micState === 'ready' ? 'on' : micState === 'error' ? 'err' : ''}`}>
          {micState === 'ready' ? 'MIC READY' : micState === 'error' ? 'MIC BLOCKED' : 'MIC IDLE'}
        </span>
      </div>
      <canvas ref={canvasRef} className="mic-scope" />
      <div className="input-meter">
        <div style={{ width: `${Math.min(100, level * 100)}%` }} />
        <span className="input-peak mono">{level > 0.98 ? 'CLIP' : `${(20 * Math.log10(Math.max(0.0001, level))).toFixed(0)} dB`}</span>
      </div>
      {message && <div className="callout warn">{message}</div>}
      <div className="row gap">
        <button
          className="btn"
          onClick={async () => {
            const res = await engine.enableMic()
            setMicState(res.ready ? 'ready' : 'error')
            setMessage(res.error ?? '')
            if (res.ready) engine.setMonitoring(settings.monitoring)
          }}
        >
          Enable microphone
        </button>
        <button
          className={`btn ${ui.recording ? 'danger' : 'accent'}`}
          onClick={async () => {
            const { startRecording } = await import('../state/record')
            if (ui.recording) await stopRecording()
            else await startRecording()
          }}
          disabled={!armed}
        >
          {ui.recording ? 'Stop recording' : 'Start recording'}
        </button>
      </div>
      <div className="settings-grid">
        <label className="row gap space-between">
          <span>Count-in (bars)</span>
          <input type="number" min={0} max={4} value={settings.countIn} onChange={(e) => setSettings({ countIn: clamp(Number(e.target.value), 0, 4) })} />
        </label>
        <label className="row gap space-between">
          <span>Metronome during recording</span>
          <input type="checkbox" checked={settings.metronome} onChange={(e) => setSettings({ metronome: e.target.checked })} />
        </label>
        <label className="row gap space-between">
          <span>Input monitoring</span>
          <input type="checkbox" checked={settings.monitoring} onChange={(e) => setSettings({ monitoring: e.target.checked })} />
        </label>
        <label className="row gap space-between">
          <span>Punch in / out</span>
          <input
            type="checkbox"
            checked={settings.punch.enabled}
            onChange={(e) =>
              setSettings({
                punch: { enabled: e.target.checked, start: settings.punch.start, end: settings.punch.end },
              })
            }
          />
        </label>
        <label className="row gap space-between">
          <span>Latency compensation</span>
          <span className="mono">{Math.round(settings.latencyComp * 1000)} ms</span>
        </label>
        <p className="dim small">
          Arm an audio track to record your mic, or a drum/MIDI track to capture notes from your keyboard or the on-screen pads.
          Takes stack on the same clip so you can comp between them.
        </p>
      </div>
    </Modal>
  )
}

function TakesModal() {
  const project = useProject()
  const ui = useUi()
  const found = ui.selectedClipIds[0] ? findClip(project, ui.selectedClipIds[0]) : null
  const clip = found?.clip
  const track = found?.track
  const close = () => setUi({ modal: null })
  if (!clip || !track) {
    return (
      <Modal title="Takes" onClose={close}>
        <p className="dim">Select an audio clip first.</p>
      </Modal>
    )
  }
  return (
    <Modal title={`Takes — ${clip.name}`} onClose={close}>
      {!clip.takes?.length && <p className="dim">No alternative takes yet. Record over this clip to stack a new take.</p>}
      <div className="takes">
        {(clip.takes ?? []).map((take, i) => (
          <button
            key={take.id}
            className={`take-row ${clip.activeTake === i ? 'on' : ''}`}
            onClick={() => setActiveTake(track.id, clip.id, i)}
            title="Use this take"
          >
            <span>{take.name}</span>
            <span className="dim small">{take.len.toFixed(2)} beats</span>
            <span className="badge ghost">{clip.activeTake === i ? 'ACTIVE' : 'comp'}</span>
          </button>
        ))}
      </div>
      <div className="settings-grid">
        <label className="row gap space-between">
          <span>Gain</span>
          <input
            type="range"
            min={0}
            max={2}
            step={0.01}
            value={clip.gain}
            onChange={(e) => commit('Clip gain', (p) => {
              const f = findClip(p, clip.id)
              if (f) f.clip.gain = Number(e.target.value)
            })}
          />
        </label>
        <label className="row gap space-between">
          <span>Fade in (beats)</span>
          <input
            type="range"
            min={0}
            max={4}
            step={0.05}
            value={clip.fadeIn}
            onChange={(e) => commit('Fade in', (p) => {
              const f = findClip(p, clip.id)
              if (f) f.clip.fadeIn = Number(e.target.value)
            })}
          />
        </label>
        <label className="row gap space-between">
          <span>Fade out (beats)</span>
          <input
            type="range"
            min={0}
            max={4}
            step={0.05}
            value={clip.fadeOut}
            onChange={(e) => commit('Fade out', (p) => {
              const f = findClip(p, clip.id)
              if (f) f.clip.fadeOut = Number(e.target.value)
            })}
          />
        </label>
        <label className="row gap space-between">
          <span>Start offset (beats)</span>
          <input
            type="range"
            min={0}
            max={Math.max(0, clip.contentLen - 0.25)}
            step={0.05}
            value={clip.offset}
            onChange={(e) => commit('Trim clip', (p) => {
              const f = findClip(p, clip.id)
              if (f) f.clip.offset = Number(e.target.value)
            })}
          />
        </label>
        <label className="row gap space-between">
          <span>Pitch (semitones)</span>
          <input
            type="range"
            min={-12}
            max={12}
            step={1}
            value={clip.pitch}
            onChange={(e) => commit('Clip pitch', (p) => {
              const f = findClip(p, clip.id)
              if (f) f.clip.pitch = Number(e.target.value)
            })}
          />
        </label>
      </div>
    </Modal>
  )
}

function CreditsModal() {
  const close = () => setUi({ modal: null })
  const packs = getCatalog()?.packs ?? []
  return (
    <Modal title="Credits & licences" onClose={close} wide>
      <p className="dim small">
        Every instrument in ILS is a real recording from an openly licensed library. Samples are bundled with the app —
        there is no API key, login or third-party service at runtime.
      </p>
      <div className="credits-list">
        {packs.map((p) => (
          <div key={p.id} className="credit-row">
            <div>
              <strong>{p.name}</strong>
              <p className="dim small">{p.description}</p>
              <p className="mono small">
                {p.author} · {p.license} · {p.instruments.length} instrument{p.instruments.length === 1 ? '' : 's'}
              </p>
            </div>
            <div className="credit-links">
              <a href={p.source} target="_blank" rel="noreferrer">
                Source
              </a>
              <a href={p.licenseUrl} target="_blank" rel="noreferrer">
                Licence
              </a>
            </div>
          </div>
        ))}
        <div className="credit-row">
          <div>
            <strong>Impulse responses</strong>
            <p className="dim small">
              The convolution reverb ships a generated impulse by default. Load any WAV/AIFF impulse in Settings → Audio
              engine, including the public-domain EMT-140 plate and Voxengo IRs from the oramics/sampled collection.
            </p>
          </div>
          <div className="credit-links">
            <a href="https://oramics.github.io/sampled" target="_blank" rel="noreferrer">
              IR collection
            </a>
          </div>
        </div>
      </div>
      <p className="dim small">
        FluidR3 GM by Frank Wen, Salamander Grand Piano by Alexander Holm (CC BY 3.0), VSCO 2 Community Edition by
        Versilian Studios (CC0), TR-808 samples by Michael Fischer (CC0), LinnDrum LM-2 from oramics/sampled (public
        domain),         TR-909 one-shots from an openly published pack. Acoustic Kit, Hip Hop & Club Kits (with the 808 sub bass) and the
        56 real loops are sequenced from Dirt-Samples recordings (CC0). Guitars & Bass come from tonejs-instruments
        (Philharmonia samples, CC BY 3.0); Pianos & Keys, Sampled Synths and FX come from FluidR3 and tonejs-instruments
        (CC BY 3.0). Imported user samples stay in your browser only.
        {packMeta('fluidr3') ? '' : ''}
      </p>
      <div className="credit-row">
        <div>
          <strong>ILS – Infinite Lab Studio</strong>
          <p className="dim small">A product of Building Billions LLC. © 2026 Building Billions LLC. All rights reserved.</p>
        </div>
        <div className="credit-links">
          <button className="link" onClick={() => setUi({ modal: 'about' })}>
            About
          </button>
        </div>
      </div>
    </Modal>
  )
}

function AboutModal() {
  const close = () => setUi({ modal: null })
  return (
    <Modal title="About ILS" onClose={close} wide>
      <div className="about-head">
        <h2>ILS – Infinite Lab Studio</h2>
        <p className="about-line">ILS – Infinite Lab Studio is a product of Building Billions LLC.</p>
      </div>
      <p className="dim small">
        A complete production studio in a browser tab: a sequencer and piano roll, mixer with sends and sidechain,
        racks and devices, recording, real sampled instruments, stem separation, mastering and a voice assistant that
        runs the same commands you can type. It works offline once its packs are installed and needs no account or API
        key.
      </p>
      <h3>Building Billions LLC</h3>
      <p className="dim small">
        Building Billions LLC builds creative tools that run where the work happens. ILS is designed, built and
        maintained by the studio behind it.
      </p>
      <div className="row gap wrap">
        <button className="btn" onClick={() => setUi({ modal: 'credits' })}>
          Credits &amp; licences
        </button>
        <button className="btn" onClick={() => setUi({ modal: 'help' })}>
          Help &amp; voice commands
        </button>
      </div>
      <p className="dim small legal">© 2026 Building Billions LLC. All rights reserved.</p>
    </Modal>
  )
}

function HelpModal() {
  const close = () => setUi({ modal: null })
  return (
    <Modal title="Voice commands & shortcuts" onClose={close} wide>
      <div className="help-columns">
        <div>
          <h3>Say or type</h3>
          {VOICE_HELP.map((h) => (
            <div key={h.phrase} className="help-row">
              <code>{h.phrase}</code>
              <span className="dim small">{h.note}</span>
            </div>
          ))}
        </div>
        <div>
          <h3>Keys</h3>
          {[
            ['Space', 'Play / pause'],
            ['R', 'Record (toggles)'],
            ['L', 'Loop on/off'],
            ['M', 'Metronome'],
            ['1 / 2 / 3 / 4', 'Sequencer / Mixer / Racks / Room'],
            ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'],
            ['Ctrl+C / Ctrl+V', 'Copy / paste clip'],
            ['Ctrl+D', 'Duplicate clip'],
            ['Ctrl+S', 'Save project'],
            ['Q', 'Quantize selected clip'],
            ['S', 'Split at playhead'],
            ['Delete', 'Delete selected clips'],
            ['← / →', 'Move playhead by bar (Shift = beat)'],
            ['+ / −', 'Zoom timeline'],
            ['V', 'Voice panel'],
            ['?', 'This help'],
            ['Esc', 'Close dialogs'],
          ].map(([k, v]) => (
            <div key={k} className="help-row">
              <code>{k}</code>
              <span className="dim small">{v}</span>
            </div>
          ))}
        </div>
      </div>
      <p className="dim small">
        Voice needs the Web Speech API (Chrome, Edge, Safari 16+). When it is unavailable, the typed command bar in the
        Voice panel runs the identical parser, including fuzzy matching.
      </p>
      <p className="dim small">
        ILS – Infinite Lab Studio is a product of <strong>Building Billions LLC</strong>. The studio tour, the ⌘K palette
        and every panel are also described in the Help tab on the right.
      </p>
    </Modal>
  )
}

function ConfirmDialog() {
  const ui = useUi()
  if (!ui.confirm) return null
  const { title, text, action } = ui.confirm
  return (
    <Modal title={title} onClose={() => setUi({ confirm: null })}>
      <p>{text}</p>
      <div className="row gap end">
        <button className="btn" onClick={() => setUi({ confirm: null })}>
          Cancel
        </button>
        <button
          className="btn danger"
          onClick={() => {
            void action()
            setUi({ confirm: null })
          }}
        >
          Confirm
        </button>
      </div>
    </Modal>
  )
}

export default function Modals() {
  const ui = useUi()
  return (
    <>
      {ui.modal === 'export' && <ExportModal />}
      {ui.modal === 'projects' && <ProjectsModal />}
      {ui.modal === 'versions' && <VersionsModal />}
      {ui.modal === 'settings' && <SettingsModal />}
      {ui.modal === 'record' && <RecordModal />}
      {ui.modal === 'takes' && <TakesModal />}
      {ui.modal === 'help' && <HelpModal />}
      {ui.modal === 'shortcuts' && <HelpModal />}
      {ui.modal === 'credits' && <CreditsModal />}
      {ui.modal === 'about' && <AboutModal />}
      {ui.modal === 'midifx' && <MidiFxModal />}
      {ui.modal === 'sample' && <SampleEditorModal />}
      {ui.modal === 'drumrack' && <DrumRackModal />}
      {ui.modal === 'stems' && <StemsModal />}
      {ui.modal === 'mastering' && <MasteringModal />}
      {ui.modal === 'mixassistant' && <MixAssistModal />}
      {ui.modal === 'templates' && <TemplatesModal />}
      {ui.modal === 'storage' && <StorageModal />}
      {ui.modal === 'account' && <AccountModal />}
      {ui.modal === 'share' && <ShareModal />}
      <ConfirmDialog />
    </>
  )
}
