import { useEffect, useMemo, useRef, useState } from 'react'
import type { Clip, Device, PadSettings, Project, Track } from '../state/types'
import { clamp, midiName, uid } from '../state/types'
import { Modal } from './bits'
import { commit, getState, setUi, toast, useProject, useUi } from '../state/store'
import { addClip, addTrack, findClip } from '../state/actions'
import {
  applyMidiFx,
  arpClip,
  chordifyClip,
  humanizeClip,
  scaleQuantizeClip,
} from '../state/features'
import { addDevice } from '../state/actions'
import { DRUM_PADS } from '../audio/drums'
import { engine } from '../audio/engine'
import { getBuffer, registerBuffer, storedFromBuffer } from '../audio/assets'
import { db } from '../state/db'
import {
  chromaticCopies,
  clipBuffer,
  clipToSamplerTrack,
  computeSlices,
  setLoopPoints,
  setSampleRange,
  sliceClipToTimeline,
  type SliceMode,
} from '../audio/sampleTools'
import { separateStems, cancelSeparation, STEM_NAMES } from '../audio/stemSeparator'
import { analyzeProjectMix, applyMastering, masteringPlan, type MasteringPlan, type MixAnalysis } from '../audio/mastering'
import { analyzeTracks, suggestionsFrom, type MixSuggestion } from '../audio/mixassist'
import {
  listTrackTemplates,
  listProjectTemplates,
  applyTrackTemplate,
  saveTrackTemplate,
  saveProjectTemplate,
  openProjectTemplate,
  deleteTrackTemplate,
  deleteProjectTemplate,
} from '../state/templates'
import { cleanupStorage, formatBytes, requestPersistence, storageReport, type StorageReport } from '../state/storage'
import { exportProjectZip } from '../state/projectFiles'
import { audioBufferToWav, downloadBlob, renderProject } from '../audio/render'
import {
  cloudAvailable,
  cloudList,
  cloudLoad,
  cloudSave,
  cloudSignIn,
  cloudSignUp,
  createShareLink,
  currentAccount,
  localAccounts,
  signOut,
  signUpLocal,
  signInLocal,
  type Account,
} from '../state/accounts'
import { adoptProject } from '../state/store'
import { regenerateClip, shiftMood, makeVariation, lyricsToMelody } from '../music/songwriter'
import { CHORD_VOICINGS } from '../data/chords'

const close = () => setUi({ modal: null })

function selectedAudioClip(project: Project): { clip: Clip; track: Track } | null {
  const { ui } = getState()
  const hit = ui.selectedClipIds[0] ? findClip(project, ui.selectedClipIds[0]) : null
  if (hit?.clip.kind === 'audio') return hit
  for (const t of project.tracks) {
    const c = t.clips.find((x) => x.kind === 'audio')
    if (c) return { clip: c, track: t }
  }
  return null
}

// ---------------------------------------------------------------------------
// MIDI effects
// ---------------------------------------------------------------------------
export function MidiFxModal() {
  const project = useProject()
  const ui = useUi()
  const hit = ui.selectedClipIds[0] ? findClip(project, ui.selectedClipIds[0]) : null
  const clip = hit?.clip
  const midi = clip?.kind === 'midi'
  return (
    <Modal title="MIDI effects" onClose={close}>
      <p className="dim small">
        {midi
          ? `Applying to “${clip.name}” — ${clip.notes.length} notes. Effects are non-destructive until you undo.`
          : 'Select a MIDI clip in the sequencer first, then open MIDI effects.'}
      </p>
      {midi && clip && (
        <>
          <div className="section-block">
            <span className="section-label">Arpeggiator</span>
            <div className="chip-row">
              {(['up', 'down', 'updown', 'random'] as const).map((m) => (
                <button key={m} className="chip" onClick={() => arpClip(clip.id, m, 0.5, 1)}>
                  {m} 1/8
                </button>
              ))}
              <button className="chip" onClick={() => arpClip(clip.id, 'up', 0.25, 1)}>
                up 1/16
              </button>
              <button className="chip" onClick={() => arpClip(clip.id, 'up', 0.5, 2)}>
                up 2 oct
              </button>
            </div>
          </div>
          <div className="section-block">
            <span className="section-label">Chord generator</span>
            <div className="chip-row">
              {(['triad', 'seventh', 'sus4', 'octave', 'diatonic'] as const).map((m) => (
                <button key={m} className="chip" onClick={() => chordifyClip(clip.id, m)}>
                  {m}
                </button>
              ))}
            </div>
          </div>
          <div className="section-block">
            <span className="section-label">Humanize / scale / random</span>
            <div className="chip-row">
              <button className="chip" onClick={() => humanizeClip(clip.id)}>
                Humanize feel
              </button>
              <button className="chip" onClick={() => scaleQuantizeClip(clip.id)}>
                Quantize to {project.keyRoot} {project.keyScale}
              </button>
              <button className="chip" onClick={() => applyMidiFx(clip.id, 'arp_updown')}>
                Pattern: up/down 16th
              </button>
              <button className="chip" onClick={() => applyMidiFx(clip.id, 'chord_7th')}>
                Voice: 7th chords
              </button>
            </div>
          </div>
          <div className="section-block">
            <span className="section-label">Variation</span>
            <div className="chip-row">
              <button className="chip" onClick={() => regenerateClip(clip.id)}>
                Regenerate this section
              </button>
              <button className="chip" onClick={() => makeVariation(clip.id)}>
                Make variation
              </button>
              <button className="chip" onClick={() => shiftMood(clip.id, 'darker')}>
                Darker
              </button>
              <button className="chip" onClick={() => shiftMood(clip.id, 'brighter')}>
                Brighter
              </button>
            </div>
          </div>
        </>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Sample editor
// ---------------------------------------------------------------------------
export function SampleEditorModal() {
  const project = useProject()
  const found = selectedAudioClip(project)
  const [mode, setMode] = useState<SliceMode>('beats')
  const [divisions, setDivisions] = useState(4)
  const [start, setStart] = useState(0)
  const [end, setEnd] = useState(4)
  const [pitch, setPitch] = useState(0)
  const [lyric, setLyric] = useState('')
  const buffer = found ? clipBuffer(found.clip) : null
  const slices = buffer ? computeSlices(buffer, project.bpm, mode, divisions) : []

  useEffect(() => {
    if (!found) return
    setStart(Math.round(found.clip.offset * 100) / 100)
    setEnd(Math.round((found.clip.offset + found.clip.len) * 100) / 100)
    setPitch(found.clip.pitch ?? 0)
    setLyric(project.lyrics[0]?.text ?? '')
  }, [found?.clip.id])

  const updateClipField = (patch: Partial<Clip>) => {
    if (!found) return
    commit('Sample edit', (p) => {
      const c = p.tracks.flatMap((t) => t.clips).find((x) => x.id === found.clip.id)
      if (c) Object.assign(c, patch)
    })
  }

  if (!found) {
    return (
      <Modal title="Sample editor" onClose={close}>
        <p className="dim">Drop an audio file onto a track or select an audio clip, then reopen this editor.</p>
      </Modal>
    )
  }

  return (
    <Modal title={`Sample editor — ${found.clip.name}`} onClose={close} wide>
      <div className="sample-editor">
        <div className="sample-wave">
          {slices.length === 0 && <span className="dim small">Loading waveform…</span>}
          {slices.map((s) => (
            <button
              key={s.index}
              className="slice-chip"
              style={{ flex: Math.max(1, s.endSec - s.startSec) }}
              title={`Slice ${s.index + 1} — ${s.startSec.toFixed(2)}s`}
              onClick={() => buffer && engine.previewSlice(buffer, s.startSec, s.endSec - s.startSec, Math.pow(2, pitch / 12))}
            >
              {s.index + 1}
            </button>
          ))}
        </div>
        <div className="tool-row">
          <span className="tool-label">Slice by</span>
          {(['transients', 'beats', 'grid'] as const).map((m) => (
            <button key={m} className={`chip ${mode === m ? 'on' : ''}`} onClick={() => setMode(m)}>
              {m}
            </button>
          ))}
          {mode === 'grid' && (
            <label className="inline-field">
              Divisions
              <select className="text-input small" value={divisions} onChange={(e) => setDivisions(Number(e.target.value))}>
                {[2, 3, 4, 6, 8, 16].map((d) => (
                  <option key={d} value={d}>
                    1/{d} beat
                  </option>
                ))}
              </select>
            </label>
          )}
          <span className="dim small mono">{slices.length} slices</span>
        </div>
        <div className="tool-row">
          <label className="inline-field">
            Start
            <input className="text-input tiny" type="number" step={0.25} value={start} onChange={(e) => setStart(Number(e.target.value))} />
          </label>
          <label className="inline-field">
            End
            <input className="text-input tiny" type="number" step={0.25} value={end} onChange={(e) => setEnd(Number(e.target.value))} />
          </label>
          <button className="chip" onClick={() => setSampleRange(found.clip.id, start, end)}>
            Trim
          </button>
          <button className="chip" onClick={() => setLoopPoints(found.clip.id, start, end)}>
            Set loop
          </button>
          <label className="inline-field">
            Pitch
            <input type="range" min={-24} max={24} value={pitch} onChange={(e) => setPitch(Number(e.target.value))} />
            <span className="mono small">{pitch} st</span>
          </label>
          <button className="chip" onClick={() => updateClipField({ pitch })}>
            Apply pitch
          </button>
        </div>
        <div className="tool-row">
          <button className="chip gold" onClick={() => sliceClipToTimeline(found.clip.id, mode, divisions)}>
            Slice to timeline
          </button>
          <button className="chip" onClick={() => chromaticCopies(found.clip.id)}>
            Chromatic copies
          </button>
          <button className="chip" onClick={() => clipToSamplerTrack(found.clip.id)}>
            New sampler track
          </button>
          <button
            className="chip"
            onClick={() => {
              updateClipField({ fadeIn: 0, fadeOut: 0 })
              addDevice(found.track.id, 'autofilter', { cutoff: 2200, res: 3, mix: 1 }, 'Sample filter')
            }}
          >
            Filter envelope
          </button>
        </div>
        <div className="pad-grid">
          {slices.slice(0, 32).map((s) => (
            <button
              key={s.index}
              className="pad-btn"
              onClick={() => buffer && engine.previewSlice(buffer, s.startSec, s.endSec - s.startSec, 1)}
              title={`Pad ${s.index + 1}`}
            >
              {s.index + 1}
            </button>
          ))}
        </div>
        <div className="section-block">
          <span className="section-label">Chromatic pads</span>
          <div className="chip-row">
            {Array.from({ length: 13 }, (_, i) => i).map((semi) => (
              <button
                key={semi}
                className="chip"
                onClick={() => buffer && engine.previewSlice(buffer, 0, Math.min(0.6, buffer.duration), Math.pow(2, semi / 12))}
              >
                {semi === 0 ? 'C' : `C +${semi}`}
              </button>
            ))}
          </div>
        </div>
        <div className="section-block">
          <span className="section-label">Lyrics → melody</span>
          <div className="row gap">
            <input className="text-input" value={lyric} onChange={(e) => setLyric(e.target.value)} placeholder="Type a lyric line" />
            <button
              className="btn"
              onClick={() => {
                const target = found.track
                const notes = lyricsToMelody(lyric || 'infinite light')
                if (!notes.length) return
                const len = Math.max(4, Math.ceil(Math.max(...notes.map((n) => n.start + n.len)) / 4) * 4)
                addClip(
                  target.id,
                  {
                    id: uid('clip'),
                    name: `Lyric melody`,
                    start: 0,
                    len,
                    contentLen: len,
                    kind: 'midi',
                    notes,
                    offset: 0,
                    gain: 1,
                    fadeIn: 0,
                    fadeOut: 0,
                    reverse: false,
                    pitch: 0,
                    loop: false,
                  },
                )
                toast('Melody written from the lyric', 'ok')
              }}
            >
              Write melody
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Drum rack (per-pad chain, choke groups)
// ---------------------------------------------------------------------------
export function DrumRackModal() {
  const project = useProject()
  const ui = useUi()
  const track = project.tracks.find((t) => t.id === ui.selectedTrackId) ?? project.tracks.find((t) => t.kind === 'drum')
  const device = track?.devices.find((d) => d.type === 'drums')
  const [padSel, setPadSel] = useState(0)
  const pad: PadSettings = useMemo(() => {
    const base: PadSettings = { gain: 1, tune: 0, decay: 1, pan: 0, choke: 0, cutoff: 0, drive: 0 }
    return device?.padMap?.[String(36 + padSel)] ?? base
  }, [device, padSel])

  const setPad = (patch: Partial<PadSettings>) => {
    if (!track || !device) return
    commit('Drum pad', (p) => {
      const t = p.tracks.find((x) => x.id === track.id)
      const d = t?.devices.find((x) => x.id === device.id)
      if (!d) return
      const map = { ...(d.padMap ?? {}) }
      const key = String(36 + padSel)
      map[key] = { ...pad, ...patch }
      d.padMap = map
    })
  }

  if (!track) {
    return (
      <Modal title="Drum Rack" onClose={close}>
        <p className="dim">Select a drum track first.</p>
      </Modal>
    )
  }
  if (!device) {
    return (
      <Modal title={`Drum Rack — ${track.name}`} onClose={close}>
        <p className="dim">This track has no drum machine device yet.</p>
        <button
          className="btn gold"
          onClick={() => {
            addDevice(track.id, 'drums', { kit: 1, decay: 1.1 }, 'Drum Rack')
            toast('Drum machine added — reopen the rack', 'ok')
          }}
        >
          Add a drum machine to “{track.name}”
        </button>
      </Modal>
    )
  }

  return (
    <Modal title={`Drum Rack — ${track.name}`} onClose={close} wide>
      <div className="pad-grid big">
        {DRUM_PADS.map((p, i) => (
          <button
            key={p.kind}
            className={`pad-btn ${padSel === i ? 'on' : ''}`}
            onClick={() => {
              setPadSel(i)
              engine.audition(track.id, 36 + i, 0.95, 0.4, true)
            }}
            title={`${p.label} — ${midiName(36 + i)}`}
          >
            <strong>{p.label}</strong>
            <span className="dim small">{midiName(36 + i)}</span>
          </button>
        ))}
      </div>
      <div className="section-block">
        <span className="section-label">Pad {padSel + 1} — {DRUM_PADS[padSel].label}</span>
        <div className="grid-2">
          <label className="inline-field">
            Gain
            <input type="range" min={0} max={2} step={0.01} value={pad.gain} onChange={(e) => setPad({ gain: Number(e.target.value) })} />
            <span className="mono small">{pad.gain.toFixed(2)}</span>
          </label>
          <label className="inline-field">
            Tune
            <input type="range" min={-24} max={24} step={0.5} value={pad.tune} onChange={(e) => setPad({ tune: Number(e.target.value) })} />
            <span className="mono small">{pad.tune} st</span>
          </label>
          <label className="inline-field">
            Decay
            <input type="range" min={0.1} max={3} step={0.01} value={pad.decay} onChange={(e) => setPad({ decay: Number(e.target.value) })} />
            <span className="mono small">{pad.decay.toFixed(2)}×</span>
          </label>
          <label className="inline-field">
            Pan
            <input type="range" min={-1} max={1} step={0.01} value={pad.pan} onChange={(e) => setPad({ pan: Number(e.target.value) })} />
            <span className="mono small">{Math.round(pad.pan * 100)}</span>
          </label>
          <label className="inline-field">
            Filter
            <input type="range" min={0} max={12000} step={50} value={pad.cutoff} onChange={(e) => setPad({ cutoff: Number(e.target.value) })} />
            <span className="mono small">{pad.cutoff ? `${Math.round(pad.cutoff)} Hz` : 'off'}</span>
          </label>
          <label className="inline-field">
            Drive
            <input type="range" min={0} max={1} step={0.01} value={pad.drive} onChange={(e) => setPad({ drive: Number(e.target.value) })} />
            <span className="mono small">{Math.round(pad.drive * 100)}%</span>
          </label>
          <label className="inline-field">
            Choke group
            <select className="text-input small" value={pad.choke} onChange={(e) => setPad({ choke: Number(e.target.value) })}>
              {[0, 1, 2, 3, 4].map((g) => (
                <option key={g} value={g}>
                  {g === 0 ? 'None' : `Group ${g}`}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="dim small">
          Choke groups cut each other off — put closed and open hats in the same group for realistic hi-hats. Each pad has
          its own gain, tune, decay, pan, filter and drive insert chain.
        </p>
      </div>
      <div className="section-block">
        <span className="section-label">Quick choke presets</span>
        <div className="chip-row">
          <button
            className="chip"
            onClick={() => {
              const set = (pitch: number, choke: number) => {
                commit('Choke group', (p) => {
                  const t = p.tracks.find((x) => x.id === track.id)
                  const d = t?.devices.find((x) => x.id === device.id)
                  if (!d) return
                  const map = { ...(d.padMap ?? {}) }
                  map[String(pitch)] = { ...(map[String(pitch)] ?? { gain: 1, tune: 0, decay: 1, pan: 0, cutoff: 0, drive: 0 }), choke }
                  d.padMap = map
                })
              }
              set(42, 1)
              set(46, 1)
            }}
          >
            Hats: closed + open choke
          </button>
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Stem separation
// ---------------------------------------------------------------------------
export function StemsModal() {
  const project = useProject()
  const [progress, setProgress] = useState(0)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<{ ms: number; slow: boolean; message?: string; stems: number } | null>(null)
  const signal = useRef({ cancelled: false })

  const run = async () => {
    const found = selectedAudioClip(project)
    if (!found) {
      toast('Select an audio clip or add one to a track first', 'warn')
      return
    }
    const buffer = clipBuffer(found.clip)
    if (!buffer) {
      toast('The audio is still decoding', 'warn')
      return
    }
    setBusy(true)
    setProgress(0)
    setOutcome(null)
    signal.current = { cancelled: false }
    const result = await separateStems(buffer, {
      signal: signal.current,
      onProgress: (v, n) => {
        if (v >= 0) setProgress(v)
        setNote(n)
      },
    })
    setBusy(false)
    if (result.cancelled) {
      toast('Separation cancelled — nothing was written', 'warn')
      return
    }
    if (!result.ok) {
      toast(result.message ?? 'Separation failed', 'err')
      return
    }
    // Write stems to new tracks.
    const ctx = engine.ctx ?? (await engine.start())
    const projectNow = getState().project
    const base = Math.ceil(projectNow.length / 4) * 4
    for (const stem of result.stems) {
      const asset = storedFromBuffer(`${found.clip.name} ${stem.name}`, stem.buffer)
      await db.putAsset(asset)
      registerBuffer(asset.id, stem.buffer)
      const id = addTrack('audio', { name: `${found.clip.name} ${stem.name}` })
      addClip(
        id,
        {
          id: uid('clip'),
          name: stem.name,
          start: 0,
          len: Math.max(1, (stem.buffer.duration * projectNow.bpm) / 60),
          contentLen: Math.max(1, (stem.buffer.duration * projectNow.bpm) / 60),
          kind: 'audio',
          notes: [],
          assetId: asset.id,
          offset: 0,
          gain: Math.min(1, stem.name === 'other' ? 0.8 : 0.9),
          fadeIn: 0,
          fadeOut: 0,
          reverse: false,
          pitch: 0,
          loop: false,
        },
      )
      void ctx
      void base
    }
    setOutcome({ ms: result.ms, slow: result.slow, message: result.message, stems: result.stems.length })
    toast(`Separated into ${result.stems.length} stems (${(result.ms / 1000).toFixed(1)} s)`, 'ok', 4000)
  }

  return (
    <Modal title="Stem separation" onClose={close} wide>
      <p className="dim small">
        Splits the selected clip into vocals, drums, bass and other, entirely on this device with a harmonic / percussive
        mask separator. Runs in a Web Worker, so the interface stays responsive — no model download, no API key.
      </p>
      {!busy && (
        <button className="btn gold" onClick={() => void run()}>
          Separate stems
        </button>
      )}
      {busy && (
        <>
          <div className="progress-row">
            <div className="progress wide">
              <span style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <span className="mono small">{Math.round(progress * 100)}%</span>
          </div>
          <p className="dim small">{note || 'Working…'}</p>
          <button
            className="btn"
            onClick={() => {
              signal.current.cancelled = true
              cancelSeparation()
              setBusy(false)
            }}
          >
            Cancel
          </button>
        </>
      )}
      {outcome && (
        <div className="callout">
          <strong>Done in {(outcome.ms / 1000).toFixed(1)} s.</strong> {outcome.stems} stems written to their own tracks.
          {outcome.slow && <p className="warn small">{outcome.message}</p>}
        </div>
      )}
      <p className="dim small">
        Tip: a short section separates much faster. Everything stays in the browser and is saved with the project.
      </p>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Mastering assistant
// ---------------------------------------------------------------------------
export function MasteringModal() {
  const project = useProject()
  const [analysis, setAnalysis] = useState<MixAnalysis | null>(null)
  const [plan, setPlan] = useState<MasteringPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [target, setTarget] = useState(project.masterChain?.target ?? -14)
  const [bypassed, setBypassed] = useState(false)
  const [loopOnly, setLoopOnly] = useState(false)

  const analyze = async () => {
    setBusy(true)
    try {
      const { analysis: a } = await analyzeProjectMix(loopOnly)
      setAnalysis(a)
      setPlan(masteringPlan(a, target))
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Analysis failed', 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Mastering assistant" onClose={close} wide>
      <div className="row gap">
        <label className="inline-field">
          Target
          <select className="text-input" value={target} onChange={(e) => setTarget(Number(e.target.value))}>
            {[-9, -11, -14, -16, -20, -23].map((t) => (
              <option key={t} value={t}>
                {t} LUFS
              </option>
            ))}
          </select>
        </label>
        <label className="row gap small dim">
          <input type="checkbox" checked={loopOnly} onChange={(e) => setLoopOnly(e.target.checked)} />
          Analyse loop region only
        </label>
        <button className="btn gold" onClick={() => void analyze()} disabled={busy}>
          {busy ? 'Measuring…' : 'Analyse mix'}
        </button>
      </div>
      {analysis && (
        <div className="grid-3 metrics">
          <div>
            <span className="dim small">Loudness</span>
            <strong>{analysis.lufs} LUFS</strong>
          </div>
          <div>
            <span className="dim small">Peak</span>
            <strong>{analysis.peakDb} dBFS</strong>
          </div>
          <div>
            <span className="dim small">Crest</span>
            <strong>{analysis.crestDb} dB</strong>
          </div>
          <div>
            <span className="dim small">Low / Mid / High</span>
            <strong>
              {analysis.lowDb} / {analysis.midDb} / {analysis.highDb} dB
            </strong>
          </div>
          <div>
            <span className="dim small">Stereo width</span>
            <strong>{analysis.width}×</strong>
          </div>
          <div>
            <span className="dim small">Target</span>
            <strong>{target} LUFS</strong>
          </div>
        </div>
      )}
      {plan && (
        <div className="section-block">
          <span className="section-label">Proposed chain</span>
          <ul className="plan-list">
            <li>Make-up gain {plan.gainDb > 0 ? `+${plan.gainDb}` : plan.gainDb} dB</li>
            <li>
              EQ low {plan.eq.low} / mid {plan.eq.mid} / high {plan.eq.high} dB
            </li>
            <li>Stereo width {plan.width.toFixed(2)}×</li>
            <li>Glue compression {plan.glue ? 'on' : 'off'} · limiter at {plan.ceiling} dBTP</li>
            <li>Predicted {plan.predictedLufs} LUFS</li>
          </ul>
          {plan.notes.map((n) => (
            <p key={n} className="dim small">
              {n}
            </p>
          ))}
          <div className="row gap">
            <button
              className="btn gold"
              onClick={() => {
                applyMastering(plan, true)
                setBypassed(false)
              }}
            >
              Apply mastering
            </button>
            <button
              className="btn"
              onClick={() => {
                applyMastering(plan, false)
                setBypassed(true)
              }}
            >
              {bypassed ? 'Bypassed (A)' : 'Bypass for A/B'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Mix assistant
// ---------------------------------------------------------------------------
export function MixAssistModal() {
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0, name: '' })
  const [suggestions, setSuggestions] = useState<MixSuggestion[] | null>(null)

  const run = async () => {
    setBusy(true)
    setSuggestions(null)
    const reports = await analyzeTracks((done, total, name) => setProgress({ done, total, name }))
    setSuggestions(suggestionsFrom(reports))
    setBusy(false)
  }

  return (
    <Modal title="Mix assistant" onClose={close} wide>
      <p className="dim small">
        Renders every track, measures level, peaks, low-end density and stereo width, then offers one-click fixes. Nothing
        is changed until you press a fix.
      </p>
      <button className="btn gold" onClick={() => void run()} disabled={busy}>
        {busy ? `Analysing ${progress.name}…` : 'Analyse the mix'}
      </button>
      {busy && (
        <div className="progress-row">
          <div className="progress wide">
            <span style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }} />
          </div>
          <span className="mono small">
            {progress.done}/{progress.total}
          </span>
        </div>
      )}
      {suggestions && (
        <div className="suggestion-list">
          {suggestions.length === 0 && <p className="dim">No problems found — the balance is already consistent.</p>}
          {suggestions.map((s) => (
            <div key={s.id} className={`suggestion ${s.severity}`}>
              <div className="suggestion-head">
                <strong>{s.title}</strong>
                <span className={`chip tiny ${s.severity}`}>{s.severity}</span>
              </div>
              <p className="dim small">{s.detail}</p>
              <button
                className="chip gold"
                onClick={() => {
                  s.fix()
                }}
              >
                {s.fixLabel}
              </button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------
export function TemplatesModal() {
  const project = useProject()
  const ui = useUi()
  const track = project.tracks.find((t) => t.id === ui.selectedTrackId) ?? project.tracks[0]
  const [trackTpl, setTrackTpl] = useState(listTrackTemplates())
  const [projTpl, setProjTpl] = useState(listProjectTemplates())
  const [name, setName] = useState('')

  return (
    <Modal title="Templates" onClose={close} wide>
      <div className="help-columns">
        <div>
          <h3>Track templates</h3>
          <div className="help-row">
            <input className="text-input" placeholder="Name this track template" value={name} onChange={(e) => setName(e.target.value)} />
            <button
              className="chip"
              onClick={() => {
                if (!track) return
                saveTrackTemplate(track.id, name)
                setTrackTpl(listTrackTemplates())
                setName('')
              }}
            >
              Save “{track?.name ?? 'track'}”
            </button>
          </div>
          {trackTpl.map((t) => (
            <div key={t.id} className="help-row">
              <div>
                <strong>{t.name}</strong>
                <div className="dim small">{t.blurb}</div>
              </div>
              <div className="row gap">
                <button
                  className="chip"
                  onClick={() => {
                    applyTrackTemplate(t.id)
                    setUi({ modal: null, view: 'rack' })
                  }}
                >
                  Add
                </button>
                {!t.builtIn && (
                  <button
                    className="icon-btn"
                    title="Delete template"
                    onClick={() => {
                      deleteTrackTemplate(t.id)
                      setTrackTpl(listTrackTemplates())
                    }}
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
        <div>
          <h3>Project templates</h3>
          <div className="help-row">
            <input className="text-input" placeholder="Name this project template" value={name} onChange={(e) => setName(e.target.value)} />
            <button
              className="chip"
              onClick={() => {
                void saveProjectTemplate(name || `${project.name} template`)
                setProjTpl(listProjectTemplates())
                setName('')
              }}
            >
              Save project
            </button>
          </div>
          {projTpl.map((t) => (
            <div key={t.id} className="help-row">
              <div>
                <strong>{t.name}</strong>
                <div className="dim small">{t.blurb}</div>
              </div>
              <div className="row gap">
                <button
                  className="chip"
                  onClick={() => {
                    void openProjectTemplate(t.id)
                  }}
                >
                  New
                </button>
                {!t.builtIn && (
                  <button
                    className="icon-btn"
                    title="Delete template"
                    onClick={() => {
                      deleteProjectTemplate(t.id)
                      setProjTpl(listProjectTemplates())
                    }}
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
export function StorageModal() {
  const [report, setReport] = useState<StorageReport | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = async () => setReport(await storageReport())
  useEffect(() => {
    void refresh()
  }, [])

  return (
    <Modal title="Storage" onClose={close} wide>
      {!report && <p className="dim">Measuring…</p>}
      {report && (
        <>
          <div className="grid-3 metrics">
            <div>
              <span className="dim small">Browser quota</span>
              <strong>{formatBytes(report.quota)}</strong>
            </div>
            <div>
              <span className="dim small">Used by this origin</span>
              <strong>{formatBytes(report.usage)}</strong>
            </div>
            <div>
              <span className="dim small">Packs installed</span>
              <strong>
                {report.packFiles} files · {formatBytes(report.packBytes)}
              </strong>
            </div>
            <div>
              <span className="dim small">Projects</span>
              <strong>{report.projects}</strong>
            </div>
            <div>
              <span className="dim small">Versions</span>
              <strong>{report.versions}</strong>
            </div>
            <div>
              <span className="dim small">Recordings / assets</span>
              <strong>
                {report.assets} · {formatBytes(report.assetBytes)}
              </strong>
            </div>
          </div>
          {report.supported && !report.persisted && (
            <button className="chip" onClick={() => void requestPersistence().then(refresh)}>
              Protect storage from eviction
            </button>
          )}
          <div className="chip-row">
            {[
              ['versions', 'Trim old versions (keep 5)'],
              ['orphan-assets', 'Remove unused audio'],
              ['old-projects', 'Remove old projects (keep 10)'],
              ['recordings', 'Remove unused recordings'],
            ].map(([mode, label]) => (
              <button
                key={mode}
                className="chip"
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  const msg = await cleanupStorage(mode as 'versions')
                  toast(msg, 'ok')
                  setBusy(false)
                  void refresh()
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="dim small">
            Everything lives in this browser (IndexedDB). Clearing site data deletes it — export a project zip first if
            you want a backup.
          </p>
        </>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Accounts and cloud
// ---------------------------------------------------------------------------
export function AccountModal() {
  const [account, setAccount] = useState<Account | null>(() => currentAccount())
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [cloudReady, setCloudReady] = useState<boolean | null>(null)
  const [useCloud, setUseCloud] = useState(false)
  const [busy, setBusy] = useState(false)
  const [remote, setRemote] = useState<{ id: string; name: string; updatedAt: number }[]>([])

  useEffect(() => {
    void cloudAvailable().then((v) => setCloudReady(v))
  }, [])

  const submit = async () => {
    setBusy(true)
    try {
      const acc = useCloud
        ? mode === 'signin'
          ? await cloudSignIn(email, password)
          : await cloudSignUp(email, password, name)
        : mode === 'signin'
          ? await signInLocal(email, password)
          : await signUpLocal(email, password, name)
      setAccount(acc)
      toast(`Welcome, ${acc.name}`, 'ok')
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Sign-in failed', 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Account & cloud" onClose={close} wide>
      {account ? (
        <>
          <p>
            Signed in as <strong>{account.name}</strong> ({account.email}) · {account.cloud ? 'Cloudflare cloud' : 'this browser only'}
          </p>
          <div className="chip-row">
            <button
              className="btn"
              onClick={() => {
                void cloudSave(getState().project)
              }}
              disabled={!account.cloud}
              title={account.cloud ? 'Save to D1' : 'Sign in with cloud enabled after deploying /functions'}
            >
              Save project to cloud
            </button>
            <button
              className="btn"
              onClick={async () => {
                try {
                  setRemote(await cloudList())
                } catch (err) {
                  toast(err instanceof Error ? err.message : 'Cloud unavailable', 'err')
                }
              }}
              disabled={!account.cloud}
            >
              List cloud projects
            </button>
            <button
              className="btn"
              onClick={() => {
                signOut()
                setAccount(null)
              }}
            >
              Sign out
            </button>
          </div>
          {remote.length > 0 && (
            <div className="section-block">
              <span className="section-label">Cloud projects</span>
              {remote.map((r) => (
                <div key={r.id} className="help-row">
                  <span>{r.name}</span>
                  <span className="dim small">{new Date(r.updatedAt).toLocaleString()}</span>
                  <button
                    className="chip"
                    onClick={async () => {
                      try {
                        const p = await cloudLoad(r.id)
                        await adoptProject(p)
                        setUi({ modal: null, view: 'seq' })
                      } catch (err) {
                        toast(err instanceof Error ? err.message : 'Could not load', 'err')
                      }
                    }}
                  >
                    Open
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <p className="dim small">
            Local accounts are free and stay on this device (PBKDF2 hashed). Deploy the included Cloudflare Functions and
            the same account can save to D1 and R2 — no keys to paste.
          </p>
          <div className="row gap">
            <label className="row gap small">
              <input type="checkbox" checked={useCloud} onChange={(e) => setUseCloud(e.target.checked)} />
              Use cloud account {cloudReady === false ? '(not deployed)' : cloudReady ? '(ready)' : ''}
            </label>
          </div>
          <div className="section-block">
            <div className="chip-row">
              <button className={`chip ${mode === 'signin' ? 'on' : ''}`} onClick={() => setMode('signin')}>
                Sign in
              </button>
              <button className={`chip ${mode === 'signup' ? 'on' : ''}`} onClick={() => setMode('signup')}>
                Create account
              </button>
            </div>
            <div className="grid-2">
              <input className="text-input" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
              <input
                className="text-input"
                type="password"
                placeholder="Password (6+ characters)"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              {mode === 'signup' && <input className="text-input" placeholder="Display name" value={name} onChange={(e) => setName(e.target.value)} />}
            </div>
            <button className="btn gold" onClick={() => void submit()} disabled={busy}>
              {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create account'}
            </button>
          </div>
          {localAccounts().length > 0 && (
            <p className="dim small">{localAccounts().length} local account(s) on this device.</p>
          )}
        </>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Share
// ---------------------------------------------------------------------------
export function ShareModal() {
  const project = useProject()
  const [url, setUrl] = useState('')
  const [cloud, setCloud] = useState(false)
  const [busy, setBusy] = useState(false)
  const [exporting, setExporting] = useState('')

  const create = async () => {
    setBusy(true)
    try {
      const link = await createShareLink(project)
      setUrl(link.url)
      setCloud(link.cloud)
      try {
        await navigator.clipboard.writeText(link.url)
        toast('Share link copied', 'ok')
      } catch {
        toast('Link ready — copy it below', 'ok')
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create the link', 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Share & export" onClose={close} wide>
      <p className="dim small">
        A share link opens a read-only player with play/pause, track mute/solo and mix / stem downloads. Links made before
        deploying the cloud functions carry the whole arrangement inside the URL, so they work offline.
      </p>
      <div className="row gap">
        <button className="btn gold" onClick={() => void create()} disabled={busy}>
          {busy ? 'Building link…' : 'Create share link'}
        </button>
        {url && (
          <button className="chip" onClick={() => void navigator.clipboard.writeText(url).then(() => toast('Copied', 'ok'))}>
            Copy link
          </button>
        )}
      </div>
      {url && (
        <>
          <textarea className="text-area mono small" readOnly value={url} rows={3} />
          <p className="dim small">
            {cloud ? 'Stored on Cloudflare (D1) — short link.' : 'Self-contained link — no server, works offline.'}
          </p>
        </>
      )}
      <div className="section-block">
        <span className="section-label">Offline files</span>
        <div className="chip-row">
          <button
            className="chip"
            disabled={!!exporting}
            onClick={async () => {
              setExporting('mix')
              try {
                const buf = await renderProject(project)
                downloadBlob(audioBufferToWav(buf, { bitDepth: 24 }), `${project.name.replace(/\W+/g, '_')} - mix.wav`)
              } finally {
                setExporting('')
              }
            }}
          >
            {exporting === 'mix' ? 'Rendering…' : 'Download mix (WAV)'}
          </button>
          <button
            className="chip"
            disabled={!!exporting}
            onClick={async () => {
              setExporting('zip')
              try {
                await exportProjectZip({ stems: true, mix: true, midi: true })
              } finally {
                setExporting('')
              }
            }}
          >
            {exporting === 'zip' ? 'Packing…' : 'Project zip (stems + MIDI)'}
          </button>
          <button
            className="chip"
            disabled={!!exporting}
            onClick={async () => {
              setExporting('stems')
              try {
                await exportProjectZip({ stems: true, mix: false, midi: false })
              } finally {
                setExporting('')
              }
            }}
          >
            {exporting === 'stems' ? 'Rendering…' : 'Stems only (zip)'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Chord library helper (used by the Create panel)
// ---------------------------------------------------------------------------
export function ChordLibrary({ rootPc, scale }: { rootPc: number; scale: string }) {
  void scale
  return (
    <div className="chip-row">
      {CHORD_VOICINGS.slice(0, 10).map((v) => (
        <span key={v.id} className="chip tiny" title={v.name}>
          {v.name}
        </span>
      ))}
    </div>
  )
}
