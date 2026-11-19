// ---------------------------------------------------------------------------
// Mastering assistant: measures the rendered mix, proposes an EQ / glue /
// width / limiter plan for a loudness target, applies it and keeps an A/B.
// ---------------------------------------------------------------------------

import type { MasterChain, Project } from '../state/types'
import { commit, getState, setUi, toast } from '../state/store'
import { renderProject } from './render'
import { engine } from './engine'

export interface MixAnalysis {
  lufs: number
  peakDb: number
  rmsDb: number
  crestDb: number
  lowDb: number
  midDb: number
  highDb: number
  width: number
  duration: number
}

function db(v: number): number {
  return 20 * Math.log10(Math.max(1e-9, v))
}

function biquadRun(input: Float32Array, sr: number, type: 'lowpass' | 'highpass', freq: number, q = 0.707): Float32Array {
  const w0 = (2 * Math.PI * freq) / sr
  const cos = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * q)
  const b0 = type === 'lowpass' ? (1 - cos) / 2 : (1 + cos) / 2
  const b1 = type === 'lowpass' ? 1 - cos : -(1 + cos)
  const b2 = b0
  const a0 = 1 + alpha
  const a1 = -2 * cos
  const a2 = 1 - alpha
  const out = new Float32Array(input.length)
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < input.length; i++) {
    const x = input[i]
    const y = (b0 / a0) * x + (b1 / a0) * x1 + (b2 / a0) * x2 - (a1 / a0) * y1 - (a2 / a0) * y2
    x2 = x1
    x1 = x
    y2 = y1
    y1 = y
    out[i] = y
  }
  return out
}

function rmsOf(samples: Float32Array): number {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / Math.max(1, samples.length))
}

/** Approximate integrated loudness (K-weighted, gated) without a library. */
export function analyzeMix(buffer: AudioBuffer): MixAnalysis {
  const sr = buffer.sampleRate
  const left = buffer.getChannelData(0)
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left
  const mono = new Float32Array(left.length)
  let peak = 0
  let sideEnergy = 0
  let midEnergy = 0
  for (let i = 0; i < left.length; i++) {
    const m = (left[i] + right[i]) * 0.5
    const s = (left[i] - right[i]) * 0.5
    mono[i] = m
    midEnergy += m * m
    sideEnergy += s * s
    peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]))
  }
  const weighted = biquadRun(biquadRun(mono, sr, 'highpass', 90), sr, 'highpass', 1800)
  // Gated block loudness: 400 ms blocks, skip blocks 20 dB below the mean.
  const block = Math.max(256, Math.round(sr * 0.4))
  const powers: number[] = []
  for (let start = 0; start + block <= weighted.length; start += block) {
    let sum = 0
    for (let i = start; i < start + block; i++) sum += weighted[i] * weighted[i]
    powers.push(sum / block)
  }
  const mean = powers.reduce((a, b) => a + b, 0) / Math.max(1, powers.length)
  const gate = mean * 0.01
  let sum = 0
  let count = 0
  for (const p of powers) {
    if (p >= gate) {
      sum += p
      count++
    }
  }
  const meanPower = count ? sum / count : mean
  const lufs = -0.691 + 10 * Math.log10(Math.max(1e-12, meanPower))

  const low = biquadRun(mono, sr, 'lowpass', 180)
  const high = biquadRun(biquadRun(mono, sr, 'highpass', 6000), sr, 'highpass', 6000)
  const midAll = biquadRun(mono, sr, 'highpass', 180)
  const mid = biquadRun(midAll, sr, 'lowpass', 6000)
  const lowRms = rmsOf(low)
  const midRms = rmsOf(mid)
  const highRms = rmsOf(high)
  const total = rmsOf(mono) + 1e-9
  return {
    lufs: Math.round(lufs * 10) / 10,
    peakDb: Math.round(db(peak) * 10) / 10,
    rmsDb: Math.round(db(total) * 10) / 10,
    crestDb: Math.round((db(peak) - db(total)) * 10) / 10,
    lowDb: Math.round(db(lowRms / total) * 10) / 10,
    midDb: Math.round(db(midRms / total) * 10) / 10,
    highDb: Math.round(db(highRms / total) * 10) / 10,
    width: Math.round(Math.sqrt(sideEnergy / Math.max(1e-9, midEnergy)) * 100) / 100,
    duration: buffer.duration,
  }
}

export interface MasteringPlan {
  target: number
  gainDb: number
  eq: { low: number; mid: number; high: number }
  width: number
  glue: boolean
  limiter: boolean
  ceiling: number
  predictedLufs: number
  notes: string[]
}

/** Turn measurements into a conservative mastering move. */
export function masteringPlan(a: MixAnalysis, target = -14): MasteringPlan {
  const notes: string[] = []
  const gainDb = Math.max(-12, Math.min(18, Math.round((target - a.lufs) * 10) / 10))
  if (gainDb > 6) notes.push('The mix is quiet — most of the move is gain, not compression.')
  if (gainDb < -3) notes.push('The mix is already loud — the limiter will do light safety work only.')

  const low = a.lowDb > -12 ? -1.6 : a.lowDb < -24 ? 1.4 : 0
  const mid = a.midDb < -18 ? 0.8 : 0
  const high = a.highDb < -22 ? 1.4 : a.highDb > -12 ? -1.2 : 0
  if (low < 0) notes.push('Low end is heavy — small shelf cut keeps the limiter from pumping.')
  if (high > 0) notes.push('Air is dull — a gentle high shelf opens it up.')
  if (high < 0) notes.push('Harsh top — a shelf cut tames cymbals and sibilance.')

  const width = a.width < 0.12 ? 1.35 : a.width > 0.65 ? 0.82 : 1
  if (width > 1) notes.push('The mix is narrow — width matrix opens the stereo image.')
  if (width < 1) notes.push('Wide but unstable — narrowing keeps mono compatibility.')

  const predictedLufs = Math.round((a.lufs + gainDb - (a.crestDb > 12 ? 0.8 : 0.3)) * 10) / 10
  return {
    target,
    gainDb,
    eq: { low, mid, high },
    width,
    glue: a.crestDb > 9,
    limiter: true,
    ceiling: -1,
    predictedLufs,
    notes: notes.length ? notes : ['Balanced mix — gentle glue and a transparent limiter.'],
  }
}

export async function analyzeProjectMix(loopOnly = false): Promise<{ analysis: MixAnalysis; buffer: AudioBuffer }> {
  const { project } = getState()
  const opts = loopOnly
    ? { startBeat: project.loop.start, endBeat: project.loop.end, masterLimiter: false, bypassMaster: true }
    : { masterLimiter: false, bypassMaster: true }
  const buffer = await renderProject(project, opts)
  return { analysis: analyzeMix(buffer), buffer }
}

export function applyMastering(plan: MasteringPlan, on = true): void {
  const chain: MasterChain = {
    glue: on && plan.glue,
    eq: on && (plan.eq.low !== 0 || plan.eq.mid !== 0 || plan.eq.high !== 0),
    limiter: on && plan.limiter,
    target: plan.target,
    eqGains: plan.eq,
    width: plan.width,
    gainDb: plan.gainDb,
    ceiling: plan.ceiling,
  }
  const project = getState().project
  commit(on ? 'Apply mastering' : 'Bypass mastering', (p) => {
    p.masterChain = chain
    p.master.limiterOn = chain.limiter
    p.master.volume = Math.max(0, Math.min(1.5, project.master.volume * Math.pow(10, (on ? plan.gainDb : 0) / 20)))
    p.master.ceiling = on ? plan.ceiling : project.master.ceiling
  })
  engine.setMasterChain(chain)
  toast(on ? `Mastering applied — aim ${plan.target} LUFS` : 'Mastering bypassed (A/B before)', 'ok')
}

export function storePlanForAB(plan: MasteringPlan): void {
  try {
    sessionStorage.setItem('ils.masterPlan', JSON.stringify(plan))
  } catch {
    /* storage disabled */
  }
}

export function loadPlanForAB(): MasteringPlan | null {
  try {
    const raw = sessionStorage.getItem('ils.masterPlan')
    return raw ? (JSON.parse(raw) as MasteringPlan) : null
  } catch {
    return null
  }
}

export function openMastering(): void {
  setUi({ modal: 'mastering' })
}

export function bypassMastering(): void {
  const chain: MasterChain = { glue: false, eq: false, limiter: false, target: getState().project.masterChain?.target ?? -14 }
  commit('Mastering bypass', (p) => {
    p.masterChain = chain
    p.master.limiterOn = false
  })
  engine.setMasterChain(chain)
}

export type { Project }
