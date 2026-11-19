import type { DeviceType, Params } from '../state/types'
import { midiToFreq } from '../state/types'
import {
  ampEnv,
  biquad,
  gainNode,
  noiseBuffer,
  percEnv,
  reversedBuffer,
  safeFreq,
  shaper,
  distCurve,
  waveAt,
} from './dsp'
import { DRUM_PADS, playDrum } from './drums'
import { defaultParams } from '../data/deviceDefs'
import { getPatch, loadSampleBuffer, patchHasAudio, playPatch, type Patch } from './patch'

export interface PlayNoteOpts {
  ctx: BaseAudioContext
  type: DeviceType
  params: Params
  dest: AudioNode
  time: number
  dur: number
  pitch: number
  vel: number
  buffer?: AudioBuffer | null
  /** Multisample patch for the sampler device. */
  samplerId?: string
}

function driveNode(ctx: BaseAudioContext, amount: number): WaveShaperNode | null {
  if (amount <= 0.01) return null
  return shaper(ctx, distCurve(1 + amount * 18))
}

function stopAll(nodes: AudioScheduledSourceNode[], t: number): void {
  for (const n of nodes) {
    try {
      n.stop(t)
    } catch {
      /* ignore */
    }
  }
}

function playSynth(o: PlayNoteOpts): void {
  const { ctx, params: p, dest, time: t, dur, pitch, vel } = o
  const f = midiToFreq(pitch)
  const amp = ampEnv(ctx, dest, t, dur, p.attack, p.decay, p.sustain, p.release, 0.55 * vel)
  const filt = biquad(ctx, p.ftype === 1 ? 'highpass' : p.ftype === 2 ? 'bandpass' : 'lowpass', 400, Math.max(0.3, p.res))
  const dr = driveNode(ctx, p.drive)
  if (dr) filt.connect(dr).connect(amp.gain)
  else filt.connect(amp.gain)
  const base = safeFreq(p.cutoff)
  const peak = safeFreq(base * (1 + p.fenv * 9))
  filt.frequency.setValueAtTime(peak, t)
  filt.frequency.exponentialRampToValueAtTime(base, t + Math.max(0.02, p.decay))
  const mix = Math.max(0, Math.min(1, p.mix))
  const oscs: OscillatorNode[] = []
  const a = ctx.createOscillator()
  a.type = waveAt(p.osc)
  a.frequency.value = f
  const ga = gainNode(ctx, 0.5 * (1 - mix * 0.5))
  a.connect(ga).connect(filt)
  oscs.push(a)
  const b = ctx.createOscillator()
  b.type = waveAt(p.osc2)
  b.frequency.value = f
  b.detune.value = p.detune
  const gb = gainNode(ctx, 0.45 * mix + 0.06)
  b.connect(gb).connect(filt)
  oscs.push(b)
  if (p.sub > 0.01) {
    const s = ctx.createOscillator()
    s.type = 'sine'
    s.frequency.value = f / 2
    const gs = gainNode(ctx, 0.4 * p.sub)
    s.connect(gs).connect(filt)
    oscs.push(s)
  }
  if (p.lfoAmt > 0.01) {
    const lfo = ctx.createOscillator()
    lfo.type = 'sine'
    lfo.frequency.value = Math.max(0.02, p.lfoRate)
    const lg = gainNode(ctx, 0)
    lfo.connect(lg)
    if (p.lfoTarget === 0) {
      lg.gain.value = p.lfoAmt * 22
      for (const x of oscs) lg.connect(x.detune)
    } else if (p.lfoTarget === 1) {
      lg.gain.value = p.lfoAmt * base * 4
      lg.connect(filt.frequency)
    } else {
      lg.gain.value = p.lfoAmt * 0.18
      lg.connect(amp.gain)
    }
    lfo.start(t)
    oscs.push(lfo)
  }
  for (const x of oscs) x.start(t)
  stopAll(oscs, amp.stopAt)
}

function playFM(o: PlayNoteOpts): void {
  const { ctx, params: p, dest, time: t, dur, pitch, vel } = o
  const f = midiToFreq(pitch)
  const amp = ampEnv(ctx, dest, t, dur, p.attack, p.decay, p.sustain, p.release, 0.5 * vel)
  const lp = biquad(ctx, 'lowpass', safeFreq(p.tone), 0.7)
  lp.connect(amp.gain)
  const carrier = ctx.createOscillator()
  carrier.type = 'sine'
  carrier.frequency.value = f
  const mod = ctx.createOscillator()
  mod.type = 'sine'
  mod.frequency.value = f * Math.max(0.05, p.ratio)
  mod.detune.value = p.detune
  const modGain = gainNode(ctx, 0)
  const idx = Math.max(0.001, p.index) * f * (0.4 + vel * p.vel)
  modGain.gain.setValueAtTime(idx, t)
  modGain.gain.exponentialRampToValueAtTime(Math.max(1, idx * 0.12), t + Math.max(0.05, p.decay * 1.4))
  mod.connect(modGain).connect(carrier.frequency)
  carrier.connect(lp)
  const harm = ctx.createOscillator()
  harm.type = 'sine'
  harm.frequency.value = f * 2
  const hg = gainNode(ctx, 0.1)
  harm.connect(hg).connect(lp)
  carrier.start(t)
  mod.start(t)
  harm.start(t)
  stopAll([carrier, mod, harm], amp.stopAt)
}

function playKeys(o: PlayNoteOpts): void {
  const { ctx, params: p, dest, time: t, dur, pitch, vel } = o
  const f = midiToFreq(pitch)
  const amp = ampEnv(ctx, dest, t, dur, p.attack, Math.max(0.2, p.decay), p.sustain, p.release, 0.42 * vel)
  const trem = gainNode(ctx, 1)
  const tremOsc = ctx.createOscillator()
  tremOsc.type = 'sine'
  tremOsc.frequency.value = Math.max(0.1, p.tremRate)
  const tremDepth = gainNode(ctx, p.tremolo * 0.45)
  tremOsc.connect(tremDepth).connect(trem.gain)
  const drive = driveNode(ctx, p.drive)
  const out = trem
  if (drive) trem.connect(drive).connect(amp.gain)
  else trem.connect(amp.gain)
  const body = ctx.createOscillator()
  body.type = 'sine'
  body.frequency.value = f
  const bodyGain = gainNode(ctx, 0.7)
  body.connect(bodyGain).connect(out)
  const bell = ctx.createOscillator()
  bell.type = 'sine'
  bell.frequency.value = f * 2.001
  const bg = gainNode(ctx, 0)
  bg.gain.setValueAtTime(0.55 * p.bell, t)
  bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.5 + p.tone)
  bell.connect(bg).connect(out)
  const tine = ctx.createOscillator()
  tine.type = 'triangle'
  tine.frequency.value = f * 3.02
  const tg = gainNode(ctx, 0)
  tg.gain.setValueAtTime(0.18 * p.bell * p.tone, t)
  tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.22)
  tine.connect(tg).connect(out)
  for (const x of [body, bell, tine, tremOsc]) x.start(t)
  stopAll([body, bell, tine, tremOsc], amp.stopAt)
}

function playPad(o: PlayNoteOpts): void {
  const { ctx, params: p, dest, time: t, dur, pitch, vel } = o
  const f = midiToFreq(pitch)
  const amp = ampEnv(ctx, dest, t, dur, Math.max(0.05, p.attack), p.decay, p.sustain, p.release, 0.3 * vel)
  const lp = biquad(ctx, 'lowpass', safeFreq(p.cutoff), 1.2)
  lp.connect(amp.gain)
  const oscs: OscillatorNode[] = []
  const detunes = [-14, -6, 6, 14]
  detunes.forEach((d, i) => {
    const x = ctx.createOscillator()
    x.type = waveAt(p.osc)
    x.frequency.value = f
    x.detune.value = d * (0.5 + p.spread)
    const g = gainNode(ctx, 0.16)
    const pan = ctx.createStereoPanner()
    pan.pan.value = (i / 3) * 2 - 1
    x.connect(g).connect(pan).connect(lp)
    x.start(t)
    oscs.push(x)
  })
  const lfo = ctx.createOscillator()
  lfo.type = 'sine'
  lfo.frequency.value = Math.max(0.02, p.lfoRate)
  const lg = gainNode(ctx, p.cutoff * 0.5 * p.movement)
  lfo.connect(lg).connect(lp.frequency)
  lfo.start(t)
  oscs.push(lfo)
  stopAll(oscs, amp.stopAt)
}

function playPluck(o: PlayNoteOpts): void {
  const { ctx, params: p, dest, time: t, dur, pitch, vel } = o
  const f = midiToFreq(pitch)
  const amp = ampEnv(ctx, dest, t, Math.max(0.05, Math.min(dur, 0.7)), 0.002, 0.02, 0.9, Math.max(0.05, p.decay), 0.5 * vel * (p.gain || 1))
  const delay = ctx.createDelay(0.05)
  delay.delayTime.value = Math.min(0.049, 1 / safeFreq(f))
  const damped = Math.min(0.988, 0.5 + p.damp * 0.48)
  const fb = gainNode(ctx, damped)
  const decayEnd = t + Math.max(0.12, p.decay + 0.12)
  fb.gain.setValueAtTime(damped, t)
  fb.gain.exponentialRampToValueAtTime(0.0005, decayEnd)
  fb.gain.setValueAtTime(0, decayEnd + 0.01)
  const damp = biquad(ctx, 'lowpass', 1200 + p.bright * 9000, 0.6)
  const src = ctx.createBufferSource()
  src.buffer = noiseBuffer(ctx)
  const pick = biquad(ctx, 'highpass', 900 + p.pick * 4000, 0.7)
  src.connect(pick).connect(delay)
  delay.connect(damp).connect(fb).connect(delay)
  delay.connect(amp.gain)
  src.start(t, Math.random() * 0.5)
  src.stop(t + 0.04)
}

function playStrings(o: PlayNoteOpts): void {
  const { ctx, params: p, dest, time: t, dur, pitch, vel } = o
  const f = midiToFreq(pitch)
  const amp = ampEnv(ctx, dest, t, dur, Math.max(0.08, p.attack), p.decay, p.sustain, p.release, 0.24 * vel)
  const lp = biquad(ctx, 'lowpass', safeFreq(p.cutoff), 0.8)
  lp.connect(amp.gain)
  const vib = ctx.createOscillator()
  vib.type = 'sine'
  vib.frequency.value = Math.max(1, p.vibRate)
  const vibGain = gainNode(ctx, p.vibrato * 12)
  vib.connect(vibGain)
  const oscs: OscillatorNode[] = [vib]
  const spread = 4 + p.ensemble * 14
  for (let i = 0; i < 3; i++) {
    const x = ctx.createOscillator()
    x.type = 'sawtooth'
    x.frequency.value = f
    x.detune.value = (i - 1) * spread
    vibGain.connect(x.detune)
    const g = gainNode(ctx, 0.14)
    x.connect(g).connect(lp)
    x.start(t)
    oscs.push(x)
  }
  vib.start(t)
  stopAll(oscs, amp.stopAt)
}

function playBass(o: PlayNoteOpts): void {
  const { ctx, params: p, dest, time: t, dur, pitch, vel } = o
  const f = midiToFreq(pitch)
  const amp = ampEnv(ctx, dest, t, dur, p.attack, p.decay, p.sustain, p.release, 0.75 * vel)
  const lp = biquad(ctx, 'lowpass', safeFreq(p.cutoff), Math.max(0.5, p.res))
  const dr = driveNode(ctx, p.drive)
  if (dr) lp.connect(dr).connect(amp.gain)
  else lp.connect(amp.gain)
  const peak = safeFreq(p.cutoff * (1 + p.fenv * 12))
  lp.frequency.setValueAtTime(peak, t)
  lp.frequency.exponentialRampToValueAtTime(safeFreq(p.cutoff), t + Math.max(0.03, p.decay))
  const oscs: OscillatorNode[] = []
  const main = ctx.createOscillator()
  main.type = waveAt(p.osc)
  main.frequency.setValueAtTime(f, t)
  const g = gainNode(ctx, 0.4)
  main.connect(g).connect(lp)
  main.start(t)
  oscs.push(main)
  const sub = ctx.createOscillator()
  sub.type = 'sine'
  sub.frequency.value = f
  const sg = gainNode(ctx, 0.55 * p.sub)
  sub.connect(sg).connect(lp)
  sub.start(t)
  oscs.push(sub)
  stopAll(oscs, amp.stopAt)
}

function play808(o: PlayNoteOpts): void {
  const { ctx, params: p, dest, time: t, dur, pitch, vel } = o
  const f = midiToFreq(pitch)
  const len = Math.max(0.15, Math.min(3.2, p.decay))
  const amp = ampEnv(ctx, dest, t, Math.max(dur, len * 0.9), 0.003, len, 0.16, 0.25, 0.8 * vel)
  const lp = biquad(ctx, 'lowpass', safeFreq(p.tone), 0.9)
  const dr = shaper(ctx, distCurve(1 + p.drive * 22))
  lp.connect(dr).connect(amp.gain)
  const osc = ctx.createOscillator()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(safeFreq(f * (1 + p.drop * 2.5)), t)
  osc.frequency.exponentialRampToValueAtTime(safeFreq(f), t + 0.06 + p.glide)
  const g = gainNode(ctx, 1)
  osc.connect(g).connect(lp)
  if (p.click > 0.02) {
    const c = ctx.createBufferSource()
    c.buffer = noiseBuffer(ctx)
    const hp = biquad(ctx, 'highpass', 2200, 0.7)
    const cg = percEnv(ctx, lp, t, 0.02, 0.25 * p.click, 0.001)
    c.connect(hp).connect(cg)
    c.start(t, Math.random())
    c.stop(t + 0.04)
  }
  osc.start(t)
  stopAll([osc], amp.stopAt)
}

function playSampler(o: PlayNoteOpts): void {
  const { ctx, params: p, dest, time: t, dur, pitch, vel } = o
  const patch: Patch | null = getPatch(o.samplerId) ?? (o.samplerId ? null : getPatch(p.patch as unknown as string))
  // A patch whose pack is not installed has no decoded zones: fall through to
  // the oscillator so the track still speaks instead of going silent.
  if (
    patch &&
    patchHasAudio(patch) &&
    playPatch(ctx, dest, patch, {
      time: t,
      dur,
      pitch,
      vel,
      gain: (p.gain || 1) * 0.9,
      attack: p.attack ?? 0.002,
      release: p.release ?? 0.12,
      cutoff: p.cutoff ?? 0,
      q: Math.max(0.2, p.res ?? 0.6),
      reverse: p.reverse === 1,
    })
  ) {
    return
  }
  const root = p.root ?? 60
  const semis = pitch - root + (p.pitch ?? 0) / 100
  const rate = Math.pow(2, semis / 12)
  const amp = ampEnv(ctx, dest, t, dur, p.attack, 0.01, 1, p.release, 0.85 * vel * (p.gain || 1))
  const lp = biquad(ctx, 'lowpass', safeFreq(p.cutoff ?? 15000), 0.6)
  lp.connect(amp.gain)
  if (!o.buffer) {
    // graceful fallback so an empty sampler still speaks
    const osc = ctx.createOscillator()
    osc.type = 'triangle'
    osc.frequency.value = midiToFreq(pitch)
    const g = gainNode(ctx, 0.2)
    osc.connect(g).connect(lp)
    osc.start(t)
    stopAll([osc], amp.stopAt)
    return
  }
  const buf = p.reverse === 1 ? reversedBuffer(ctx, o.buffer) : o.buffer
  const src = ctx.createBufferSource()
  src.buffer = buf
  src.playbackRate.value = Math.max(0.06, Math.min(8, rate))
  src.connect(lp)
  const durSec = Math.min(buf.duration / Math.max(0.06, rate), Math.max(dur, 0.05))
  src.start(t, 0, Math.max(0.02, durSec))
  src.stop(amp.stopAt)
}

/** Schedule one note for any instrument device type. */
export function playInstrument(o: PlayNoteOpts): void {
  const { type } = o
  // Always fill the device defaults: a partial or empty param set used to
  // schedule NaN envelopes (silence) for tracks without an instrument device.
  const merged = { ...defaultParams(type), ...o.params }
  for (const k of Object.keys(merged)) if (!Number.isFinite(merged[k])) merged[k] = defaultParams(type)[k]
  o = { ...o, params: merged }
  if (type === 'drums') {
    const kind = DRUM_PADS[((o.pitch - 36) % 16 + 16) % 16].kind
    playDrum(o.ctx, o.dest, kind, o.time, o.vel, o.params)
    return
  }
  switch (type) {
    case 'fm':
      playFM(o)
      break
    case 'keys':
      playKeys(o)
      break
    case 'pad':
      playPad(o)
      break
    case 'pluck':
      playPluck(o)
      break
    case 'strings':
      playStrings(o)
      break
    case 'bass':
      playBass(o)
      break
    case 'eight08':
      play808(o)
      break
    case 'sampler':
      playSampler(o)
      break
    case 'synth':
    default:
      playSynth(o)
      break
  }
}

/** Default instrument type used when a track has no instrument device. */
export function fallbackInstrument(kind: 'audio' | 'midi' | 'drum' | 'group'): DeviceType {
  if (kind === 'drum') return 'drums'
  return 'synth'
}
