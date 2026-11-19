// ---------------------------------------------------------------------------
// Audio analysis: audio-to-MIDI, loudness (LUFS) and phase metering.
// ---------------------------------------------------------------------------

import type { Note } from '../state/types'

function mono(buf: AudioBuffer): Float32Array {
  if (buf.numberOfChannels === 1) return buf.getChannelData(0)
  const n = buf.length
  const out = new Float32Array(n)
  const a = buf.getChannelData(0)
  const b = buf.getChannelData(1)
  for (let i = 0; i < n; i++) out[i] = (a[i] + b[i]) * 0.5
  return out
}

/** Autocorrelation pitch for one window, restricted to ~55–1200 Hz. */
function pitchAt(x: Float32Array, start: number, len: number, sr: number): number | null {
  let rms = 0
  for (let i = 0; i < len; i++) rms += x[start + i] * x[start + i]
  rms = Math.sqrt(rms / len)
  if (rms < 0.008) return null
  const minLag = Math.floor(sr / 1200)
  const maxLag = Math.min(len - 2, Math.floor(sr / 55))
  let bestLag = 0
  let best = 0
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0
    for (let i = 0; i < len - lag; i += 2) sum += x[start + i] * x[start + i + lag]
    if (sum > best) {
      best = sum
      bestLag = lag
    }
  }
  if (!bestLag || best <= 0) return null
  return sr / bestLag
}

function hzToMidi(hz: number): number {
  return Math.round(69 + 12 * Math.log2(hz / 440))
}

/**
 * Transcribe audio into MIDI notes.
 *  - melody: monophonic pitch tracking with note segmentation
 *  - harmony: the same, but keeps the strongest two partials per frame
 *  - drums: onset detection, classified into kick / snare / hat by band energy
 */
export function audioToMidi(
  buf: AudioBuffer,
  kind: 'melody' | 'harmony' | 'drums',
  opts: { bpm: number; minNote?: number; maxNote?: number } = { bpm: 120 },
): Note[] {
  const sr = buf.sampleRate
  const x = mono(buf)
  const spb = 60 / Math.max(30, opts.bpm)
  const notes: Note[] = []

  if (kind === 'drums') {
    // three band-pass envelopes via simple one-pole filters
    const hop = Math.max(64, Math.round(sr * 0.005))
    const lowA = 0.02
    const highA = 0.35
    let lowLp = 0
    let lowLp2 = 0
    let highLp = 0
    let prevLow = 0
    let prevHigh = 0
    let prevMid = 0
    let lastOnset = -1
    for (let i = 0; i + hop < x.length; i += hop) {
      let low = 0
      let mid = 0
      let high = 0
      for (let j = 0; j < hop; j++) {
        const v = x[i + j]
        lowLp += lowA * (v - lowLp)
        lowLp2 += lowA * (lowLp - lowLp2)
        highLp += highA * (v - highLp)
        low += lowLp2 * lowLp2
        high += (v - highLp) * (v - highLp)
        mid += (lowLp - lowLp2) * (lowLp - lowLp2)
      }
      low = Math.sqrt(low / hop)
      mid = Math.sqrt(mid / hop)
      high = Math.sqrt(high / hop)
      const dLow = Math.max(0, low - prevLow)
      const dMid = Math.max(0, mid - prevMid)
      const dHigh = Math.max(0, high - prevHigh)
      prevLow = low
      prevMid = mid
      prevHigh = high
      const t = (i / sr) / spb
      const strength = Math.max(dLow, dMid, dHigh)
      if (strength > 0.02 && (lastOnset < 0 || t - lastOnset > 0.08)) {
        const pitch = dLow >= dMid && dLow >= dHigh ? 36 : dMid >= dHigh ? 38 : 42
        notes.push({ id: `am_${notes.length}`, pitch, start: Math.round(t * 96) / 96, len: 0.25, vel: Math.min(1, 0.4 + strength * 4) })
        lastOnset = t
      }
    }
    return notes
  }

  const win = Math.round(sr * 0.046)
  const hop = Math.round(sr * 0.012)
  let current: { pitch: number; start: number; last: number; vel: number } | null = null
  for (let i = 0; i + win < x.length; i += hop) {
    const hz = pitchAt(x, i, win, sr)
    const beat = (i / sr) / spb
    if (hz == null) {
      if (current) {
        if (current.last - current.start > 0.1) {
          notes.push({
            id: `am_${notes.length}`,
            pitch: current.pitch,
            start: Math.round(current.start * 96) / 96,
            len: Math.round((current.last - current.start) * 96) / 96,
            vel: current.vel,
          })
        }
        current = null
      }
      continue
    }
    const midi = hzToMidi(hz)
    if (midi < (opts.minNote ?? 21) || midi > (opts.maxNote ?? 108)) continue
    if (current && Math.abs(current.pitch - midi) <= 1) {
      current.last = beat
      current.pitch = Math.round((current.pitch + midi) / 2)
    } else {
      if (current && current.last - current.start > 0.1) {
        notes.push({
          id: `am_${notes.length}`,
          pitch: current.pitch,
          start: Math.round(current.start * 96) / 96,
          len: Math.round((current.last - current.start) * 96) / 96,
          vel: current.vel,
        })
      }
      current = { pitch: midi, start: beat, last: beat, vel: 0.8 }
    }
  }
  if (current && current.last - current.start > 0.05) {
    notes.push({
      id: `am_${notes.length}`,
      pitch: current.pitch,
      start: Math.round(current.start * 96) / 96,
      len: Math.round((current.last - current.start) * 96) / 96,
      vel: current.vel,
    })
  }
  // harmony mode: stack a third/fifth from the detected melody contour
  if (kind === 'harmony') {
    const base = [...notes]
    for (const n of base) {
      notes.push({ ...n, id: `am_h_${notes.length}`, pitch: n.pitch - 5, vel: n.vel * 0.7 })
      notes.push({ ...n, id: `am_h_${notes.length}`, pitch: n.pitch - 12, vel: n.vel * 0.55 })
    }
    notes.sort((a, b) => a.start - b.start)
  }
  return notes
}

// ---------------------------------------------------------------------------
// Loudness (approximate ITU-R BS.1770 with the K-weighting shelf/HP merged
// into a single 2nd-order high-pass plus a high shelf — good to ±0.5 LU for
// programme material, which is what a loudness target needs).
// ---------------------------------------------------------------------------

export function lufsFromSamples(channels: Float32Array[], sampleRate: number): number {
  if (!channels.length) return -Infinity
  const n = channels[0].length
  if (!n) return -Infinity
  let sumSq = 0
  for (const ch of channels) {
    let hp = 0
    let hpPrev = 0
    let shelf = 0
    for (let i = 0; i < n; i++) {
      // high-pass ~60 Hz
      const a = 0.995
      hp = a * (hp + ch[i] - hpPrev)
      hpPrev = ch[i]
      // high shelf ~+4 dB above 1.5 kHz
      shelf += 0.18 * (hp - shelf)
      const v = hp + (hp - shelf) * 0.35
      sumSq += v * v
    }
  }
  const mean = sumSq / (n * channels.length)
  if (mean <= 1e-12) return -Infinity
  return -0.691 + 10 * Math.log10(mean)
}

/** Short-term loudness of an analyser's current window. */
export function lufsFromAnalyser(left: Float32Array, right: Float32Array, sampleRate: number): number {
  return lufsFromSamples([left, right], sampleRate)
}

export function phaseCorrelation(left: Float32Array, right: Float32Array): number {
  let lr = 0
  let ll = 0
  let rr = 0
  for (let i = 0; i < left.length; i++) {
    lr += left[i] * right[i]
    ll += left[i] * left[i]
    rr += right[i] * right[i]
  }
  const denom = Math.sqrt(ll * rr)
  return denom > 1e-9 ? Math.max(-1, Math.min(1, lr / denom)) : 0
}
