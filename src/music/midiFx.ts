// ---------------------------------------------------------------------------
// MIDI effects: arpeggiator, chord generator, scale quantizer, randomizer and
// humanizer. Pure note transformations — usable on any clip and by voice.
// ---------------------------------------------------------------------------

import type { Note } from '../state/types'
import { uid, SCALES } from '../state/types'
import { chordForDegree, scalePitches, snapToScale } from './theory'
import { chordPitches } from '../data/chords'

export type ArpMode = 'up' | 'down' | 'updown' | 'random' | 'as-played'
export type ArpRate = 0.25 | 0.5 | 1

export interface ArpOptions {
  mode?: ArpMode
  rate?: ArpRate
  octaves?: number
  gate?: number
}

/** Turn held notes into a rhythmic arpeggio across the clip. */
export function arpeggiate(notes: Note[], opts: ArpOptions = {}): Note[] {
  const mode = opts.mode ?? 'up'
  const rate = opts.rate ?? 0.5
  const octaves = Math.max(1, Math.min(4, opts.octaves ?? 1))
  const gate = Math.max(0.1, Math.min(1, opts.gate ?? 0.85))
  if (!notes.length) return []
  const sorted = [...notes].sort((a, b) => a.start - b.start)
  const start = Math.min(...sorted.map((n) => n.start))
  const end = Math.max(...sorted.map((n) => n.start + n.len))
  const pitches: number[] = []
  for (let o = 0; o < octaves; o++) {
    const order = [...new Set(sorted.map((n) => n.pitch + o * 12))]
    if (mode === 'down') order.sort((a, b) => b - a)
    else if (mode === 'as-played') sorted.forEach((n) => order.push(n.pitch + o * 12))
    else order.sort((a, b) => a - b)
    if (mode === 'updown' && order.length > 2) {
      const down = [...order].reverse().slice(1, -1)
      pitches.push(...order, ...down)
    } else {
      pitches.push(...order)
    }
  }
  if (!pitches.length) return []
  const out: Note[] = []
  let t = start
  let i = 0
  while (t < end - 1e-6) {
    const pitch = mode === 'random' ? pitches[Math.floor(Math.random() * pitches.length)] : pitches[i % pitches.length]
    out.push({ id: uid('nt'), pitch, start: t, len: Math.max(0.05, rate * gate), vel: 0.78 })
    t = Math.round((t + rate) * 1000) / 1000
    i++
  }
  return out
}

export type ChordMode = 'triad' | 'seventh' | 'sus4' | 'octave' | 'diatonic'

/** Stack a chord under every played note. */
export function generateChords(notes: Note[], opts: { mode?: ChordMode; rootPc?: number; scale?: string } = {}): Note[] {
  const mode = opts.mode ?? 'triad'
  const rootPc = opts.rootPc ?? 0
  const scale = opts.scale ?? 'Minor'
  const out: Note[] = []
  for (const n of notes) {
    const degree = Math.max(0, Math.min(6, Math.round(((n.pitch - 48 - rootPc) / 12) * 7)))
    let pitches: number[]
    if (mode === 'diatonic') pitches = chordForDegree(rootPc, scale, degree)
    else if (mode === 'seventh') pitches = [0, 4, 7, 11].map((i) => n.pitch + i)
    else if (mode === 'sus4') pitches = [0, 5, 7].map((i) => n.pitch + i)
    else if (mode === 'octave') pitches = [0, 12]
    else pitches = [0, 3, 7].map((i) => n.pitch + i)
    pitches.forEach((pitch, i) => {
      out.push({ id: uid('nt'), pitch, start: n.start, len: n.len, vel: i === 0 ? n.vel : n.vel * 0.82 })
    })
  }
  return out.sort((a, b) => a.start - b.start || a.pitch - b.pitch)
}

/** Snap notes into a scale. Returns the same note ids and timing. */
export function quantizeToScale(notes: Note[], rootPc: number, scale: string): Note[] {
  return notes.map((n) => ({ ...n, pitch: snapToScale(n.pitch, rootPc, scale) }))
}

export function randomizeNotes(
  notes: Note[],
  opts: { velocity?: number; length?: number; probability?: number; seed?: number } = {},
): Note[] {
  const vAmt = opts.velocity ?? 0.2
  const lAmt = opts.length ?? 0.2
  const prob = opts.probability ?? 1
  let s = (opts.seed ?? 1234567) >>> 0
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
  return notes
    .filter(() => rnd() <= prob)
    .map((n) => {
      const vel = Math.max(0.05, Math.min(1, n.vel * (1 - vAmt / 2 + rnd() * vAmt)))
      const len = Math.max(0.05, n.len * (1 - lAmt / 2 + rnd() * lAmt))
      return { ...n, id: n.id, vel: Math.round(vel * 1000) / 1000, len: Math.round(len * 1000) / 1000 }
    })
}

export function humanizeNotes(
  notes: Note[],
  opts: { timing?: number; velocity?: number; spread?: number; seed?: number } = {},
): Note[] {
  const timing = opts.timing ?? 0.035
  const velAmt = opts.velocity ?? 0.08
  let s = (opts.seed ?? 987654321) >>> 0
  const rnd = () => {
    s = (s * 1103515245 + 12345) >>> 0
    return s / 4294967296 - 0.5
  }
  return notes.map((n) => ({
    ...n,
    start: Math.max(0, Math.round((n.start + rnd() * timing) * 1000) / 1000),
    len: Math.max(0.05, Math.round((n.len + rnd() * timing * 0.6) * 1000) / 1000),
    vel: Math.max(0.05, Math.min(1, Math.round((n.vel + rnd() * velAmt) * 1000) / 1000)),
  }))
}

/** Notes in the clip ordered for chord detection (lowest first). */
export function chordNamesIn(notes: Note[], scale = 'Minor', rootPc = 0): string[] {
  const pitches = scalePitches(rootPc, scale, 36, 96)
  void pitches
  const groups = new Map<number, Set<number>>()
  for (const n of notes) {
    const k = Math.round(n.start * 4) / 4
    if (!groups.has(k)) groups.set(k, new Set())
    groups.get(k)!.add(n.pitch % 12)
  }
  return [...groups.values()].slice(0, 8).map((pcs) => [...pcs].map((p) => p).join(','))
}

export const MIDI_FX_PRESETS = [
  { id: 'arp_up', name: 'Arp Up 1/8', run: (n: Note[]) => arpeggiate(n, { mode: 'up', rate: 0.5 }) },
  { id: 'arp_down', name: 'Arp Down 1/8', run: (n: Note[]) => arpeggiate(n, { mode: 'down', rate: 0.5 }) },
  { id: 'arp_updown', name: 'Arp Up/Down 1/16', run: (n: Note[]) => arpeggiate(n, { mode: 'updown', rate: 0.25 }) },
  { id: 'arp_oct', name: 'Arp Octaves', run: (n: Note[]) => arpeggiate(n, { mode: 'up', rate: 0.5, octaves: 2 }) },
  { id: 'chord_triad', name: 'Chord Triads', run: (n: Note[]) => generateChords(n, { mode: 'triad' }) },
  { id: 'chord_7th', name: 'Chord 7ths', run: (n: Note[]) => generateChords(n, { mode: 'seventh' }) },
  { id: 'chord_sus', name: 'Chord Sus4', run: (n: Note[]) => generateChords(n, { mode: 'sus4' }) },
  { id: 'chord_diatonic', name: 'Diatonic Stack', run: (n: Note[]) => generateChords(n, { mode: 'diatonic' }) },
] as const

export function scaleNotesInRange(rootPc: number, scale: string, low = 48, high = 84): number[] {
  const iv = SCALES[scale] ?? SCALES.Major
  const out: number[] = []
  for (let p = low; p <= high; p++) if (iv.includes((((p - rootPc) % 12) + 12) % 12)) out.push(p)
  return out
}

export { chordPitches }
