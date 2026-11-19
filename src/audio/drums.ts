import type { Params } from '../state/types'
import { midiToFreq } from '../state/types'
import { biquad, gainNode, noiseBuffer, percEnv, safeFreq, shaper, distCurve } from './dsp'

export type DrumVoice =
  | 'kick'
  | 'snare'
  | 'clap'
  | 'rim'
  | 'hat'
  | 'ohat'
  | 'tomL'
  | 'tomM'
  | 'tomH'
  | 'crash'
  | 'ride'
  | 'cowbell'
  | 'shaker'
  | 'perc'
  | 'snap'
  | 'sub'

export interface PadDef {
  kind: DrumVoice
  label: string
  key: string
}

/** The 16 pads of the drum machine, in pitch order from C1 (36). */
export const DRUM_PADS: PadDef[] = [
  { kind: 'kick', label: 'Kick', key: '1' },
  { kind: 'snare', label: 'Snare', key: '2' },
  { kind: 'clap', label: 'Clap', key: '3' },
  { kind: 'rim', label: 'Rim', key: '4' },
  { kind: 'hat', label: 'CH', key: 'q' },
  { kind: 'ohat', label: 'OH', key: 'w' },
  { kind: 'tomL', label: 'Tom L', key: 'e' },
  { kind: 'tomM', label: 'Tom M', key: 'r' },
  { kind: 'tomH', label: 'Tom H', key: 't' },
  { kind: 'crash', label: 'Crash', key: 'y' },
  { kind: 'ride', label: 'Ride', key: 'u' },
  { kind: 'cowbell', label: 'Cowbell', key: 'i' },
  { kind: 'shaker', label: 'Shaker', key: 'a' },
  { kind: 'perc', label: 'Perc', key: 's' },
  { kind: 'snap', label: 'Snap', key: 'd' },
  { kind: 'sub', label: 'Sub', key: 'f' },
]

export const DRUM_BASE_PITCH = 36

export function padForPitch(pitch: number): DrumVoice {
  return DRUM_PADS[((pitch - DRUM_BASE_PITCH) % 16 + 16) % 16].kind
}

interface KitStyle {
  kickFreq: number
  kickDecay: number
  snareTone: number
  snap: number
  metal: number
  noiseDecay: number
}

const KITS: KitStyle[] = [
  { kickFreq: 132, kickDecay: 0.36, snareTone: 190, snap: 1, metal: 1, noiseDecay: 0.18 }, // analog
  { kickFreq: 54, kickDecay: 0.95, snareTone: 160, snap: 0.65, metal: 1.15, noiseDecay: 0.22 }, // 808
  { kickFreq: 118, kickDecay: 0.28, snareTone: 210, snap: 1.35, metal: 1.35, noiseDecay: 0.13 }, // 909
  { kickFreq: 96, kickDecay: 0.42, snareTone: 175, snap: 0.9, metal: 0.8, noiseDecay: 0.2 }, // acoustic
]

function noiseHit(
  ctx: BaseAudioContext,
  dest: AudioNode,
  t: number,
  decay: number,
  peak: number,
  filter: BiquadFilterType,
  freq: number,
  q = 1,
): void {
  const src = ctx.createBufferSource()
  src.buffer = noiseBuffer(ctx)
  src.loopStart = 0
  const f = biquad(ctx, filter, safeFreq(freq), q)
  const g = percEnv(ctx, dest, t, decay, peak)
  src.connect(f).connect(g)
  src.start(t, Math.random() * 0.8)
  src.stop(t + decay + 0.1)
  src.onended = () => {
    try {
      src.disconnect()
      f.disconnect()
    } catch {
      /* noop */
    }
  }
}

function tone(
  ctx: BaseAudioContext,
  dest: AudioNode,
  t: number,
  type: OscillatorType,
  f0: number,
  f1: number,
  decay: number,
  peak: number,
  glide = 0.05,
): void {
  const o = ctx.createOscillator()
  o.type = type
  o.frequency.setValueAtTime(safeFreq(f0), t)
  o.frequency.exponentialRampToValueAtTime(safeFreq(f1), t + Math.max(0.005, glide))
  const g = percEnv(ctx, dest, t, decay, peak)
  o.connect(g)
  o.start(t)
  o.stop(t + decay + 0.1)
  o.onended = () => {
    try {
      o.disconnect()
    } catch {
      /* noop */
    }
  }
}

/** Synthesize one drum hit into `dest` at audio-context time `t`. */
export function playDrum(
  ctx: BaseAudioContext,
  dest: AudioNode,
  kind: DrumVoice,
  t: number,
  vel: number,
  params: Params = {},
): void {
  const kitIdx = Math.max(0, Math.min(3, Math.round(params.kit ?? 0)))
  const kit = KITS[kitIdx]
  const tune = Math.pow(2, (params.tune ?? 0) / 12)
  const dscale = Math.max(0.35, params.decay ?? 1)
  const toneCtl = params.tone ?? 0
  const snap = (params.snap ?? 0.4) * kit.snap
  const out = gainNode(ctx, Math.max(0, vel) * (params.gain ?? 1))
  // Per-pad insert chain (Drum Rack): filter → drive → pan → destination.
  let bus: AudioNode = out
  const padCutoff = params._cutoff ?? 0
  if (padCutoff > 0) {
    const f = biquad(ctx, 'lowpass', Math.max(60, padCutoff), 0.9)
    bus.connect(f)
    bus = f
  }
  const padDrive = params._drive ?? 0
  if (padDrive > 0) {
    const ws = ctx.createWaveShaper()
    ws.curve = distCurve(Math.max(0, Math.min(60, padDrive * 40)))
    ws.oversample = '2x'
    bus.connect(ws)
    bus = ws
  }
  const pan = params._pan ?? 0
  if (pan !== 0) {
    const pn = ctx.createStereoPanner()
    pn.pan.value = Math.max(-1, Math.min(1, pan))
    bus.connect(pn)
    bus = pn
  }
  bus.connect(dest)

  switch (kind) {
    case 'kick': {
      const base = kit.kickFreq * tune * (1 + toneCtl * 0.12)
      const o = ctx.createOscillator()
      o.type = 'sine'
      o.frequency.setValueAtTime(safeFreq(base * (kitIdx === 1 ? 3.2 : 4.4)), t)
      o.frequency.exponentialRampToValueAtTime(safeFreq(base), t + 0.055)
      o.frequency.exponentialRampToValueAtTime(safeFreq(base * 0.86), t + 0.2)
      const g = percEnv(ctx, out, t, kit.kickDecay * dscale, 1.0, 0.004)
      o.connect(g)
      o.start(t)
      o.stop(t + kit.kickDecay * dscale + 0.1)
      const click = ctx.createBufferSource()
      click.buffer = noiseBuffer(ctx)
      const hp = biquad(ctx, 'highpass', 1800 + toneCtl * 2000, 0.7)
      const cg = percEnv(ctx, out, t, 0.018, 0.32 * snap + 0.05, 0.001)
      click.connect(hp).connect(cg)
      click.start(t, Math.random() * 0.5)
      click.stop(t + 0.05)
      break
    }
    case 'snare': {
      noiseHit(ctx, out, t, kit.noiseDecay * dscale + 0.05, 0.5 * (0.6 + snap * 0.6), 'bandpass', 1700 + toneCtl * 1200, 0.8)
      tone(ctx, out, t, 'triangle', kit.snareTone * tune * 1.8, kit.snareTone * tune, 0.11 * dscale, 0.5, 0.05)
      break
    }
    case 'clap': {
      for (let i = 0; i < 4; i++) {
        noiseHit(ctx, out, t + i * 0.009, 0.085 + i * 0.012, 0.34 + i * 0.05, 'bandpass', 1050 + toneCtl * 600, 1.6)
      }
      break
    }
    case 'rim': {
      noiseHit(ctx, out, t, 0.028, 0.35, 'highpass', 2600, 0.9)
      tone(ctx, out, t, 'square', 1850 * tune, 1600 * tune, 0.026, 0.16, 0.01)
      break
    }
    case 'hat': {
      noiseHit(ctx, out, t, 0.042 * dscale, 0.3, 'highpass', 7200 * kit.metal, 0.9)
      noiseHit(ctx, out, t, 0.03, 0.12, 'bandpass', 11000, 2)
      break
    }
    case 'ohat': {
      noiseHit(ctx, out, t, 0.34 * dscale, 0.26, 'highpass', 6800 * kit.metal, 0.8)
      break
    }
    case 'crash': {
      noiseHit(ctx, out, t, 1.25 * dscale, 0.22, 'highpass', 3800, 0.6)
      noiseHit(ctx, out, t, 0.9 * dscale, 0.1, 'bandpass', 7200, 1.2)
      break
    }
    case 'ride': {
      noiseHit(ctx, out, t, 0.8 * dscale, 0.16, 'bandpass', 6200, 1.5)
      tone(ctx, out, t, 'square', 3150 * tune, 3050 * tune, 0.5 * dscale, 0.05, 0.02)
      break
    }
    case 'cowbell': {
      const g = percEnv(ctx, out, t, 0.19 * dscale, 0.2, 0.001)
      for (const f of [562, 846]) {
        const o = ctx.createOscillator()
        o.type = 'square'
        o.frequency.value = safeFreq(f * tune)
        o.connect(g)
        o.start(t)
        o.stop(t + 0.4)
      }
      break
    }
    case 'shaker': {
      noiseHit(ctx, out, t, 0.075 * dscale, 0.22, 'bandpass', 6400, 1.8)
      break
    }
    case 'perc': {
      tone(ctx, out, t, 'sine', 520 * tune, 300 * tune, 0.13 * dscale, 0.42, 0.04)
      noiseHit(ctx, out, t, 0.02, 0.1, 'highpass', 3000, 1)
      break
    }
    case 'snap': {
      noiseHit(ctx, out, t, 0.03, 0.34, 'bandpass', 2400, 2)
      noiseHit(ctx, out, t + 0.014, 0.04, 0.26, 'bandpass', 1900, 2)
      break
    }
    case 'sub': {
      tone(ctx, out, t, 'sine', 62 * tune, 42 * tune, 0.7 * dscale, 0.8, 0.08)
      break
    }
    case 'tomL':
    case 'tomM':
    case 'tomH':
    default: {
      const base = (kind === 'tomL' ? 110 : kind === 'tomM' ? 155 : 210) * tune
      tone(ctx, out, t, 'sine', base * 1.6, base, 0.32 * dscale, 0.6, 0.09)
      noiseHit(ctx, out, t, 0.04, 0.08, 'bandpass', base * 3, 1)
      break
    }
  }
}

export interface DrumOneShotSpec {
  kind: DrumVoice
  kit: number
  tune: number
  decay: number
  tone: number
  snap: number
  drive: number
}

/** Render a one-bar-friendly one-shot to an AudioBuffer (used by the library). */
export async function renderDrumOneShot(spec: DrumOneShotSpec, sampleRate = 44100): Promise<AudioBuffer> {
  const seconds = 1.6
  const ctx = new OfflineAudioContext(2, Math.ceil(sampleRate * seconds), sampleRate)
  const master = ctx.createGain()
  master.gain.value = 0.9
  const drive = ctx.createWaveShaper()
  if (spec.drive > 0.01) {
    drive.curve = distCurve(1 + spec.drive * 14)
    master.connect(drive).connect(ctx.destination)
  } else {
    master.connect(ctx.destination)
  }
  playDrum(ctx, master, spec.kind, 0.01, 0.95, {
    kit: spec.kit,
    tune: spec.tune,
    decay: spec.decay,
    tone: spec.tone,
    snap: spec.snap,
    gain: 1,
  })
  return ctx.startRendering()
}

/** Note pitch helpers for sampler / instrument library previews. */
export function noteFreq(pitch: number): number {
  return midiToFreq(pitch)
}

export function shaperCurve(amount: number) {
  return distCurve(amount)
}
