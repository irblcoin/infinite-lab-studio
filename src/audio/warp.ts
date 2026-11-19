// ---------------------------------------------------------------------------
// Warp engine: transient detection, tempo detection, WSOLA time-stretching and
// pitch shifting with Ableton-style modes, plus warp markers.
//
// WSOLA (waveform-similarity overlap-add) keeps transients audible at any
// stretch amount; 'beats' uses short frames to keep attacks sharp, 'tones' and
// 'texture' use long frames for smooth sustained material.
// ---------------------------------------------------------------------------

import type { WarpMode, WarpSettings } from '../state/types'

const MODE_FRAME: Record<WarpMode, number> = {
  beats: 1024,
  complex: 2048,
  tones: 4096,
  texture: 8192,
}

function mono(buf: AudioBuffer): Float32Array {
  if (buf.numberOfChannels === 1) return buf.getChannelData(0)
  const n = buf.length
  const out = new Float32Array(n)
  const a = buf.getChannelData(0)
  const b = buf.getChannelData(1)
  for (let i = 0; i < n; i++) out[i] = (a[i] + b[i]) * 0.5
  return out
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/** RMS envelope in 10 ms frames. */
export function energyEnvelope(buf: AudioBuffer): { env: Float32Array; hop: number } {
  const x = mono(buf)
  const hop = Math.max(64, Math.round(buf.sampleRate * 0.01))
  const frames = Math.max(1, Math.floor(x.length / hop))
  const env = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    let sum = 0
    const start = f * hop
    for (let i = 0; i < hop; i++) {
      const v = x[start + i] ?? 0
      sum += v * v
    }
    env[f] = Math.sqrt(sum / hop)
  }
  return { env, hop }
}

/** Onset times in seconds from a spectral-flux style energy derivative. */
export function detectTransients(buf: AudioBuffer, sensitivity = 1): number[] {
  const { env, hop } = energyEnvelope(buf)
  const out: number[] = []
  let avg = 0
  for (let i = 1; i < env.length; i++) avg += Math.abs(env[i] - env[i - 1])
  avg /= Math.max(1, env.length - 1)
  const threshold = Math.max(0.004, avg * 2.2 * sensitivity)
  let last = -1
  for (let i = 2; i < env.length - 2; i++) {
    const rise = env[i] - env[i - 1]
    const local = env[i] - (env[i - 2] + env[i + 2]) * 0.5
    if (rise > threshold && local > threshold * 0.6 && env[i] > 0.006) {
      const t = (i * hop) / buf.sampleRate
      if (last < 0 || t - last > 0.055) {
        out.push(t)
        last = t
      }
    }
  }
  return out
}

/**
 * Tempo estimate from the onset envelope. Uses autocorrelation of the onset
 * strength with a log-normal prior around 110 BPM so the octave is stable.
 */
export function detectBpm(buf: AudioBuffer): number | null {
  const { env, hop } = energyEnvelope(buf)
  if (env.length < 40) return null
  const novelty = new Float32Array(env.length)
  let mean = 0
  for (let i = 1; i < env.length; i++) {
    novelty[i] = Math.max(0, env[i] - env[i - 1])
    mean += novelty[i]
  }
  mean /= novate(env.length)
  if (mean < 1e-5) return null
  for (let i = 0; i < novelty.length; i++) novelty[i] = Math.max(0, novelty[i] - mean * 0.7)

  const frameRate = buf.sampleRate / hop
  const minLag = Math.floor((60 / 190) * frameRate)
  const maxLag = Math.ceil((60 / 55) * frameRate)
  let bestLag = 0
  let best = 0
  for (let lag = minLag; lag <= Math.min(maxLag, novelty.length - 1); lag++) {
    let sum = 0
    for (let i = lag; i < novelty.length; i++) sum += novelty[i] * novelty[i - lag]
    const bpm = (60 * frameRate) / lag
    // octave weighting: prefer 70–160 BPM
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 110) / 0.9, 2))
    const score = sum * prior
    if (score > best) {
      best = score
      bestLag = lag
    }
  }
  if (!bestLag) return null
  return Math.round(((60 * frameRate) / bestLag) * 10) / 10
}

function novate(n: number): number {
  return Math.max(1, n - 1)
}

// ---------------------------------------------------------------------------
// WSOLA
// ---------------------------------------------------------------------------

function wsola(buf: AudioBuffer, ratio: number, mode: WarpMode): AudioBuffer {
  const frame = Math.min(MODE_FRAME[mode], Math.max(256, 1 << Math.floor(Math.log2(buf.length / 4))))
  const hopOut = Math.floor(frame / 2)
  const hopIn = hopOut * ratio
  const outLen = Math.max(1, Math.floor(buf.length / ratio))
  const ctx = new OfflineAudioContext(buf.numberOfChannels, outLen, buf.sampleRate)
  const out = ctx.createBuffer(buf.numberOfChannels, outLen, buf.sampleRate)
  const window = new Float32Array(frame)
  for (let i = 0; i < frame; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (frame - 1))

  const search = Math.round(frame * 0.12)
  const stride = 8 // coarse search stride for speed

  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const src = buf.getChannelData(ch)
    const dst = out.getChannelData(ch)
    let inPos = 0
    for (let outPos = 0; outPos < outLen - 1; outPos += hopOut) {
      const expected = Math.round(outPos * ratio)
      let bestOffset = 0
      if (outPos > 0) {
        let bestScore = -Infinity
        for (let off = -search; off <= search; off += stride) {
          const pos = expected + off
          if (pos < 0 || pos + frame >= src.length) continue
          let score = 0
          // compare against the tail of the previous frame
          for (let i = 0; i < frame / 4; i += 4) score += src[pos + i] * src[Math.max(0, inPos + i)]
          if (score > bestScore) {
            bestScore = score
            bestOffset = off
          }
        }
      }
      inPos = Math.max(0, Math.min(src.length - 1, expected + bestOffset))
      const n = Math.min(frame, outLen - outPos, src.length - inPos)
      for (let i = 0; i < n; i++) {
        const w = window[i] ?? 0
        dst[outPos + i] += (src[inPos + i] ?? 0) * w
      }
    }
  }
  // normalise the overlap-add gain
  let peak = 0
  for (let ch = 0; ch < out.numberOfChannels; ch++) {
    const d = out.getChannelData(ch)
    for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]))
  }
  if (peak > 0.98) {
    const g = 0.98 / peak
    for (let ch = 0; ch < out.numberOfChannels; ch++) {
      const d = out.getChannelData(ch)
      for (let i = 0; i < d.length; i++) d[i] *= g
    }
  }
  return out
}

/** Resample by a playback rate, keeping the sample count proportional. */
function resample(buf: AudioBuffer, rate: number, ctx: BaseAudioContext): AudioBuffer {
  if (Math.abs(rate - 1) < 1e-4) return buf
  const outLen = Math.max(1, Math.floor(buf.length / rate))
  const out = ctx.createBuffer(buf.numberOfChannels, outLen, buf.sampleRate)
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const src = buf.getChannelData(ch)
    const dst = out.getChannelData(ch)
    for (let i = 0; i < outLen; i++) {
      const pos = i * rate
      const i0 = Math.floor(pos)
      const frac = pos - i0
      dst[i] = (src[i0] ?? 0) * (1 - frac) + (src[i0 + 1] ?? 0) * frac
    }
  }
  return out
}

const cache = new WeakMap<AudioBuffer, Map<string, AudioBuffer>>()

/**
 * Stretch (and optionally pitch-shift) an audio buffer.
 * ratio = source duration / target duration (2 = play twice as fast).
 */
export function warpBuffer(
  buf: AudioBuffer,
  ratio: number,
  semitones = 0,
  mode: WarpMode = 'complex',
  ctx?: BaseAudioContext,
): AudioBuffer {
  const r = Math.max(0.25, Math.min(4, ratio))
  const key = `${r.toFixed(4)}|${semitones}|${mode}`
  let perBuffer = cache.get(buf)
  if (!perBuffer) {
    perBuffer = new Map()
    cache.set(buf, perBuffer)
  }
  const hit = perBuffer.get(key)
  if (hit) return hit
  const work = ctx ?? new OfflineAudioContext(1, 1, buf.sampleRate)
  let result: AudioBuffer
  if (Math.abs(semitones) < 0.01 && Math.abs(r - 1) < 0.001) {
    result = buf
  } else {
    const pitchRate = Math.pow(2, semitones / 12)
    // Resampling changes pitch and length together; the WSOLA pass puts the
    // length back, so the two operations compose into a clean pitch shift.
    const shifted = semitones ? resample(buf, pitchRate, work) : buf
    const stretch = r / (semitones ? pitchRate : 1)
    result = Math.abs(stretch - 1) < 0.001 ? shifted : wsola(shifted, stretch, mode)
  }
  perBuffer.set(key, result)
  return result
}

// ---------------------------------------------------------------------------
// Clip-facing API
// ---------------------------------------------------------------------------

export interface WarpRequest {
  projectBpm: number
  clipBeats: number
  warp?: WarpSettings
  semitones?: number
}

/** The stretch ratio needed for this clip to line up with the project tempo. */
export function warpRatio(req: WarpRequest): number {
  const w = req.warp
  if (!w) return 1
  const source = w.sourceBpm && w.sourceBpm > 0 ? w.sourceBpm : null
  let ratio = source ? req.projectBpm / source : 1
  ratio *= w.stretch || 1
  return Math.max(0.25, Math.min(4, ratio))
}

/**
 * Warp an audio buffer for playback: honours the source tempo, the manual
 * stretch and any warp markers (each marker pair becomes its own stretch
 * segment, so a drummer who drifted can be pulled back to the grid).
 */
export function warpForClip(
  buf: AudioBuffer,
  req: WarpRequest,
  ctx: BaseAudioContext,
): { buffer: AudioBuffer; ratio: number } {
  const w = req.warp
  const ratio = warpRatio(req)
  if (!w || !w.enabled) return { buffer: buf, ratio: 1 }
  if (w.markers.length >= 2 && req.clipBeats > 0) {
    const markers = [...w.markers].sort((a, b) => a.beat - b.beat)
    const segments: AudioBuffer[] = []
    for (let i = 0; i < markers.length - 1; i++) {
      const a = markers[i]
      const b = markers[i + 1]
      const segSec = Math.max(0.01, b.sec - a.sec)
      const segBeats = Math.max(0.01, b.beat - a.beat)
      const targetSec = (segBeats * 60) / Math.max(20, req.projectBpm)
      const slice = sliceBuffer(buf, a.sec, segSec, ctx)
      segments.push(warpBuffer(slice, segSec / targetSec, req.semitones ?? 0, w.mode, ctx))
    }
    const total = segments.reduce((n, s) => n + s.length, 0)
    if (total > 0) {
      const out = ctx.createBuffer(buf.numberOfChannels, total, buf.sampleRate)
      for (let ch = 0; ch < out.numberOfChannels; ch++) {
        let at = 0
        for (const seg of segments) {
          out.getChannelData(ch).set(seg.getChannelData(Math.min(ch, seg.numberOfChannels - 1)), at)
          at += seg.length
        }
      }
      return { buffer: out, ratio: out.length / buf.length }
    }
  }
  return { buffer: warpBuffer(buf, ratio, req.semitones ?? 0, w.mode, ctx), ratio }
}

export function sliceBuffer(buf: AudioBuffer, startSec: number, lenSec: number, ctx: BaseAudioContext): AudioBuffer {
  const start = Math.max(0, Math.min(buf.length, Math.floor(startSec * buf.sampleRate)))
  const len = Math.max(1, Math.min(buf.length - start, Math.floor(lenSec * buf.sampleRate)))
  const out = ctx.createBuffer(buf.numberOfChannels, len, buf.sampleRate)
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    out.getChannelData(ch).set(buf.getChannelData(ch).subarray(start, start + len))
  }
  return out
}

/** How many source seconds one project beat occupies after warping. */
export function warpBeatsPerSecond(req: WarpRequest): number {
  return Math.max(20, req.projectBpm) / 60
}
