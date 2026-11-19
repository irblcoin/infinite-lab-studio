// ---------------------------------------------------------------------------
// Ableton-style feature actions: warping, sidechain, tempo maps, clip
// envelopes, groove, consolidate/freeze/flatten, audio-to-MIDI, comping,
// vocal chains, return and master presets.
// ---------------------------------------------------------------------------

import type { Clip, CompRegion, DeviceType, EnvPoint, GrooveSettings, Note, WarpMode } from './types'
import { clamp, makeClip, makeDevice, uid } from './types'
import { commit, getState, setUi, toast, toastError } from './store'
import { addClip, addDevice, addTrack, findClip, findTrack, setTrackProp, toggleArm, updateClip } from './actions'
import { engine } from '../audio/engine'
import { detectBpm, detectTransients } from '../audio/warp'
import { audioToMidi } from '../audio/analysis'
import { bpmAt, sigAt } from '../audio/tempo'
import { db } from './db'
import { getBuffer, registerBuffer, storedFromBuffer } from '../audio/assets'
import { defaultParams } from '../data/deviceDefs'
import { GROOVES, MASTER_PRESETS, RETURN_PRESETS, SIDECHAIN_PRESETS, VOCAL_CHAINS } from '../data/presets'
import { LOOPS, type LoopDef } from '../data/loops'
import { audioBufferToWav, downloadBlob, renderProject } from '../audio/render'

// ---------------------------------------------------------------------------
// Warping
// ---------------------------------------------------------------------------

function clipBufferFor(clip: Clip): AudioBuffer | null {
  if (clip.assetId) return getBuffer(clip.assetId)
  if (clip.libId) return getBuffer(clip.libId)
  return null
}

export function detectClipTempo(clipId: string): number | null {
  const { project } = getState()
  const hit = findClip(project, clipId)
  if (!hit) return null
  const buf = clipBufferFor(hit.clip)
  if (!buf) {
    toast('That clip has no audio loaded yet', 'warn')
    return null
  }
  const bpm = detectBpm(buf)
  if (!bpm) {
    toast('Could not find a clear pulse in this audio', 'warn')
    return null
  }
  updateClip(clipId, { warp: { enabled: true, mode: hit.clip.warp?.mode ?? 'complex', sourceBpm: bpm, detectedBpm: bpm, stretch: 1, markers: [] } })
  toast(`Detected ${bpm} BPM`, 'ok')
  return bpm
}

export function warpClipToTempo(clipId: string): void {
  const { project } = getState()
  const hit = findClip(project, clipId)
  if (!hit) return
  const clip = hit.clip
  if (clip.kind !== 'audio') {
    toast('Only audio clips can be warped', 'warn')
    return
  }
  const buf = clipBufferFor(clip)
  const bpm = clip.warp?.sourceBpm ?? (buf ? detectBpm(buf) : null) ?? project.bpm
  updateClip(
    clipId,
    {
      warp: {
        enabled: true,
        mode: clip.warp?.mode ?? 'complex',
        sourceBpm: bpm,
        detectedBpm: clip.warp?.detectedBpm ?? bpm,
        stretch: 1,
        markers: clip.warp?.markers ?? [],
      },
      // Content length follows the audio's beat length at the project tempo.
      contentLen: buf ? (buf.duration * project.bpm) / 60 : clip.contentLen,
    },
    true,
  )
  toast(`Warped to ${project.bpm} BPM (source ${Math.round(bpm)} BPM)`, 'ok')
}

export function setWarp(clipId: string, patch: Partial<NonNullable<Clip['warp']>>): void {
  const { project } = getState()
  const hit = findClip(project, clipId)
  if (!hit?.clip.warp) return
  updateClip(clipId, { warp: { ...hit.clip.warp, ...patch } })
}

export function toggleWarp(clipId: string): void {
  const hit = findClip(getState().project, clipId)
  if (!hit?.clip.warp) {
    warpClipToTempo(clipId)
    return
  }
  setWarp(clipId, { enabled: !hit.clip.warp.enabled })
}

export function addWarpMarker(clipId: string, atBeat: number): void {
  const hit = findClip(getState().project, clipId)
  if (!hit?.clip.warp) return
  const warp = hit.clip.warp
  const ratio = warp.sourceBpm ? getState().project.bpm / warp.sourceBpm : 1
  const sec = Math.max(0, atBeat * (60 / getState().project.bpm) / Math.max(0.25, ratio))
  const markers = [...warp.markers.filter((m) => Math.abs(m.beat - atBeat) > 0.01), { beat: atBeat, sec }].sort(
    (a, b) => a.beat - b.beat,
  )
  setWarp(clipId, { markers })
  toast(`Warp marker at beat ${atBeat.toFixed(2)}`, 'ok')
}

export function clearWarpMarkers(clipId: string): void {
  setWarp(clipId, { markers: [] })
}

// ---------------------------------------------------------------------------
// Sidechain
// ---------------------------------------------------------------------------

export function setSidechain(
  trackId: string,
  sourceId: string,
  patch: Partial<{ depth: number; attack: number; release: number }> = {},
): void {
  const { project } = getState()
  const track = findTrack(project, trackId)
  const source = findTrack(project, sourceId)
  if (!track || !source) return
  if (track.id === source.id) {
    toast('A track cannot duck itself', 'warn')
    return
  }
  setTrackProp(trackId, {
    sidechain: {
      enabled: true,
      sourceId: source.id,
      depth: patch.depth ?? 0.75,
      attack: patch.attack ?? 0.005,
      release: patch.release ?? 0.18,
    },
  })
  toast(`${source.name} now ducks ${track.name}`, 'ok')
}

export function sidechainPreset(trackId: string, sourceId: string, preset: string): void {
  const p = SIDECHAIN_PRESETS.find((x) => x.id === preset) ?? SIDECHAIN_PRESETS[0]
  setSidechain(trackId, sourceId, { depth: p.depth, attack: p.attack, release: p.release })
}

export function clearSidechain(trackId: string): void {
  const track = findTrack(getState().project, trackId)
  if (!track) return
  setTrackProp(trackId, { sidechain: { enabled: false, sourceId: '', depth: 0, attack: 0.005, release: 0.2 } })
  toast(`Sidechain off for ${track.name}`, 'ok')
}

// ---------------------------------------------------------------------------
// Tempo automation and time signatures
// ---------------------------------------------------------------------------

export function addTempoPoint(bpm: number, beat = engine.getBeat()): void {
  commit(`Tempo ${bpm} at ${beat.toFixed(0)}`, (p) => {
    const map = (p.tempoMap ?? []).filter((x) => Math.abs(x.beat - beat) > 1e-6)
    map.push({ beat, bpm: clamp(Math.round(bpm), 20, 300) })
    p.tempoMap = map.sort((a, b) => a.beat - b.beat)
    p.bpm = bpmAt(p, 0)
  })
  toast(`Tempo ${bpm} BPM from beat ${beat.toFixed(0)}`, 'ok')
}

export function removeTempoPoint(beat: number): void {
  commit('Remove tempo change', (p) => {
    p.tempoMap = (p.tempoMap ?? []).filter((x) => Math.abs(x.beat - beat) > 1e-6)
  })
}

export function clearTempoMap(): void {
  commit('Clear tempo automation', (p) => {
    p.tempoMap = []
  })
}

export function addTimeSignature(bar: number, num: number, den: number): void {
  commit(`Time signature ${num}/${den}`, (p) => {
    const map = (p.sigMap ?? []).filter((x) => x.bar !== bar)
    map.push({ bar, num: clamp(num, 1, 16), den: clamp(den, 2, 16) })
    p.sigMap = map.sort((a, b) => a.bar - b.bar)
    if (bar === 0) p.timeSig = [num, den]
  })
  toast(`${num}/${den} from bar ${bar + 1}`, 'ok')
}

export function removeTimeSignature(bar: number): void {
  commit('Remove time signature', (p) => {
    p.sigMap = (p.sigMap ?? []).filter((x) => x.bar !== bar)
  })
}

export function currentSignature(): [number, number] {
  return sigAt(getState().project, engine.getBeat())
}

// ---------------------------------------------------------------------------
// Clip envelopes and groove
// ---------------------------------------------------------------------------

export function setEnvelope(clipId: string, points: { beat: number; value: number }[]): void {
  updateClip(clipId, {
    envelope: points
      .map((p) => ({ id: uid('env'), beat: p.beat, value: clamp(p.value, 0, 2) }))
      .sort((a, b) => a.beat - b.beat) as EnvPoint[],
  })
}

export function addEnvelopePoint(clipId: string, beat: number, value = 1): void {
  const hit = findClip(getState().project, clipId)
  if (!hit) return
  const points = [...(hit.clip.envelope ?? []), { id: uid('env'), beat, value }]
  updateClip(clipId, { envelope: points.sort((a, b) => a.beat - b.beat) })
}

export function clearEnvelope(clipId: string): void {
  updateClip(clipId, { envelope: [] })
}

/** Sine-shaped gain envelope — a handy starting point for pumping/duck shapes. */
export function autoEnvelope(clipId: string, shape: 'fade' | 'pump' | 'swell'): void {
  const hit = findClip(getState().project, clipId)
  if (!hit) return
  const len = Math.max(1, hit.clip.len)
  const points: EnvPoint[] = []
  const steps = Math.max(4, Math.round(len * 2))
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const beat = t * len
    const value =
      shape === 'fade' ? 1 - t * 0.95 : shape === 'swell' ? 0.15 + t * 0.85 : 0.55 + 0.45 * Math.cos(t * Math.PI * 8)
    points.push({ id: uid('env'), beat, value })
  }
  updateClip(clipId, { envelope: points })
  toast(`${shape} envelope applied`, 'ok')
}

export function applyGrooveToClip(clipId: string, preset: string, amount = 1): void {
  updateClip(clipId, { groove: { preset, amount } as GrooveSettings }, true)
  const g = GROOVES.find((x) => x.id === preset)
  toast(`${g?.name ?? preset} groove on clip`, 'ok')
}

export function applyGrooveToProject(preset: string, amount = 1): void {
  commit(`Groove ${preset}`, (p) => {
    p.groove = { preset, amount }
  })
  const g = GROOVES.find((x) => x.id === preset)
  toast(`${g?.name ?? preset} groove applied to the project`, 'ok')
}

// ---------------------------------------------------------------------------
// Consolidate / freeze / flatten
// ---------------------------------------------------------------------------

/** Flatten a track to a single audio clip (destructive but undoable). */
export async function flattenTrack(trackId: string): Promise<void> {
  const { project } = getState()
  const track = findTrack(project, trackId)
  if (!track || track.kind === 'group') return
  if (!track.clips.length) {
    toast('That track has nothing to flatten', 'warn')
    return
  }
  toast(`Flattening ${track.name}…`, 'ok', 1200)
  try {
    const buffer = await engine.renderTrackOnly(trackId)
    if (!buffer) throw new Error('render failed')
    const asset = storedFromBuffer(`${track.name} (flattened)`, buffer)
    await db.putAsset(asset)
    registerBuffer(asset.id, buffer)
    const beats = (buffer.duration * project.bpm) / 60
    commit('Flatten track', (p) => {
      const t = findTrack(p, trackId)
      if (!t) return
      t.clips = [
        makeClip({
          name: `${track.name} (flattened)`,
          start: 0,
          len: beats,
          contentLen: beats,
          kind: 'audio',
          assetId: asset.id,
          warp: { enabled: false, mode: 'complex', stretch: 1, markers: [] },
        }),
      ]
      t.frozenAssetId = undefined
    })
    toast(`${track.name} flattened to one audio clip`, 'ok')
  } catch (err) {
    toastError(err, 'Could not flatten that track')
  }
}

/** Consolidate a clip: bounce its current sound (with effects) into one file. */
export async function consolidateClip(clipId: string): Promise<void> {
  const { project } = getState()
  const hit = findClip(project, clipId)
  if (!hit) return
  const { track, clip } = hit
  if (clip.kind === 'midi') {
    // MIDI consolidation: merge looped passes into one linear clip.
    commit('Consolidate clip', (p) => {
      const t = findTrack(p, track.id)
      const c = t?.clips.find((x) => x.id === clipId)
      if (!c) return
      c.loop = false
      c.contentLen = c.len
    })
    toast('Clip consolidated', 'ok')
    return
  }
  const buffer = await engine.renderTrackOnly(track.id)
  if (!buffer) {
    toast('Could not consolidate this clip', 'err')
    return
  }
  const asset = storedFromBuffer(`${clip.name} (consolidated)`, buffer)
  await db.putAsset(asset)
  registerBuffer(asset.id, buffer)
  const beats = (buffer.duration * project.bpm) / 60
  commit('Consolidate clip', (p) => {
    const t = findTrack(p, track.id)
    if (!t) return
    const idx = t.clips.findIndex((x) => x.id === clipId)
    if (idx < 0) return
    t.clips[idx] = makeClip({
      name: `${clip.name} (bounce)`,
      start: clip.start,
      len: beats,
      contentLen: beats,
      kind: 'audio',
      assetId: asset.id,
    })
  })
  toast('Clip consolidated to audio', 'ok')
}

// ---------------------------------------------------------------------------
// Audio to MIDI
// ---------------------------------------------------------------------------

export async function clipToMidi(clipId: string, kind: 'melody' | 'harmony' | 'drums'): Promise<void> {
  const { project } = getState()
  const hit = findClip(project, clipId)
  if (!hit) return
  const buf = clipBufferFor(hit.clip)
  if (!buf) {
    toast('Load the audio first, then transcribe it', 'warn')
    return
  }
  const notes: Note[] = audioToMidi(buf, kind, { bpm: project.bpm })
  if (!notes.length) {
    toast('Nothing recognisable in that audio', 'warn')
    return
  }
  const len = Math.max(hit.clip.len, ...notes.map((n) => n.start + n.len))
  commit(`Audio to MIDI (${kind})`, (p) => {
    const t = findTrack(p, hit.track.id)
    if (!t) return
    const track: typeof t = {
      ...t,
      id: uid('tr'),
      name: `${hit.track.name} ${kind === 'drums' ? 'Drums' : 'MIDI'}`,
      kind: kind === 'drums' ? 'drum' : 'midi',
      clips: [],
      devices: kind === 'drums' ? [makeDevice('drums', defaultParams('drums'), 'Drums')] : [makeDevice('keys', defaultParams('keys'), 'Keys')],
      automation: [],
      frozenAssetId: undefined,
    }
    track.clips = [makeClip({ name: `${hit.clip.name} (${kind})`, start: hit.clip.start, len, contentLen: len, kind: 'midi', notes })]
    p.tracks.splice(p.tracks.indexOf(t) + 1, 0, track)
    setUi({ selectedTrackId: track.id })
  })
  toast(`Transcribed ${notes.length} notes from audio`, 'ok')
}

// ---------------------------------------------------------------------------
// Comping
// ---------------------------------------------------------------------------

export function setCompRegion(clipId: string, start: number, end: number, take: number): void {
  const hit = findClip(getState().project, clipId)
  if (!hit) return
  const regions: CompRegion[] = [...(hit.clip.comp ?? [])]
    .filter((r) => r.end <= start + 1e-6 || r.start >= end - 1e-6)
    .concat({ start, end, take })
    .sort((a, b) => a.start - b.start)
  updateClip(clipId, { comp: regions, activeTake: take })
}

export function clearComp(clipId: string): void {
  updateClip(clipId, { comp: [] })
}

/** Split the clip into one-bar comp regions and pick takes in order. */
export function autoComp(clipId: string): void {
  const hit = findClip(getState().project, clipId)
  if (!hit?.clip.takes?.length) {
    toast('Record at least two takes first', 'warn')
    return
  }
  const takes = hit.clip.takes.length
  const regions: CompRegion[] = []
  const bars = Math.max(1, Math.ceil(hit.clip.len / 4))
  for (let i = 0; i < bars; i++) {
    const start = i * 4
    const end = Math.min(hit.clip.len, start + 4)
    if (end - start < 0.01) continue
    regions.push({ start, end, take: i % takes })
  }
  updateClip(clipId, { comp: regions }, true)
  toast(`Comp built from ${takes} takes`, 'ok')
}

// ---------------------------------------------------------------------------
// Vocal chain / returns / master
// ---------------------------------------------------------------------------

export function applyVocalChain(trackId: string, presetId: string): void {
  const preset = VOCAL_CHAINS.find((p) => p.id === presetId)
  if (!preset) return
  const { project } = getState()
  const track = findTrack(project, trackId)
  if (!track) return
  const devices = preset.chain.map((step) => {
    const dev = makeDevice(step.type, defaultParams(step.type), step.name ?? step.type)
    for (const [k, v] of Object.entries(step.params ?? {})) dev.params[k] = v
    return dev
  })
  commit(`Vocal chain: ${preset.name}`, (p) => {
    const t = findTrack(p, trackId)
    if (!t) return
    t.devices = [...devices, ...t.devices.filter((d) => !preset.chain.some((c) => c.type === d.type))]
    if (preset.sends) t.sends = preset.sends
    t.name = t.name.match(/vocal/i) ? t.name : `${t.name} Vocal`
  })
  toast(`${preset.name} chain loaded`, 'ok')
}

/** One-click vocal booth: audio track + chain + armed + transport recording. */
export async function startVocalBooth(presetId = 'vocal_clean'): Promise<void> {
  const { project } = getState()
  let track = project.tracks.find((t) => t.kind === 'audio' && /vocal/i.test(t.name))
  if (!track) {
    const id = addTrack('audio', { name: 'Vocal' })
    track = findTrack(getState().project, id) ?? undefined
  }
  if (!track) return
  setUi({ selectedTrackId: track.id, view: 'seq' })
  applyVocalChain(track.id, presetId)
  if (!track.armed) toggleArm(track.id)
  const { startRecording } = await import('./record')
  await startRecording()
  toast('Vocal booth ready — recording', 'ok', 3000)
}

export function applyReturnPreset(trackId: string | null, presetId: string): void {
  const preset = RETURN_PRESETS.find((p) => p.id === presetId)
  if (!preset) return
  engine.setReturnPreset(preset.id)
  if (!trackId) {
    toast(`${preset.name} on the master returns`, 'ok')
    return
  }
  setTrackProp(trackId, { sends: preset.sends })
  const track = findTrack(getState().project, trackId)
  toast(`${preset.name} → ${track?.name ?? 'track'}`, 'ok')
}

export function applyMasterPreset(presetId: string): void {
  const preset = MASTER_PRESETS.find((p) => p.id === presetId) ?? MASTER_PRESETS[0]
  commit(`Master: ${preset.name}`, (p) => {
    p.masterChain = { glue: preset.glue, eq: preset.eq, limiter: preset.limiter, target: preset.target }
    p.master.limiterOn = preset.limiter
  })
  engine.setMasterChain({ glue: preset.glue, eq: preset.eq, limiter: preset.limiter, target: preset.target })
  toast(`${preset.name} master chain`, 'ok')
}

export function setLufsTarget(target: number): void {
  commit('Loudness target', (p) => {
    p.masterChain = { glue: p.masterChain?.glue ?? true, eq: p.masterChain?.eq ?? true, limiter: p.masterChain?.limiter ?? true, target }
  })
}

// ---------------------------------------------------------------------------
// Stems
// ---------------------------------------------------------------------------

/**
 * Render one WAV per track (no master limiter, so stems sum back to the mix).
 * Shared by the Export dialog's stem button and the “export stems” command.
 */
export async function exportStems(opts: { startBeat?: number; endBeat?: number } = {}): Promise<number> {
  const { project } = getState()
  const tracks = project.tracks.filter((t) => t.kind !== 'group' && t.clips.length > 0)
  if (!tracks.length) {
    toast('No tracks with clips to render', 'warn')
    return 0
  }
  const safeName = project.name.replace(/[^\w-]+/g, '_') || 'ils-project'
  let files = 0
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i]
    const buffer = await renderProject(project, { ...opts, tracks: [track.id], masterLimiter: false })
    downloadBlob(
      audioBufferToWav(buffer, { bitDepth: 24, dither: true }),
      `${safeName}_stem_${String(i + 1).padStart(2, '0')}_${track.name.replace(/[^\w-]+/g, '_')}.wav`,
    )
    files++
  }
  toast(`${files} stem${files === 1 ? '' : 's'} exported`, 'ok')
  return files
}

// ---------------------------------------------------------------------------
// Real loop library
// ---------------------------------------------------------------------------

const loopBuffers = new Map<string, AudioBuffer>()
const loopPromise = new Map<string, Promise<AudioBuffer | null>>()

export function loopUrl(loop: LoopDef): string {
  return new URL(`packs/${loop.file}`, document.baseURI).href
}

export async function loadLoop(loop: LoopDef): Promise<AudioBuffer | null> {
  const hit = loopBuffers.get(loop.id)
  if (hit) return hit
  const inflight = loopPromise.get(loop.id)
  if (inflight) return inflight
  const task = (async () => {
    try {
      const res = await fetch(loopUrl(loop))
      if (!res.ok) return null
      const data = await res.arrayBuffer()
      const ctx = engine.ctx ?? (await engine.start())
      const buf = await ctx.decodeAudioData(data)
      loopBuffers.set(loop.id, buf)
      registerBuffer(`looppack:${loop.id}`, buf)
      return buf
    } catch {
      return null
    } finally {
      loopPromise.delete(loop.id)
    }
  })()
  loopPromise.set(loop.id, task)
  return task
}

export async function previewLoop(loopId: string): Promise<void> {
  const loop = LOOPS.find((l) => l.id === loopId)
  if (!loop) return
  const buf = await loadLoop(loop)
  if (buf) engine.previewBuffer(buf, 0.9)
}

/** Drop a real loop as an audio clip that time-stretches to the project tempo. */
export async function dropLoop(loopId: string, trackId?: string, startBeat = 0): Promise<void> {
  const loop = LOOPS.find((l) => l.id === loopId)
  if (!loop) return
  const buf = await loadLoop(loop)
  if (!buf) {
    toast('That loop file is missing — reinstall the Loops pack', 'err')
    return
  }
  const { project } = getState()
  const target =
    findTrack(project, trackId) ??
    project.tracks.find((t) => t.kind === 'audio') ??
    project.tracks[0]
  if (!target) return
  const beats = loop.beats
  addClip(
    target.id,
    makeClip({
      name: `${loop.name} · ${loop.key} ${loop.bpm}`,
      start: startBeat,
      len: beats,
      contentLen: beats,
      kind: 'audio',
      libId: `looppack:${loop.id}`,
      warp: { enabled: true, mode: loop.role === 'drums' ? 'beats' : 'complex', sourceBpm: loop.bpm, detectedBpm: loop.bpm, stretch: 1, markers: [] },
    }),
  )
  toast(`${loop.name} placed — warped from ${loop.bpm} to ${project.bpm} BPM`, 'ok')
}

export function loopsByGenre(genre?: string): LoopDef[] {
  return genre ? LOOPS.filter((l) => l.genreLabel === genre) : LOOPS
}

// ---------------------------------------------------------------------------
// Misc helpers used by the UI and voice commands
// ---------------------------------------------------------------------------

export function selectedClip(): { trackId: string; clipId: string } | null {
  const { ui, project } = getState()
  const id = ui.selectedClipIds[0]
  if (!id) return null
  for (const t of project.tracks) if (t.clips.some((c) => c.id === id)) return { trackId: t.id, clipId: id }
  return null
}

export function addEffectChain(trackId: string, types: DeviceType[]): void {
  for (const type of types) addDevice(trackId, type)
}


// ---------------------------------------------------------------------------
// MIDI effects
// ---------------------------------------------------------------------------
import { arpeggiate, generateChords, humanizeNotes, MIDI_FX_PRESETS, quantizeToScale } from '../music/midiFx'

export function applyMidiFx(clipId: string, fxId: string): void {
  const { project } = getState()
  const hit = findClip(project, clipId)
  if (!hit
) return
  if (hit.clip.kind !== 'midi' || !hit.clip.notes.length) {
    toast('Select a MIDI clip with notes', 'warn')
    return
  }
  const preset = MIDI_FX_PRESETS.find((p) => p.id === fxId)
  if (!preset) return
  const notes = preset.run(hit.clip.notes)
  updateClip(clipId, { notes })
  toast(`${preset.name} applied`, 'ok')
}

export function arpClip(clipId: string, mode: 'up' | 'down' | 'updown' | 'random' = 'up', rate = 0.5, octaves = 1): void {
  const hit = findClip(getState().project, clipId)
  if (!hit || hit.clip.kind !== 'midi') return
  updateClip(clipId, { notes: arpeggiate(hit.clip.notes, { mode, rate: rate as 0.25 | 0.5 | 1, octaves }) })
  toast(`Arpeggiator: ${mode}`, 'ok')
}

export function chordifyClip(clipId: string, mode: 'triad' | 'seventh' | 'sus4' | 'octave' | 'diatonic' = 'triad'): void {
  const { project } = getState()
  const hit = findClip(project, clipId)
  if (!hit || hit.clip.kind !== 'midi') return
  const rootPc = Math.max(0, ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'].indexOf(project.keyRoot))
  updateClip(clipId, { notes: generateChords(hit.clip.notes, { mode, rootPc, scale: project.keyScale }) })
  toast(`Chords: ${mode}`, 'ok')
}

export function scaleQuantizeClip(clipId: string): void {
  const { project } = getState()
  const hit = findClip(project, clipId)
  if (!hit || hit.clip.kind !== 'midi') return
  const rootPc = Math.max(0, ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'].indexOf(project.keyRoot))
  updateClip(clipId, { notes: quantizeToScale(hit.clip.notes, rootPc, project.keyScale) })
  toast(`Quantized to ${project.keyRoot} ${project.keyScale}`, 'ok')
}

export function humanizeClip(clipId: string): void {
  const hit = findClip(getState().project, clipId)
  if (!hit || hit.clip.kind !== 'midi') return
  updateClip(clipId, { notes: humanizeNotes(hit.clip.notes) })
  toast('Humanized timing and velocity', 'ok')
}
