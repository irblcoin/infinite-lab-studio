import { engine } from '../audio/engine'
import { makeClip, uid, clamp, type Note } from './types'
import { commit, getState, setUi, toast } from './store'
import { db } from './db'
import { registerBuffer, storedFromBuffer } from '../audio/assets'
import { findTrack } from './actions'

interface RecState {
  active: boolean
  trackId: string | null
  startBeat: number
  notes: Map<number, { start: number; vel: number }>
  captured: Note[]
  audio: boolean
  micReady: boolean
}

export const rec: RecState = {
  active: false,
  trackId: null,
  startBeat: 0,
  notes: new Map(),
  captured: [],
  audio: false,
  micReady: false,
}

export const isRecording = (): boolean => rec.active

function activeTrackId(): string | null {
  const { project, ui } = getState()
  const armed = project.tracks.find((t) => t.armed && t.kind !== 'group')
  return armed?.id ?? ui.selectedTrackId ?? project.tracks[0]?.id ?? null
}

export async function startRecording(): Promise<void> {
  if (rec.active) return
  const { project, settings } = getState()
  const trackId = activeTrackId()
  const track = findTrack(project, trackId)
  if (!track) {
    toast('Add a track before recording', 'warn')
    return
  }
  await engine.start()
  let micReady = false
  if (track.kind === 'audio' || settings.monitoring) {
    const mic = await engine.enableMic()
    if (!mic.ready) {
      toast(mic.error ?? 'Microphone unavailable', 'err', 6000)
      if (track.kind === 'audio') {
        // MIDI + virtual instruments keep working without a mic.
        return
      }
    } else {
      micReady = true
    }
  }
  if (track.kind === 'audio') {
    if (!micReady) {
      toast('Microphone needed for audio recording. Arm a MIDI track or allow mic access.', 'warn', 5000)
      return
    }
    const started = engine.startCapture()
    if (!started) {
      toast('This browser cannot start audio capture', 'err')
      return
    }
  }
  engine.setMonitoring(settings.monitoring)
  engine.setMetronome(true)
  const countIn = settings.countIn > 0 ? settings.countIn * (project.timeSig[0] || 4) : 0
  const from = engine.getBeat()
  engine.play(from, countIn)
  rec.active = true
  rec.trackId = track.id
  rec.startBeat = from
  rec.notes.clear()
  rec.captured = []
  rec.audio = track.kind === 'audio'
  rec.micReady = micReady
  setUi({ recording: true, playing: true, selectedTrackId: track.id })
  toast(countIn > 0 ? `Recording in ${settings.countIn} bar${settings.countIn > 1 ? 's' : ''}…` : 'Recording', 'warn')
}

function sliceBuffer(ctx: BaseAudioContext, buffer: AudioBuffer, startSec: number, endSec: number): AudioBuffer {
  const sr = buffer.sampleRate
  const start = Math.max(0, Math.floor(startSec * sr))
  const end = Math.min(buffer.length, Math.floor(endSec * sr))
  const len = Math.max(1, end - start)
  const out = ctx.createBuffer(buffer.numberOfChannels, len, sr)
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    out.copyToChannel(buffer.getChannelData(c).subarray(start, end), c)
  }
  return out
}

export async function stopRecording(): Promise<void> {
  if (!rec.active) return
  const { project, settings } = getState()
  const endBeat = engine.getBeat()
  rec.active = false
  setUi({ recording: false })
  engine.setMetronome(settings.metronome)
  const trackId = rec.trackId
  const track = findTrack(project, trackId)
  const startBeat = rec.startBeat

  if (rec.audio && track) {
    const buffer = await engine.stopCapture()
    if (buffer) {
      let buf = buffer
      if (settings.punch.enabled && settings.punch.end > settings.punch.start) {
        const spb = 60 / project.bpm
        const from = (Math.max(settings.punch.start, startBeat) - startBeat) * spb
        const to = (Math.min(settings.punch.end, startBeat + buffer.duration * (project.bpm / 60)) - startBeat) * spb
        if (to > from) buf = sliceBuffer(engine.ctx!, buffer, from, to)
      }
      const asset = storedFromBuffer(`${track.name} take`, buf)
      await db.putAsset(asset)
      registerBuffer(asset.id, buf)
      const latBeats = settings.latencyComp * (project.bpm / 60)
      const placeAt = Math.max(0, startBeat - latBeats)
      const beats = Math.max(0.25, (buf.duration * project.bpm) / 60)
      const takeIndex = commitTake(track.id, placeAt, beats, asset.id)
      toast(`Recorded ${beats.toFixed(1)} beats on ${track.name}${takeIndex ? ` (take ${takeIndex})` : ''}`, 'ok')
    } else {
      toast('Nothing was captured — check that a microphone is connected', 'warn', 5000)
    }
  } else if (track && rec.captured.length) {
    const len = Math.max(0.5, endBeat - startBeat)
    const notes = rec.captured
      .map((n) => ({ ...n, start: Math.max(0, n.start - startBeat), len: Math.max(0.08, Math.min(n.len, len)) }))
      .filter((n) => n.start < len)
    const clip = makeClip({
      name: `${track.name} take`,
      start: startBeat,
      len,
      contentLen: len,
      kind: 'midi',
      notes,
    })
    commit('Record MIDI', (p) => {
      const t = findTrack(p, track.id)
      if (!t) return
      t.clips.push(clip)
      p.length = Math.max(p.length, Math.ceil(startBeat + len + 8))
    })
    toast(`Recorded ${notes.length} note${notes.length === 1 ? '' : 's'}`, 'ok')
  } else if (track) {
    toast('No notes captured. Play the on-screen keys or connect a MIDI keyboard.', 'warn', 4200)
  }

  engine.stop()
  setUi({ playing: false, positionBeat: engine.getBeat() })
}

function commitTake(trackId: string, startBeat: number, beats: number, assetId: string): number {
  let takeNumber = 0
  commit('Record audio', (p) => {
    const track = findTrack(p, trackId)
    if (!track) return
    const existing = track.clips.find(
      (c) => c.kind === 'audio' && Math.abs(c.start - startBeat) < Math.max(1, beats * 0.35),
    )
    const take = { id: uid('take'), name: `Take ${(existing?.takes?.length ?? 0) + 1}`, assetId, offset: 0, len: beats }
    if (existing) {
      if (!existing.takes) {
        existing.takes = existing.assetId
          ? [{ id: uid('take'), name: 'Take 1', assetId: existing.assetId, offset: existing.offset, len: existing.len }]
          : []
      }
      existing.takes.push(take)
      existing.activeTake = existing.takes.length - 1
      existing.libId = undefined
      takeNumber = existing.takes.length
    } else {
      const clip = makeClip({
        name: `${track.name} ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
        start: startBeat,
        len: beats,
        contentLen: beats,
        kind: 'audio',
        assetId,
      })
      track.clips.push(clip)
      takeNumber = 0
    }
    p.length = Math.max(p.length, Math.ceil(startBeat + beats + 8))
  })
  return takeNumber
}

export function liveNoteOn(pitch: number, vel = 0.85): void {
  const { project, ui } = getState()
  const track = findTrack(project, ui.selectedTrackId) ?? project.tracks[0]
  if (!track) return
  engine.audition(track.id, pitch, vel, 0.7, track.kind === 'drum')
  if (rec.active) {
    rec.notes.set(pitch, { start: engine.getBeat(), vel })
  }
}

export function liveNoteOff(pitch: number): void {
  if (!rec.active) return
  const held = rec.notes.get(pitch)
  if (!held) return
  rec.notes.delete(pitch)
  rec.captured.push({
    id: uid('nt'),
    pitch,
    start: held.start,
    len: Math.max(0.08, engine.getBeat() - held.start),
    vel: held.vel,
  })
}

export function setActiveTake(trackId: string, clipId: string, index: number): void {
  commit('Select take', (p) => {
    const track = findTrack(p, trackId)
    const clip = track?.clips.find((c) => c.id === clipId)
    if (clip && clip.takes && clip.takes[index]) clip.activeTake = index
  })
  toast(`Take ${index + 1} active`, 'ok')
}

export function latencyFromMeasurement(): void {
  const ctx = engine.ctx
  if (!ctx) return
  const total = (ctx.baseLatency || 0) + ((ctx as AudioContext & { outputLatency?: number }).outputLatency || 0)
  toast(`Measured round-trip latency ≈ ${(total * 1000).toFixed(1)} ms`, 'ok', 3600)
}

export function clampBeat(b: number): number {
  return clamp(b, 0, 100000)
}
