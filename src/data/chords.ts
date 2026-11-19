// ---------------------------------------------------------------------------
// Chord library: voicings, roman-numeral progressions and mood presets.
// All free-standing music theory — no samples, no network.
// ---------------------------------------------------------------------------

import { NOTE_NAMES } from '../state/types'

export interface ChordVoicing {
  id: string
  name: string
  /** Semitones from the chord root, in playing order. */
  intervals: number[]
  /** Human-readable suffix used in progression text. */
  suffix: string
  family: 'triad' | 'seventh' | 'extended' | 'sus' | 'power'
}

export const CHORD_VOICINGS: ChordVoicing[] = [
  { id: 'maj', name: 'Major', intervals: [0, 4, 7], suffix: '', family: 'triad' },
  { id: 'min', name: 'Minor', intervals: [0, 3, 7], suffix: 'm', family: 'triad' },
  { id: 'dim', name: 'Diminished', intervals: [0, 3, 6], suffix: 'dim', family: 'triad' },
  { id: 'aug', name: 'Augmented', intervals: [0, 4, 8], suffix: 'aug', family: 'triad' },
  { id: 'sus2', name: 'Sus2', intervals: [0, 2, 7], suffix: 'sus2', family: 'sus' },
  { id: 'sus4', name: 'Sus4', intervals: [0, 5, 7], suffix: 'sus4', family: 'sus' },
  { id: 'maj7', name: 'Major 7', intervals: [0, 4, 7, 11], suffix: 'maj7', family: 'seventh' },
  { id: 'min7', name: 'Minor 7', intervals: [0, 3, 7, 10], suffix: 'm7', family: 'seventh' },
  { id: 'dom7', name: 'Dominant 7', intervals: [0, 4, 7, 10], suffix: '7', family: 'seventh' },
  { id: 'min7b5', name: 'Half diminished', intervals: [0, 3, 6, 10], suffix: 'm7b5', family: 'seventh' },
  { id: 'maj9', name: 'Major 9', intervals: [0, 4, 7, 11, 14], suffix: 'maj9', family: 'extended' },
  { id: 'min9', name: 'Minor 9', intervals: [0, 3, 7, 10, 14], suffix: 'm9', family: 'extended' },
  { id: 'add9', name: 'Add 9', intervals: [0, 4, 7, 14], suffix: 'add9', family: 'extended' },
  { id: 'six', name: 'Six', intervals: [0, 4, 7, 9], suffix: '6', family: 'extended' },
  { id: 'power', name: 'Power', intervals: [0, 7, 12], suffix: '5', family: 'power' },
]

export interface ProgressionPreset {
  id: string
  name: string
  /** Roman numerals (major-scale degrees, case = minor quality). */
  degrees: number[]
  quality: string[]
  mood: string[]
  /** Suggested chord rhythm: beats per chord. */
  beatsPerChord: number
}

/** Degree numbers are 0-based scale degrees; quality picks a triad variant. */
export const PROGRESSIONS: ProgressionPreset[] = [
  { id: 'pop_axis', name: 'Pop axis (I–V–vi–IV)', degrees: [0, 4, 5, 3], quality: ['maj', 'maj', 'min', 'maj'], mood: ['happy', 'bright', 'pop'], beatsPerChord: 4 },
  { id: 'minor_epic', name: 'Minor epic (i–VI–III–VII)', degrees: [0, 5, 2, 6], quality: ['min', 'maj', 'maj', 'maj'], mood: ['dark', 'epic', 'cinematic'], beatsPerChord: 4 },
  { id: 'trap_dark', name: 'Trap dark (i–iv–VI–v)', degrees: [0, 3, 5, 4], quality: ['min', 'min', 'maj', 'min'], mood: ['dark', 'trap', 'moody'], beatsPerChord: 4 },
  { id: 'rnb_smooth', name: 'R&B smooth (ii–V–I–vi)', degrees: [1, 4, 0, 5], quality: ['min7', 'dom7', 'maj7', 'min7'], mood: ['smooth', 'rnb', 'warm'], beatsPerChord: 4 },
  { id: 'lofi_loop', name: 'Lo-fi loop (i–VII–VI–VII)', degrees: [0, 6, 5, 6], quality: ['min7', 'maj7', 'maj7', 'dom7'], mood: ['chill', 'lofi', 'sad'], beatsPerChord: 4 },
  { id: 'house_loop', name: 'House loop (i–VI–III–VII)', degrees: [0, 5, 2, 6], quality: ['min7', 'maj7', 'maj7', 'dom7'], mood: ['uplifting', 'house', 'edm'], beatsPerChord: 2 },
  { id: 'jazz_turn', name: 'Jazz turnaround (I–vi–ii–V)', degrees: [0, 5, 1, 4], quality: ['maj7', 'min7', 'min7', 'dom7'], mood: ['jazz', 'sophisticated'], beatsPerChord: 4 },
  { id: 'drill_slide', name: 'Drill slide (i–VI–iv–v)', degrees: [0, 5, 3, 4], quality: ['min', 'maj', 'min', 'min'], mood: ['dark', 'drill', 'tense'], beatsPerChord: 4 },
  { id: 'ballad', name: 'Ballad (I–iii–IV–V)', degrees: [0, 2, 3, 4], quality: ['maj', 'min', 'maj', 'maj'], mood: ['sad', 'tender', 'ballad'], beatsPerChord: 4 },
  { id: 'rock_power', name: 'Rock (i–VII–VI–VII)', degrees: [0, 6, 5, 6], quality: ['power', 'power', 'power', 'power'], mood: ['rock', 'angry', 'energetic'], beatsPerChord: 4 },
]

export function rootName(rootPc: number): string {
  return NOTE_NAMES[((rootPc % 12) + 12) % 12]
}

export function voicing(id: string): ChordVoicing {
  return CHORD_VOICINGS.find((v) => v.id === id) ?? CHORD_VOICINGS[0]
}

/** Absolute pitches for a chord, close-voiced from a base octave. */
export function chordPitches(rootPc: number, qualityId: string, base = 48, inversion = 0): number[] {
  const v = voicing(qualityId)
  const root = base + ((((rootPc % 12) + 12) % 12))
  const pitches = v.intervals.map((i) => root + i)
  for (let i = 0; i < inversion; i++) {
    const p = pitches.shift()
    if (p != null) pitches.push(p + 12)
  }
  return pitches
}

export function chordLabel(rootPc: number, qualityId: string): string {
  const v = voicing(qualityId)
  return `${rootName(rootPc)}${v.suffix}`
}

/** Scale degree (0-based) to semitone offset inside a scale. */
export function degreeSemitone(scale: number[], degree: number): number {
  const n = scale.length
  const d = ((degree % n) + n) % n
  return scale[d] + Math.floor(degree / n) * 12
}

export function progressionChords(
  rootPc: number,
  scale: number[],
  preset: ProgressionPreset,
): { label: string; pitches: number[]; degree: number; quality: string }[] {
  return preset.degrees.map((deg, i) => {
    const semis = degreeSemitone(scale, deg)
    const pc = (rootPc + semis) % 12
    return {
      degree: deg,
      quality: preset.quality[i] ?? 'maj',
      label: chordLabel(pc, preset.quality[i] ?? 'maj'),
      pitches: chordPitches(pc, preset.quality[i] ?? 'maj'),
    }
  })
}

export function progressionsForMood(mood: string): ProgressionPreset[] {
  const m = mood.toLowerCase()
  const hits = PROGRESSIONS.filter((p) => p.mood.some((x) => m.includes(x) || x.includes(m)))
  return hits.length ? hits : PROGRESSIONS
}
