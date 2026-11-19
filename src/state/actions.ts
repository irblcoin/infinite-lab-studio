import type {
  Clip,
  Device,
  DeviceType,
  Note,
  Params,
  Project,
  Track,
  TrackKind,
  MixSnapshot,
} from './types'
import { clamp, makeClip, makeDevice, makeTrack, TRACK_COLORS, uid } from './types'
import { commit, getState, mutate, pushHistory, setUi, toast, toastError } from './store'
import { DEVICE_DEFS, PRESETS, defaultParams } from '../data/deviceDefs'
import { engine } from '../audio/engine'
import { db } from './db'
import { bufferFromStored, getBuffer, registerBuffer, storedFromBuffer } from '../audio/assets'
import { ensureLibraryBuffer, libById, type LibItem } from '../data/library'
import { generateFromPrompt, loopToTracks, type GeneratedProject } from '../music/generator'
import { snapToScale } from '../music/theory'
import { getPatch, loadSampleBuffer, pickZone, preloadPatch } from '../audio/patch'
import { realInstrumentFor } from '../data/realInstruments'

/** Decode every sampled instrument a project uses, so the first bar is never silent. */
export function preloadProjectInstruments(): void {
  const { project } = getState()
  for (const t of project.tracks) {
    const dev = t.devices.find((d) => d.type === 'sampler' && d.instrumentId)
    const patch = dev ? getPatch(dev.instrumentId) : null
    if (patch) void preloadPatch(patch)
  }
}

/** Real sampled instrument for a generated track, or the requested synth. */
function instrumentDevices(name: string, type: DeviceType, params: Params): Device[] {
  const real = realInstrumentFor(name)
  if (real) {
    const dev = makeDevice('sampler', defaultParams('sampler'), real.label)
    dev.instrumentId = real.instrumentId
    return [dev]
  }
  return [makeDevice(type, params, DEVICE_DEFS[type].name)]
}

export function findTrack(project: Project, trackId: string | null | undefined): Track | undefined {
  if (!trackId) return undefined
  return project.tracks.find((t) => t.id === trackId)
}

export function findClip(project: Project, clipId: string): { track: Track; clip: Clip } | null {
  for (const track of project.tracks) {
    const clip = track.clips.find((c) => c.id === clipId)
    if (clip) return { track, clip }
  }
  return null
}

export const selectedTrack = (): Track | undefined => {
  const { project, ui } = getState()
  return findTrack(project, ui.selectedTrackId) ?? project.tracks[0]
}

// ---------------------------------------------------------------------------
// tracks
// ---------------------------------------------------------------------------
const KIND_DEVICE: Record<TrackKind, DeviceType | null> = {
  drum: 'drums',
  midi: 'synth',
  audio: null,
  group: null,
}

export function addTrack(kind: TrackKind = 'midi', opts: { name?: string; device?: DeviceType; params?: Params; color?: string } = {}): string {
  const { project } = getState()
  const index = project.tracks.length
  const color = opts.color ?? TRACK_COLORS[index % TRACK_COLORS.length]
  const deviceType = opts.device ?? KIND_DEVICE[kind]
  const devices =
    deviceType && DEVICE_DEFS[deviceType]
      ? [makeDevice(deviceType, opts.params ?? defaultParams(deviceType), DEVICE_DEFS[deviceType].name)]
      : []
  const base =
    kind === 'drum' ? 'Drums' : kind === 'audio' ? 'Audio' : kind === 'group' ? 'Group' : 'Instrument'
  const track = makeTrack(opts.name ?? `${base} ${project.tracks.length + 1}`, kind, color, devices)
  if (kind === 'group') track.volume = 0.85
  commit(`Add ${kind} track`, (p) => {
    p.tracks.push(track)
  })
  setUi({ selectedTrackId: track.id })
  toast(`Added ${track.name}`, 'ok')
  return track.id
}

export function deleteTrack(trackId: string): void {
  const { project } = getState()
  const track = findTrack(project, trackId)
  commit('Delete track', (p) => {
    p.tracks = p.tracks.filter((t) => t.id !== trackId)
    for (const t of p.tracks) if (t.output === trackId) t.output = 'master'
    p.tracks.forEach((t) => {
      t.automation = t.automation.filter((a) => !a.target.startsWith(`dev:${trackId}`))
    })
  })
  setUi({ selectedTrackId: project.tracks.find((t) => t.id !== trackId)?.id ?? null, selectedClipIds: [] })
  toast(`Deleted ${track?.name ?? 'track'}`, 'ok')
}

export function duplicateTrack(trackId: string): void {
  const { project } = getState()
  const src = findTrack(project, trackId)
  if (!src) return
  const copy: Track = JSON.parse(JSON.stringify(src))
  copy.id = uid('tr')
  copy.name = `${src.name} copy`
  copy.output = src.output === 'master' ? 'master' : src.output
  copy.clips = copy.clips.map((c) => {
    const clip = { ...c, id: uid('clip') }
    clip.notes = c.notes.map((n) => ({ ...n, id: uid('nt') }))
    return clip
  })
  copy.devices = copy.devices.map((d) => ({ ...d, id: uid('dev'), params: { ...d.params } }))
  copy.automation = copy.automation.map((a) => ({ ...a, id: uid('auto'), points: a.points.map((x) => ({ ...x, id: uid('pt') })) }))
  commit('Duplicate track', (p) => {
    const idx = p.tracks.findIndex((t) => t.id === trackId)
    p.tracks.splice(idx + 1, 0, copy)
  })
  setUi({ selectedTrackId: copy.id })
  toast('Track duplicated', 'ok')
}

export function renameTrack(trackId: string, name: string): void {
  commit('Rename track', (p) => {
    const t = findTrack(p, trackId)
    if (t) t.name = name.trim() || t.name
  })
}

export function setTrackProp(trackId: string, patch: Partial<Track>, history = true): void {
  const apply = (p: Project) => {
    const t = findTrack(p, trackId)
    if (t) Object.assign(t, patch)
  }
  if (history) commit('Edit track', apply)
  else mutate(apply)
}

export function moveTrack(trackId: string, dir: -1 | 1): void {
  commit('Reorder tracks', (p) => {
    const idx = p.tracks.findIndex((t) => t.id === trackId)
    const next = idx + dir
    if (idx < 0 || next < 0 || next >= p.tracks.length) return
    const [t] = p.tracks.splice(idx, 1)
    p.tracks.splice(next, 0, t)
  })
}

export function reorderTrack(from: number, to: number): void {
  commit('Reorder tracks', (p) => {
    if (from === to || from < 0 || from >= p.tracks.length) return
    const [t] = p.tracks.splice(from, 1)
    p.tracks.splice(Math.max(0, Math.min(p.tracks.length, to)), 0, t)
  })
}

export function toggleSolo(trackId: string): void {
  commit('Solo', (p) => {
    const t = findTrack(p, trackId)
    if (!t) return
    t.solo = !t.solo
    if (t.solo) t.mute = false
  })
}

export function toggleMute(trackId: string): void {
  commit('Mute', (p) => {
    const t = findTrack(p, trackId)
    if (t) t.mute = !t.mute
  })
}

export function toggleArm(trackId: string): void {
  commit('Arm track', (p) => {
    for (const t of p.tracks) t.armed = t.id === trackId ? !t.armed : false
  })
}

// ---------------------------------------------------------------------------
// devices
// ---------------------------------------------------------------------------
export function addDevice(trackId: string, type: DeviceType, params?: Params, name?: string): void {
  const dev = makeDevice(type, params ?? defaultParams(type), name ?? DEVICE_DEFS[type].name)
  commit(`Add ${DEVICE_DEFS[type].name}`, (p) => {
    const t = findTrack(p, trackId)
    if (!t) return
    t.devices.push(dev)
  })
  toast(`${DEVICE_DEFS[type].name} added to ${findTrack(getState().project, trackId)?.name}`, 'ok')
}

export function addPresetToTrack(trackId: string, type: DeviceType, presetName: string): void {
  const preset = PRESETS.find((p) => p.type === type && p.name === presetName)
  addDevice(trackId, type, preset?.params, presetName)
}

export function removeDevice(trackId: string, deviceId: string): void {
  commit('Remove device', (p) => {
    const t = findTrack(p, trackId)
    if (!t) return
    t.devices = t.devices.filter((d) => d.id !== deviceId)
  })
}

export function moveDevice(trackId: string, from: number, to: number): void {
  commit('Reorder devices', (p) => {
    const t = findTrack(p, trackId)
    if (!t || from === to) return
    const [d] = t.devices.splice(from, 1)
    t.devices.splice(clamp(to, 0, t.devices.length), 0, d)
  })
}

export function setDeviceParam(trackId: string, deviceId: string, key: string, value: number): void {
  mutate((p) => {
    const t = findTrack(p, trackId)
    const d = t?.devices.find((x) => x.id === deviceId)
    if (d) d.params[key] = value
  })
}

export function setDeviceProps(trackId: string, deviceId: string, patch: { bypass?: boolean; sampleId?: string; name?: string }): void {
  commit('Edit device', (p) => {
    const t = findTrack(p, trackId)
    const d = t?.devices.find((x) => x.id === deviceId)
    if (d) Object.assign(d, patch)
  })
}

export function applyDevicePreset(trackId: string, deviceId: string, presetName: string): void {
  commit('Load preset', (p) => {
    const t = findTrack(p, trackId)
    const d = t?.devices.find((x) => x.id === deviceId)
    if (!d) return
    const preset = PRESETS.find((x) => x.type === d.type && x.name === presetName)
    if (preset) {
      d.params = { ...preset.params }
      d.name = preset.name
    }
  })
  toast(`Preset "${presetName}" loaded`, 'ok')
}

// ---------------------------------------------------------------------------
// clips
// ---------------------------------------------------------------------------
export function addClip(trackId: string, clip: Clip): void {
  commit('Add clip', (p) => {
    const t = findTrack(p, trackId)
    if (!t) return
    t.clips.push(clip)
    p.length = Math.max(p.length, Math.ceil(clip.start + clip.len + 8))
  })
  setUi({ selectedClipIds: [clip.id], selectedTrackId: trackId })
}

export function updateClip(clipId: string, patch: Partial<Clip>, history = false): void {
  const apply = (p: Project) => {
    const found = findClip(p, clipId)
    if (!found) return
    Object.assign(found.clip, patch)
    p.length = Math.max(p.length, Math.ceil(found.clip.start + found.clip.len + 8))
  }
  if (history) commit('Edit clip', apply)
  else mutate(apply)
}

export function deleteClip(clipId: string): void {
  commit('Delete clip', (p) => {
    for (const t of p.tracks) t.clips = t.clips.filter((c) => c.id !== clipId)
  })
  setUi((ui) => ({ selectedClipIds: ui.selectedClipIds.filter((id) => id !== clipId) }))
}

export function duplicateClip(clipId: string): void {
  const { project } = getState()
  const found = findClip(project, clipId)
  if (!found) return
  const copy: Clip = JSON.parse(JSON.stringify(found.clip))
  copy.id = uid('clip')
  copy.start = found.clip.start + found.clip.len
  copy.notes = found.clip.notes.map((n) => ({ ...n, id: uid('nt') }))
  commit('Duplicate clip', (p) => {
    const f = findClip(p, clipId)
    if (!f) return
    f.track.clips.push(copy)
    p.length = Math.max(p.length, Math.ceil(copy.start + copy.len + 8))
  })
  setUi({ selectedClipIds: [copy.id] })
}

export function splitClipAt(clipId: string, atBeat: number): void {
  commit('Split clip', (p) => {
    const found = findClip(p, clipId)
    if (!found) return
    const { clip, track } = found
    const cut = atBeat - clip.start
    if (cut <= 0.05 || cut >= clip.len - 0.05) return
    const left: Clip = JSON.parse(JSON.stringify(clip))
    const right: Clip = JSON.parse(JSON.stringify(clip))
    right.id = uid('clip')
    right.start = atBeat
    right.len = clip.len - cut
    left.len = cut
    if (clip.kind === 'midi') {
      left.contentLen = Math.min(left.contentLen, cut)
      left.notes = clip.notes
        .filter((n) => n.start < cut)
        .map((n) => ({ ...n, len: Math.min(n.len, cut - n.start) }))
      right.contentLen = Math.max(0.25, clip.contentLen - cut)
      right.notes = clip.notes
        .filter((n) => n.start >= cut)
        .map((n) => ({ ...n, id: uid('nt'), start: n.start - cut }))
    } else {
      right.offset = clip.offset + cut
    }
    track.clips = track.clips.filter((c) => c.id !== clipId)
    track.clips.push(left, right)
  })
}

export function moveClipToTrack(clipId: string, targetTrackId: string, start: number): void {
  commit('Move clip', (p) => {
    const found = findClip(p, clipId)
    const target = findTrack(p, targetTrackId)
    if (!found || !target) return
    found.track.clips = found.track.clips.filter((c) => c.id !== clipId)
    found.clip.start = Math.max(0, start)
    target.clips.push(found.clip)
    p.length = Math.max(p.length, Math.ceil(found.clip.start + found.clip.len + 8))
  })
}

export function quantizeClip(clipId: string, grid = 0.25, scaleLock = false): void {
  const { project } = getState()
  commit('Quantize', (p) => {
    const found = findClip(p, clipId)
    if (!found) return
    const rootPc = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].indexOf(p.keyRoot)
    found.clip.notes = found.clip.notes.map((n) => ({
      ...n,
      start: Math.round(n.start / grid) * grid,
      pitch: scaleLock ? snapToScale(n.pitch, rootPc < 0 ? 0 : rootPc, p.keyScale) : n.pitch,
    }))
  })
  toast(`Quantized to ${grid === 0.25 ? '1/16' : grid === 0.5 ? '1/8' : `${grid} beats`}`, 'ok')
}

export function transposeClip(clipId: string, semis: number): void {
  commit('Transpose', (p) => {
    const found = findClip(p, clipId)
    if (!found) return
    found.clip.notes = found.clip.notes.map((n) => ({ ...n, pitch: clamp(n.pitch + semis, 0, 127) }))
  })
}

export function editClipNotes(clipId: string, fn: (notes: Note[]) => Note[]): void {
  mutate((p) => {
    const found = findClip(p, clipId)
    if (found) found.clip.notes = fn(found.clip.notes)
  })
}

export function quantizeNotes(clipId: string, grid: number): void {
  commit('Quantize notes', (p) => {
    const found = findClip(p, clipId)
    if (!found) return
    found.clip.notes = found.clip.notes.map((n) => ({ ...n, start: Math.round(n.start / grid) * grid }))
  })
}

// ---------------------------------------------------------------------------
// automation
// ---------------------------------------------------------------------------
export function ensureLane(trackId: string, target: string): string {
  let laneId = ''
  commit('Add automation', (p) => {
    const t = findTrack(p, trackId)
    if (!t) return
    let lane = t.automation.find((a) => a.target === target)
    if (!lane) {
      lane = { id: uid('auto'), target, points: [], visible: true }
      t.automation.push(lane)
    }
    lane.visible = true
    laneId = lane.id
  })
  return laneId
}

export function addAutoPoint(trackId: string, target: string, beat: number, value: number): void {
  commit('Automation point', (p) => {
    const t = findTrack(p, trackId)
    if (!t) return
    let lane = t.automation.find((a) => a.target === target)
    if (!lane) {
      lane = { id: uid('auto'), target, points: [], visible: true }
      t.automation.push(lane)
    }
    const existing = lane.points.find((pt) => Math.abs(pt.beat - beat) < 0.02)
    if (existing) existing.value = value
    else lane.points.push({ id: uid('pt'), beat, value })
    lane.points.sort((a, b) => a.beat - b.beat)
  })
}

export function updateAutoPoint(trackId: string, laneId: string, pointId: string, beat: number, value: number): void {
  mutate((p) => {
    const t = findTrack(p, trackId)
    const lane = t?.automation.find((a) => a.id === laneId)
    const pt = lane?.points.find((x) => x.id === pointId)
    if (pt) {
      pt.beat = Math.max(0, beat)
      pt.value = value
      lane!.points.sort((a, b) => a.beat - b.beat)
    }
  })
}

export function removeAutoPoint(trackId: string, laneId: string, pointId: string): void {
  commit('Remove automation point', (p) => {
    const t = findTrack(p, trackId)
    const lane = t?.automation.find((a) => a.id === laneId)
    if (lane) lane.points = lane.points.filter((x) => x.id !== pointId)
  })
}

export function toggleAutomationLane(trackId: string, laneId: string): void {
  commit('Toggle automation', (p) => {
    const t = findTrack(p, trackId)
    const lane = t?.automation.find((a) => a.id === laneId)
    if (lane) lane.visible = !lane.visible
  })
}

export function removeLane(trackId: string, laneId: string): void {
  commit('Remove automation lane', (p) => {
    const t = findTrack(p, trackId)
    if (t) t.automation = t.automation.filter((a) => a.id !== laneId)
  })
}

// ---------------------------------------------------------------------------
// mixer
// ---------------------------------------------------------------------------
export function setTrackVolume(trackId: string, v: number, history = false): void {
  const apply = (p: Project) => {
    const t = findTrack(p, trackId)
    if (t) t.volume = clamp(v, 0, 1.5)
  }
  if (history) commit('Volume', apply)
  else mutate(apply)
  const { ui } = getState()
  if (ui.recording && engine.isPlaying) recordFaderPoint(trackId, 'volume', clamp(v, 0, 1.5))
}

export function setTrackPan(trackId: string, v: number, history = false): void {
  const apply = (p: Project) => {
    const t = findTrack(p, trackId)
    if (t) t.pan = clamp(v, -1, 1)
  }
  if (history) commit('Pan', apply)
  else mutate(apply)
  const { ui } = getState()
  if (ui.recording && engine.isPlaying) recordFaderPoint(trackId, 'pan', clamp(v, -1, 1))
}

export function setTrackSend(trackId: string, index: 0 | 1, v: number): void {
  mutate((p) => {
    const t = findTrack(p, trackId)
    if (t) t.sends = index === 0 ? [clamp(v, 0, 1), t.sends[1]] : [t.sends[0], clamp(v, 0, 1)]
  })
}

function recordFaderPoint(trackId: string, target: 'volume' | 'pan', value: number): void {
  const beat = engine.getBeat()
  mutate((p) => {
    const t = findTrack(p, trackId)
    if (!t) return
    let lane = t.automation.find((a) => a.target === target)
    if (!lane) {
      lane = { id: uid('auto'), target, points: [], visible: true }
      t.automation.push(lane)
    }
    lane.points.push({ id: uid('pt'), beat, value })
    if (lane.points.length > 4000) lane.points.splice(0, 1000)
    lane.points.sort((a, b) => a.beat - b.beat)
  })
}

export function saveMixSnapshot(name: string): void {
  const { project } = getState()
  const snap: MixSnapshot = {
    id: uid('mix'),
    name: name || `Snapshot ${project.snapshots.length + 1}`,
    createdAt: Date.now(),
    tracks: Object.fromEntries(
      project.tracks.map((t) => [t.id, { volume: t.volume, pan: t.pan, sends: [...t.sends] as [number, number], mute: t.mute, solo: t.solo }]),
    ),
  }
  commit('Save mix snapshot', (p) => {
    p.snapshots.unshift(snap)
    p.snapshots = p.snapshots.slice(0, 12)
  })
  toast(`Mix snapshot "${snap.name}" saved`, 'ok')
}

export function recallMixSnapshot(id: string): void {
  commit('Recall mix snapshot', (p) => {
    const snap = p.snapshots.find((s) => s.id === id)
    if (!snap) return
    for (const t of p.tracks) {
      const s = snap.tracks[t.id]
      if (s) {
        t.volume = s.volume
        t.pan = s.pan
        t.sends = [...s.sends] as [number, number]
        t.mute = s.mute
        t.solo = s.solo
      }
    }
  })
  toast('Mix recalled', 'ok')
}

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------
export async function togglePlay(): Promise<void> {
  const { settings } = getState()
  if (engine.isPlaying) {
    engine.stop()
    setUi({ playing: false })
    return
  }
  await engine.start()
  engine.setMetronome(settings.metronome)
  engine.play(engine.getBeat(), 0)
  setUi({ playing: true })
}

export function stopTransport(): void {
  engine.stop()
  setUi({ playing: false, positionBeat: engine.getBeat() })
}

export function setBpm(bpm: number): void {
  commit('Tempo', (p) => {
    p.bpm = clamp(Math.round(bpm), 30, 300)
  })
}

export function setKey(keyRoot: string, keyScale?: string): void {
  commit('Key', (p) => {
    p.keyRoot = keyRoot
    if (keyScale) p.keyScale = keyScale
  })
}

export function setLoop(start: number, end: number, enabled = true): void {
  commit('Loop region', (p) => {
    p.loop = { start: Math.max(0, start), end: Math.max(start + 0.25, end), enabled }
  })
}

export function toggleLoop(): void {
  commit('Toggle loop', (p) => {
    p.loop.enabled = !p.loop.enabled
  })
}

export function addMarker(beat: number, name?: string): void {
  commit('Add marker', (p) => {
    p.markers.push({ id: uid('mk'), beat, name: name || `Marker ${p.markers.length + 1}`, color: TRACK_COLORS[p.markers.length % TRACK_COLORS.length] })
    p.markers.sort((a, b) => a.beat - b.beat)
  })
}

export function removeMarker(id: string): void {
  commit('Remove marker', (p) => {
    p.markers = p.markers.filter((m) => m.id !== id)
  })
}

// ---------------------------------------------------------------------------
// library / import
// ---------------------------------------------------------------------------
export async function importAudioFile(file: File, trackId?: string, startBeat = 0): Promise<void> {
  try {
    const ctx = engine.ctx ?? (await engine.start())
    const data = await file.arrayBuffer()
    const buffer = await ctx.decodeAudioData(data)
    const asset = storedFromBuffer(file.name, buffer)
    await db.putAsset(asset)
    registerBuffer(asset.id, buffer)
    const { project, ui } = getState()
    let target = trackId
    if (!target) {
      const audio = project.tracks.find((t) => t.kind === 'audio')
      target = audio?.id ?? addTrack('audio', { name: file.name.replace(/\.[^.]+$/, '') })
    }
    const beats = (buffer.duration * project.bpm) / 60
    const clip = makeClip({
      name: file.name.replace(/\.[^.]+$/, ''),
      start: startBeat,
      len: beats,
      contentLen: beats,
      kind: 'audio',
      assetId: asset.id,
    })
    addClip(target, clip)
    toast(`Imported ${file.name}`, 'ok')
  } catch (err) {
    toastError(err, 'Could not read that audio file')
  }
}

export async function dropLibraryItem(itemId: string, trackId?: string, startBeat = 0): Promise<void> {
  if (itemId.startsWith('patch:')) {
    addSamplerInstrument(itemId.slice(6), trackId)
    return
  }
  if (itemId.startsWith('asset:')) {
    const assetId = itemId.slice(6)
    const { project } = getState()
    let buf = getBuffer(assetId)
    if (!buf) {
      const ctx = engine.ctx ?? (await engine.start())
      const stored = await db.getAsset(assetId)
      if (stored) {
        buf = bufferFromStored(ctx, stored)
        registerBuffer(assetId, buf)
      }
    }
    if (!buf) {
      toast('That recording could not be loaded', 'err')
      return
    }
    const beats = Math.max(0.25, (buf.duration * project.bpm) / 60)
    const target = findTrack(project, trackId) ?? project.tracks.find((t) => t.kind === 'audio') ?? project.tracks[0]
    if (!target) return
    addClip(
      target.id,
      makeClip({ name: 'Recording', start: startBeat, len: beats, contentLen: beats, kind: 'audio', assetId }),
    )
    return
  }
  const item = libById(itemId)
  if (!item) return
  const { project } = getState()
  try {
    if (item.kind === 'instrument' && item.device) {
      const target = findTrack(project, trackId) ?? selectedTrack()
      if (!target) return
      addDevice(target.id, item.device.type, item.device.params, item.device.presetName)
      return
    }
    if (item.kind === 'effect' && item.device) {
      const target = findTrack(project, trackId) ?? selectedTrack()
      if (!target) return
      addDevice(target.id, item.device.type, item.device.params, item.device.presetName)
      return
    }
    if (item.kind === 'loop' && item.loop) {
      await engine.start()
      const rootPc = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].indexOf(project.keyRoot)
      const tracks = loopToTracks(item.loop, rootPc < 0 ? 0 : rootPc, project.keyScale, project.bpm)
      commit(`Drop ${item.name}`, (p) => {
        for (const gt of tracks) {
          const t = makeTrack(gt.name, gt.kind, gt.color, instrumentDevices(gt.name, gt.deviceType, gt.params))
          const start = startBeat + (gt.clips[0]?.startBar ?? 0) * 4
          t.clips = gt.clips.map((c) =>
            makeClip({
              name: c.name,
              start: startBeat + c.startBar * 4,
              len: c.bars * 4,
              contentLen: c.bars * 4,
              kind: 'midi',
              notes: c.notes,
            }),
          )
          t.volume = gt.volume ?? 0.75
          p.tracks.push(t)
          p.length = Math.max(p.length, Math.ceil(start + (gt.clips[0]?.bars ?? 4) * 4 + 8))
        }
        p.length = Math.max(p.length, Math.ceil(startBeat + tracks[0].clips[0].bars * 4 + 8))
      })
      setUi({ selectedTrackId: getState().project.tracks[getState().project.tracks.length - tracks.length]?.id ?? null })
      preloadProjectInstruments()
      toast(`${item.name} added as ${tracks.length} track${tracks.length > 1 ? 's' : ''}`, 'ok')
      return
    }
    // audio-based item
    const buf = await ensureLibraryBuffer(item.id)
    if (!buf) {
      toast('That sound could not be generated', 'err')
      return
    }
    const beats = Math.max(0.25, (buf.duration * project.bpm) / 60)
    const target = findTrack(project, trackId) ?? project.tracks.find((t) => t.kind === 'audio') ?? project.tracks[0]
    if (!target) return
    addClip(
      target.id,
      makeClip({
        name: item.name,
        start: startBeat,
        len: beats,
        contentLen: beats,
        kind: 'audio',
        libId: item.id,
      }),
    )
    toast(`${item.name} placed on ${target.name}`, 'ok')
  } catch (err) {
    toastError(err, 'Could not drop that item')
  }
}

/**
 * Swap the empty demo tracks (Drums / Bass / Keys) over to real sampled
 * instruments once the catalogue has loaded. Only touches tracks that still
 * hold the default synth and no clips, so it can never overwrite user work.
 */
export function upgradeDefaultInstruments(): void {
  const { project } = getState()
  const targets: Record<string, string> = {
    Drums: 'dr_lm2',
    Bass: 'gm_electric_bass_finger',
    Keys: 'sam_salamander',
  }
  const swaps = project.tracks.filter((t) => {
    const patchId = targets[t.name]
    if (!patchId || t.clips.length > 0) return false
    const inst = t.devices.find((d) => DEVICE_DEFS[d.type].category === 'instrument')
    return !!inst && inst.type !== 'sampler' && !!getPatch(patchId)
  })
  if (!swaps.length) return
  commit('Load sampled instruments', (p) => {
    for (const t of p.tracks) {
      const patchId = targets[t.name]
      const patch = getPatch(patchId)
      if (!patch || t.clips.length > 0) continue
      const inst = t.devices.find((d) => DEVICE_DEFS[d.type].category === 'instrument')
      if (!inst || inst.type === 'sampler') continue
      const dev = makeDevice('sampler', defaultParams('sampler'), patch.name)
      dev.instrumentId = patch.id
      t.devices = [dev, ...t.devices.filter((d) => d.id !== inst.id)]
    }
  })
  void Promise.all(swaps.map((t) => {
    const patch = getPatch(targets[t.name])
    return patch ? preloadPatch(patch) : Promise.resolve()
  }))
}

/** Load a real sampled instrument onto a track, replacing its instrument device. */
export function addSamplerInstrument(patchId: string, trackId?: string): void {
  const patch = getPatch(patchId)
  if (!patch) {
    toast('That instrument pack is not available yet', 'warn')
    return
  }
  const { project } = getState()
  const target = findTrack(project, trackId) ?? selectedTrack() ?? project.tracks[0]
  if (!target) return
  const dev = makeDevice('sampler', defaultParams('sampler'), patch.name)
  dev.instrumentId = patch.id
  commit(`Load ${patch.name}`, (p) => {
    const t = findTrack(p, target.id)
    if (!t) return
    t.devices = t.devices.filter((d) => DEVICE_DEFS[d.type].category !== 'instrument')
    t.devices.unshift(dev)
  })
  void preloadPatch(patch)
  toast(`${patch.name} → ${target.name}`, 'ok')
}

/** Decode just the samples a short preview needs, then play a phrase. */
export async function previewPackInstrument(patchId: string): Promise<void> {
  const patch = getPatch(patchId)
  if (!patch) return
  await engine.start()
  await Promise.all(
    [55, 60, 64, 67, 72].map((pitch) => {
      const zone = pickZone(patch, pitch, 0.85)
      return zone ? loadSampleBuffer(patch.packId, zone.file) : Promise.resolve(null)
    }),
  )
  engine.previewPhrase('sampler', defaultParams('sampler'), [60, 64, 67, 72], 0.85, 0.12, undefined, patch.id)
}

export async function previewLibraryItem(item: LibItem): Promise<void> {
  await engine.start()
  if (item.kind === 'instrument' && item.device) {
    const p = item.device.params
    engine.previewPhrase(item.device.type, p, [60, 64, 67, 72], 0.5, 0.12)
    return
  }
  if (item.kind === 'effect' && item.device) {
    engine.previewPhrase('synth', defaultParams('synth'), [57, 60, 64, 67], 0.35, 0.1, {
      type: item.device.type,
      params: item.device.params,
    })
    return
  }
  if (item.kind === 'loop' && item.loop) {
    const { project } = getState()
    const rootPc = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].indexOf(project.keyRoot)
    const tracks = loopToTracks(item.loop, rootPc < 0 ? 0 : rootPc, project.keyScale, project.bpm)
    const gt = tracks[0]
    const notes = tracks.flatMap((t) =>
      t.clips.flatMap((c) =>
        c.notes.map((n) => ({ pitch: n.pitch, start: n.start + c.startBar * 4, len: n.len, vel: n.vel })),
      ),
    )
    engine.previewNotes(gt.deviceType, gt.params, notes, project.bpm)
    return
  }
  const buf = await ensureLibraryBuffer(item.id)
  if (buf) engine.previewBuffer(buf, 0.9)
}

export async function freezeTrack(trackId: string): Promise<void> {
  const { project } = getState()
  const track = findTrack(project, trackId)
  if (!track || track.kind === 'group') return
  if (track.frozenAssetId) {
    commit('Unfreeze track', (p) => {
      const t = findTrack(p, trackId)
      if (t) t.frozenAssetId = undefined
    })
    toast(`${track.name} unfrozen`, 'ok')
    return
  }
  toast(`Freezing ${track.name}…`, 'ok', 1200)
  const buffer = await engine.freezeTrack(trackId)
  if (!buffer) {
    toast('Could not freeze this track', 'err')
    return
  }
  const asset = storedFromBuffer(`${track.name} (frozen)`, buffer)
  await db.putAsset(asset)
  registerBuffer(asset.id, buffer)
  commit('Freeze track', (p) => {
    const t = findTrack(p, trackId)
    if (t) t.frozenAssetId = asset.id
  })
  toast(`${track.name} frozen to audio`, 'ok')
}

// ---------------------------------------------------------------------------
// generation
// ---------------------------------------------------------------------------
export function applyGeneratedProject(gen: GeneratedProject, replace = false): void {
  const startBarOffset = replace ? 0 : Math.ceil(getState().project.length / 4)
  commit('AI create', (p) => {
    p.bpm = gen.bpm
    p.keyRoot = gen.keyRoot
    p.keyScale = gen.scale
    if (!p.name || p.name === 'Untitled Session') {
      p.name = gen.genre.replace(/\b\w/g, (c) => c.toUpperCase()) + ' ' + gen.bpm
    }
    if (replace) p.tracks = []
    for (const gt of gen.tracks) {
      const t = makeTrack(gt.name, gt.kind, gt.color, instrumentDevices(gt.name, gt.deviceType, gt.params))
      t.clips = gt.clips.map((c) =>
        makeClip({
          name: c.name,
          start: (startBarOffset + c.startBar) * 4,
          len: c.bars * 4,
          contentLen: c.bars * 4,
          kind: 'midi',
          notes: c.notes.map((n) => ({ ...n, id: uid('nt') })),
        }),
      )
      t.volume = gt.volume ?? 0.75
      t.pan = gt.pan ?? 0
      p.tracks.push(t)
    }
    for (const s of gen.sections) {
      const bar = startBarOffset + s.startBar
      p.markers.push({ id: uid('mk'), beat: bar * 4, name: s.name, color: '#d7a951' })
    }
    p.markers.sort((a, b) => a.beat - b.beat)
    p.length = Math.max(64, (startBarOffset + gen.bars) * 4 + 16)
  })
  setUi({ view: 'seq', selectedTrackId: getState().project.tracks[0]?.id ?? null })
  preloadProjectInstruments()
  const jumpBeat = startBarOffset * 4
  engine.seek(jumpBeat)
  window.dispatchEvent(new CustomEvent('ils:scroll-to-beat', { detail: jumpBeat }))
  toast(`Generated ${gen.tracks.length} tracks — ${gen.genre}, ${gen.bpm} BPM, ${gen.keyRoot} ${gen.scale}`, 'ok', 3800)
}

export function generateFromText(prompt: string, replace = false): void {
  const gen = generateFromPrompt(prompt)
  applyGeneratedProject(gen, replace)
}

export function scrollTimelineTo(beat: number): void {
  window.dispatchEvent(new CustomEvent('ils:scroll-to-beat', { detail: beat }))
}

export function pushHistoryStep(): void {
  pushHistory()
}
