import type { DeviceType, Params } from '../state/types'
import { SCALES, KEY_ROOT_NAMES } from '../state/types'

export interface ParamDef {
  key: string
  label: string
  min: number
  max: number
  def: number
  step?: number
  unit?: string
  curve?: 'lin' | 'log'
  options?: string[]
}

export interface DeviceDef {
  type: DeviceType
  name: string
  category: 'instrument' | 'effect'
  color: string
  blurb: string
  params: ParamDef[]
}

const P = (
  key: string,
  label: string,
  min: number,
  max: number,
  def: number,
  extra: Partial<ParamDef> = {},
): ParamDef => ({ key, label, min, max, def, ...extra })

const wave = (def = 1) => P('osc', 'Wave', 0, 3, def, { options: ['Sine', 'Saw', 'Square', 'Tri'] })

export const ADSR = [
  P('attack', 'Attack', 0.001, 2, 0.01, { unit: 's' }),
  P('decay', 'Decay', 0.005, 3, 0.25, { unit: 's' }),
  P('sustain', 'Sustain', 0, 1, 0.7),
  P('release', 'Release', 0.01, 5, 0.35, { unit: 's' }),
]

export const DEVICE_DEFS: Record<DeviceType, DeviceDef> = {
  synth: {
    type: 'synth',
    name: 'Subtractive',
    category: 'instrument',
    color: '#4fd1c5',
    blurb: 'Dual oscillator subtractive synth with noise, drive and filter envelope.',
    params: [
      { ...wave(1), label: 'Osc A' },
      { ...wave(2), label: 'Osc B' },
      P('mix', 'Osc Mix', 0, 1, 0.45),
      P('detune', 'Detune', -50, 50, 7, { unit: 'ct' }),
      P('sub', 'Sub', 0, 1, 0.2),
      P('cutoff', 'Cutoff', 60, 18000, 3200, { curve: 'log', unit: 'Hz' }),
      P('res', 'Resonance', 0, 22, 3),
      P('fenv', 'Filter Env', 0, 1, 0.4),
      P('ftype', 'Filter', 0, 2, 0, { options: ['Lowpass', 'Highpass', 'Bandpass'] }),
      ...ADSR,
      P('lfoRate', 'LFO Rate', 0.05, 14, 0.4, { unit: 'Hz' }),
      P('lfoAmt', 'LFO Amt', 0, 1, 0),
      P('lfoTarget', 'LFO Dest', 0, 2, 1, { options: ['Pitch', 'Filter', 'Amp'] }),
      P('drive', 'Drive', 0, 1, 0.08),
    ],
  },
  fm: {
    type: 'fm',
    name: 'FM Operator',
    category: 'instrument',
    color: '#8f7bf7',
    blurb: 'Two operator FM with bell ratio and metallic overtones.',
    params: [
      P('ratio', 'Ratio', 0.25, 9, 2),
      P('index', 'Index', 0, 14, 3.4),
      P('detune', 'Detune', -30, 30, 0),
      P('tone', 'Tone', 200, 16000, 9000, { curve: 'log' }),
      ...ADSR,
      P('vel', 'Velocity', 0, 1, 0.5),
    ],
  },
  sampler: {
    type: 'sampler',
    name: 'Sampler',
    category: 'instrument',
    color: '#f6ad55',
    blurb: 'Drop any sample and play it chromatically across the keys.',
    params: [
      P('root', 'Root Key', 24, 96, 60),
      P('gain', 'Gain', 0, 2, 1),
      P('attack', 'Attack', 0.001, 1, 0.002),
      P('release', 'Release', 0.01, 3, 0.12),
      P('cutoff', 'Filter', 200, 18000, 15000, { curve: 'log' }),
      P('pitch', 'Fine', -100, 100, 0, { unit: 'ct' }),
      P('reverse', 'Reverse', 0, 1, 0, { options: ['Off', 'On'] }),
    ],
  },
  drums: {
    type: 'drums',
    name: 'Drum Machine',
    category: 'instrument',
    color: '#f2777a',
    blurb: '16 synthesized pads: kicks, snares, hats, claps, toms, metals and perc.',
    params: [
      P('kit', 'Kit', 0, 3, 0, { options: ['Analog', '808', '909', 'Acoustic'] }),
      P('tune', 'Tune', -12, 12, 0, { unit: 'st' }),
      P('decay', 'Decay', 0.4, 2.2, 1),
      P('tone', 'Tone', -1, 1, 0),
      P('snap', 'Snap', 0, 1, 0.4),
      P('gain', 'Gain', 0, 1.6, 1),
    ],
  },
  bass: {
    type: 'bass',
    name: 'Sub Bass',
    category: 'instrument',
    color: '#63b3ed',
    blurb: 'Round sub with drive and resonant lowpass, built for 808-style weight.',
    params: [
      { ...wave(0), label: 'Wave' },
      P('sub', 'Sub Level', 0, 1, 0.7),
      P('drive', 'Drive', 0, 1, 0.18),
      P('cutoff', 'Cutoff', 60, 4000, 420, { curve: 'log' }),
      P('res', 'Res', 0, 16, 4),
      P('fenv', 'Env Amt', 0, 1, 0.5),
      ...ADSR,
      P('glide', 'Glide', 0, 0.4, 0, { unit: 's' }),
    ],
  },
  keys: {
    type: 'keys',
    name: 'Electric Keys',
    category: 'instrument',
    color: '#f9d77e',
    blurb: 'Tine electric piano: bell attack, tremolo and warm body.',
    params: [
      P('bell', 'Bell', 0, 1, 0.34),
      P('tone', 'Tone', 0, 1, 0.5),
      P('tremolo', 'Tremolo', 0, 1, 0.18),
      P('tremRate', 'Trem Rate', 0.2, 9, 4.2),
      P('drive', 'Drive', 0, 1, 0.12),
      ...ADSR,
    ],
  },
  pad: {
    type: 'pad',
    name: 'Ambient Pad',
    category: 'instrument',
    color: '#a78bfa',
    blurb: 'Wide detuned saw stack with slow swell and drifting filter.',
    params: [
      wave(1),
      P('spread', 'Spread', 0, 1, 0.7),
      P('cutoff', 'Cutoff', 200, 12000, 2400, { curve: 'log' }),
      P('movement', 'Movement', 0, 1, 0.5),
      P('lfoRate', 'Drift', 0.02, 2, 0.12),
      ...ADSR,
    ],
  },
  pluck: {
    type: 'pluck',
    name: 'Pluck',
    category: 'instrument',
    color: '#68d391',
    blurb: 'Karplus-Strong styled pluck: bright attack, tunable decay.',
    params: [
      P('damp', 'Damping', 0, 0.98, 0.72),
      P('bright', 'Brightness', 0, 1, 0.62),
      P('decay', 'Decay', 0.05, 2, 0.5, { unit: 's' }),
      P('pick', 'Pick', 0, 1, 0.3),
      P('gain', 'Gain', 0, 1.5, 0.9),
    ],
  },
  strings: {
    type: 'strings',
    name: 'Strings',
    category: 'instrument',
    color: '#e17bd8',
    blurb: 'Bowed ensemble with vibrato and slow bow attack.',
    params: [
      P('vibrato', 'Vibrato', 0, 1, 0.28),
      P('vibRate', 'Vib Rate', 2, 8, 5.1),
      P('ensemble', 'Ensemble', 0, 1, 0.6),
      P('cutoff', 'Brightness', 400, 12000, 3600, { curve: 'log' }),
      ...ADSR,
    ],
  },
  eight08: {
    type: 'eight08',
    name: '808',
    category: 'instrument',
    color: '#f6ad55',
    blurb: 'Distorted long-tail 808 with pitch drop and glide.',
    params: [
      P('drop', 'Pitch Drop', 0, 1, 0.55),
      P('decay', 'Length', 0.15, 3.2, 1.1, { unit: 's' }),
      P('drive', 'Drive', 0, 1, 0.4),
      P('tone', 'Tone', 200, 8000, 1600, { curve: 'log' }),
      P('glide', 'Glide', 0, 0.3, 0.02),
      P('click', 'Click', 0, 1, 0.3),
    ],
  },
  eq3: {
    type: 'eq3',
    name: 'Parametric EQ',
    category: 'effect',
    color: '#4fd1c5',
    blurb: 'Three band EQ with live response graph.',
    params: [
      P('lowGain', 'Low', -18, 18, 0, { unit: 'dB' }),
      P('lowFreq', 'Low Freq', 40, 600, 120, { curve: 'log', unit: 'Hz' }),
      P('midGain', 'Mid', -18, 18, 0, { unit: 'dB' }),
      P('midFreq', 'Mid Freq', 200, 6000, 1200, { curve: 'log', unit: 'Hz' }),
      P('midQ', 'Mid Q', 0.3, 8, 1),
      P('highGain', 'High', -18, 18, 0, { unit: 'dB' }),
      P('highFreq', 'High Freq', 2000, 16000, 8000, { curve: 'log', unit: 'Hz' }),
    ],
  },
  comp: {
    type: 'comp',
    name: 'Compressor',
    category: 'effect',
    color: '#63b3ed',
    blurb: 'Glue compressor with knee, makeup and gain reduction meter.',
    params: [
      P('threshold', 'Threshold', -60, 0, -18, { unit: 'dB' }),
      P('ratio', 'Ratio', 1, 20, 3.5),
      P('attack', 'Attack', 0.001, 0.3, 0.008, { unit: 's' }),
      P('release', 'Release', 0.02, 1.2, 0.22, { unit: 's' }),
      P('knee', 'Knee', 0, 40, 12),
      P('makeup', 'Makeup', -6, 18, 3, { unit: 'dB' }),
      P('mix', 'Mix', 0, 1, 1),
    ],
  },
  limiter: {
    type: 'limiter',
    name: 'Limiter',
    category: 'effect',
    color: '#f2777a',
    blurb: 'Brickwall safety limiter for the master bus.',
    params: [
      P('ceiling', 'Ceiling', -24, 0, -0.3, { unit: 'dB' }),
      P('release', 'Release', 0.01, 0.6, 0.09, { unit: 's' }),
      P('mix', 'Mix', 0, 1, 1),
    ],
  },
  reverb: {
    type: 'reverb',
    name: 'Reverb',
    category: 'effect',
    color: '#a78bfa',
    blurb: 'Convolution reverb with procedurally generated rooms.',
    params: [
      P('size', 'Size', 0.15, 1, 0.55),
      P('decay', 'Decay', 0.3, 9, 2.4, { unit: 's' }),
      P('predelay', 'Pre-delay', 0, 0.15, 0.02, { unit: 's' }),
      P('damp', 'Damping', 0, 1, 0.45),
      P('lowcut', 'Low Cut', 0, 600, 120, { unit: 'Hz' }),
      P('mix', 'Mix', 0, 1, 0.28),
    ],
  },
  delay: {
    type: 'delay',
    name: 'Delay',
    category: 'effect',
    color: '#68d391',
    blurb: 'Tempo-aware stereo delay with ping-pong and tone control.',
    params: [
      P('time', 'Time', 0.05, 2, 0.5, { unit: '♩' }),
      P('feedback', 'Feedback', 0, 0.92, 0.34),
      P('tone', 'Tone', 300, 14000, 5200, { curve: 'log', unit: 'Hz' }),
      P('ping', 'Ping-Pong', 0, 1, 1, { options: ['Off', 'On'] }),
      P('mix', 'Mix', 0, 1, 0.24),
    ],
  },
  chorus: {
    type: 'chorus',
    name: 'Chorus',
    category: 'effect',
    color: '#4fd1c5',
    blurb: 'Wide modulated doubling for thickness and space.',
    params: [
      P('rate', 'Rate', 0.05, 6, 0.55, { unit: 'Hz' }),
      P('depth', 'Depth', 0, 0.02, 0.006, { unit: 's' }),
      P('spread', 'Spread', 0, 1, 0.7),
      P('mix', 'Mix', 0, 1, 0.35),
    ],
  },
  flanger: {
    type: 'flanger',
    name: 'Flanger',
    category: 'effect',
    color: '#7ea6ff',
    blurb: 'Jet sweep with feedback and stereo offset.',
    params: [
      P('rate', 'Rate', 0.02, 4, 0.25, { unit: 'Hz' }),
      P('depth', 'Depth', 0, 0.01, 0.003, { unit: 's' }),
      P('feedback', 'Feedback', 0, 0.9, 0.55),
      P('mix', 'Mix', 0, 1, 0.4),
    ],
  },
  phaser: {
    type: 'phaser',
    name: 'Phaser',
    category: 'effect',
    color: '#8f7bf7',
    blurb: 'Multi-stage allpass phaser with feedback.',
    params: [
      P('rate', 'Rate', 0.02, 4, 0.3, { unit: 'Hz' }),
      P('depth', 'Depth', 0, 1, 0.7),
      P('stages', 'Stages', 2, 8, 4, { step: 2 }),
      P('feedback', 'Feedback', 0, 0.9, 0.4),
      P('mix', 'Mix', 0, 1, 0.45),
    ],
  },
  distortion: {
    type: 'distortion',
    name: 'Distortion',
    category: 'effect',
    color: '#f6ad55',
    blurb: 'Asymmetric wave-shaping drive with tone stack.',
    params: [
      P('drive', 'Drive', 0, 40, 6),
      P('tone', 'Tone', 400, 14000, 4800, { curve: 'log', unit: 'Hz' }),
      P('bias', 'Bias', -0.5, 0.5, 0),
      P('output', 'Output', 0, 1.5, 0.8),
      P('mix', 'Mix', 0, 1, 1),
    ],
  },
  bitcrush: {
    type: 'bitcrush',
    name: 'Bitcrusher',
    category: 'effect',
    color: '#f2777a',
    blurb: 'Bit depth reduction with sample-rate crush.',
    params: [
      P('bits', 'Bits', 1, 16, 6),
      P('crush', 'Sample Rate', 0, 1, 0.35),
      P('drive', 'Drive', 0, 1, 0.2),
      P('mix', 'Mix', 0, 1, 0.6),
    ],
  },
  autofilter: {
    type: 'autofilter',
    name: 'Auto Filter',
    category: 'effect',
    color: '#63b3ed',
    blurb: 'Resonant filter with LFO and envelope follower.',
    params: [
      P('freq', 'Cutoff', 80, 14000, 1400, { curve: 'log', unit: 'Hz' }),
      P('res', 'Resonance', 0, 20, 6),
      P('mode', 'Mode', 0, 2, 0, { options: ['Lowpass', 'Highpass', 'Bandpass'] }),
      P('lfoRate', 'LFO Rate', 0.02, 8, 0.35, { unit: 'Hz' }),
      P('lfoAmt', 'LFO Amt', 0, 1, 0.3),
      P('envAmt', 'Env Amt', 0, 1, 0.2),
      P('mix', 'Mix', 0, 1, 1),
    ],
  },
  gate: {
    type: 'gate',
    name: 'Gate',
    category: 'effect',
    color: '#68d391',
    blurb: 'Noise gate with threshold, attack and release.',
    params: [
      P('threshold', 'Threshold', -80, 0, -46, { unit: 'dB' }),
      P('attack', 'Attack', 0.001, 0.1, 0.004, { unit: 's' }),
      P('release', 'Release', 0.01, 0.8, 0.14, { unit: 's' }),
      P('hold', 'Hold', 0, 0.4, 0.05, { unit: 's' }),
      P('mix', 'Mix', 0, 1, 1),
    ],
  },
  pitchshift: {
    type: 'pitchshift',
    name: 'Pitch Shifter',
    category: 'effect',
    color: '#7ea6ff',
    blurb: 'Real-time granular pitch shifting across two octaves.',
    params: [
      P('semitones', 'Semitones', -12, 12, 0, { step: 1, unit: 'st' }),
      P('window', 'Window', 0.02, 0.18, 0.07, { unit: 's' }),
      P('mix', 'Mix', 0, 1, 0.6),
    ],
  },
  autotune: {
    type: 'autotune',
    name: 'Vocal Tuner',
    category: 'effect',
    color: '#e17bd8',
    blurb: 'Detects pitch and snaps it to scale — the hard-tune sound.',
    params: [
      P('root', 'Key', 0, 11, 0, { options: KEY_ROOT_NAMES }),
      P('scale', 'Scale', 0, Object.keys(SCALES).length - 1, 0, { options: Object.keys(SCALES) }),
      P('strength', 'Strength', 0, 1, 0.85),
      P('speed', 'Retune', 0, 1, 0.8),
      P('mix', 'Mix', 0, 1, 0.8),
    ],
  },
  vocoder: {
    type: 'vocoder',
    name: 'Vocoder',
    category: 'effect',
    color: '#8f7bf7',
    blurb: 'Ten-band robot vocoder: the input shapes an internal carrier into a talking synth.',
    params: [
      P('bands', 'Bands', 4, 16, 10, { step: 1 }),
      P('formant', 'Formant', -12, 12, 0, { unit: 'st' }),
      P('release', 'Release', 0.01, 0.6, 0.1, { unit: 's' }),
      P('carrier', 'Carrier', 0, 2, 0, { options: ['Saw', 'Square', 'Pulse'] }),
      P('mix', 'Mix', 0, 1, 0.85),
    ],
  },
  resonator: {
    type: 'resonator',
    name: 'Resonator',
    category: 'effect',
    color: '#4fd1c5',
    blurb: 'Seven tuned comb resonators that turn any hit into pitched metal or strings.',
    params: [
      P('root', 'Root', 24, 84, 48, { step: 1 }),
      P('partials', 'Partials', 3, 8, 6, { step: 1 }),
      P('spread', 'Spread', 0.5, 2.4, 1.4),
      P('decay', 'Decay', 0.05, 4, 0.9, { unit: 's' }),
      P('damp', 'Damping', 400, 12000, 5200, { curve: 'log', unit: 'Hz' }),
      P('mix', 'Mix', 0, 1, 0.55),
    ],
  },
  spectral: {
    type: 'spectral',
    name: 'Spectral Blur',
    category: 'effect',
    color: '#63b3ed',
    blurb: 'Freezes and smears the spectrum into glassy pads and metallic tails.',
    params: [
      P('blur', 'Blur', 0, 1, 0.6),
      P('shift', 'Shift', -12, 12, 0, { unit: 'st' }),
      P('motion', 'Motion', 0, 1, 0.3),
      P('feedback', 'Feedback', 0, 0.92, 0.45),
      P('mix', 'Mix', 0, 1, 0.5),
    ],
  },
  looper: {
    type: 'looper',
    name: 'Looper',
    category: 'effect',
    color: '#f6ad55',
    blurb: 'Captures the last few seconds of the track and loops it with feedback — an instant performance looper.',
    params: [
      P('length', 'Length', 0.5, 8, 2, { unit: 's' }),
      P('feedback', 'Feedback', 0, 0.95, 0.6),
      P('speed', 'Speed', 0.25, 2, 1),
      P('mix', 'Mix', 0, 1, 0.7),
    ],
  },
  utility: {
    type: 'utility',
    name: 'Utility',
    category: 'effect',
    color: '#9aa4b2',
    blurb: 'Gain, stereo width and mono fold for routing chores.',
    params: [
      P('gain', 'Gain', -24, 12, 0, { unit: 'dB' }),
      P('width', 'Width', 0, 1.6, 1),
      P('mono', 'Mono', 0, 1, 0, { options: ['Off', 'On'] }),
      P('mix', 'Mix', 0, 1, 1),
    ],
  },
}

export const INSTRUMENT_TYPES = (Object.keys(DEVICE_DEFS) as DeviceType[]).filter(
  (t) => DEVICE_DEFS[t].category === 'instrument',
)
export const EFFECT_TYPES = (Object.keys(DEVICE_DEFS) as DeviceType[]).filter(
  (t) => DEVICE_DEFS[t].category === 'effect',
)

export function defaultParams(type: DeviceType): Params {
  const out: Params = {}
  for (const p of DEVICE_DEFS[type].params) out[p.key] = p.def
  return out
}

export interface DevicePreset {
  id: string
  type: DeviceType
  name: string
  params: Params
  tags: string
}

function preset(type: DeviceType, name: string, over: Params, tags = ''): DevicePreset {
  return { id: `${type}:${name.toLowerCase().replace(/\s+/g, '-')}`, type, name, params: { ...defaultParams(type), ...over }, tags }
}

export const PRESETS: DevicePreset[] = [
  // ---------------- synth
  preset('synth', 'Init Saw', {}, 'basic'),
  preset('synth', 'Deep House Stab', { osc: 1, cutoff: 900, res: 8, attack: 0.004, decay: 0.18, sustain: 0.1, release: 0.18, fenv: 0.75, drive: 0.2 }, 'house chord stab'),
  preset('synth', 'Neon Lead', { osc: 2, cutoff: 5200, res: 6, attack: 0.01, decay: 0.3, sustain: 0.55, release: 0.4, lfoRate: 5.2, lfoAmt: 0.18, lfoTarget: 0 }, 'lead bright'),
  preset('synth', 'Trap Bell Lead', { osc: 3, cutoff: 8000, res: 2, decay: 0.5, sustain: 0.2, lfoAmt: 0.12, lfoTarget: 0 }, 'trap bells'),
  preset('synth', 'Warm Analog', { osc: 1, osc2: 1, detune: 12, mix: 0.5, cutoff: 2200, res: 3, drive: 0.16 }, 'analog warm'),
  preset('synth', 'Acid Line', { osc: 2, cutoff: 700, res: 18, fenv: 0.9, decay: 0.2, sustain: 0.05, release: 0.12 }, 'acid 303'),
  preset('synth', 'Hollow Pluck', { osc: 2, cutoff: 2600, res: 10, decay: 0.14, sustain: 0, release: 0.2, fenv: 0.6 }, 'pluck short'),
  preset('synth', 'Wide Saw Stack', { osc: 1, osc2: 1, detune: -18, mix: 0.62, cutoff: 4200, res: 1, attack: 0.06, release: 0.6 }, 'wide stack'),

  // ---------------- fm
  preset('fm', 'Init FM', {}, 'basic'),
  preset('fm', 'Glass Keys', { ratio: 3, index: 2.2, decay: 1.2, sustain: 0.3, release: 0.7, tone: 11000 }, 'keys glass'),
  preset('fm', 'Metal Bell', { ratio: 3.5, index: 8, decay: 1.8, sustain: 0.05, release: 1.4 }, 'bell metal'),
  preset('fm', 'Bass Growl', { ratio: 0.5, index: 6, decay: 0.3, sustain: 0.6, release: 0.2, tone: 2200 }, 'bass growl'),
  preset('fm', 'Marimba', { ratio: 4, index: 1.5, decay: 0.4, sustain: 0, release: 0.3, tone: 6000 }, 'mallet marimba'),
  preset('fm', 'Airy Pad', { ratio: 1.5, index: 1.2, attack: 0.7, decay: 1.4, sustain: 0.7, release: 2.2, tone: 7000 }, 'pad airy'),

  // ---------------- sampler
  preset('sampler', 'Init Sampler', {}, 'basic'),
  preset('sampler', 'Pitched Chop', { root: 60, attack: 0.001, release: 0.05, pitch: 0 }, 'chop'),
  preset('sampler', 'Tape Keys', { root: 48, pitch: -7, cutoff: 4200, release: 0.4 }, 'tape lofi'),
  preset('sampler', 'Reverse Swell', { reverse: 1, attack: 0.4, release: 0.8 }, 'reverse riser'),

  // ---------------- drums
  preset('drums', 'Analog Kit', { kit: 0 }, 'analog 909 drum'),
  preset('drums', '808 Kit', { kit: 1, tune: -2, decay: 1.4, snap: 0.3 }, '808 trap'),
  preset('drums', '909 Kit', { kit: 2, tone: 0.3, snap: 0.7 }, '909 house techno'),
  preset('drums', 'Acoustic Kit', { kit: 3, tone: -0.2, decay: 1.1 }, 'acoustic rock'),
  preset('drums', 'Lo-Fi Dust Kit', { kit: 3, tune: -3, decay: 0.7, tone: -0.6, snap: 0.15 }, 'lofi dusty'),

  // ---------------- bass
  preset('bass', 'Init Sub', {}, 'basic'),
  preset('bass', 'Trap 808 Sub', { osc: 0, sub: 0.9, drive: 0.3, cutoff: 260, decay: 1.2, sustain: 0.5, release: 0.5, glide: 0.04 }, 'trap sub'),
  preset('bass', 'Funk Finger', { osc: 1, sub: 0.4, cutoff: 900, res: 7, decay: 0.22, sustain: 0.25, release: 0.12, fenv: 0.6 }, 'funk bass'),
  preset('bass', 'Reese', { osc: 1, sub: 0.5, cutoff: 380, res: 9, attack: 0.02, release: 0.3, detune: 0 }, 'dnb reese'),
  preset('bass', 'House Pluck Bass', { osc: 2, cutoff: 620, res: 5, decay: 0.16, sustain: 0.1, release: 0.1 }, 'house bass'),

  // ---------------- keys
  preset('keys', 'Init Keys', {}, 'basic'),
  preset('keys', 'Velvet Rhodes', { bell: 0.24, tone: 0.4, tremolo: 0.24, drive: 0.1 }, 'rhodes soul'),
  preset('keys', 'DX Bells', { bell: 0.7, tone: 0.7, tremolo: 0.1, decay: 1.1, sustain: 0.2 }, 'bell fm keys'),
  preset('keys', 'Lo-Fi Wurli', { bell: 0.16, tone: 0.32, tremolo: 0.4, drive: 0.34, cutoff: 0 }, 'lofi keys'),
  preset('keys', 'House Piano', { bell: 0.5, tone: 0.62, decay: 0.5, sustain: 0.25, release: 0.4 }, 'piano house'),

  // ---------------- pad
  preset('pad', 'Init Pad', {}, 'basic'),
  preset('pad', 'Dream Swell', { attack: 0.9, release: 2.6, cutoff: 1500, movement: 0.7, lfoRate: 0.06, spread: 0.9 }, 'dream pop pad'),
  preset('pad', 'Cinematic Strings Pad', { cutoff: 3200, attack: 0.5, release: 2, movement: 0.4 }, 'cinematic'),
  preset('pad', 'Choir Air', { osc: 3, cutoff: 2200, attack: 0.7, release: 3, spread: 0.8 }, 'choir airy'),
  preset('pad', 'Dark Drone', { osc: 0, cutoff: 400, attack: 0.3, release: 2.4, movement: 0.8, lfoRate: 0.04 }, 'dark drone'),

  // ---------------- pluck
  preset('pluck', 'Init Pluck', {}, 'basic'),
  preset('pluck', 'Kalimba', { damp: 0.82, bright: 0.5, decay: 0.35, pick: 0.2 }, 'kalimba'),
  preset('pluck', 'Trap Harp', { damp: 0.7, bright: 0.8, decay: 0.7, pick: 0.4 }, 'harp trap'),
  preset('pluck', 'Nylon Guitar', { damp: 0.9, bright: 0.45, decay: 0.9, pick: 0.5 }, 'guitar nylon'),
  preset('pluck', 'Crystal Drop', { damp: 0.55, bright: 0.95, decay: 1.2, pick: 0.7 }, 'crystal bright'),

  // ---------------- strings
  preset('strings', 'Init Strings', {}, 'basic'),
  preset('strings', 'Warm Section', { vibrato: 0.3, ensemble: 0.7, cutoff: 2800 }, 'warm strings'),
  preset('strings', 'Tension Bowed', { vibrato: 0.1, cutoff: 4200, attack: 0.35, release: 1.6 }, 'tension'),
  preset('strings', 'Octave Ensemble', { vibrato: 0.45, ensemble: 0.9, cutoff: 5000, attack: 0.25 }, 'ensemble'),

  // ---------------- 808
  preset('eight08', 'Init 808', {}, 'basic'),
  preset('eight08', 'Long Trap 808', { decay: 2.1, drop: 0.6, drive: 0.45, tone: 1200 }, 'trap 808'),
  preset('eight08', 'Screwed 808', { decay: 1.6, drop: 0.8, drive: 0.3, tone: 700, glide: 0.1 }, 'screwed'),
  preset('eight08', 'Clean Sub 808', { decay: 1.2, drive: 0.12, tone: 2200 }, 'clean sub'),
  preset('eight08', 'Distorted Knock', { decay: 0.8, drive: 0.8, tone: 3200, click: 0.8 }, 'distorted knock'),

  // ---------------- effects (effects presets)
  preset('eq3', 'Init EQ', {}, 'flat'),
  preset('eq3', 'Vocal Air', { highGain: 3.5, highFreq: 9000, lowGain: -3, lowFreq: 90 }, 'vocal eq'),
  preset('eq3', 'Low Cut Only', { lowGain: -14, lowFreq: 110, midGain: 0, highGain: 0 }, 'cut rumble'),
  preset('eq3', 'Telephone', { lowGain: -18, lowFreq: 400, midGain: 8, midFreq: 1600, highGain: -12, highFreq: 4000 }, 'telephone lofi'),
  preset('eq3', 'Smiley', { lowGain: 5, lowFreq: 90, midGain: -4, midFreq: 900, highGain: 5, highFreq: 8000 }, 'smiley'),
  preset('comp', 'Init Comp', {}, 'basic'),
  preset('comp', 'Vocal Level', { threshold: -22, ratio: 4, attack: 0.006, release: 0.16, makeup: 4 }, 'vocal'),
  preset('comp', 'Drum Glue', { threshold: -16, ratio: 2.5, attack: 0.02, release: 0.14, knee: 18, makeup: 2 }, 'drum bus'),
  preset('comp', 'Trap Punch', { threshold: -26, ratio: 8, attack: 0.002, release: 0.08, makeup: 6 }, 'punch'),
  preset('comp', 'Parallel Smash', { threshold: -40, ratio: 16, attack: 0.001, release: 0.12, makeup: 10, mix: 0.4 }, 'parallel'),
  preset('limiter', 'Master Safe', { ceiling: -0.3, release: 0.1 }, 'master'),
  preset('limiter', 'Loud', { ceiling: -0.1, release: 0.05 }, 'loud'),
  preset('reverb', 'Init Reverb', {}, 'basic'),
  preset('reverb', 'Studio Plate', { size: 0.45, decay: 1.9, predelay: 0.02, damp: 0.35, mix: 0.24 }, 'plate vocal'),
  preset('reverb', 'Cathedral', { size: 0.95, decay: 6.5, predelay: 0.06, damp: 0.6, mix: 0.4 }, 'cathedral huge'),
  preset('reverb', 'Tight Room', { size: 0.22, decay: 0.7, predelay: 0.005, damp: 0.2, mix: 0.18 }, 'room tight'),
  preset('reverb', 'Dark Hall', { size: 0.8, decay: 4.2, damp: 0.85, mix: 0.35 }, 'dark hall'),
  preset('delay', 'Init Delay', {}, 'basic'),
  preset('delay', 'Trap Eighth', { time: 0.5, feedback: 0.32, ping: 1, mix: 0.22, tone: 4200 }, 'eighth trap'),
  preset('delay', 'Dub Quarter', { time: 0.75, feedback: 0.62, tone: 2600, ping: 1, mix: 0.3 }, 'dub'),
  preset('delay', 'Slapback', { time: 0.16, feedback: 0.1, tone: 7000, ping: 0, mix: 0.22 }, 'slapback'),
  preset('delay', 'Ambient Wash', { time: 1.0, feedback: 0.78, tone: 3000, ping: 1, mix: 0.4 }, 'ambient'),
  preset('chorus', 'Init Chorus', {}, 'basic'),
  preset('chorus', 'Wide Guitars', { rate: 0.4, depth: 0.008, spread: 0.9, mix: 0.3 }, 'guitar wide'),
  preset('chorus', 'Subtle Doubler', { rate: 0.2, depth: 0.003, mix: 0.18 }, 'doubler'),
  preset('chorus', '80s Shimmer', { rate: 0.9, depth: 0.012, mix: 0.5 }, '80s shimmer'),
  preset('flanger', 'Init Flanger', {}, 'basic'),
  preset('flanger', 'Jet Sweep', { rate: 0.12, depth: 0.006, feedback: 0.7, mix: 0.5 }, 'jet'),
  preset('flanger', 'Subtle Motion', { rate: 0.3, depth: 0.002, feedback: 0.3, mix: 0.25 }, 'subtle'),
  preset('phaser', 'Init Phaser', {}, 'basic'),
  preset('phaser', 'Slow Phase', { rate: 0.08, depth: 0.9, stages: 6, feedback: 0.5, mix: 0.5 }, 'slow phase'),
  preset('phaser', 'Pedal Swirl', { rate: 0.6, depth: 0.7, stages: 4, feedback: 0.6, mix: 0.55 }, 'pedal'),
  preset('distortion', 'Init Drive', {}, 'basic'),
  preset('distortion', 'Warm Saturation', { drive: 3, tone: 6000, output: 0.9, mix: 0.7 }, 'saturation'),
  preset('distortion', 'Drum Crush', { drive: 14, tone: 3600, output: 0.6 }, 'drum crush'),
  preset('distortion', 'Vocal Grit', { drive: 5, tone: 5200, mix: 0.5 }, 'vocal grit'),
  preset('distortion', 'Fuzz Wall', { drive: 32, tone: 2600, bias: 0.2, output: 0.5 }, 'fuzz'),
  preset('bitcrush', 'Init Crush', {}, 'basic'),
  preset('bitcrush', 'Lo-Fi 8bit', { bits: 4, crush: 0.6, mix: 0.8 }, '8bit lofi'),
  preset('bitcrush', 'Telephone Bits', { bits: 6, crush: 0.35, mix: 0.9 }, 'telephone'),
  preset('bitcrush', 'Subtle Dirt', { bits: 10, crush: 0.15, mix: 0.4 }, 'dirt'),
  preset('autofilter', 'Init Filter', {}, 'basic'),
  preset('autofilter', 'Sweeping House', { freq: 700, res: 12, lfoRate: 0.25, lfoAmt: 0.6 }, 'house sweep'),
  preset('autofilter', 'Wobble Bass', { freq: 400, res: 16, lfoRate: 3.2, lfoAmt: 0.8 }, 'wobble'),
  preset('autofilter', 'Riser Filter', { freq: 300, res: 8, lfoRate: 0.08, lfoAmt: 0.9 }, 'riser'),
  preset('gate', 'Init Gate', {}, 'basic'),
  preset('gate', 'Vocal Gate', { threshold: -42, attack: 0.003, release: 0.1, hold: 0.04 }, 'vocal'),
  preset('gate', 'Tight Drums', { threshold: -34, attack: 0.001, release: 0.05, hold: 0.02 }, 'drums'),
  preset('gate', 'Stutter Gate', { threshold: -50, attack: 0.001, release: 0.03, hold: 0.0 }, 'stutter'),
  preset('pitchshift', 'Init Shift', {}, 'basic'),
  preset('pitchshift', 'Octave Up', { semitones: 12, window: 0.06, mix: 0.55 }, 'octave'),
  preset('pitchshift', 'Fifth Harmony', { semitones: 7, window: 0.07, mix: 0.45 }, 'harmony'),
  preset('pitchshift', 'Detune Thickener', { semitones: -0.15, window: 0.09, mix: 0.4 }, 'detune'),
  preset('autotune', 'Init Tuner', {}, 'basic'),
  preset('autotune', 'Modern Trap Tune', { root: 0, scale: 1, strength: 1, speed: 0.95, mix: 0.9 }, 'trap tune'),
  preset('autotune', 'Natural Correction', { strength: 0.45, speed: 0.3, mix: 0.6 }, 'natural'),
  preset('autotune', 'Hard Chrome', { strength: 1, speed: 1, mix: 1 }, 'hard'),
  preset('utility', 'Init Utility', {}, 'basic'),
  preset('utility', 'Mono Fold', { width: 0, mono: 1 }, 'mono'),
  preset('utility', 'Wide 140', { width: 1.45, gain: 0 }, 'wide'),
  preset('vocoder', 'Init Vocoder', {}, 'basic'),
  preset('vocoder', 'Robot Choir', { bands: 14, formant: 5, release: 0.25, carrier: 1, mix: 0.9 }, 'robot'),
  preset('vocoder', 'Talking Bass', { bands: 8, formant: -7, release: 0.05, carrier: 0, mix: 0.8 }, 'bass talk'),
  preset('resonator', 'Init Resonator', {}, 'basic'),
  preset('resonator', 'Cathedral Strings', { root: 48, partials: 7, spread: 1.6, decay: 2.2, damp: 6500, mix: 0.6 }, 'strings'),
  preset('resonator', 'Metal Bell', { root: 64, partials: 8, spread: 2.1, decay: 1.4, damp: 9000, mix: 0.7 }, 'bell'),
  preset('resonator', 'Dub Stab', { root: 40, partials: 5, spread: 1.2, decay: 0.5, damp: 3200, mix: 0.5 }, 'dub'),
  preset('spectral', 'Init Spectral', {}, 'basic'),
  preset('spectral', 'Frozen Glass', { blur: 0.85, shift: 7, motion: 0.1, feedback: 0.6, mix: 0.6 }, 'glass'),
  preset('spectral', 'Shimmer Cloud', { blur: 1, shift: 12, motion: 0.4, feedback: 0.75, mix: 0.45 }, 'shimmer'),
  preset('looper', 'Init Looper', {}, 'basic'),
  preset('looper', 'Two Bar Loop', { length: 2, feedback: 0.7, speed: 1, mix: 0.75 }, '2 bar'),
  preset('looper', 'Tape Echo Loop', { length: 1.2, feedback: 0.55, speed: 0.8, mix: 0.6 }, 'tape'),
]

export function presetsFor(type: DeviceType): DevicePreset[] {
  return PRESETS.filter((p) => p.type === type)
}
