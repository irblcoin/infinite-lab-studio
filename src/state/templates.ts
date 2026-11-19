// ---------------------------------------------------------------------------
// Track and project templates. Saved locally in IndexedDB, with built-ins that
// work before the user saves anything.
// ---------------------------------------------------------------------------

import type { Device, Project, Track } from './types'
import { makeDevice, makeTrack, TRACK_COLORS, uid } from './types'
import { commit, getState, newProject, setUi, toast, adoptProject } from './store'
import { db } from './db'
import { DEVICE_DEFS, defaultParams } from '../data/deviceDefs'

export interface TrackTemplate {
  id: string
  name: string
  blurb: string
  color: string
  kind: Track['kind']
  devices: Device[]
  volume: number
  pan: number
  sends: [number, number]
  builtIn?: boolean
}

export interface ProjectTemplate {
  id: string
  name: string
  blurb: string
  builtIn?: boolean
  data?: string
  createdAt: number
}

const KEY_TRACKS = 'ils.trackTemplates.v2'
const KEY_PROJECTS = 'ils.projectTemplates.v2'

const dev = (type: Device['type'], params: Record<string, number>, name?: string): Device =>
  makeDevice(type, { ...defaultParams(type), ...params }, name ?? DEVICE_DEFS[type].name)

export const BUILTIN_TRACK_TEMPLATES: TrackTemplate[] = [
  {
    id: 'tpl_vocal',
    name: 'Vocal strip',
    blurb: 'EQ, 3:1 comp, de-esser-style filter and a plate send — ready to record.',
    color: '#4fd1c5',
    kind: 'audio',
    devices: [dev('eq3', { lowGain: -3, midGain: 1, highGain: 2 }), dev('comp', { threshold: -20, ratio: 3, attack: 12, release: 140 })],
    volume: 0.82,
    pan: 0,
    sends: [0.18, 0.04],
    builtIn: true,
  },
  {
    id: 'tpl_808',
    name: '808 / sub bass',
    blurb: 'Tuned 808 with saturation and a low-pass guard.',
    color: '#63b3ed',
    kind: 'midi',
    devices: [dev('eight08', { decay: 1.8, drive: 0.4, glide: 0.08 }), dev('autofilter', { cutoff: 900, res: 0.5 })],
    volume: 0.78,
    pan: 0,
    sends: [0, 0],
    builtIn: true,
  },
  {
    id: 'tpl_drumbus',
    name: 'Drum bus',
    blurb: 'Glue compressor and tone EQ for a group of drum tracks.',
    color: '#f2777a',
    kind: 'group',
    devices: [dev('comp', { threshold: -16, ratio: 4, attack: 8, release: 90 }), dev('eq3', { lowGain: 1.5, midGain: -1, highGain: 1 })],
    volume: 0.86,
    pan: 0,
    sends: [0, 0],
    builtIn: true,
  },
  {
    id: 'tpl_guitar',
    name: 'Guitar DI',
    blurb: 'Clean DI with amp-like drive and a short room send.',
    color: '#f6ad55',
    kind: 'audio',
    devices: [dev('distortion', { drive: 0.28, mix: 0.35 }), dev('eq3', { lowGain: -1, midGain: 1.4, highGain: 0.8 })],
    volume: 0.72,
    pan: 0.08,
    sends: [0.14, 0.05],
    builtIn: true,
  },
  {
    id: 'tpl_piano',
    name: 'Piano + room',
    blurb: 'Sampled grand with a chamber reverb and gentle compression.',
    color: '#d7a951',
    kind: 'midi',
    devices: [dev('keys', {}), dev('comp', { threshold: -18, ratio: 2, attack: 20, release: 200 })],
    volume: 0.68,
    pan: 0,
    sends: [0.22, 0],
    builtIn: true,
  },
  {
    id: 'tpl_riser',
    name: 'FX riser',
    blurb: 'Filtered noise sweep with a long reverb tail.',
    color: '#e17bd8',
    kind: 'midi',
    devices: [dev('pad', { attack: 0.8, release: 1.6 }), dev('autofilter', { cutoff: 2400, res: 4 })],
    volume: 0.6,
    pan: 0,
    sends: [0.4, 0.2],
    builtIn: true,
  },
]

export const BUILTIN_PROJECT_TEMPLATES: ProjectTemplate[] = [
  { id: 'ptpl_blank', name: 'Studio blank', blurb: 'Drums, bass, keys and a vocal track with sampled defaults.', builtIn: true, createdAt: 0 },
  { id: 'ptpl_band', name: 'Live band', blurb: 'Drum kit, bass, two guitars, keys and two vocal tracks.', builtIn: true, createdAt: 0 },
  { id: 'ptpl_beat', name: 'Beat session', blurb: 'Drum machine, 808, chords and a lead with sends ready.', builtIn: true, createdAt: 0 },
]

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function writeJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* ignore quota */
  }
}

export function listTrackTemplates(): TrackTemplate[] {
  return [...BUILTIN_TRACK_TEMPLATES, ...readJSON<TrackTemplate[]>(KEY_TRACKS, [])]
}

export function listProjectTemplates(): ProjectTemplate[] {
  return [...BUILTIN_PROJECT_TEMPLATES, ...readJSON<ProjectTemplate[]>(KEY_PROJECTS, [])]
}

export function saveTrackTemplate(trackId: string, name?: string): TrackTemplate | null {
  const { project } = getState()
  const track = project.tracks.find((t) => t.id === trackId)
  if (!track) return null
  const tpl: TrackTemplate = {
    id: uid('tpl'),
    name: name?.trim() || `${track.name} template`,
    blurb: `${track.devices.length} devices · ${track.kind} track`,
    color: track.color,
    kind: track.kind,
    devices: JSON.parse(JSON.stringify(track.devices)) as Device[],
    volume: track.volume,
    pan: track.pan,
    sends: [...track.sends],
    createdAt: Date.now(),
  } as TrackTemplate
  writeJSON(KEY_TRACKS, [...readJSON<TrackTemplate[]>(KEY_TRACKS, []), tpl])
  toast(`Saved track template “${tpl.name}”`, 'ok')
  return tpl
}

export function applyTrackTemplate(id: string): string | null {
  const tpl = listTrackTemplates().find((t) => t.id === id)
  if (!tpl) return null
  const { project } = getState()
  const track = makeTrack(tpl.name, tpl.kind, tpl.color ?? TRACK_COLORS[0], JSON.parse(JSON.stringify(tpl.devices)) as Device[])
  track.volume = tpl.volume
  track.pan = tpl.pan
  track.sends = tpl.sends
  track.devices = track.devices.map((d) => ({ ...d, id: uid('dev') }))
  commit(`Add template ${tpl.name}`, (p) => {
    p.tracks.push(track)
  })
  setUi({ selectedTrackId: track.id })
  toast(`Added “${tpl.name}” from template`, 'ok')
  return track.id
}

export function deleteTrackTemplate(id: string): void {
  writeJSON(KEY_TRACKS, readJSON<TrackTemplate[]>(KEY_TRACKS, []).filter((t) => t.id !== id))
  toast('Template removed', 'ok')
}

export async function saveProjectTemplate(name: string): Promise<void> {
  const { project } = getState()
  const tpl: ProjectTemplate = {
    id: uid('ptpl'),
    name: name.trim() || `${project.name} template`,
    blurb: `${project.tracks.length} tracks · ${project.bpm} BPM · ${project.keyRoot} ${project.keyScale}`,
    data: JSON.stringify({ ...project, name }),
    createdAt: Date.now(),
  }
  const stored = readJSON<ProjectTemplate[]>(KEY_PROJECTS, [])
  stored.push(tpl)
  // Keep the payload small: localStorage only holds light projects.
  try {
    localStorage.setItem(KEY_PROJECTS, JSON.stringify(stored))
  } catch {
    await db.setKV(`projectTemplate:${tpl.id}`, JSON.stringify({ ...project, name }))
    tpl.data = undefined
    writeJSON(KEY_PROJECTS, [...stored.map((s) => (s.id === tpl.id ? tpl : s))])
  }
  toast(`Project template “${tpl.name}” saved`, 'ok')
}

export async function openProjectTemplate(id: string): Promise<void> {
  const tpl = listProjectTemplates().find((t) => t.id === id)
  if (!tpl) return
  if (tpl.id === 'ptpl_blank') {
    newProject('Untitled Session')
    return
  }
  if (tpl.builtIn) {
    newProject(tpl.name)
    if (tpl.id === 'ptpl_band') {
      const { project } = getState()
      const names: [string, Track['kind'], string][] = [
        ['Drums', 'drum', '#f2777a'],
        ['Bass', 'midi', '#63b3ed'],
        ['Guitar L', 'audio', '#f6ad55'],
        ['Guitar R', 'audio', '#68d391'],
        ['Keys', 'midi', '#d7a951'],
        ['Lead Vocal', 'audio', '#4fd1c5'],
        ['Backing Vocal', 'audio', '#8f7bf7'],
      ]
      commit('Band template', (p) => {
        p.tracks = names.map(([n, k, c], i) => {
          const t = makeTrack(n, k, c, k === 'audio' ? [] : [makeDevice(k === 'drum' ? 'drums' : k === 'midi' ? 'keys' : 'synth', defaultParams(k === 'drum' ? 'drums' : 'keys'), n)])
          t.volume = 0.78 - i * 0.02
          return t
        })
      })
    }
    if (tpl.id === 'ptpl_beat') {
      const { project } = getState()
      commit('Beat template', (p) => {
        p.bpm = 140
        p.keyScale = 'Minor'
        p.tracks.forEach((t, i) => {
          if (i === 0) {
            t.name = 'Drum Machine'
            t.devices = [makeDevice('drums', { ...defaultParams('drums'), kit: 1 }, 'Trap Kit')]
          }
          if (i === 1) {
            t.name = '808'
            t.devices = [makeDevice('eight08', defaultParams('eight08'), '808 Sub')]
          }
          t.sends = [i === 2 ? 0.2 : 0.02, i === 2 ? 0.1 : 0]
        })
        void project
      })
    }
    setUi({ view: 'seq' })
    toast(`New project from “${tpl.name}”`, 'ok')
    return
  }
  try {
    const raw = tpl.data ?? ((await db.getKV<string>(`projectTemplate:${tpl.id}`)) as string | null)
    if (!raw) throw new Error('missing template')
    const project = JSON.parse(raw) as Project
    project.id = uid('proj')
    project.name = tpl.name.replace(/ template$/i, '')
    project.createdAt = Date.now()
    project.updatedAt = Date.now()
    await adoptProject(project)
    setUi({ view: 'seq', modal: null })
    toast(`Opened “${tpl.name}”`, 'ok')
  } catch {
    toast('That template could not be opened', 'err')
  }
}

export function deleteProjectTemplate(id: string): void {
  writeJSON(KEY_PROJECTS, readJSON<ProjectTemplate[]>(KEY_PROJECTS, []).filter((t) => t.id !== id))
  void db.setKV(`projectTemplate:${id}`, '')
  toast('Project template removed', 'ok')
}
