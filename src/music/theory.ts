import type { Note } from '../state/types'
import { SCALES, uid } from '../state/types'

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const pick = <T,>(rng: () => number, arr: T[]): T => arr[Math.floor(rng() * arr.length) % arr.length]

export function scaleIntervals(scale: string): number[] {
  return SCALES[scale] || SCALES.Major
}

/** All scale pitches between two midi notes inclusive. */
export function scalePitches(rootPc: number, scale: string, low = 48, high = 84): number[] {
  const iv = scaleIntervals(scale)
  const out: number[] = []
  for (let p = low; p <= high; p++) {
    if (iv.includes((((p - rootPc) % 12) + 12) % 12)) out.push(p)
  }
  return out
}

export function snapToScale(pitch: number, rootPc: number, scale: string): number {
  const iv = scaleIntervals(scale)
  const pc = (((pitch - rootPc) % 12) + 12) % 12
  if (iv.includes(pc)) return pitch
  for (let d = 1; d <= 6; d++) {
    const up = pitch + d
    if (iv.includes(((((up - rootPc) % 12) + 12) % 12))) return up
    const down = pitch - d
    if (iv.includes(((((down - rootPc) % 12) + 12) % 12))) return down
  }
  return pitch
}

export const DEGREE_SEMITONES = [0, 2, 4, 5, 7, 9, 11]

export function chordForDegree(rootPc: number, scale: string, degree: number): number[] {
  const iv = scaleIntervals(scale)
  const n = iv.length
  const d = ((degree % n) + n) % n
  const base = 48 + rootPc
  const semis = [iv[d], iv[(d + 2) % n] + (d + 2 >= n ? 12 : 0), iv[(d + 4) % n] + (d + 4 >= n ? 12 : 0)]
  return semis.map((s) => base + s)
}

export function chordName(rootPc: number, scale: string, degree: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  const iv = scaleIntervals(scale)
  const n = iv.length
  const d = ((degree % n) + n) % n
  const third = (iv[(d + 2) % n] + (d + 2 >= n ? 12 : 0) - iv[d] + 12) % 12
  const root = names[(rootPc + iv[d]) % 12]
  const quality = third === 3 ? 'm' : third === 4 ? '' : third === 5 ? 'sus4' : 'dim'
  return `${root}${quality}`
}

export const GENRE_PROGRESSIONS: Record<string, number[][]> = {
  trap: [
    [0, 5, 3, 4],
    [0, 3, 5, 4],
    [5, 4, 0, 0],
    [0, 0, 5, 6],
  ],
  hiphop: [
    [0, 3, 4, 0],
    [1, 4, 0, 0],
    [0, 5, 3, 4],
  ],
  drill: [
    [0, 5, 2, 6],
    [0, 2, 5, 4],
  ],
  rnb: [
    [1, 4, 0, 5],
    [0, 3, 4, 3],
    [3, 2, 0, 4],
  ],
  pop: [
    [0, 4, 5, 3],
    [5, 3, 0, 4],
    [0, 3, 5, 4],
  ],
  dreampop: [
    [0, 4, 3, 5],
    [5, 3, 0, 4],
    [0, 5, 4, 3],
  ],
  edm: [
    [5, 3, 0, 4],
    [0, 4, 5, 3],
    [0, 5, 3, 4],
  ],
  rock: [
    [0, 4, 5, 3],
    [0, 3, 4, 5],
    [5, 4, 0, 0],
  ],
  lofi: [
    [1, 4, 0, 5],
    [0, 5, 1, 4],
    [3, 4, 0, 0],
  ],
  cinematic: [
    [0, 5, 2, 4],
    [3, 4, 0, 5],
  ],
}

export function progressionFor(genre: string, seed = 1): number[] {
  const list = GENRE_PROGRESSIONS[genre] || GENRE_PROGRESSIONS.pop
  const rng = mulberry32(seed * 977 + 13)
  return pick(rng, list)
}

// Drum pad pitches (match DRUM_PADS order)
export const PAD = {
  kick: 36,
  snare: 37,
  clap: 38,
  rim: 39,
  ch: 40,
  oh: 41,
  tomL: 42,
  tomM: 43,
  tomH: 44,
  crash: 45,
  ride: 46,
  cowbell: 47,
  shaker: 48,
  perc: 49,
  snap: 50,
  sub: 51,
}

const n = (pitch: number, start: number, len: number, vel: number): Note => ({
  id: uid('nt'),
  pitch,
  start,
  len,
  vel,
})

export type DrumStyle =
  | 'trap'
  | 'trap-halftime'
  | 'drill'
  | 'boombap'
  | 'four-floor'
  | 'house'
  | 'rnb'
  | 'rock'
  | 'lofi'
  | 'pop'
  | 'edm'
  | 'breakbeat'

export interface PatternArgs {
  bars: number
  seed: number
  swing?: number
  density?: number
}

/** Build a drum pattern in 16th notes. */
export function drumPattern(style: DrumStyle, args: PatternArgs): Note[] {
  const rng = mulberry32(args.seed || 7)
  const bars = Math.max(1, args.bars)
  const stepsPerBar = 16
  const notes: Note[] = []
  const add = (pitch: number, step: number, vel: number, len = 0.12) => {
    notes.push(n(pitch, step * 0.25, len, Math.max(0.12, Math.min(1, vel))))
  }
  const density = args.density ?? 1

  for (let bar = 0; bar < bars; bar++) {
    const b = bar * stepsPerBar
    const last = bar === bars - 1
    switch (style) {
      case 'trap':
      case 'drill': {
        add(PAD.kick, b + 0, 1)
        if (rng() > 0.3) add(PAD.kick, b + 7, 0.85)
        if (rng() > 0.55) add(PAD.kick, b + 11, 0.8)
        if (rng() > 0.7) add(PAD.kick, b + 14, 0.7)
        add(PAD.snare, b + 4, 0.9)
        add(PAD.snare, b + 12, 0.95)
        if (style === 'drill') add(PAD.snare, b + 10, 0.55)
        for (let s = 0; s < 16; s++) {
          if (s % 2 === 0) add(PAD.ch, b + s, s % 4 === 0 ? 0.62 : 0.4, 0.1)
          else if (rng() > 0.55) add(PAD.ch, b + s, 0.24, 0.08)
        }
        if (rng() > 0.5) add(PAD.oh, b + 14, 0.4, 0.3)
        if (bar === 0) add(PAD.crash, b, 0.4, 0.5)
        if (last) add(PAD.oh, b + 15, 0.3)
        if (rng() > 0.7) add(PAD.clap, b + 12, 0.4)
        break
      }
      case 'trap-halftime': {
        add(PAD.kick, b + 0, 1)
        add(PAD.kick, b + 10, 0.85)
        add(PAD.snare, b + 8, 0.95)
        for (let s = 0; s < 16; s += 2) add(PAD.ch, b + s, s % 4 === 0 ? 0.5 : 0.32, 0.1)
        add(PAD.oh, b + 6, 0.35, 0.35)
        add(PAD.oh, b + 14, 0.3, 0.3)
        break
      }
      case 'boombap':
      case 'lofi': {
        add(PAD.kick, b + 0, 0.95)
        add(PAD.kick, b + 6, 0.8)
        if (rng() > 0.5) add(PAD.kick, b + 10, 0.75)
        add(PAD.snare, b + 4, 0.85)
        add(PAD.snare, b + 12, 0.9)
        for (let s = 0; s < 16; s++) {
          if (s % 2 === 0) add(PAD.ch, b + s, s % 4 === 0 ? 0.5 : 0.3, 0.1)
          else if (rng() > 0.72) add(PAD.ch, b + s, 0.18, 0.08)
        }
        if (style === 'lofi') {
          if (rng() > 0.6) add(PAD.rim, b + 7, 0.3)
          if (last) add(PAD.perc, b + 15, 0.25)
        }
        break
      }
      case 'four-floor':
      case 'house':
      case 'edm': {
        for (let s = 0; s < 16; s += 4) add(PAD.kick, b + s, 0.95, 0.2)
        add(PAD.clap, b + 4, 0.75)
        add(PAD.clap, b + 12, 0.8)
        for (let s = 2; s < 16; s += 4) add(PAD.oh, b + s, 0.42, 0.25)
        if (style === 'house' || style === 'edm') {
          for (let s = 0; s < 16; s += 2) add(PAD.ch, b + s, s % 4 === 0 ? 0.3 : 0.22, 0.08)
        }
        if (rng() > 0.6) add(PAD.shaker, b + 10, 0.22)
        if (bar === 0) add(PAD.crash, b, 0.35, 0.5)
        break
      }
      case 'rnb':
      case 'pop': {
        add(PAD.kick, b + 0, 0.9)
        if (rng() > 0.4) add(PAD.kick, b + 6, 0.72)
        if (rng() > 0.6) add(PAD.kick, b + 11, 0.7)
        add(PAD.snare, b + 4, 0.8)
        add(PAD.snare, b + 12, 0.85)
        for (let s = 0; s < 16; s += 2) add(PAD.ch, b + s, s % 4 === 0 ? 0.4 : 0.24, 0.09)
        if (style === 'rnb' && rng() > 0.5) add(PAD.snap, b + 4, 0.5)
        if (last && rng() > 0.4) add(PAD.oh, b + 14, 0.3, 0.28)
        break
      }
      case 'breakbeat': {
        add(PAD.kick, b + 0, 0.95)
        add(PAD.kick, b + 10, 0.8)
        add(PAD.snare, b + 4, 0.9)
        add(PAD.snare, b + 12, 0.9)
        add(PAD.snare, b + 7, 0.4)
        for (let s = 0; s < 16; s++) if (s % 2 === 0) add(PAD.ch, b + s, 0.3, 0.09)
        break
      }
      case 'rock':
      default: {
        add(PAD.kick, b + 0, 0.95)
        add(PAD.kick, b + 8, 0.85)
        add(PAD.snare, b + 4, 0.9)
        add(PAD.snare, b + 12, 0.9)
        for (let s = 0; s < 16; s++) add(PAD.ch, b + s, s % 2 === 0 ? 0.42 : 0.28, 0.08)
        if (bar === 0) add(PAD.crash, b, 0.45, 0.6)
        break
      }
    }
    // light humanisation
    if (density < 1) {
      for (let i = notes.length - 1; i >= 0; i--) {
        if (notes[i].start >= b * 0.25 && notes[i].start < (b + 16) * 0.25 && rng() > density) notes.splice(i, 1)
      }
    }
  }
  if (args.swing && args.swing > 0) {
    const sw = args.swing * 0.12
    for (const note of notes) {
      const step = note.start / 0.25
      if (Math.abs(step % 4 - 2) < 0.01) note.start += sw
    }
  }
  return notes
}

export interface HarmonyArgs extends PatternArgs {
  genre: string
  rootPc: number
  scale: string
  octave?: number
}

export function chordProgressionNotes(args: HarmonyArgs, style: 'pad' | 'stab' | 'keys' | 'pluck'): Note[] {
  const rng = mulberry32(args.seed + 31)
  const prog = progressionFor(args.genre, args.seed)
  const bars = Math.max(1, args.bars)
  const notes: Note[] = []
  const oct = args.octave ?? 0
  for (let bar = 0; bar < bars; bar++) {
    const degree = prog[bar % prog.length]
    const chord = chordForDegree(args.rootPc, args.scale, degree).map((p) => p + oct * 12)
    const start = bar * 4
    if (style === 'pad') {
      chord.forEach((p) => notes.push(n(p, start, 3.85, 0.7)))
    } else if (style === 'stab') {
      const rhythms = [
        [0, 0.75],
        [0, 1.5],
        [0, 0.5, 1.5],
      ]
      const r = pick(rng, rhythms)
      for (const off of r) chord.forEach((p) => notes.push(n(p, start + off, 0.45, 0.8)))
    } else if (style === 'keys') {
      chord.forEach((p) => notes.push(n(p, start, 2.4, 0.6)))
      chord.forEach((p) => notes.push(n(p, start + 2.5, 1.2, 0.45)))
    } else {
      for (let s = 0; s < 4; s++) {
        chord.forEach((p, i) => {
          if (rng() > 0.15) notes.push(n(p + 12, start + s * 0.5 + i * 0.05, 0.4, 0.6))
        })
      }
    }
  }
  return notes
}

export function bassLineNotes(args: HarmonyArgs): Note[] {
  const rng = mulberry32(args.seed + 77)
  const prog = progressionFor(args.genre, args.seed)
  const bars = Math.max(1, args.bars)
  const notes: Note[] = []
  const rootBase = 36 + args.rootPc
  for (let bar = 0; bar < bars; bar++) {
    const degree = prog[bar % prog.length]
    const chord = chordForDegree(args.rootPc, args.scale, degree)
    const root = rootBase + ((chord[0] - 48) % 12)
    const isTrap = args.genre === 'trap' || args.genre === 'drill'
    if (isTrap) {
      notes.push(n(root, bar * 4, 1.4, 1))
      if (rng() > 0.35) notes.push(n(root, bar * 4 + 1.75, 0.9, 0.85))
      if (rng() > 0.5) notes.push(n(root + 12, bar * 4 + 3, 0.75, 0.7))
    } else if (args.genre === 'edm' || args.genre === 'house') {
      for (let s = 0; s < 8; s++) {
        if (s % 2 === 0) notes.push(n(root + (s === 6 ? 12 : 0), bar * 4 + s * 0.5, 0.42, 0.85))
      }
    } else {
      const pattern = pick(rng, [
        [0, 1, 2, 3],
        [0, 1.5, 2.5, 3],
        [0, 0.75, 2, 2.75],
      ])
      pattern.forEach((p) => notes.push(n(root, bar * 4 + p, 0.55, 0.85)))
      if (rng() > 0.6) notes.push(n(root + 7, bar * 4 + 3.5, 0.4, 0.6))
    }
  }
  return notes
}

export function melodyNotes(args: HarmonyArgs): Note[] {
  const rng = mulberry32(args.seed + 991)
  const pitches = scalePitches(args.rootPc, args.scale, 60 + (args.octave ?? 0) * 12, 84 + (args.octave ?? 0) * 12)
  const prog = progressionFor(args.genre, args.seed)
  const bars = Math.max(1, args.bars)
  const notes: Note[] = []
  const motifs: number[][] = []
  for (let bar = 0; bar < bars; bar++) {
    const degree = prog[bar % prog.length]
    const chord = chordForDegree(args.rootPc, args.scale, degree)
    const chordTones = chord.map((p) => p + 12)
    let motif = motifs[bar % 2]
    if (!motif) {
      motif = []
      const steps = pick(rng, [
        [0, 1, 2, 3.5],
        [0, 0.75, 1.5, 2.5, 3],
        [0, 2, 2.5, 3.5],
      ])
      for (const s of steps) motif.push(s)
      motifs.push(motif)
    }
    for (const s of motif) {
      const useChord = rng() > 0.45
      const pitch = useChord
        ? pick(rng, chordTones)
        : pitches[Math.floor(rng() * pitches.length)]
      const len = pick(rng, [0.5, 0.75, 1, 1.5])
      notes.push(n(Math.max(48, Math.min(96, pitch)), bar * 4 + s, len, 0.62 + rng() * 0.3))
    }
  }
  return notes
}

export function arpNotes(args: HarmonyArgs): Note[] {
  const rng = mulberry32(args.seed + 4021)
  const prog = progressionFor(args.genre, args.seed)
  const bars = Math.max(1, args.bars)
  const notes: Note[] = []
  for (let bar = 0; bar < bars; bar++) {
    const degree = prog[bar % prog.length]
    const chord = chordForDegree(args.rootPc, args.scale, degree).map((p) => p + 12)
    const order = [0, 1, 2, 3, 2, 1]
    for (let s = 0; s < 8; s++) {
      if (rng() > 0.12) {
        notes.push(n(chord[order[s % order.length] % chord.length] + (s > 3 ? 12 : 0), bar * 4 + s * 0.5, 0.4, 0.55))
      }
    }
  }
  return notes
}
