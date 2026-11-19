// ---------------------------------------------------------------------------
// ILS core data model
// ---------------------------------------------------------------------------

export type TrackKind = 'audio' | 'midi' | 'drum' | 'group'

export type DeviceType =
  // instruments
  | 'synth'
  | 'fm'
  | 'sampler'
  | 'drums'
  | 'bass'
  | 'keys'
  | 'pad'
  | 'pluck'
  | 'strings'
  | 'eight08'
  // effects
  | 'eq3'
  | 'comp'
  | 'limiter'
  | 'reverb'
  | 'delay'
  | 'chorus'
  | 'flanger'
  | 'phaser'
  | 'distortion'
  | 'bitcrush'
  | 'autofilter'
  | 'gate'
  | 'pitchshift'
  | 'autotune'
  | 'utility'
  // creative processors
  | 'vocoder'
  | 'resonator'
  | 'spectral'
  | 'looper'

export type ViewId = 'home' | 'seq' | 'mix' | 'rack'

export type Params = Record<string, number>

export interface Note {
  id: string
  pitch: number
  start: number
  len: number
  vel: number
}

export interface Take {
  id: string
  name: string
  assetId: string
  offset: number
  len: number
}

export type WarpMode = 'complex' | 'beats' | 'tones' | 'texture'

export interface WarpPoint {
  /** Position in the clip, in beats. */
  beat: number
  /** Position in the source audio, in seconds. */
  sec: number
}

export interface WarpSettings {
  enabled: boolean
  mode: WarpMode
  /** Tempo the audio was recorded at (detected or typed). */
  sourceBpm?: number
  /** Detected tempo from the transient analyser. */
  detectedBpm?: number
  /** Manual stretch amount applied on top of tempo matching. */
  stretch: number
  /** Warp markers (beat → source second). */
  markers: WarpPoint[]
}

export interface EnvPoint {
  id: string
  beat: number
  value: number
}

export interface CompRegion {
  start: number
  end: number
  take: number
}

export interface GrooveSettings {
  preset: string
  amount: number
}

export interface Clip {
  id: string
  name: string
  start: number
  len: number
  contentLen: number
  kind: 'midi' | 'audio'
  notes: Note[]
  assetId?: string
  libId?: string
  offset: number
  gain: number
  fadeIn: number
  fadeOut: number
  reverse: boolean
  pitch: number
  loop: boolean
  takes?: Take[]
  activeTake?: number
  color?: string
  /** Audio timing: keep pitch while matching the project tempo. */
  warp?: WarpSettings
  /** Per-clip gain envelope, drawn on the clip. */
  envelope?: EnvPoint[]
  /** Swing / groove template applied to this clip's notes. */
  groove?: GrooveSettings
  /** Swipe-comp regions: which take is heard between two beats. */
  comp?: CompRegion[]
}

export interface AutoPoint {
  id: string
  beat: number
  value: number
}

export interface AutomationLane {
  id: string
  target: string
  points: AutoPoint[]
  visible: boolean
}

export interface PadSettings {
  gain: number
  tune: number
  decay: number
  pan: number
  choke: number
  cutoff: number
  drive: number
}

export interface Device {
  id: string
  type: DeviceType
  name: string
  bypass: boolean
  params: Params
  sampleId?: string
  /** Multisample patch id (real sampled instrument) when type is 'sampler'. */
  instrumentId?: string
  macroTargets?: Record<string, string>
  /** Per-pad drum rack settings keyed by MIDI pitch. */
  padMap?: Record<string, PadSettings>
}

export interface Sidechain {
  enabled: boolean
  /** Track whose level ducks this one (usually the kick). */
  sourceId: string
  /** 0…1 amount of gain reduction. */
  depth: number
  attack: number
  release: number
}

export interface Track {
  id: string
  name: string
  kind: TrackKind
  color: string
  volume: number
  pan: number
  mute: boolean
  solo: boolean
  armed: boolean
  input: string
  output: string
  sends: [number, number]
  devices: Device[]
  clips: Clip[]
  automation: AutomationLane[]
  frozenAssetId?: string
  height: number
  collapsed: boolean
  sidechain?: Sidechain
}

export interface Marker {
  id: string
  beat: number
  name: string
  color: string
}

export interface LyricLine {
  id: string
  text: string
  note: string
}

export interface MixSnapshot {
  id: string
  name: string
  createdAt: number
  tracks: Record<string, { volume: number; pan: number; sends: [number, number]; mute: boolean; solo: boolean }>
}

export interface MasterSettings {
  volume: number
  limiterOn: boolean
  ceiling: number
}

export interface TempoPoint {
  beat: number
  bpm: number
}

export interface SigPoint {
  /** Bar number (0-based) where the signature changes. */
  bar: number
  num: number
  den: number
}

export interface MasterChain {
  glue: boolean
  eq: boolean
  limiter: boolean
  /** Loudness target in LUFS: -14 streaming, -9 club. */
  target: number
  /** Mastering assistant EQ trims in dB. */
  eqGains?: { low: number; mid: number; high: number }
  /** Mid/side width multiplier (1 = unchanged). */
  width?: number
  /** Make-up gain in dB applied by the assistant. */
  gainDb?: number
  ceiling?: number
}

export interface Project {
  id: string
  name: string
  bpm: number
  timeSig: [number, number]
  /** Tempo automation, sorted by beat. */
  tempoMap?: TempoPoint[]
  /** Time-signature changes along the timeline. */
  sigMap?: SigPoint[]
  masterChain?: MasterChain
  groove?: GrooveSettings
  keyRoot: string
  keyScale: string
  tracks: Track[]
  master: MasterSettings
  loop: { start: number; end: number; enabled: boolean }
  markers: Marker[]
  scenes: number
  length: number
  lyrics: LyricLine[]
  snapshots: MixSnapshot[]
  createdAt: number
  updatedAt: number
}

export interface Settings {
  metronome: boolean
  countIn: number
  punch: { enabled: boolean; start: number; end: number }
  latencyComp: number
  monitoring: boolean
  autosave: boolean
  wakeWord: boolean
  followPlayhead: boolean
  tooltips: boolean
  theme: 'studio' | 'light'
}

export interface Toast {
  id: string
  text: string
  kind: 'ok' | 'warn' | 'err' | 'voice'
}

export interface UIState {
  booted: boolean
  view: ViewId
  selectedTrackId: string | null
  selectedClipIds: string[]
  selectedNoteIds: string[]
  editor: 'piano' | 'drum' | 'automation' | 'none'
  automationTarget: string
  zoom: number
  snap: number // in beats; 0 = off
  libraryOpen: boolean
  rightPanel: 'voice' | 'create' | 'help' | 'none'
  session: boolean
  toasts: Toast[]
  modal:
    | null
    | 'projects'
    | 'versions'
    | 'settings'
    | 'export'
    | 'help'
    | 'record'
    | 'takes'
    | 'shortcuts'
    | 'presets'
    | 'credits'
    | 'sample'
    | 'stems'
    | 'mastering'
    | 'mixassistant'
    | 'storage'
    | 'templates'
    | 'account'
    | 'share'
    | 'midifx'
    | 'drumrack'
    | 'about'
  contextMenu: null | { x: number; y: number; items: { label: string; action: () => void; danger?: boolean }[] }
  recording: boolean
  playing: boolean
  positionBeat: number
  voiceListening: boolean
  voiceWake: boolean
  helpOpen: boolean
  tour: number
  confirm: null | { title: string; text: string; action: () => void }
  search: string
  /** Command palette (Ctrl/Cmd+K). */
  palette: boolean
  /** Continuous hands-free voice sessions. */
  studioMode: boolean
  commandHistory: string[]
  /** User-defined spoken shortcuts. */
  customShortcuts: { id: string; phrase: string; intent: string; args: string }[]
  /** Layout preset name (persisted). */
  layout: string
  rightWidth: number
  /** Which block of Settings a homepage hotspot should jump to. */
  settingsFocus: 'audio' | 'latency' | null
  /** Tab the Sound Library should show (set by the homepage). */
  libraryTab: string
}

export const TRACK_COLORS = [
  '#d7a951',
  '#4fd1c5',
  '#8f7bf7',
  '#f2777a',
  '#63b3ed',
  '#68d391',
  '#f6ad55',
  '#e17bd8',
  '#f9d77e',
  '#7ea6ff',
]

export const SCALES: Record<string, number[]> = {
  Major: [0, 2, 4, 5, 7, 9, 11],
  Minor: [0, 2, 3, 5, 7, 8, 10],
  Dorian: [0, 2, 3, 5, 7, 9, 10],
  Phrygian: [0, 1, 3, 5, 7, 8, 10],
  Lydian: [0, 2, 4, 6, 7, 9, 11],
  Mixolydian: [0, 2, 4, 5, 7, 9, 10],
  HarmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  PentatonicMajor: [0, 2, 4, 7, 9],
  PentatonicMinor: [0, 3, 5, 7, 10],
  Blues: [0, 3, 5, 6, 7, 10],
  Chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
}

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

export const KEY_ROOT_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

export const uid = (prefix = 'id'): string =>
  `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`

export function midiToFreq(p: number): number {
  return 440 * Math.pow(2, (p - 69) / 12)
}

export function midiName(p: number): string {
  return `${NOTE_NAMES[((p % 12) + 12) % 12]}${Math.floor(p / 12) - 1}`
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

export function beatToBar(beat: number, sig: [number, number] = [4, 4]): string {
  const per = sig[0] || 4
  const bar = Math.floor(beat / per) + 1
  const b = Math.floor(beat % per) + 1
  return `${bar}.${b}`
}

export function makeMaster(): MasterSettings {
  return { volume: 0.85, limiterOn: true, ceiling: -0.3 }
}

export function makeDevice(type: DeviceType, params: Params, name: string): Device {
  return { id: uid('dev'), type, name, bypass: false, params: { ...params } }
}

export function makeTrack(name: string, kind: TrackKind, color: string, devices: Device[] = []): Track {
  return {
    id: uid('tr'),
    name,
    kind,
    color,
    volume: 0.8,
    pan: 0,
    mute: false,
    solo: false,
    armed: false,
    input: 'none',
    output: 'master',
    sends: [0, 0],
    devices,
    clips: [],
    automation: [],
    height: 88,
    collapsed: false,
  }
}

export function makeWarp(sourceBpm?: number): WarpSettings {
  return { enabled: true, mode: 'complex', sourceBpm, stretch: 1, markers: [] }
}

export function makeClip(partial: Partial<Clip> & { start: number; len: number }): Clip {
  return {
    id: uid('clip'),
    name: partial.name ?? 'Clip',
    start: partial.start,
    len: partial.len,
    contentLen: partial.contentLen ?? partial.len,
    kind: partial.kind ?? 'midi',
    notes: partial.notes ?? [],
    assetId: partial.assetId,
    libId: partial.libId,
    offset: partial.offset ?? 0,
    gain: partial.gain ?? 1,
    fadeIn: partial.fadeIn ?? 0,
    fadeOut: partial.fadeOut ?? 0,
    reverse: partial.reverse ?? false,
    pitch: partial.pitch ?? 0,
    loop: partial.loop ?? false,
    takes: partial.takes,
    activeTake: partial.activeTake,
    color: partial.color,
    warp: partial.warp,
    envelope: partial.envelope,
    groove: partial.groove,
    comp: partial.comp,
  }
}

export const defaultSettings: Settings = {
  metronome: false,
  countIn: 1,
  punch: { enabled: false, start: 0, end: 16 },
  latencyComp: 0.04,
  monitoring: false,
  autosave: true,
  wakeWord: false,
  followPlayhead: true,
  tooltips: true,
  theme: 'studio',
}
