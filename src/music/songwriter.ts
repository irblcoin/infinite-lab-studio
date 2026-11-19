// ---------------------------------------------------------------------------
// Songwriter: section-based song generation, section regeneration, mood
// shifts, variations and lyrics-to-melody. Everything is procedural and local.
// ---------------------------------------------------------------------------

import type { Clip, DeviceType, Note, Params, TrackKind } from '../state/types'
import { NOTE_NAMES, SCALES, TRACK_COLORS, makeClip, makeDevice, makeTrack, uid } from '../state/types'
import { commit, getState, setUi, toast } from '../state/store'
import { realInstrumentFor } from '../data/realInstruments'
import { chordForDegree, mulberry32, scalePitches } from './theory'
import { PROGRESSIONS, type ProgressionPreset } from '../data/chords'

export type SectionName = 'Intro' | 'Verse' | 'Pre-Chorus' | 'Chorus' | 'Bridge' | 'Outro'

export interface SongSection {
  name: SectionName
  startBar: number
  bars: number
}

export interface SongClipSpec {
  name: string
  startBar: number
  bars: number
  notes: Note[]
}

export interface SongTrackSpec {
  name: string
  kind: TrackKind
  color: string
  deviceType: DeviceType
  params: Params
  clips: SongClipSpec[]
}

export interface SongIdea {
  title: string
  genre: string
  mood: string
  bpm: number
  keyRoot: string
  scale: string
  bars: number
  sections: SongSection[]
  progression: string[]
  tracks: SongTrackSpec[]
}

const ROOT_PC: Record<string, number> = Object.fromEntries(NOTE_NAMES.map((n, i) => [n, i]))

export const GENRE_TEMPO: Record<string, number> = {
  trap: 140,
  drill: 142,
  hiphop: 90,
  'lo-fi': 78,
  rnb: 88,
  pop: 118,
  rock: 120,
  edm: 126,
  house: 124,
  cinematic: 96,
  ambient: 70,
  jazz: 112,
}

const GENRE_PROGRESSIONS: Record<string, string> = {
  trap: 'trap_dark',
  drill: 'drill_slide',
  hiphop: 'lofi_loop',
  'lo-fi': 'lofi_loop',
  rnb: 'rnb_smooth',
  pop: 'pop_axis',
  rock: 'rock_power',
  edm: 'house_loop',
  house: 'house_loop',
  cinematic: 'minor_epic',
  ambient: 'ballad',
  jazz: 'jazz_turn',
}

const DRUM_STEPS: Record<string, number[]> = {
  // [kick steps, snare steps, hat steps, open-hat steps] in 16ths
  trap: [0, 6, 10, 14, 7, 15, 4, 12, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  hiphop: [0, 10, 3, 11, 7, 4, 12],
  'lo-fi': [0, 10, 3, 7, 11, 4, 12, 6, 14],
  rock: [0, 8, 6, 10, 4, 12],
  edm: [0, 4, 8, 12, 2, 6, 10, 14],
  house: [0, 4, 8, 12, 2, 6, 10, 14],
  drill: [0, 3, 10, 12, 6, 14, 7, 15],
}

function seeded(seed: number) {
  return mulberry32(seed >>> 0)
}

function drumNotes(genre: string, bars: number, seed: number, density = 1): Note[] {
  const r = seeded(seed)
  const steps = Math.max(4, bars * 16)
  const out: Note[] = []
  const g = DRUM_STEPS[genre] ?? DRUM_STEPS.trap
  const kicks = new Set([0, 10, 3, 11, 7, 14, 6])
  const snare = genre === 'trap' || genre === 'drill' ? 8 : 4
  const perBar = 16
  for (let s = 0; s < steps; s++) {
    const step = s % perBar
    const beat = s / 16 + Math.floor(s / 16) * 0 // step in beats is s/4
    const t = s / 4
    if (step === 0) out.push({ id: uid('nt'), pitch: 36, start: t, len: 0.25, vel: 0.95 })
    if (kicks.has(step) && r() < 0.75 * density) out.push({ id: uid('nt'), pitch: 36, start: t, len: 0.25, vel: 0.75 + r() * 0.2 })
    if (step === snare || (genre === 'trap' && step === 12) || (genre === 'drill' && step === 11)) {
      out.push({ id: uid('nt'), pitch: 38, start: t, len: 0.25, vel: 0.85 })
    }
    if (g.includes(step) && r() < 0.9 * density) {
      out.push({ id: uid('nt'), pitch: step % 4 === 2 ? 42 : 42, start: t, len: 0.15, vel: step % 2 === 0 ? 0.6 : 0.42 })
    }
    if (step === 14 && (genre === 'trap' || genre === 'drill') && r() < 0.5) {
      out.push({ id: uid('nt'), pitch: 46, start: t, len: 0.2, vel: 0.55 })
    }
    if (step === 4 && r() < 0.25) out.push({ id: uid('nt'), pitch: 39, start: t, len: 0.2, vel: 0.5 })
  }
  return out
}

function padChordNotes(rootPc: number, scale: string, progression: ProgressionPreset, bars: number, bass = false): Note[] {
  const out: Note[] = []
  const beatsPer = progression.beatsPerChord
  for (let b = 0; b < bars; b++) {
    const chord = progression.degrees[b % progression.degrees.length]
    const quality = progression.quality[b % progression.quality.length]
    const degree = chord
    const base = chordForDegree(rootPc, scale, degree)
    const pitches = quality.includes('7')
      ? [...base, base[0] + (quality.includes('maj') ? 11 : 10)]
      : quality === 'sus4'
        ? [base[0], base[0] + 5, base[0] + 7]
        : quality === 'power'
          ? [base[0], base[0] + 7, base[0] + 12]
          : base
    const start = b * 4
    if (bass) {
      out.push({ id: uid('nt'), pitch: base[0] - 12, start, len: beatsPer * 0.9, vel: 0.82 })
      out.push({ id: uid('nt'), pitch: base[0] - 12, start: start + beatsPer / 2, len: beatsPer * 0.35, vel: 0.6 })
      continue
    }
    pitches.forEach((p, i) => {
      out.push({ id: uid('nt'), pitch: p, start: start + i * 0.02, len: 3.8, vel: 0.62 })
    })
  }
  return out
}

function melodyNotes(rootPc: number, scale: string, bars: number, seed: number, density = 1): Note[] {
  const r = seeded(seed)
  const pool = scalePitches(rootPc, scale, 60, 84)
  if (!pool.length) return []
  const out: Note[] = []
  let idx = Math.floor(pool.length / 2)
  for (let beat = 0; beat < bars * 4; beat += 0.5) {
    if (r() > 0.42 * density) continue
    idx = Math.max(0, Math.min(pool.length - 1, idx + Math.round((r() - 0.5) * 4)))
    const len = r() < 0.3 ? 1 : r() < 0.7 ? 0.5 : 0.25
    out.push({ id: uid('nt'), pitch: pool[idx], start: beat, len, vel: 0.55 + r() * 0.3 })
  }
  return out
}

export function structureFor(bars: number, full = true): SongSection[] {
  const plan: [SectionName, number][] = full
    ? [
        ['Intro', 4],
        ['Verse', 8],
        ['Pre-Chorus', 4],
        ['Chorus', 8],
        ['Verse', 8],
        ['Chorus', 8],
        ['Bridge', 4],
        ['Outro', 4],
      ]
    : [
        ['Intro', 2],
        ['Verse', 4],
        ['Chorus', 4],
        ['Outro', 2],
      ]
  const out: SongSection[] = []
  let bar = 0
  for (const [name, len] of plan) {
    if (bar >= bars) break
    const l = Math.min(len, bars - bar)
    out.push({ name, startBar: bar, bars: l })
    bar += l
  }
  return out
}

export interface ComposeOptions {
  prompt?: string
  genre?: string
  mood?: string
  keyRoot?: string
  scale?: string
  bpm?: number
  bars?: number
  seed?: number
  title?: string
  replace?: boolean
}

function parsePrompt(prompt: string): ComposeOptions {
  const text = prompt.toLowerCase()
  const genre =
    ['trap', 'drill', 'hiphop', 'lo-fi', 'rnb', 'pop', 'rock', 'edm', 'house', 'cinematic', 'ambient', 'jazz'].find((g) =>
      text.includes(g === 'hiphop' ? 'hip hop' : g),
    ) ?? (text.includes('hip hop') ? 'hiphop' : 'trap')
  const moodMatch = text.match(/\b(dark|happy|sad|epic|chill|aggressive|uplifting|dreamy|moody|warm|tense)\b/)
  const bpm = Number(text.match(/(\d{2,3})\s*(?:bpm|beats per minute)/)?.[1] ?? text.match(/\b(?:at|tempo)\s*(\d{2,3})\b/)?.[1] ?? 0) || undefined
  const key = text.match(/\bin\s+([a-g][#b]?)(?:\s*(minor|major|min|maj))?\b/)
  const scale = key?.[2] ? (key[2].startsWith('min') ? 'Minor' : 'Major') : undefined
  const bars = Number(text.match(/\b(\d{1,3})\s*bars?\b/)?.[1] ?? 0) || undefined
  return { genre, mood: moodMatch?.[1], keyRoot: key?.[1]?.toUpperCase(), scale, bpm, bars }
}

export function composeSong(opts: ComposeOptions = {}): SongIdea {
  const parsed = parsePrompt(opts.prompt ?? '')
  const merged = { ...parsed, ...opts }
  const genre = (merged.genre ?? 'trap').toLowerCase()
  const mood = merged.mood ?? (/dark|tense/.test(opts.prompt ?? '') ? 'dark' : 'warm')
  const bpm = merged.bpm ?? GENRE_TEMPO[genre] ?? 120
  const keyRoot = (merged.keyRoot ?? 'C').toUpperCase()
  const rootPc = ROOT_PC[keyRoot] ?? 0
  const scale = merged.scale ?? (mood === 'dark' || genre === 'trap' || genre === 'drill' ? 'Minor' : genre === 'cinematic' ? 'Dorian' : 'Major')
  const bars = Math.max(8, Math.min(128, merged.bars ?? 48))
  const seed = merged.seed ?? Math.floor(Math.random() * 1e9)
  const sections = structureFor(bars)
  const prog = PROGRESSIONS.find((p) => p.id === (GENRE_PROGRESSIONS[genre] ?? 'trap_dark')) ?? PROGRESSIONS[0]
  const progression = prog.degrees.map((d) => {
    const pitches = chordForDegree(rootPc, scale, d)
    const pc = pitches[0] % 12
    return `${NOTE_NAMES[(pc + 12) % 12]}${prog.quality[prog.degrees.indexOf(d)] === 'min' || prog.quality[prog.degrees.indexOf(d)].startsWith('min') ? 'm' : ''}`
  })

  const tracks: SongTrackSpec[] = []
  const add = (spec: SongTrackSpec) => tracks.push(spec)
  const sectionClips = (
    name: string,
    gen: (s: SongSection, i: number) => Note[],
    roleDensity: Partial<Record<SectionName, number>> = {},
  ): SongClipSpec[] =>
    sections
      .map((s, i) => {
        if (s.name === 'Intro' && name !== 'Pad' && name !== 'Melody') return null
        if (s.name === 'Outro' && name !== 'Pad' && name !== 'Chords' && name !== 'Drums') return null
        const notes = gen(s, i)
        if (!notes.length) return null
        void roleDensity
        return { name: `${s.name} ${name}`, startBar: s.startBar, bars: s.bars, notes }
      })
      .filter(Boolean) as SongClipSpec[]

  add({
    name: 'Drums',
    kind: 'drum',
    color: TRACK_COLORS[3],
    deviceType: 'drums',
    params: { kit: genre === 'trap' || genre === 'drill' ? 1 : 0, decay: 1.1, tune: 0 },
    clips: sectionClips('Drums', (s, i) => drumNotes(genre, s.bars, seed + i * 31, s.name === 'Chorus' ? 1.1 : s.name === 'Verse' ? 0.9 : 0.55)),
  })
  add({
    name: 'Bass',
    kind: 'midi',
    color: TRACK_COLORS[4],
    deviceType: 'bass',
    params: genre === 'trap' ? { decay: 1.6, drive: 0.4 } : { decay: 0.8, drive: 0.15 },
    clips: sectionClips('Bass', (s, i) => padChordNotes(rootPc, scale, prog, Math.ceil(s.bars), true).map((n) => ({ ...n, start: n.start + s.startBar * 4 }))),
  })
  add({
    name: 'Chords',
    kind: 'midi',
    color: TRACK_COLORS[2],
    deviceType: 'keys',
    params: {},
    clips: sectionClips('Chords', (s) =>
      padChordNotes(rootPc, scale, prog, s.bars).map((n) => ({ ...n, start: n.start + s.startBar * 4 })),
    ),
  })
  add({
    name: 'Melody',
    kind: 'midi',
    color: TRACK_COLORS[5],
    deviceType: 'pluck',
    params: { decay: 0.5, bright: 0.6 },
    clips: sectionClips('Melody', (s, i) =>
      melodyNotes(rootPc, scale, s.bars, seed + 900 + i * 17, s.name === 'Intro' ? 0.5 : 1).map((n) => ({
        ...n,
        start: n.start + s.startBar * 4,
      })),
    ),
  })
  add({
    name: 'Pad',
    kind: 'midi',
    color: TRACK_COLORS[7],
    deviceType: 'pad',
    params: { attack: 0.6, release: 1.2 },
    clips: sectionClips('Pad', (s) =>
      padChordNotes(rootPc, scale, prog, s.bars).map((n) => ({
        ...n,
        pitch: n.pitch + 12,
        start: n.start + s.startBar * 4,
        len: 4,
        vel: 0.45,
      })),
    ),
  })

  const title = merged.title ?? `${mood[0].toUpperCase()}${mood.slice(1)} ${genre} song`
  return { title, genre, mood, bpm, keyRoot, scale, bars, sections, progression, tracks }
}

/** Replace the project's arrangement with a generated song. */
export function applySong(idea: SongIdea, replace = true): void {
  const { project } = getState()
  const keepAudio = replace ? project.tracks.filter((t) => t.kind === 'audio') : project.tracks
  const generated = idea.tracks.map((spec) => {
    let devices = []
    const real = spec.kind === 'drum' ? null : realInstrumentFor(spec.name)
    if (real) {
      const dev = makeDevice('sampler', { root: 60, gain: 1, attack: 0.004, release: 0.2, cutoff: 16000, pitch: 0, reverb: 0.1, res: 0.5 }, real.label)
      dev.instrumentId = real.instrumentId
      devices = [dev]
    } else {
      devices = [makeDevice(spec.deviceType, spec.params, spec.name)]
    }
    const track = makeTrack(spec.name, spec.kind, spec.color, devices)
    track.clips = spec.clips.map((c) =>
      makeClip({
        name: c.name,
        start: c.startBar * 4,
        len: c.bars * 4,
        contentLen: c.bars * 4,
        kind: 'midi',
        notes: c.notes,
      }),
    )
    return track
  })
  commit(`Generate ${idea.title}`, (p) => {
    p.name = idea.title
    p.bpm = idea.bpm
    p.keyRoot = idea.keyRoot
    p.keyScale = idea.scale
    p.length = Math.max(p.length, idea.bars * 4 + 8)
    p.tracks = [...keepAudio, ...generated]
    for (const s of idea.sections) {
      p.markers.push({ id: uid('mk'), beat: s.startBar * 4, name: s.name, color: '#d7a951' })
    }
    p.markers.sort((a, b) => a.beat - b.beat)
  })
  setUi({ selectedTrackId: generated[0]?.id ?? null, view: 'seq' })
  toast(`${idea.title} — ${idea.sections.map((s) => s.name).join(' · ')}`, 'ok', 5000)
}

/** Regenerate the notes of one clip (a section of one track). */
export function regenerateClip(clipId: string, seedOffset = 1): void {
  const { project } = getState()
  const track = project.tracks.find((t) => t.clips.some((c) => c.id === clipId))
  const clip = track?.clips.find((c) => c.id === clipId)
  if (!track || !clip) return
  const rootPc = ROOT_PC[project.keyRoot] ?? 0
  const bars = Math.max(1, Math.round(clip.contentLen / 4))
  const genre = /drum/i.test(track.name) ? 'trap' : 'trap'
  const seed = Math.floor(Math.random() * 1e9) + seedOffset
  let notes: Note[] = []
  if (track.kind === 'drum') notes = drumNotes(genre, bars, seed, 0.9)
  else if (/bass/i.test(track.name)) {
    const prog = PROGRESSIONS[0]
    notes = padChordNotes(rootPc, project.keyScale, prog, bars, true).map((n) => ({ ...n, start: n.start * 1 }))
  } else if (/chord|pad|key/i.test(track.name)) {
    notes = padChordNotes(rootPc, project.keyScale, PROGRESSIONS[0], bars)
  } else {
    notes = melodyNotes(rootPc, project.keyScale, bars, seed)
  }
  commit('Regenerate section', (p) => {
    const t = p.tracks.find((x) => x.id === track.id)
    const c = t?.clips.find((x) => x.id === clipId)
    if (c) c.notes = notes
  })
  toast(`Regenerated ${clip.name}`, 'ok')
}

export function sectionClipsIn(bars: number): string[] {
  return structureFor(bars).map((s) => s.name)
}

/** Make a clip darker or brighter, musically. */
export function shiftMood(clipId: string, direction: 'darker' | 'brighter'): void {
  const { project } = getState()
  const track = project.tracks.find((t) => t.clips.some((c) => c.id === clipId))
  const clip = track?.clips.find((c) => c.id === clipId)
  if (!clip || !clip.notes.length) {
    toast('Select a MIDI clip first', 'warn')
    return
  }
  const rootPc = ROOT_PC[project.keyRoot] ?? 0
  const shift = direction === 'darker' ? -3 : 2
  const notes = clip.notes.map((n) => ({
    ...n,
    pitch: Math.max(21, Math.min(108, n.pitch + shift)),
    vel: Math.max(0.05, Math.min(1, n.vel * (direction === 'darker' ? 0.9 : 1.08))),
    len: direction === 'darker' ? n.len : Math.round(n.len * 0.9 * 1000) / 1000,
  }))
  void rootPc
  commit(direction === 'darker' ? 'Make darker' : 'Make brighter', (p) => {
    const c = p.tracks.flatMap((t) => t.clips).find((x) => x.id === clipId)
    if (c) c.notes = notes
  })
  toast(direction === 'darker' ? 'Darker — down a minor third, softer' : 'Brighter — up a whole tone, tighter', 'ok')
}

/** Rhythmic + melodic variation of a clip, keeping its harmony. */
export function makeVariation(clipId: string): void {
  const { project } = getState()
  const track = project.tracks.find((t) => t.clips.some((c) => c.id === clipId))
  const clip = track?.clips.find((c) => c.id === clipId)
  if (!clip || !clip.notes.length) {
    toast('Select a MIDI clip first', 'warn')
    return
  }
  const r = seeded(Math.floor(Math.random() * 1e9))
  const notes = clip.notes.map((n) => {
    const move = r() < 0.35 ? (r() < 0.5 ? -2 : 2) : 0
    const startJitter = r() < 0.3 ? (r() < 0.5 ? -0.25 : 0.25) : 0
    return {
      ...n,
      pitch: n.pitch + move,
      start: Math.max(0, Math.round((n.start + startJitter) * 100) / 100),
      vel: Math.max(0.08, Math.min(1, n.vel + (r() - 0.5) * 0.15)),
    }
  })
  commit('Variation', (p) => {
    const c = p.tracks.flatMap((t) => t.clips).find((x) => x.id === clipId)
    if (c) c.notes = notes
  })
  toast('Variation created', 'ok')
}

/** Map lyric syllables onto a singable melody in the project key. */
export function lyricsToMelody(text: string, opts: { keyRoot?: string; scale?: string; bars?: number; seed?: number } = {}): Note[] {
  const { project } = getState()
  const keyRoot = opts.keyRoot ?? project.keyRoot
  const scale = opts.scale ?? project.keyScale
  const rootPc = ROOT_PC[keyRoot] ?? 0
  const bars = Math.max(1, Math.min(16, opts.bars ?? 4))
  const pool = scalePitches(rootPc, scale, 60, 81)
  if (!pool.length) return []
  const r = seeded(opts.seed ?? Math.floor(Math.random() * 1e9))
  const syllables = text
    .toLowerCase()
    .replace(/[^a-z\s']/g, ' ')
    .split(/\s+/)
    .flatMap((w) => {
      // Rough syllable count: vowel groups.
      const groups = w.match(/[aeiouy]+/g)
      const count = Math.max(1, groups ? groups.length : 1)
      return Array.from({ length: Math.min(5, count) }, () => w)
    })
    .filter(Boolean)
  const notes: Note[] = []
  let t = 0
  let idx = Math.floor(pool.length / 2)
  syllables.forEach((word, i) => {
    if (t >= bars * 4) return
    idx = Math.max(0, Math.min(pool.length - 1, idx + Math.round((r() - 0.5) * 3)))
    const isLong = /[aeiou]{2}|[.!?]$/.test(word) || i === syllables.length - 1
    const len = isLong ? 1 : r() < 0.4 ? 0.5 : 0.25
    notes.push({ id: uid('nt'), pitch: pool[idx], start: Math.round(t * 4) / 4, len, vel: 0.68 + r() * 0.2 })
    t += len
    if (i % 8 === 7) t = Math.ceil(t) + 0.25
  })
  return notes
}

/** Add a lyric melody clip to the selected MIDI track. */
export function addLyricMelody(text: string): void {
  const { project, ui } = getState()
  const track = project.tracks.find((t) => t.id === ui.selectedTrackId) ?? project.tracks[0]
  if (!track) return
  const notes = lyricsToMelody(text)
  if (!notes.length) {
    toast('Add some words first', 'warn')
    return
  }
  const len = Math.max(4, Math.ceil(Math.max(...notes.map((n) => n.start + n.len)) / 4) * 4)
  commit('Lyrics → melody', (p) => {
    const t = p.tracks.find((x) => x.id === track.id)
    if (t) t.clips.push(makeClip({ name: `Lyric melody — ${text.slice(0, 22)}`, start: 0, len, contentLen: len, kind: 'midi', notes }))
  })
  setUi({ selectedClipIds: [] })
  toast(`Melody written for “${text.slice(0, 24)}…”`, 'ok')
}

export function songSectionsForUi(bars = 48): SongSection[] {
  return structureFor(bars)
}

export function scaleOptions(): string[] {
  return Object.keys(SCALES)
}

export function moodPalette(): { id: string; label: string }[] {
  return [
    { id: 'dark', label: 'Dark' },
    { id: 'warm', label: 'Warm' },
    { id: 'bright', label: 'Bright' },
    { id: 'chill', label: 'Chill' },
    { id: 'epic', label: 'Epic' },
    { id: 'tense', label: 'Tense' },
  ]
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 1e9)
}

export type { Clip }
