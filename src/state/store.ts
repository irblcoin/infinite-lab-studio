import { useSyncExternalStore } from 'react'
import { db, type StoredProject } from './db'
import { engine } from '../audio/engine'
import { registerBuffer, bufferFromStored } from '../audio/assets'
import {
  defaultSettings,
  makeDevice,
  makeMaster,
  makeTrack,
  TRACK_COLORS,
  uid,
  type Project,
  type Settings,
  type Toast,
  type UIState,
} from './types'
import { PRESETS } from '../data/deviceDefs'
import { getPatch } from '../audio/patch'
import { SAMPLER_DEFAULTS } from '../data/realInstruments'
import type { Device, DeviceType, Params } from './types'

/** Prefer a real sampled instrument when its pack has been registered. */
function samplerOrDefault(patchId: string, type: DeviceType, params: Params, label: string): Device {
  const patch = getPatch(patchId)
  if (!patch) return makeDevice(type, params, label)
  const dev = makeDevice('sampler', { ...SAMPLER_DEFAULTS }, patch.name)
  dev.instrumentId = patch.id
  return dev
}

export interface AppState {
  project: Project
  ui: UIState
  settings: Settings
}

const HISTORY_CAP = 400

const defaultUi: UIState = {
  booted: false,
  view: 'home',
  selectedTrackId: null,
  selectedClipIds: [],
  selectedNoteIds: [],
  editor: 'piano',
  automationTarget: 'volume',
  zoom: 32,
  snap: 0.25,
  libraryOpen: typeof window === 'undefined' ? true : window.innerWidth >= 1280,
  rightPanel: typeof window === 'undefined' ? 'voice' : window.innerWidth >= 1500 ? 'voice' : 'none',
  session: false,
  toasts: [],
  modal: null,
  contextMenu: null,
  recording: false,
  playing: false,
  positionBeat: 0,
  voiceListening: false,
  voiceWake: false,
  helpOpen: false,
  tour: 0,
  confirm: null,
  search: '',
  palette: false,
  studioMode: false,
  commandHistory: [],
  customShortcuts: [],
  layout: 'producer',
  rightWidth: 360,
  settingsFocus: null,
  libraryTab: 'All',
}

export function createEmptyProject(name = 'Untitled Session'): Project {
  const drums = makeTrack('Drums', 'drum', TRACK_COLORS[3], [
    samplerOrDefault('dr_lm2', 'drums', PRESETS.find((p) => p.type === 'drums' && p.name === 'Analog Kit')?.params ?? {}, 'Analog Kit'),
  ])
  drums.volume = 0.8
  const bass = makeTrack('Bass', 'midi', TRACK_COLORS[4], [
    samplerOrDefault('gm_electric_bass_finger', 'bass', PRESETS.find((p) => p.type === 'bass' && p.name === 'Trap 808 Sub')?.params ?? {}, 'Trap 808 Sub'),
  ])
  bass.volume = 0.75
  const keys = makeTrack('Keys', 'midi', TRACK_COLORS[0], [
    samplerOrDefault('sam_salamander', 'keys', PRESETS.find((p) => p.type === 'keys' && p.name === 'Velvet Rhodes')?.params ?? {}, 'Velvet Rhodes'),
  ])
  keys.volume = 0.62
  const vocal = makeTrack('Vocal', 'audio', TRACK_COLORS[1])
  vocal.volume = 0.85
  vocal.armed = true
  vocal.sends = [0.12, 0.05]
  const now = Date.now()
  return {
    id: uid('proj'),
    name,
    bpm: 120,
    timeSig: [4, 4],
    keyRoot: 'C',
    keyScale: 'Minor',
    tracks: [drums, bass, keys, vocal],
    master: makeMaster(),
    loop: { start: 0, end: 16, enabled: false },
    markers: [],
    scenes: 8,
    length: 64,
    lyrics: [
      { id: uid('ly'), text: 'Infinite lab, infinite light', note: 'Verse 1' },
      { id: uid('ly'), text: 'Everything you dream, we can synthesize', note: 'Hook' },
    ],
    snapshots: [],
    createdAt: now,
    updatedAt: now,
  }
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem('ils.settings')
    if (raw) return { ...defaultSettings, ...(JSON.parse(raw) as Partial<Settings>) }
  } catch {
    /* ignore */
  }
  return { ...defaultSettings }
}

let state: AppState = {
  project: createEmptyProject(),
  ui: { ...defaultUi },
  settings: loadSettings(),
}
const past: Project[] = []
const future: Project[] = []
const listeners = new Set<() => void>()
let snapshotVersion = 0
let autosaveTimer = 0
let autosaveInterval = 0

export function getState(): AppState {
  return state
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function notify(): void {
  snapshotVersion++
  engine.sync(state.project)
  for (const l of listeners) l()
}

export function useApp(): AppState {
  useSyncExternalStore(subscribe, () => snapshotVersion)
  return state
}

export function useProject(): Project {
  useSyncExternalStore(subscribe, () => snapshotVersion)
  return state.project
}

export function useUi(): UIState {
  useSyncExternalStore(subscribe, () => snapshotVersion)
  return state.ui
}

export function useSettings(): Settings {
  useSyncExternalStore(subscribe, () => snapshotVersion)
  return state.settings
}

const clone = <T,>(v: T): T => {
  if (typeof structuredClone === 'function') return structuredClone(v)
  return JSON.parse(JSON.stringify(v)) as T
}

export function pushHistory(): void {
  past.push(clone(state.project))
  if (past.length > HISTORY_CAP) past.shift()
  future.length = 0
}

/** Record a history step and apply a mutation. */
export function commit(_label: string, mutate: (p: Project) => void): void {
  pushHistory()
  mutate(state.project)
  state.project.updatedAt = Date.now()
  notify()
  scheduleAutosave()
}

/** Apply a mutation without adding a history step (drag frames). */
export function mutate(fn: (p: Project) => void): void {
  fn(state.project)
  state.project.updatedAt = Date.now()
  notify()
  scheduleAutosave()
}

export function undo(): void {
  const prev = past.pop()
  if (!prev) {
    toast('Nothing to undo', 'warn')
    return
  }
  future.push(clone(state.project))
  state.project = prev
  notify()
  toast('Undo', 'ok')
}

export function redo(): void {
  const next = future.pop()
  if (!next) {
    toast('Nothing to redo', 'warn')
    return
  }
  past.push(clone(state.project))
  state.project = next
  notify()
  toast('Redo', 'ok')
}

export const canUndo = (): boolean => past.length > 0
export const canRedo = (): boolean => future.length > 0
export const historyDepth = (): number => past.length

export function setUi(patch: Partial<UIState> | ((ui: UIState) => Partial<UIState>)): void {
  const p = typeof patch === 'function' ? patch(state.ui) : patch
  state.ui = { ...state.ui, ...p }
  notify()
}

export function saveLayout(name = state.ui.layout): void {
  try {
    localStorage.setItem('ils.layout', JSON.stringify({ name, rightWidth: state.ui.rightWidth, zoom: state.ui.zoom }))
  } catch {
    /* ignore */
  }
}

export function restoreLayout(): void {
  try {
    const raw = localStorage.getItem('ils.layout')
    if (!raw) return
    const data = JSON.parse(raw) as { name?: string; rightWidth?: number }
    state.ui = { ...state.ui, layout: data.name ?? state.ui.layout, rightWidth: data.rightWidth ?? state.ui.rightWidth }
  } catch {
    /* ignore */
  }
}

export function setSettings(patch: Partial<Settings>): void {
  state.settings = { ...state.settings, ...patch }
  try {
    localStorage.setItem('ils.settings', JSON.stringify(state.settings))
  } catch {
    /* ignore */
  }
  engine.setMetronome(state.settings.metronome)
  engine.setMonitoring(state.settings.monitoring)
  notify()
}

export function toast(text: string, kind: Toast['kind'] = 'ok', ms = 2600): void {
  const t: Toast = { id: uid('toast'), text, kind }
  state.ui = { ...state.ui, toasts: [...state.ui.toasts, t] }
  notify()
  window.setTimeout(() => {
    state.ui = { ...state.ui, toasts: state.ui.toasts.filter((x) => x.id !== t.id) }
    notify()
  }, ms)
}

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------
export function scheduleAutosave(): void {
  if (!state.settings.autosave) return
  if (autosaveTimer) window.clearTimeout(autosaveTimer)
  autosaveTimer = window.setTimeout(() => {
    autosaveTimer = 0
    void persistProject(state.project, false)
  }, 1400)
}

export function startAutosaveLoop(): void {
  if (autosaveInterval || typeof window === 'undefined') return
  autosaveInterval = window.setInterval(() => {
    if (state.settings.autosave) void persistProject(state.project, false)
  }, 30000)
}

export function stopAutosaveLoop(): void {
  if (autosaveInterval) window.clearInterval(autosaveInterval)
  autosaveInterval = 0
}

/** Crash marker: set while the app is open, cleared on a clean exit. */
export function markSessionOpen(): void {
  try {
    localStorage.setItem('ils.sessionOpen', JSON.stringify({ at: Date.now(), projectId: state.project.id }))
  } catch {
    /* ignore */
  }
}

export function markSessionClean(): void {
  try {
    localStorage.removeItem('ils.sessionOpen')
  } catch {
    /* ignore */
  }
}

export interface RecoveryInfo {
  at: number
  projectId: string
}

export function pendingRecovery(): RecoveryInfo | null {
  try {
    const raw = localStorage.getItem('ils.sessionOpen')
    if (!raw) return null
    const info = JSON.parse(raw) as RecoveryInfo
    if (Date.now() - info.at < 60_000) return null
    return info
  } catch {
    return null
  }
}

export function applyTheme(theme: 'studio' | 'light'): void {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = theme
}

export async function persistProject(project: Project, makeVersion = true): Promise<void> {
  try {
    const thumb = (await import('../audio/render')).makeThumbnail(project)
    const record: StoredProject = {
      id: project.id,
      name: project.name,
      updatedAt: project.updatedAt,
      createdAt: project.createdAt,
      thumbnail: thumb,
      data: JSON.stringify(project),
    }
    await db.putProject(record)
    await db.setKV('lastProject', project.id)
    try {
      localStorage.setItem('ils.lastSave', JSON.stringify({ at: Date.now(), projectId: project.id }))
    } catch {
      /* ignore */
    }
    if (makeVersion) {
      await db.putVersion({
        key: `${project.id}:${Date.now()}`,
        projectId: project.id,
        savedAt: Date.now(),
        label: project.name,
        data: JSON.stringify(project),
      })
      const versions = await db.versionsFor(project.id)
      for (const v of versions.slice(20)) await db.deleteVersion(v.key)
    }
  } catch (err) {
    console.warn('save failed', err)
    toast('Could not save to this browser (storage may be full)', 'err')
  }
}

export async function saveProjectNow(): Promise<void> {
  await persistProject(state.project, true)
  toast('Project saved with a new version', 'ok')
}

export async function openProjectById(id: string): Promise<boolean> {
  const rec = await db.getProject(id)
  if (!rec) return false
  try {
    const project = JSON.parse(rec.data) as Project
    await adoptProject(project)
    return true
  } catch {
    toast('That project file could not be read', 'err')
    return false
  }
}

export async function adoptProject(project: Project): Promise<void> {
  engine.stop()
  past.length = 0
  future.length = 0
  state.project = project
  state.ui = {
    ...state.ui,
    selectedTrackId: project.tracks[0]?.id ?? null,
    selectedClipIds: [],
    selectedNoteIds: [],
    modal: null,
  }
  await loadProjectAssets(project)
  notify()
  await persistProject(project, false)
}

export async function loadProjectAssets(project: Project): Promise<void> {
  const ids = new Set<string>()
  for (const track of project.tracks) {
    if (track.frozenAssetId) ids.add(track.frozenAssetId)
    for (const device of track.devices) if (device.sampleId && device.sampleId.startsWith('asset_')) ids.add(device.sampleId)
    for (const clip of track.clips) {
      if (clip.assetId) ids.add(clip.assetId)
      for (const take of clip.takes ?? []) ids.add(take.assetId)
    }
  }
  const ctx = engine.ctx ?? (await engine.start())
  for (const id of ids) {
    try {
      const asset = await db.getAsset(id)
      if (asset) registerBuffer(id, bufferFromStored(ctx, asset))
    } catch {
      /* ignore missing asset */
    }
  }
}

export function newProject(name = 'Untitled Session'): void {
  engine.stop()
  past.length = 0
  future.length = 0
  state.project = createEmptyProject(name)
  state.ui = {
    ...state.ui,
    selectedTrackId: state.project.tracks[0]?.id ?? null,
    selectedClipIds: [],
    selectedNoteIds: [],
    view: 'seq',
    modal: null,
  }
  notify()
  toast('New project started', 'ok')
}

export async function importProjectFile(file: File): Promise<void> {
  try {
    const text = await file.text()
    const parsed = JSON.parse(text) as {
      kind?: string
      project?: Project
      assets?: Record<string, { name: string; sampleRate: number; channels: number[][]; duration: number }>
    }
    const project = parsed.project ?? (parsed as unknown as Project)
    if (!project || !Array.isArray(project.tracks)) throw new Error('bad file')
    if (parsed.assets) {
      const ctx = engine.ctx ?? (await engine.start())
      for (const [id, a] of Object.entries(parsed.assets)) {
        const asset = {
          id,
          name: a.name,
          sampleRate: a.sampleRate,
          channels: a.channels.map((c) => Float32Array.from(c)),
          duration: a.duration,
          createdAt: Date.now(),
        }
        await db.putAsset(asset)
        registerBuffer(id, bufferFromStored(ctx, asset))
      }
    }
    project.id = project.id || uid('proj')
    await adoptProject(project)
    toast(`Imported "${project.name}"`, 'ok')
  } catch {
    toast('That file is not a valid ILS project', 'err')
  }
}

export async function exportProjectFile(): Promise<void> {
  const { downloadBlob } = await import('../audio/render')
  const assets: Record<string, unknown> = {}
  for (const track of state.project.tracks) {
    for (const clip of track.clips) {
      const ids = [clip.assetId, ...(clip.takes ?? []).map((t) => t.assetId)].filter(Boolean) as string[]
      for (const id of ids) {
        if (assets[id]) continue
        const a = await db.getAsset(id)
        if (a) {
          assets[id] = {
            name: a.name,
            sampleRate: a.sampleRate,
            duration: a.duration,
            channels: a.channels.map((c) => Array.from(c)),
          }
        }
      }
    }
  }
  const payload = JSON.stringify({ kind: 'ils-project', version: 1, project: state.project, assets })
  downloadBlob(new Blob([payload], { type: 'application/json' }), `${state.project.name.replace(/[^\w-]+/g, '_')}.ils.json`)
  toast('Project file exported', 'ok')
}

export function toastError(err: unknown, fallback: string): void {
  console.warn(err)
  toast(err instanceof Error && err.message ? err.message : fallback, 'err')
}
