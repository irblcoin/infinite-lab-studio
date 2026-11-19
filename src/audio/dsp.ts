// Low level DSP helpers shared by every instrument and effect.

const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>()

export function noiseBuffer(ctx: BaseAudioContext, seconds = 2): AudioBuffer {
  const cached = noiseCache.get(ctx)
  if (cached) return cached
  const len = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
  noiseCache.set(ctx, buf)
  return buf
}

const reverseCache = new WeakMap<AudioBuffer, AudioBuffer>()

export function reversedBuffer(ctx: BaseAudioContext, buf: AudioBuffer): AudioBuffer {
  const hit = reverseCache.get(buf)
  if (hit) return hit
  const out = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate)
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const src = buf.getChannelData(c)
    const dst = out.getChannelData(c)
    for (let i = 0; i < src.length; i++) dst[i] = src[src.length - 1 - i]
  }
  reverseCache.set(buf, out)
  return out
}

/** Procedural room impulse: shaped noise burst with progressive damping. */
export function impulseResponse(
  ctx: BaseAudioContext,
  decay: number,
  damp: number,
  size: number,
): AudioBuffer {
  const rate = ctx.sampleRate
  const seconds = Math.max(0.25, decay)
  const len = Math.max(512, Math.floor(rate * seconds))
  const buf = ctx.createBuffer(2, len, rate)
  const curve = 2.6 + damp * 4
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c)
    let lp = 0
    const coef = 0.12 + (1 - damp) * 0.75
    const preDelay = Math.floor(size * 0.02 * rate * (c === 0 ? 1 : 1.12))
    for (let i = 0; i < len; i++) {
      const n = Math.random() * 2 - 1
      lp += (n - lp) * coef
      const t = i / len
      const env = Math.pow(1 - t, curve)
      d[i] = i < preDelay ? 0 : lp * env * (0.85 - c * 0.08)
    }
    // early reflections
    for (let k = 1; k <= 6; k++) {
      const idx = Math.floor(preDelay + (size * 0.055 * k + Math.random() * 0.01) * rate)
      if (idx < len) d[idx] += (0.5 - k * 0.06) * (Math.random() > 0.5 ? 1 : -1)
    }
  }
  return buf
}

export function distCurve(amount: number, bias = 0) {
  const n = 2048
  const curve = new Float32Array(n)
  const k = Math.max(0.0001, amount)
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1 + bias
    curve[i] = Math.tanh(x * k) / Math.tanh(k)
  }
  return curve
}

export function crushCurve(bits: number) {
  const n = 4096
  const curve = new Float32Array(n)
  const steps = Math.pow(2, Math.max(1, Math.min(16, bits)))
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    curve[i] = Math.round(x * steps) / steps
  }
  return curve
}

export function gateCurve(thresholdDb: number) {
  const n = 4096
  const curve = new Float32Array(n)
  const thr = Math.pow(10, thresholdDb / 20)
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    const a = Math.abs(x)
    const y = a <= thr ? 0 : (a - thr) / (1 - thr)
    curve[i] = Math.sign(x) * Math.min(1, y)
  }
  return curve
}

export interface EnvHandle {
  gain: GainNode
  stopAt: number
}

/**
 * ADSR amplitude envelope. Attack/decay are squeezed for short notes so the
 * release never fights the attack ramp.
 */
export function ampEnv(
  ctx: BaseAudioContext,
  dest: AudioNode,
  t: number,
  dur: number,
  a: number,
  d: number,
  s: number,
  r: number,
  peak: number,
): EnvHandle {
  const g = ctx.createGain()
  const A = Math.max(0.002, Math.min(a, Math.max(0.02, dur * 0.5)))
  const D = Math.max(0.004, Math.min(d, Math.max(0.02, dur - A)))
  const sus = Math.max(0.0001, Math.min(1, s))
  const R = Math.max(0.02, r)
  const p = Math.max(0.0001, peak)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.linearRampToValueAtTime(p, t + A)
  g.gain.linearRampToValueAtTime(Math.max(0.0001, p * sus), t + A + D)
  const relStart = Math.max(t + dur, t + A + D)
  g.gain.setValueAtTime(Math.max(0.0001, p * sus), relStart)
  g.gain.exponentialRampToValueAtTime(0.0001, relStart + R)
  g.gain.setValueAtTime(0, relStart + R + 0.001)
  g.connect(dest)
  return { gain: g, stopAt: relStart + R + 0.02 }
}

/** Percussive envelope: instant attack, exponential tail. */
export function percEnv(
  ctx: BaseAudioContext,
  dest: AudioNode,
  t: number,
  decay: number,
  peak: number,
  attack = 0.002,
): GainNode {
  const g = ctx.createGain()
  const A = Math.max(0.0005, attack)
  const D = Math.max(0.01, decay)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + A)
  g.gain.exponentialRampToValueAtTime(0.0001, t + A + D)
  g.gain.setValueAtTime(0, t + A + D + 0.005)
  g.connect(dest)
  return g
}

export function osc(
  ctx: BaseAudioContext,
  type: OscillatorType,
  freq: number,
  detune = 0,
): OscillatorNode {
  const o = ctx.createOscillator()
  o.type = type
  o.frequency.value = freq
  o.detune.value = detune
  return o
}

export function biquad(
  ctx: BaseAudioContext,
  type: BiquadFilterType,
  freq: number,
  q = 1,
  gain = 0,
): BiquadFilterNode {
  const f = ctx.createBiquadFilter()
  f.type = type
  f.frequency.value = freq
  f.Q.value = q
  f.gain.value = gain
  return f
}

export function shaper(ctx: BaseAudioContext, curve: Float32Array<ArrayBuffer>): WaveShaperNode {
  const ws = ctx.createWaveShaper()
  ws.curve = curve
  ws.oversample = '4x'
  return ws
}

export function gainNode(ctx: BaseAudioContext, value = 1): GainNode {
  const g = ctx.createGain()
  g.gain.value = value
  return g
}

export function startStop(node: AudioScheduledSourceNode, t: number, stopAt: number): void {
  const end = Math.max(t, stopAt)
  try {
    node.start(t)
    node.stop(end)
  } catch {
    /* already started */
  }
}

export function safeFreq(f: number): number {
  return Math.max(8, Math.min(20000, f))
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20)
}

export function gainToDb(g: number): number {
  return 20 * Math.log10(Math.max(0.000001, g))
}

export const WAVE_TYPES: OscillatorType[] = ['sine', 'sawtooth', 'square', 'triangle']

export function waveAt(i: number): OscillatorType {
  return WAVE_TYPES[Math.max(0, Math.min(3, Math.round(i)))]
}
