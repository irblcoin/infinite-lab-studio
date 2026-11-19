import type { DeviceType, Params } from '../state/types'
import type { DrumVoice } from '../audio/drums'
import { createEffect } from '../audio/effects'
import { playInstrument } from '../audio/instruments'
import { mulberry32 } from '../music/theory'
import type { DrumStyle } from '../music/theory'
import { DEVICE_DEFS, PRESETS } from './deviceDefs'
import { registerBuffer, markPending, hasBuffer } from '../audio/assets'

export type LibCategory = 'Drums' | 'Instruments' | 'Synth' | 'Effects' | 'Loops' | 'Samples'

export type LoopRole = 'drums' | 'bass' | 'chords' | 'melody' | 'arp' | 'keys' | 'full'

export interface LoopSpec {
  genre: string
  style: DrumStyle
  role: LoopRole
  bars: number
  bpm: number
  seed: number
  swing: number
  instrument?: DeviceType
  params?: Params
}

export interface SampleSpec {
  type: DeviceType
  params: Params
  pitches: number[]
  dur: number
  spacing: number
  fx?: 'reverb' | 'delay' | 'distortion'
  fxParams?: Params
}

export interface LibItem {
  id: string
  name: string
  category: LibCategory
  kind: 'drum' | 'sample' | 'instrument' | 'effect' | 'loop'
  tags: string
  drum?: {
    kind: DrumVoice
    kit: number
    tune: number
    decay: number
    tone: number
    snap: number
    drive: number
  }
  sample?: SampleSpec
  device?: { type: DeviceType; presetName: string; params: Params }
  loop?: LoopSpec
  durationHint?: number
}

export const LIB_CATEGORIES: LibCategory[] = ['Drums', 'Instruments', 'Synth', 'Effects', 'Loops', 'Samples']

function presetParams(type: DeviceType, name: string): Params {
  const p = PRESETS.find((x) => x.type === type && x.name === name)
  if (p) return { ...p.params }
  const out: Params = {}
  for (const d of DEVICE_DEFS[type].params) out[d.key] = d.def
  return out
}

// ---------------------------------------------------------------------------
// Drums: 80 synthesized one-shots
// ---------------------------------------------------------------------------
const DRUM_TARGETS: { kind: DrumVoice; label: string; tags: string; count: number }[] = [
  { kind: 'kick', label: 'Kick', tags: 'kick low end', count: 8 },
  { kind: 'snare', label: 'Snare', tags: 'snare backbeat', count: 8 },
  { kind: 'clap', label: 'Clap', tags: 'clap layer', count: 6 },
  { kind: 'rim', label: 'Rim', tags: 'rim click', count: 4 },
  { kind: 'hat', label: 'Closed Hat', tags: 'hat hihat', count: 6 },
  { kind: 'ohat', label: 'Open Hat', tags: 'hat open hihat', count: 5 },
  { kind: 'tomL', label: 'Low Tom', tags: 'tom', count: 4 },
  { kind: 'tomM', label: 'Mid Tom', tags: 'tom', count: 4 },
  { kind: 'tomH', label: 'High Tom', tags: 'tom', count: 4 },
  { kind: 'crash', label: 'Crash', tags: 'crash cymbal', count: 4 },
  { kind: 'ride', label: 'Ride', tags: 'ride cymbal', count: 3 },
  { kind: 'cowbell', label: 'Cowbell', tags: 'cowbell', count: 3 },
  { kind: 'shaker', label: 'Shaker', tags: 'shaker percussion', count: 4 },
  { kind: 'perc', label: 'Perc', tags: 'percussion', count: 5 },
  { kind: 'snap', label: 'Snap', tags: 'snap finger', count: 4 },
  { kind: 'sub', label: 'Sub Boom', tags: 'sub boom', count: 8 },
]

const DRUM_FLAVOURS = [
  'Deep',
  'Punchy',
  'Dusty',
  'Neon',
  'Vintage',
  'Tape',
  'Sub',
  'Crisp',
  'Warm',
  'Gritty',
  'Tight',
  'Wide',
  'Analog',
  'Digital',
  'Smoked',
  'Silver',
  'Velvet',
  'Midnight',
]

function buildDrums(): LibItem[] {
  const items: LibItem[] = []
  let seed = 101
  for (const target of DRUM_TARGETS) {
    for (let i = 0; i < target.count; i++) {
      const rng = mulberry32(seed++)
      const kit = Math.floor(rng() * 4)
      const tune = Math.round((rng() * 10 - 5) * 2) / 2
      const decay = 0.6 + rng() * 1.1
      const tone = rng() * 2 - 1
      const snap = 0.15 + rng() * 0.85
      const drive = rng() > 0.7 ? rng() * 0.6 : 0
      const flavour = DRUM_FLAVOURS[(seed + i * 3) % DRUM_FLAVOURS.length]
      items.push({
        id: `dr_${target.kind}_${i}`,
        name: `${flavour} ${target.label}${target.count > 1 ? ` ${String(i + 1).padStart(2, '0')}` : ''}`,
        category: 'Drums',
        kind: 'drum',
        tags: `${target.tags} ${flavour.toLowerCase()} ${['analog', '808', '909', 'acoustic'][kit]}`,
        drum: { kind: target.kind, kit, tune, decay, tone, snap, drive },
        durationHint: 1.6,
      })
    }
  }
  return items
}

// ---------------------------------------------------------------------------
// Samples: 70 textured one-shots / chords / risers
// ---------------------------------------------------------------------------
interface SampleArchetype {
  label: string
  tags: string
  type: DeviceType
  pitches: number[]
  dur: number
  spacing?: number
  fx?: 'reverb' | 'delay' | 'distortion'
}

const SAMPLE_ARCHETYPES: SampleArchetype[] = [
  { label: 'Riser', tags: 'riser transition sweep', type: 'pad', pitches: [48, 55, 60, 67], dur: 2.4, spacing: 0.45, fx: 'reverb' },
  { label: 'Downlifter', tags: 'downlifter sweep transition', type: 'pad', pitches: [72, 65, 60, 48], dur: 2.2, spacing: 0.4, fx: 'reverb' },
  { label: 'Impact', tags: 'impact hit boom', type: 'eight08', pitches: [36], dur: 2, fx: 'reverb' },
  { label: 'Texture', tags: 'texture atmosphere noise', type: 'pad', pitches: [52, 59], dur: 3.2, fx: 'reverb' },
  { label: 'Chord', tags: 'chord stab keys', type: 'keys', pitches: [60, 64, 67, 71], dur: 2, fx: 'reverb' },
  { label: 'Vox Pad', tags: 'vocal vox choir ooh', type: 'pad', pitches: [57, 60, 64], dur: 2.8, fx: 'reverb' },
  { label: 'Bell', tags: 'bell chime metallic', type: 'fm', pitches: [72, 76], dur: 2.4, fx: 'delay' },
  { label: 'Pluck', tags: 'pluck string harp', type: 'pluck', pitches: [64, 67, 72], dur: 1.6, spacing: 0.18 },
  { label: 'Drone', tags: 'drone dark low', type: 'pad', pitches: [45, 45, 52], dur: 3.4, fx: 'reverb' },
  { label: 'Foley', tags: 'foley click foley noise', type: 'pluck', pitches: [48], dur: 1.2, fx: 'distortion' },
]

const SAMPLE_FLAVOURS = ['Dusty', 'Cinematic', 'Analog', 'Neon', 'Tape', 'Glass', 'Velvet', 'Warehouse', 'Midnight', 'Sunset', 'Velour', 'Static']

function buildSamples(): LibItem[] {
  const items: LibItem[] = []
  let seed = 901
  for (const arch of SAMPLE_ARCHETYPES) {
    for (let v = 0; v < 7; v++) {
      const rng = mulberry32(seed++)
      const type = arch.type
      const base = presetParams(type, '')
      const params: Params = { ...base }
      if (type === 'pad') {
        params.attack = 0.05 + rng() * 0.6
        params.release = 1 + rng() * 1.6
        params.cutoff = 700 + rng() * 4200
      }
      if (type === 'keys') {
        params.bell = rng()
        params.decay = 0.8 + rng() * 1.4
      }
      if (type === 'pluck') {
        params.decay = 0.4 + rng() * 1.2
        params.bright = rng()
      }
      if (type === 'eight08') {
        params.decay = 0.6 + rng() * 1.8
        params.drive = 0.2 + rng() * 0.7
      }
      if (type === 'fm') params.ratio = 1 + Math.floor(rng() * 6)
      const flavour = SAMPLE_FLAVOURS[(seed + v) % SAMPLE_FLAVOURS.length]
      items.push({
        id: `smp_${arch.label.toLowerCase().replace(/\s+/g, '_')}_${v}`,
        name: `${flavour} ${arch.label} ${String(v + 1).padStart(2, '0')}`,
        category: 'Samples',
        kind: 'sample',
        tags: `${arch.tags} ${flavour.toLowerCase()}`,
        sample: {
          type,
          params,
          pitches: arch.pitches.map((p) => p + (rng() > 0.6 ? 12 : 0)),
          dur: arch.dur,
          spacing: arch.spacing ?? 0,
          fx: arch.fx,
          fxParams: { mix: 0.2 + rng() * 0.3, decay: 1.5 + rng() * 2 },
        },
        durationHint: arch.dur + 2,
      })
    }
  }
  return items
}

// ---------------------------------------------------------------------------
// Instruments + effects pulled from the device preset library
// ---------------------------------------------------------------------------
function buildInstruments(): LibItem[] {
  return PRESETS.filter((p) => DEVICE_DEFS[p.type].category === 'instrument').map((p) => ({
    id: `inst_${p.id.replace(/[^a-z0-9]+/gi, '_')}`,
    name: p.name,
    category: 'Synth' as LibCategory,
    kind: 'instrument' as const,
    tags: `${p.tags} ${DEVICE_DEFS[p.type].name.toLowerCase()} synth instrument ${p.type}`,
    device: { type: p.type, presetName: p.name, params: { ...p.params } },
  }))
}

function buildEffects(): LibItem[] {
  return PRESETS.filter((p) => DEVICE_DEFS[p.type].category === 'effect').map((p) => ({
    id: `fx_${p.id.replace(/[^a-z0-9]+/gi, '_')}`,
    name: p.name,
    category: 'Effects' as LibCategory,
    kind: 'effect' as const,
    tags: `${p.tags} ${DEVICE_DEFS[p.type].name.toLowerCase()} effect ${p.type}`,
    device: { type: p.type, presetName: p.name, params: { ...p.params } },
  }))
}

// ---------------------------------------------------------------------------
// Loops: 56 generated, tempo-aware patterns
// ---------------------------------------------------------------------------
const GENRE_LOOPS: {
  label: string
  genre: string
  bpm: number
  style: DrumStyle
  flavour: string[]
  chordsType: DeviceType
  bassType: DeviceType
  melodyType: DeviceType
}[] = [
  {
    label: 'Hip Hop',
    genre: 'hiphop',
    bpm: 90,
    style: 'boombap',
    flavour: ['Boom Bap', 'Dusty', 'Crate', 'Sunday', 'Lowlight', 'Golden', 'Corner'],
    chordsType: 'keys',
    bassType: 'bass',
    melodyType: 'pluck',
  },
  {
    label: 'Trap',
    genre: 'trap',
    bpm: 140,
    style: 'trap',
    flavour: ['Dark', 'Night', 'Rolling', 'Smoke', 'Ice', 'Void', 'Pulse'],
    chordsType: 'pad',
    bassType: 'eight08',
    melodyType: 'fm',
  },
  {
    label: 'R&B',
    genre: 'rnb',
    bpm: 86,
    style: 'rnb',
    flavour: ['Silk', 'Velvet', 'Late', 'Honey', 'Slow', 'Gold', 'Warm'],
    chordsType: 'keys',
    bassType: 'bass',
    melodyType: 'pluck',
  },
  {
    label: 'Pop',
    genre: 'pop',
    bpm: 112,
    style: 'pop',
    flavour: ['Bright', 'Radio', 'Neon', 'Sunrise', 'Super', 'Clean', 'Big'],
    chordsType: 'pad',
    bassType: 'bass',
    melodyType: 'pluck',
  },
  {
    label: 'Dream Pop',
    genre: 'dreampop',
    bpm: 96,
    style: 'lofi',
    flavour: ['Haze', 'Cloud', 'Glass', 'Drift', 'Bloom', 'Soft', 'Faded'],
    chordsType: 'pad',
    bassType: 'bass',
    melodyType: 'strings',
  },
  {
    label: 'EDM',
    genre: 'edm',
    bpm: 126,
    style: 'four-floor',
    flavour: ['Festival', 'Peak', 'Laser', 'Anthem', 'Mainstage', 'Strobe', 'Rush'],
    chordsType: 'pad',
    bassType: 'bass',
    melodyType: 'synth',
  },
  {
    label: 'Rock',
    genre: 'rock',
    bpm: 118,
    style: 'rock',
    flavour: ['Garage', 'Drive', 'Fuzz', 'Amp', 'Sweat', 'Tape', 'Loud'],
    chordsType: 'strings',
    bassType: 'bass',
    melodyType: 'pluck',
  },
  {
    label: 'Lo-Fi',
    genre: 'lofi',
    bpm: 78,
    style: 'lofi',
    flavour: ['Rainy', 'Study', 'Tape', 'Coffee', 'Dust', 'Sleepy', 'Analog'],
    chordsType: 'keys',
    bassType: 'bass',
    melodyType: 'pluck',
  },
]

function buildLoops(): LibItem[] {
  const items: LibItem[] = []
  let seed = 3001
  for (const g of GENRE_LOOPS) {
    const roles: { role: LoopRole; label: string; bars: number; instrument?: DeviceType }[] = [
      { role: 'drums', label: 'Drums 01', bars: 2 },
      { role: 'drums', label: 'Drums 02', bars: 4 },
      { role: 'bass', label: 'Bass', bars: 4, instrument: g.bassType },
      { role: 'chords', label: 'Chords', bars: 4, instrument: g.chordsType },
      { role: 'melody', label: 'Melody', bars: 4, instrument: g.melodyType },
      { role: 'arp', label: 'Arp', bars: 2, instrument: 'synth' },
      { role: 'full', label: 'Full Groove', bars: 4 },
    ]
    for (const r of roles) {
      const flavour = g.flavour[Math.floor(mulberry32(seed)() * g.flavour.length)]
      const style = r.role === 'drums' && r.label.endsWith('02') ? g.style : g.style
      items.push({
        id: `loop_${g.genre}_${r.role}_${r.label.replace(/\s+/g, '').toLowerCase()}`,
        name: `${flavour} ${g.label} ${r.label}`,
        category: 'Loops',
        kind: 'loop',
        tags: `${g.genre} ${g.label.toLowerCase()} ${r.role} loop ${g.bpm}bpm ${g.style}`,
        loop: {
          genre: g.genre,
          style,
          role: r.role,
          bars: r.bars,
          bpm: g.bpm,
          seed: seed++,
          swing: g.genre === 'lofi' || g.genre === 'hiphop' ? 0.35 : g.genre === 'edm' ? 0 : 0.15,
          instrument: r.instrument,
          params: r.instrument ? presetParams(r.instrument, '') : undefined,
        },
      })
    }
  }
  return items
}

export const LIBRARY: LibItem[] = [...buildDrums(), ...buildInstruments(), ...buildEffects(), ...buildLoops(), ...buildSamples()]

export const SOUND_COUNT = LIBRARY.filter((i) => i.kind !== 'loop' && i.kind !== 'effect').length
export const LOOP_COUNT = LIBRARY.filter((i) => i.kind === 'loop').length

export function libById(id: string): LibItem | undefined {
  return LIBRARY.find((i) => i.id === id)
}

export function searchLibrary(query: string, category: LibCategory | 'All'): LibItem[] {
  const q = query.trim().toLowerCase()
  return LIBRARY.filter((item) => {
    if (category !== 'All' && item.category !== category) return false
    if (!q) return true
    return (
      item.name.toLowerCase().includes(q) ||
      item.tags.toLowerCase().includes(q) ||
      item.category.toLowerCase().includes(q)
    )
  })
}

// ---------------------------------------------------------------------------
// Offline rendering of library sounds
// ---------------------------------------------------------------------------
async function renderItem(item: LibItem): Promise<AudioBuffer> {
  if (item.kind === 'drum' && item.drum) {
    const { renderDrumOneShot } = await import('../audio/drums')
    return renderDrumOneShot({
      kind: item.drum.kind,
      kit: item.drum.kit,
      tune: item.drum.tune,
      decay: item.drum.decay,
      tone: item.drum.tone,
      snap: item.drum.snap,
      drive: item.drum.drive,
    })
  }
  if (item.kind === 'sample' && item.sample) {
    const spec = item.sample
    const sr = 44100
    const ctx = new OfflineAudioContext(2, Math.ceil((spec.dur + 2.5) * sr), sr)
    const master = ctx.createGain()
    master.gain.value = 0.8
    let tail: AudioNode = master
    if (spec.fx) {
      const fx = createEffect(ctx, spec.fx === 'reverb' ? 'reverb' : spec.fx === 'delay' ? 'delay' : 'distortion', {
        ...(spec.fx === 'reverb'
          ? { size: 0.7, decay: 2.4, predelay: 0.02, damp: 0.4, lowcut: 120, mix: spec.fxParams?.mix ?? 0.35 }
          : spec.fx === 'delay'
            ? { time: 0.4, feedback: 0.35, tone: 5200, ping: 1, mix: spec.fxParams?.mix ?? 0.3 }
            : { drive: 8, tone: 4200, output: 0.7, bias: 0, mix: 0.5 }),
      })
      fx.output.connect(master)
      tail = fx.input
    }
    const step = spec.spacing || 0
    spec.pitches.forEach((pitch, i) => {
      playInstrument({
        ctx,
        type: spec.type,
        params: spec.params,
        dest: tail,
        time: 0.02 + i * step,
        dur: Math.max(0.25, spec.dur - i * step),
        pitch,
        vel: 0.85,
      })
    })
    master.connect(ctx.destination)
    return ctx.startRendering()
  }
  throw new Error(`No renderer for ${item.id}`)
}

export async function ensureLibraryBuffer(id: string): Promise<AudioBuffer | null> {
  if (hasBuffer(id)) {
    const { getBuffer } = await import('../audio/assets')
    return getBuffer(id)
  }
  if (!markPending(id)) return null
  const item = libById(id)
  if (!item || item.kind === 'loop' || item.kind === 'effect' || item.kind === 'instrument') return null
  try {
    const buf = await renderItem(item)
    registerBuffer(id, buf)
    return buf
  } catch (err) {
    console.warn('library render failed', id, err)
    return null
  }
}

/** Render an instrument or effect preview phrase through the requested device. */
export function previewPhraseSpec(item: LibItem): { type: DeviceType; params: Params } | null {
  if (item.kind === 'instrument' && item.device) return { type: item.device.type, params: item.device.params }
  if (item.kind === 'effect' && item.device) return { type: 'synth', params: presetParams('synth', '') }
  return null
}
