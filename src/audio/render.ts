import type { Clip, DeviceType, Params, Project, Track } from '../state/types'
import { clamp } from '../state/types'
import { DEVICE_DEFS } from '../data/deviceDefs'
import { getPatch, preloadPatch } from './patch'
import { createEffect, type FXNode } from './effects'
import { playInstrument } from './instruments'
import { getBuffer } from './assets'
import { audibleTracks, buildEvents, isInstrument, laneValue, type SchedEvent } from './engine'
import { gainNode, impulseResponse, reversedBuffer } from './dsp'

export interface RenderOptions {
  startBeat?: number
  endBeat?: number
  sampleRate?: number
  tracks?: string[]
  masterLimiter?: boolean
  tailSeconds?: number
}

interface OfflineTrack {
  input: GainNode
  fader: GainNode
  pan: StereoPannerNode
  effects: FXNode[]
}

function scheduleClipAudio(
  ctx: BaseAudioContext,
  dest: AudioNode,
  clip: Clip | null,
  track: Track,
  time: number,
  durBeats: number,
  spb: number,
): void {
  const raw = clip
    ? (clip.takes?.length && clip.activeTake != null
        ? getBuffer(clip.takes[clip.activeTake]?.assetId)
        : getBuffer(clip.assetId) || getBuffer(clip.libId))
    : getBuffer(track.frozenAssetId)
  if (!raw) return
  const buf = clip?.reverse ? reversedBuffer(ctx, raw) : raw
  const src = ctx.createBufferSource()
  src.buffer = buf
  const targetSec = Math.max(0.02, durBeats * spb)
  const contentSec = clip ? Math.max(0.05, clip.contentLen * spb) : buf.duration
  const rate = clamp(contentSec / Math.max(0.02, buf.duration), 0.06, 8) * Math.pow(2, (clip?.pitch ?? 0) / 12)
  src.playbackRate.value = rate
  const offsetSec = clip ? clamp(clip.offset * spb * rate, 0, Math.max(0, buf.duration - 0.01)) : 0
  const gain = ctx.createGain()
  const level = clip?.gain ?? 1
  const fadeIn = clip ? Math.max(0, clip.fadeIn * spb) : 0
  const fadeOut = clip ? Math.max(0, clip.fadeOut * spb) : 0
  const end = time + targetSec
  gain.gain.setValueAtTime(0, time)
  gain.gain.linearRampToValueAtTime(level, time + Math.min(fadeIn, targetSec * 0.9) + 0.004)
  if (fadeOut > 0.001) {
    gain.gain.setValueAtTime(level, Math.max(time + 0.004, end - fadeOut))
    gain.gain.linearRampToValueAtTime(0, end)
  }
  src.connect(gain).connect(dest)
  src.start(time, offsetSec, Math.max(0.02, Math.min(buf.duration - offsetSec, targetSec * rate)))
}

function scheduleNote(
  ctx: BaseAudioContext,
  dest: AudioNode,
  track: Track,
  ev: SchedEvent,
  time: number,
  spb: number,
): void {
  const inst = track.devices.find((d) => !d.bypass && isInstrument(d.type))
  const type: DeviceType = inst?.type ?? (track.kind === 'drum' ? 'drums' : 'synth')
  const params: Params = inst?.params ?? {}
  playInstrument({
    ctx,
    type,
    params,
    dest,
    time,
    dur: Math.max(0.02, ev.dur * spb),
    pitch: ev.pitch ?? 60,
    vel: ev.vel ?? 0.8,
    buffer: inst?.sampleId ? getBuffer(inst.sampleId) : null,
    samplerId: inst?.instrumentId,
  })
}

/** Offline mixing console that mirrors the live engine. */
export async function renderProject(project: Project, opts: RenderOptions = {}): Promise<AudioBuffer> {
  // Real sampled instruments must be in the file cache before an offline
  // context starts: their voices schedule synchronously during rendering.
  const wantedTracks = opts.tracks ? new Set(opts.tracks) : null
  const patches = new Set<string>()
  for (const track of project.tracks) {
    if (wantedTracks && !wantedTracks.has(track.id)) continue
    for (const d of track.devices) if (d.type === 'sampler' && d.instrumentId) patches.add(d.instrumentId)
  }
  for (const id of patches) {
    const patch = getPatch(id)
    if (!patch) continue
    // Never let a large multisample block an export: whatever decodes in the
    // budget is used, and unloaded zones fall back to the synth voice.
    await Promise.race([preloadPatch(patch), new Promise((r) => setTimeout(r, 2500))])
  }
  const sr = opts.sampleRate ?? 44100
  const spb = 60 / project.bpm
  const startBeat = Math.max(0, opts.startBeat ?? 0)
  const endBeat = Math.max(startBeat + 0.25, opts.endBeat ?? project.length)
  const durSec = (endBeat - startBeat) * spb + (opts.tailSeconds ?? 2.2)
  const ctx = new OfflineAudioContext(2, Math.ceil(durSec * sr), sr)

  const masterIn = gainNode(ctx, 0.92)
  const limiter = ctx.createDynamicsCompressor()
  if (opts.masterLimiter !== false && project.master.limiterOn) {
    limiter.threshold.value = project.master.ceiling - 1.2
    limiter.ratio.value = 20
    limiter.knee.value = 0
    limiter.attack.value = 0.001
    limiter.release.value = 0.1
  } else {
    limiter.threshold.value = 0
    limiter.ratio.value = 1
  }
  const masterGain = gainNode(ctx, clamp(project.master.volume, 0, 1.5))
  masterIn.connect(limiter).connect(masterGain).connect(ctx.destination)

  const reverbIn = gainNode(ctx, 1)
  const conv = ctx.createConvolver()
  conv.buffer = impulseResponse(ctx, 2.8, 0.45, 0.6)
  reverbIn.connect(conv).connect(masterIn)
  const delayIn = gainNode(ctx, 1)
  const dl = ctx.createDelay(3)
  const dr = ctx.createDelay(3)
  const fb = gainNode(ctx, 0.34)
  dl.delayTime.value = spb * 0.5
  dr.delayTime.value = spb * 0.75
  delayIn.connect(dl)
  dl.connect(dr)
  dr.connect(fb).connect(dl)
  const merger = ctx.createChannelMerger(2)
  dl.connect(merger, 0, 0)
  dr.connect(merger, 0, 1)
  merger.connect(masterIn)

  const wanted = opts.tracks ? new Set(opts.tracks) : null
  const gate = audibleTracks(project)
  const included = project.tracks.filter((t) => (wanted ? wanted.has(t.id) : true))
  const includedIds = new Set(included.map((t) => t.id))
  const outs = new Map<string, OfflineTrack>()

  for (const track of project.tracks) {
    if (!includedIds.has(track.id)) continue
    const input = gainNode(ctx, 1)
    const fader = gainNode(ctx, clamp(track.volume, 0, 1.6))
    const pan = ctx.createStereoPanner()
    pan.pan.value = clamp(track.pan, -1, 1)
    fader.connect(pan)
    const effects = track.frozenAssetId
      ? []
      : track.devices
          .filter((d) => !d.bypass && DEVICE_DEFS[d.type].category === 'effect')
          .map((d) => createEffect(ctx, d.type, d.params))
    let node: AudioNode = input
    for (const fx of effects) {
      node.connect(fx.input)
      node = fx.output
    }
    node.connect(fader)
    const sa = gainNode(ctx, clamp(track.sends[0], 0, 1))
    const sb = gainNode(ctx, clamp(track.sends[1], 0, 1))
    pan.connect(sa).connect(reverbIn)
    pan.connect(sb).connect(delayIn)
    outs.set(track.id, { input, fader, pan, effects })
  }

  // routing (groups feed their parent, otherwise the master bus)
  for (const track of included) {
    const g = outs.get(track.id)
    if (!g) continue
    const target = track.output !== 'master' && outs.has(track.output) ? outs.get(track.output)!.input : masterIn
    g.pan.connect(target)
  }

  // automation ramps (volume / pan / sends)
  for (const track of included) {
    const g = outs.get(track.id)
    if (!g) continue
    for (const lane of track.automation) {
      if (lane.points.length < 2) continue
      const pts = [...lane.points].sort((a, b) => a.beat - b.beat)
      const param =
        lane.target === 'volume'
          ? g.fader.gain
          : lane.target === 'pan'
            ? g.pan.pan
            : lane.target === 'sendA' || lane.target === 'sendB'
              ? null
              : null
      if (!param) continue
      param.cancelScheduledValues(0)
      param.setValueAtTime(pts[0].value, Math.max(0, (pts[0].beat - startBeat) * spb))
      for (const p of pts.slice(1)) {
        const t = Math.max(0, (p.beat - startBeat) * spb)
        param.linearRampToValueAtTime(p.value, t)
      }
    }
  }

  const events = buildEvents(project)
  for (const ev of events) {
    if (ev.beat < startBeat - 1e-6 || ev.beat >= endBeat - 1e-6) continue
    if (!includedIds.has(ev.trackId)) continue
    if (!gate.has(ev.trackId) && !opts.tracks) continue
    const track = project.tracks.find((t) => t.id === ev.trackId)
    if (!track) continue
    const g = outs.get(track.id)
    if (!g) continue
    const time = Math.max(0, (ev.beat - startBeat) * spb)
    if (ev.kind === 'note') scheduleNote(ctx, g.input, track, ev, time, spb)
    else scheduleClipAudio(ctx, g.input, ev.clip ?? null, track, time, ev.dur, spb)
  }

  return ctx.startRendering()
}

export async function renderTrackBuffer(project: Project, trackId: string): Promise<AudioBuffer | null> {
  try {
    return await renderProject(project, { tracks: [trackId], masterLimiter: false })
  } catch (err) {
    console.warn('freeze render failed', err)
    return null
  }
}

// ---------------------------------------------------------------------------
// Encoders
// ---------------------------------------------------------------------------
export interface WavOptions {
  /** 16, 24 or 32 (32 = IEEE float). Defaults to 24-bit. */
  bitDepth?: 16 | 24 | 32
  /** TPDF dither, on by default for 16/24-bit integer output. */
  dither?: boolean
}

export function audioBufferToWav(buffer: AudioBuffer, opts: WavOptions = {}): Blob {
  const numChannels = Math.min(2, buffer.numberOfChannels)
  const length = buffer.length
  const sampleRate = buffer.sampleRate
  const depth = opts.bitDepth ?? 24
  const isFloat = depth === 32
  const bytesPerSample = depth / 8
  const blockAlign = numChannels * bytesPerSample
  const dataSize = length * blockAlign
  // WAVE_FORMAT_EXTENSIBLE keeps 24-bit and float files readable everywhere.
  const fmtSize = isFloat || depth === 24 ? 40 : 16
  const headerSize = 12 + 8 + fmtSize + 8
  const ab = new ArrayBuffer(headerSize + dataSize)
  const view = new DataView(ab)
  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, headerSize - 8 + dataSize, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, fmtSize, true)
  view.setUint16(20, isFloat ? 3 : 1, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, depth, true)
  if (fmtSize === 40) {
    view.setUint16(36, 22, true)
    view.setUint16(38, depth, true)
    view.setUint32(40, isFloat ? 4 : numChannels === 2 ? 3 : 4, true)
    writeStr(44, isFloat ? '\x00\x00\x00\x00\x10\x00\x80\x00\x00\xaa\x00\x38\x9b\x71' : '\x01\x00\x00\x00\x00\x00\x10\x00\x80\x00\x00\xaa\x00\x38\x9b\x71')
  }
  writeStr(headerSize - 8, 'data')
  view.setUint32(headerSize - 4, dataSize, true)
  const chans: Float32Array[] = []
  for (let c = 0; c < numChannels; c++) chans.push(buffer.getChannelData(c))
  const useDither = opts.dither !== false && !isFloat
  const scale = depth === 16 ? 0x8000 : 0x800000
  const ditherAmp = 1 / scale
  const rand = () => Math.random() + Math.random() - 1
  let offset = headerSize
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < numChannels; c++) {
      let s = chans[c][i]
      s = Math.max(-1, Math.min(1, s))
      if (isFloat) {
        view.setFloat32(offset, s, true)
        offset += 4
      } else if (depth === 16) {
        if (useDither) s += rand() * ditherAmp
        view.setInt16(offset, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true)
        offset += 2
      } else {
        if (useDither) s += rand() * ditherAmp
        const v = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff)
        view.setUint8(offset, v & 0xff)
        view.setUint8(offset + 1, (v >> 8) & 0xff)
        view.setUint8(offset + 2, (v >> 16) & 0xff)
        offset += 3
      }
    }
  }
  return new Blob([ab], { type: 'audio/wav' })
}

export async function audioBufferToMp3(buffer: AudioBuffer, kbps = 192): Promise<Blob> {
  const mod = (await import('@breezystack/lamejs')) as unknown as {
    Mp3Encoder?: new (ch: number, sr: number, kbps: number) => {
      encodeBuffer: (l: Int16Array, r?: Int16Array) => Uint8Array
      flush: () => Uint8Array
    }
    default?: { Mp3Encoder?: unknown }
  }
  const Encoder =
    mod.Mp3Encoder ||
    (mod.default as { Mp3Encoder?: new (ch: number, sr: number, kbps: number) => {
      encodeBuffer: (l: Int16Array, r?: Int16Array) => Uint8Array
      flush: () => Uint8Array
    } })?.Mp3Encoder
  if (!Encoder) throw new Error('MP3 encoder unavailable')
  const channels = buffer.numberOfChannels >= 2 ? 2 : 1
  const sr = buffer.sampleRate
  const encoder = new Encoder(channels, sr, kbps)
  const left = buffer.getChannelData(0)
  const right = channels === 2 ? buffer.getChannelData(1) : left
  const blockSize = 1152
  const chunks: Uint8Array[] = []
  const l16 = new Int16Array(blockSize)
  const r16 = new Int16Array(blockSize)
  for (let i = 0; i < left.length; i += blockSize) {
    const n = Math.min(blockSize, left.length - i)
    for (let j = 0; j < n; j++) {
      l16[j] = Math.max(-1, Math.min(1, left[i + j])) * 0x7fff
      r16[j] = Math.max(-1, Math.min(1, right[i + j])) * 0x7fff
    }
    const chunk = channels === 2 ? encoder.encodeBuffer(l16.subarray(0, n), r16.subarray(0, n)) : encoder.encodeBuffer(l16.subarray(0, n))
    if (chunk.length > 0) chunks.push(new Uint8Array(chunk))
  }
  const last = encoder.flush()
  if (last.length > 0) chunks.push(new Uint8Array(last))
  return new Blob(chunks as BlobPart[], { type: 'audio/mpeg' })
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

// ---------------------------------------------------------------------------
// Standard MIDI file writer
// ---------------------------------------------------------------------------
function varLen(value: number): number[] {
  const bytes = [value & 0x7f]
  let v = value >> 7
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80)
    v >>= 7
  }
  return bytes
}

export function projectToMidi(project: Project): Blob {
  const ppq = 480
  const chunks: number[] = []
  const push = (...b: number[]) => chunks.push(...b)
  const header = ['M', 'T', 'h', 'd'].map((c) => c.charCodeAt(0))
  const trackCount = project.tracks.filter((t) => t.clips.length > 0).length + 1
  push(...header, 0, 0, 0, 6, 0, 1, (trackCount >> 8) & 0xff, trackCount & 0xff, (ppq >> 8) & 0xff, ppq & 0xff)

  const tempoTrack: number[] = []
  const tempo = Math.round(60000000 / project.bpm)
  tempoTrack.push(0, 0xff, 0x51, 0x03, (tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff)
  const nameBytes = Array.from(new TextEncoder().encode(project.name))
  tempoTrack.push(0, 0xff, 0x03, ...varLen(nameBytes.length), ...nameBytes)
  tempoTrack.push(0, 0xff, 0x2f, 0x00)

  const writeTrack = (data: number[]) => {
    push(0x4d, 0x54, 0x72, 0x6b, (data.length >> 24) & 0xff, (data.length >> 16) & 0xff, (data.length >> 8) & 0xff, data.length & 0xff, ...data)
  }
  writeTrack(tempoTrack)

  for (const track of project.tracks) {
    if (!track.clips.length) continue
    const evts: { tick: number; on: boolean; pitch: number; vel: number }[] = []
    for (const clip of track.clips) {
      if (clip.kind !== 'midi') continue
      const cycle = Math.max(0.0625, clip.contentLen || clip.len)
      const passes = clip.loop ? Math.max(1, Math.ceil(clip.len / cycle - 1e-6)) : 1
      for (let p = 0; p < passes; p++) {
        for (const note of clip.notes) {
          const rel = p * cycle + note.start
          if (rel >= clip.len - 1e-6) continue
          const startTick = Math.round((clip.start + rel) * ppq)
          const endTick = Math.round((clip.start + rel + Math.min(note.len, clip.len - rel)) * ppq)
          evts.push({ tick: startTick, on: true, pitch: note.pitch, vel: Math.round(note.vel * 127) })
          evts.push({ tick: endTick, on: false, pitch: note.pitch, vel: 0 })
        }
      }
    }
    evts.sort((a, b) => a.tick - b.tick || (a.on ? 1 : -1))
    const data: number[] = []
    const tname = Array.from(new TextEncoder().encode(track.name))
    data.push(0, 0xff, 0x03, ...varLen(tname.length), ...tname)
    let last = 0
    for (const e of evts) {
      data.push(...varLen(e.tick - last))
      last = e.tick
      data.push(e.on ? 0x90 : 0x80, e.pitch & 0x7f, e.vel & 0x7f)
    }
    data.push(0, 0xff, 0x2f, 0x00)
    writeTrack(data)
  }
  return new Blob([new Uint8Array(chunks)], { type: 'audio/midi' })
}

export function makeThumbnail(project: Project): string {
  const w = 320
  const h = 180
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  const g = ctx.createLinearGradient(0, 0, w, h)
  g.addColorStop(0, '#111317')
  g.addColorStop(1, '#1a1d24')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  const total = Math.max(16, project.length)
  const rows = Math.min(project.tracks.length, 9)
  project.tracks.slice(0, rows).forEach((track, i) => {
    const y = 16 + i * ((h - 32) / Math.max(1, rows))
    const rowH = Math.max(6, (h - 32) / Math.max(1, rows) - 4)
    for (const clip of track.clips) {
      const x = 8 + (clip.start / total) * (w - 16)
      const cw = Math.max(3, (clip.len / total) * (w - 16))
      ctx.fillStyle = track.color
      ctx.globalAlpha = 0.78
      ctx.beginPath()
      ctx.roundRect(x, y, cw, rowH, 2)
      ctx.fill()
      ctx.globalAlpha = 1
    }
  })
  ctx.fillStyle = 'rgba(215,169,81,0.9)'
  ctx.font = 'bold 11px system-ui, sans-serif'
  ctx.fillText('ILS', 10, 12)
  return canvas.toDataURL('image/png')
}
