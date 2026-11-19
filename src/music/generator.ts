import type { DeviceType, Note, Params, TrackKind } from '../state/types'
import {
  arpNotes,
  bassLineNotes,
  chordName,
  chordProgressionNotes,
  drumPattern,
  melodyNotes,
  progressionFor,
  scaleIntervals,
  type DrumStyle,
  type HarmonyArgs,
} from './theory'
import type { LoopSpec } from '../data/library'

export interface GeneratedClip {
  startBar: number
  bars: number
  name: string
  notes: Note[]
}

export interface GeneratedTrack {
  name: string
  kind: TrackKind
  color: string
  deviceType: DeviceType
  params: Params
  clips: GeneratedClip[]
  volume?: number
  pan?: number
}

export interface GeneratedProject {
  genre: string
  bpm: number
  keyRoot: string
  scale: string
  bars: number
  tracks: GeneratedTrack[]
  sections: { name: string; startBar: number; bars: number }[]
  progression: string[]
  prompt: string
}

function defaultParams(type: DeviceType): Params {
  // local copy to avoid importing the whole device def bundle twice
  const map: Record<string, Params> = {
    drums: { kit: 0, tune: 0, decay: 1, tone: 0, snap: 0.4, gain: 1 },
    eight08: { drop: 0.55, decay: 1.4, drive: 0.4, tone: 1400, glide: 0.03, click: 0.3 },
    bass: { osc: 0, sub: 0.75, drive: 0.2, cutoff: 420, res: 4, fenv: 0.5, attack: 0.005, decay: 0.4, sustain: 0.6, release: 0.3, glide: 0 },
    pad: { osc: 1, spread: 0.75, cutoff: 2400, movement: 0.5, lfoRate: 0.12, attack: 0.5, decay: 1, sustain: 0.8, release: 1.8 },
    keys: { bell: 0.3, tone: 0.5, tremolo: 0.2, tremRate: 4.2, drive: 0.1, attack: 0.004, decay: 0.7, sustain: 0.35, release: 0.5 },
    pluck: { damp: 0.75, bright: 0.6, decay: 0.5, pick: 0.3, gain: 0.9 },
    synth: { osc: 1, osc2: 2, mix: 0.4, detune: 6, sub: 0.1, cutoff: 3200, res: 3, fenv: 0.5, ftype: 0, attack: 0.01, decay: 0.3, sustain: 0.5, release: 0.35, lfoRate: 0.4, lfoAmt: 0, lfoTarget: 1, drive: 0.1 },
    fm: { ratio: 2, index: 3, detune: 0, tone: 9000, attack: 0.005, decay: 0.6, sustain: 0.3, release: 0.6, vel: 0.5 },
    strings: { vibrato: 0.25, vibRate: 5, ensemble: 0.6, cutoff: 3200, attack: 0.3, decay: 0.6, sustain: 0.8, release: 1.2 },
  }
  return { ...(map[type] || {}) }
}

function withParams(type: DeviceType, extra: Params): Params {
  return { ...defaultParams(type), ...extra }
}

export interface PromptParse {
  genre: string
  bpm: number
  keyRoot: string
  scale: string
  bars: number
  mood: string[]
  prompt: string
}

const NOTE_PC: Record<string, number> = {
  C: 0,
  'C#': 1,
  Db: 1,
  D: 2,
  'D#': 3,
  Eb: 3,
  E: 4,
  F: 5,
  'F#': 6,
  Gb: 6,
  G: 7,
  'G#': 8,
  Ab: 8,
  A: 9,
  'A#': 10,
  Bb: 10,
  B: 11,
}

const GENRE_WORDS: [RegExp, string][] = [
  [/\b(trap|drill)\b/i, 'trap'],
  [/\b(hip[\s-]?hop|boombap|boom bap)\b/i, 'hiphop'],
  [/\b(r&b|rnb|r and b|soul)\b/i, 'rnb'],
  [/\b(dream[\s-]?pop|shoegaze)\b/i, 'dreampop'],
  [/\b(edm|house|techno|dance|rave)\b/i, 'edm'],
  [/\b(rock|guitar|grunge)\b/i, 'rock'],
  [/\b(lo[\s-]?fi|chill|lofi)\b/i, 'lofi'],
  [/\b(pop)\b/i, 'pop'],
  [/\b(cinematic|score|film)\b/i, 'cinematic'],
]

const DARK_WORDS = /\b(dark|moody|evil|menac|ominous|night|heavy|aggressive|hard)\b/i
const HAPPY_WORDS = /\b(happy|bright|sunny|uplift|joy|major|warm|sweet)\b/i
const CHILL_WORDS = /\b(chill|relax|soft|ambient|calm|sleep|study|smooth)\b/i

export function parsePrompt(prompt: string): PromptParse {
  const text = prompt.trim()
  const bpmMatch = text.match(/(\d{2,3})\s*(?:bpm|beats)/i) || text.match(/\bat\s+(\d{2,3})\b/i)
  const keyMatch = text.match(/\b([A-G][#b]?)\s*(minor|major|min|maj|dorian|phrygian|lydian|mixolydian)\b/i)
  const barsMatch = text.match(/(\d{1,3})\s*(?:bars|bar|measures)/i)
  let genre = 'trap'
  for (const [re, g] of GENRE_WORDS) {
    if (re.test(text)) {
      genre = g
      break
    }
  }
  const defaultBpm: Record<string, number> = {
    trap: 140,
    hiphop: 90,
    rnb: 88,
    dreampop: 96,
    edm: 126,
    rock: 118,
    lofi: 78,
    pop: 112,
    cinematic: 80,
  }
  let bpm = bpmMatch ? Number(bpmMatch[1]) : defaultBpm[genre]
  bpm = Math.max(40, Math.min(220, bpm))
  const mood: string[] = []
  if (DARK_WORDS.test(text)) mood.push('dark')
  if (HAPPY_WORDS.test(text)) mood.push('happy')
  if (CHILL_WORDS.test(text)) mood.push('chill')
  const keyRoot = keyMatch ? keyMatch[1].replace('b', 'b') : 'C'
  const rootPc = NOTE_PC[keyRoot] ?? 0
  let scale: string
  if (keyMatch) {
    const q = keyMatch[2].toLowerCase()
    if (q.startsWith('min')) scale = 'Minor'
    else if (q.startsWith('maj')) scale = 'Major'
    else scale = q.charAt(0).toUpperCase() + q.slice(1)
  } else if (genre === 'trap' || genre === 'drill') scale = 'Minor'
  else if (genre === 'edm') scale = 'Dorian'
  else if (genre === 'lofi' || genre === 'rnb') scale = 'Dorian'
  else if (genre === 'dreampop') scale = 'Lydian'
  else if (genre === 'cinematic') scale = 'Minor'
  else scale = mood.includes('dark') ? 'Minor' : 'Major'
  if (mood.includes('dark') && scale === 'Major') scale = 'Minor'
  if (mood.includes('happy') && scale === 'Minor') scale = 'Major'
  const bars = barsMatch ? Math.max(4, Math.min(128, Number(barsMatch[1]))) : 32
  const rootName = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][rootPc]
  return { genre, bpm, keyRoot: rootName, scale, bars, mood, prompt: text }
}

export const GENRE_DEVICES: Record<
  string,
  { drums: DeviceType; bass: DeviceType; chords: DeviceType; lead: DeviceType; pad?: DeviceType }
> = {
  trap: { drums: 'drums', bass: 'eight08', chords: 'pad', lead: 'fm', pad: 'pad' },
  hiphop: { drums: 'drums', bass: 'bass', chords: 'keys', lead: 'pluck', pad: 'pad' },
  rnb: { drums: 'drums', bass: 'bass', chords: 'keys', lead: 'pluck' },
  pop: { drums: 'drums', bass: 'bass', chords: 'pad', lead: 'pluck' },
  dreampop: { drums: 'drums', bass: 'bass', chords: 'pad', lead: 'strings', pad: 'pad' },
  edm: { drums: 'drums', bass: 'bass', chords: 'pad', lead: 'synth' },
  rock: { drums: 'drums', bass: 'bass', chords: 'strings', lead: 'pluck' },
  lofi: { drums: 'drums', bass: 'bass', chords: 'keys', lead: 'pluck' },
  cinematic: { drums: 'drums', bass: 'bass', chords: 'pad', lead: 'strings', pad: 'pad' },
}

const GENRE_STYLE: Record<string, DrumStyle> = {
  trap: 'trap',
  hiphop: 'boombap',
  rnb: 'rnb',
  pop: 'pop',
  dreampop: 'lofi',
  edm: 'four-floor',
  rock: 'rock',
  lofi: 'lofi',
  cinematic: 'trap-halftime',
}

export function genreScaleDefaults(genre: string): string {
  if (genre === 'trap') return 'Minor'
  if (genre === 'edm') return 'Dorian'
  if (genre === 'dreampop') return 'Lydian'
  if (genre === 'rnb') return 'Dorian'
  if (genre === 'lofi') return 'Dorian'
  return 'Major'
}

/** Convert a library loop into one or more fully editable tracks. */
export function loopToTracks(
  spec: LoopSpec,
  keyRootPc: number,
  scale: string,
  projectBpm: number,
): GeneratedTrack[] {
  const devices = GENRE_DEVICES[spec.genre] || GENRE_DEVICES.trap
  const style = GENRE_STYLE[spec.genre] || 'trap'
  const bars = spec.bars
  const base: HarmonyArgs = {
    bars,
    seed: spec.seed,
    genre: spec.genre,
    rootPc: keyRootPc,
    scale,
    swing: spec.swing,
    density: 1,
  }
  const mk = (
    name: string,
    kind: TrackKind,
    deviceType: DeviceType,
    params: Params,
    notes: Note[],
    color: string,
  ): GeneratedTrack => ({
    name,
    kind,
    color,
    deviceType,
    params,
    clips: [{ startBar: 0, bars, name: `${name} ${bars} bars`, notes }],
  })

  switch (spec.role) {
    case 'drums':
      return [
        mk(
          `${spec.genre.toUpperCase()} Drums`,
          'drum',
          'drums',
          withParams('drums', spec.genre === 'trap' ? { kit: 1, decay: 1.2 } : spec.genre === 'lofi' ? { kit: 3, tune: -2, tone: -0.4 } : {}),
          drumPattern(style, base),
          '#f2777a',
        ),
      ]
    case 'bass':
      return [
        mk(
          'Bass',
          'midi',
          devices.bass,
          withParams(devices.bass, spec.genre === 'trap' ? { decay: 1.6, drive: 0.42 } : {}),
          bassLineNotes(base),
          '#63b3ed',
        ),
      ]
    case 'chords':
      return [
        mk(
          'Chords',
          'midi',
          devices.chords,
          withParams(devices.chords, {}),
          chordProgressionNotes(base, devices.chords === 'pad' || devices.chords === 'strings' ? 'pad' : 'keys'),
          '#8f7bf7',
        ),
      ]
    case 'melody':
      return [
        mk('Melody', 'midi', devices.lead, withParams(devices.lead, {}), melodyNotes(base), '#68d391'),
      ]
    case 'arp':
      return [mk('Arp', 'midi', 'synth', withParams('synth', { cutoff: 4200 }), arpNotes(base), '#4fd1c5')]
    case 'keys':
      return [mk('Keys', 'midi', 'keys', withParams('keys', {}), chordProgressionNotes(base, 'keys'), '#f9d77e')]
    case 'full':
    default: {
      const tracks: GeneratedTrack[] = []
      tracks.push(
        mk(
          'Drums',
          'drum',
          'drums',
          withParams('drums', spec.genre === 'trap' ? { kit: 1, decay: 1.15 } : spec.genre === 'lofi' ? { kit: 3, tune: -2, tone: -0.35 } : {}),
          drumPattern(style, base),
          '#f2777a',
        ),
      )
      tracks.push(
        mk('Bass', 'midi', devices.bass, withParams(devices.bass, spec.genre === 'trap' ? { decay: 1.5, drive: 0.4 } : {}), bassLineNotes(base), '#63b3ed'),
      )
      tracks.push(
        mk(
          'Chords',
          'midi',
          devices.chords,
          withParams(devices.chords, {}),
          chordProgressionNotes(base, devices.chords === 'keys' ? 'keys' : 'pad'),
          '#8f7bf7',
        ),
      )
      if ((spec.role as string) === 'full') {
        tracks.push(mk('Melody', 'midi', devices.lead, withParams(devices.lead, {}), melodyNotes(base), '#68d391'))
      }
      return tracks
    }
  }
}

function structureFor(bars: number): { name: string; startBar: number; bars: number }[] {
  const out: { name: string; startBar: number; bars: number }[] = []
  let bar = 0
  let left = bars
  const push = (name: string, len: number) => {
    if (left <= 0) return
    const l = Math.min(len, left)
    out.push({ name, startBar: bar, bars: l })
    bar += l
    left -= l
  }
  push('Intro', Math.min(4, bars))
  while (left > 0) {
    push('Verse', 8)
    push('Hook', 8)
    if (left > 4) push('Bridge', 4)
  }
  return out
}

/** The Mureka-style procedural creation engine. */
export function generateFromPrompt(prompt: string, overrides?: Partial<PromptParse>): GeneratedProject {
  const parsed = { ...parsePrompt(prompt), ...overrides }
  const rootPc = NOTE_PC[parsed.keyRoot] ?? 0
  const sections = structureFor(parsed.bars)
  const devices = GENRE_DEVICES[parsed.genre] || GENRE_DEVICES.trap
  const style = GENRE_STYLE[parsed.genre] || 'trap'
  const prog = progressionFor(parsed.genre, parsed.bars + 7)
  const progression = prog.map((d) => chordName(rootPc, parsed.scale, d))
  const tracks: GeneratedTrack[] = []

  const makeTrack = (
    name: string,
    kind: TrackKind,
    color: string,
    deviceType: DeviceType,
    params: Params,
    gen: (section: { name: string; startBar: number; bars: number }, idx: number) => Note[],
    opts: { include?: string[]; skip?: string[] } = {},
  ): GeneratedTrack => {
    const clips: GeneratedClip[] = []
    sections.forEach((s, i) => {
      if (opts.skip?.includes(s.name)) return
      if (opts.include && !opts.include.includes(s.name)) return
      const notes = gen(s, i)
      if (notes.length) clips.push({ startBar: s.startBar, bars: s.bars, name: `${s.name} ${name}`, notes })
    })
    return { name, kind, color, deviceType, params, clips }
  }

  const drumTrack = makeTrack('Drums', 'drum', '#f2777a', 'drums', withParams('drums', parsed.genre === 'trap' ? { kit: 1, decay: 1.15 } : parsed.genre === 'lofi' ? { kit: 3, tune: -2, tone: -0.35 } : {}), (s, i) => {
    const density = s.name === 'Intro' ? 0.55 : s.name === 'Hook' ? 1 : 0.85
    return drumPattern(style, {
      bars: s.bars,
      seed: 100 + i * 37 + parsed.bars,
      swing: parsed.genre === 'lofi' || parsed.genre === 'hiphop' ? 0.4 : 0.12,
      density,
    })
  })

  const bassTrack = makeTrack('Bass', 'midi', '#63b3ed', devices.bass, withParams(devices.bass, parsed.genre === 'trap' ? { decay: 1.7, drive: 0.45 } : {}), (s, i) =>
    bassLineNotes({
      bars: s.bars,
      seed: 200 + i * 13,
      genre: parsed.genre,
      rootPc,
      scale: parsed.scale,
    }),
  )

  const chordTrack = makeTrack('Chords', 'midi', '#8f7bf7', devices.chords, withParams(devices.chords, {}), (s, i) =>
    chordProgressionNotes(
      { bars: s.bars, seed: 300 + i * 7, genre: parsed.genre, rootPc, scale: parsed.scale },
      devices.chords === 'keys' ? 'keys' : s.name === 'Hook' ? 'stab' : 'pad',
    ),
  )

  const melodyTrack = makeTrack('Melody', 'midi', '#68d391', devices.lead, withParams(devices.lead, {}), (s, i) =>
    s.name === 'Intro'
      ? []
      : melodyNotes({ bars: s.bars, seed: 400 + i * 23, genre: parsed.genre, rootPc, scale: parsed.scale }),
  )

  const padTrack = makeTrack('Pad', 'midi', '#a78bfa', devices.pad ?? 'pad', withParams(devices.pad ?? 'pad', {}), (s, i) =>
    chordProgressionNotes(
      { bars: s.bars, seed: 500 + i * 5, genre: parsed.genre, rootPc, scale: parsed.scale, octave: 1 },
      'pad',
    ),
    { skip: ['Intro'] },
  )

  const arpTrack = makeTrack('Arp', 'midi', '#4fd1c5', 'pluck', withParams('pluck', { decay: 0.4, bright: 0.7 }), (s, i) =>
    s.name === 'Hook' || s.name === 'Bridge'
      ? arpNotes({ bars: s.bars, seed: 600 + i * 11, genre: parsed.genre, rootPc, scale: parsed.scale })
      : [],
  )

  tracks.push(drumTrack, bassTrack, chordTrack, melodyTrack)
  if (padTrack.clips.length) tracks.push(padTrack)
  if (arpTrack.clips.length) tracks.push(arpTrack)

  return {
    genre: parsed.genre,
    bpm: parsed.bpm,
    keyRoot: parsed.keyRoot,
    scale: parsed.scale,
    bars: parsed.bars,
    tracks,
    sections,
    progression,
    prompt: parsed.prompt,
  }
}

/** Chord suggestions for the Create panel. */
export function chordSuggestions(keyRoot: string, scale: string): string[][] {
  const rootPc = NOTE_PC[keyRoot] ?? 0
  const iv = scaleIntervals(scale)
  const out: string[][] = []
  for (let start = 0; start < 7; start += 2) {
    const prog = [start, (start + 3) % 7, (start + 4) % 7, (start + 5) % 7]
    out.push(prog.map((d) => chordName(rootPc, scale, d)))
  }
  out.push([0, 5, 3, 4].map((d) => chordName(rootPc, scale, d)))
  out.push([1, 4, 0, 5].map((d) => chordName(rootPc, scale, d)))
  return out.filter((p) => p.every(Boolean)).slice(0, 6)
}

export function melodySuggestion(keyRoot: string, scale: string, genre = 'trap'): Note[] {
  const rootPc = NOTE_PC[keyRoot] ?? 0
  return melodyNotes({ bars: 2, seed: Math.floor(Math.random() * 9999), genre, rootPc, scale })
}
