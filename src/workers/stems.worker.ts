// ---------------------------------------------------------------------------
// Stem separation worker. Runs a frequency + transient mask separator on
// decoded PCM entirely off the main thread. No model download, no network,
// no licence cost: harmonic/percussive split plus centre-channel extraction.
// ---------------------------------------------------------------------------

const SR_DEFAULT = 44100

function biquadCoeffs(type: 'lowpass' | 'highpass' | 'bandpass', sr: number, freq: number, q = 0.707) {
  const w0 = (2 * Math.PI * freq) / sr
  const cos = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * q)
  let b0 = 0
  let b1 = 0
  let b2 = 0
  if (type === 'lowpass') {
    b0 = (1 - cos) / 2
    b1 = 1 - cos
    b2 = (1 - cos) / 2
  } else if (type === 'highpass') {
    b0 = (1 + cos) / 2
    b1 = -(1 + cos)
    b2 = (1 + cos) / 2
  } else {
    b0 = alpha
    b1 = 0
    b2 = -alpha
  }
  const a0 = 1 + alpha
  const a1 = -2 * cos
  const a2 = 1 - alpha
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}

function biquad(input: Float32Array, type: 'lowpass' | 'highpass' | 'bandpass', sr: number, freq: number, q = 0.707) {
  const c = biquadCoeffs(type, sr, freq, q)
  const out = new Float32Array(input.length)
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < input.length; i++) {
    const x = input[i]
    const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2
    x2 = x1
    x1 = x
    y2 = y1
    y1 = y
    out[i] = y
  }
  return out
}

function smoothEnvelope(signal: Float32Array, frame = 512): Float32Array {
  const n = Math.ceil(signal.length / frame)
  const env = new Float32Array(n)
  for (let f = 0; f < n; f++) {
    let sum = 0
    const start = f * frame
    const end = Math.min(signal.length, start + frame)
    for (let i = start; i < end; i++) sum += signal[i] * signal[i]
    env[f] = Math.sqrt(sum / Math.max(1, end - start))
  }
  return env
}

function percussiveMask(env: Float32Array, smooth = 6): Float32Array {
  const n = env.length
  const mask = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let acc = 0
    let count = 0
    for (let j = Math.max(0, i - smooth); j <= Math.min(n - 1, i + smooth); j++) {
      acc += env[j]
      count++
    }
    const avg = acc / Math.max(1, count)
    const ratio = env[i] / (avg + 1e-6)
    mask[i] = Math.max(0, Math.min(1, (ratio - 1.25) * 1.8))
  }
  // Slight temporal spread so we do not chop the attack.
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    out[i] = Math.max(mask[i], mask[i - 1] ?? 0, mask[i + 1] ?? 0)
  }
  return out
}

function applyFrameMask(signal: Float32Array, mask: Float32Array, frame: number, invert = false): Float32Array {
  const out = new Float32Array(signal.length)
  for (let i = 0; i < signal.length; i++) {
    const m = mask[Math.min(mask.length - 1, Math.floor(i / frame))] ?? 0
    out[i] = signal[i] * (invert ? 1 - m : m)
  }
  return out
}

interface StemRequest {
  type: 'separate'
  left: Float32Array
  right: Float32Array
  sampleRate: number
}

self.onmessage = (e: MessageEvent<StemRequest>) => {
  const msg = e.data
  if (msg.type !== 'separate') return
  const sr = msg.sampleRate || SR_DEFAULT
  const left = msg.left
  const right = msg.right
  const n = Math.min(left.length, right.length)
  const mid = new Float32Array(n)
  const side = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    mid[i] = (left[i] + right[i]) * 0.5
    side[i] = (left[i] - right[i]) * 0.5
  }
  const post = (value: number, note: string) => (self as unknown as Worker).postMessage({ type: 'progress', value, note })

  post(0.08, 'Analysing transients')
  const env = smoothEnvelope(mid, 512)
  const perc = percussiveMask(env, 5)
  const percMask = new Float32Array(env.length)
  for (let i = 0; i < env.length; i++) percMask[i] = perc[i]

  post(0.24, 'Splitting drums')
  const drumsMid = applyFrameMask(mid, percMask, 512)
  const drumsSide = applyFrameMask(side, percMask, 512)
  const drumsL = biquad(drumsMid, 'highpass', sr, 90)
  const drumsR = biquad(drumsSide, 'highpass', sr, 400)
  // Combine mid (kick/snare body) and side (stereo hats/cymbals).
  const drums = new Float32Array(n)
  for (let i = 0; i < n; i++) drums[i] = drumsL[i] + drumsR[i] * 0.9

  post(0.44, 'Extracting vocals')
  const harmonic = applyFrameMask(mid, percMask, 512, true)
  const vocalsBand = biquad(harmonic, 'bandpass', sr, 1450, 0.55)
  const vocalsLow = biquad(harmonic, 'highpass', sr, 180)
  const vocals = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const centre = 1 - Math.min(1, Math.abs(side[i]) / (Math.abs(mid[i]) + 1e-5))
    vocals[i] = (vocalsBand[i] * 0.9 + vocalsLow[i] * 0.25) * (0.35 + centre * 0.9)
  }

  post(0.62, 'Isolating bass')
  const bass = biquad(biquad(harmonic, 'lowpass', sr, 130), 'lowpass', sr, 130)

  post(0.78, 'Rendering the residual')
  const other = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    other[i] = mid[i] - drums[i] - vocals[i] - bass[i]
  }

  post(0.9, 'Writing stems')
  const gainMatch = (buf: Float32Array) => {
    let peak = 1e-6
    for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]))
    const g = Math.min(1.8, 0.95 / peak)
    for (let i = 0; i < buf.length; i++) buf[i] *= g
    return buf
  }
  const stems = {
    vocals: gainMatch(vocals),
    drums: gainMatch(drums),
    bass: gainMatch(bass),
    other: gainMatch(other),
  }
  post(1, 'Done')
  ;(self as unknown as Worker).postMessage(
    { type: 'done', sampleRate: sr, stems },
    [stems.vocals.buffer, stems.drums.buffer, stems.bass.buffer, stems.other.buffer],
  )
}

export {}
