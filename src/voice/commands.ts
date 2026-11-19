import type { DeviceType, Project, Track } from '../state/types'
import { clamp } from '../state/types'
import { getState, setSettings, setUi, toast, commit, saveProjectNow } from '../state/store'
import {
  addDevice,
  addMarker,
  addTrack,
  deleteTrack,
  duplicateClip,
  generateFromText,
  quantizeClip,
  setBpm,
  setKey,
  setLoop,
  splitClipAt,
  stopTransport,
  togglePlay,
  deleteClip,
  setTrackVolume,
  renameTrack,
  toggleArm,
  toggleMute,
  toggleSolo,
  selectedTrack,
  addClip,
} from '../state/actions'
import { startRecording, stopRecording } from '../state/record'
import { chromaticCopies, sliceClipToTimeline } from '../audio/sampleTools'
import { engine } from '../audio/engine'
import {
  addTempoPoint,
  addTimeSignature,
  applyGrooveToProject,
  applyMasterPreset,
  applyReturnPreset,
  applyVocalChain,
  autoComp,
  autoEnvelope,
  clipToMidi,
  consolidateClip,
  detectClipTempo,
  dropLoop,
  exportStems,
  flattenTrack,
  loopsByGenre,
  setSidechain,
  startVocalBooth,
  warpClipToTempo,
} from '../state/features'
import { installAllPacks } from '../data/packStore'

export interface ParsedCommand {
  intent: string
  args: Record<string, string | number | boolean>
  raw: string
  confidence: number
  label: string
}

const NUM_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100,
}

function num(value: string | undefined): number | null {
  if (!value) return null
  const cleaned = value.trim().toLowerCase()
  if (/^\d+(\.\d+)?$/.test(cleaned)) return Number(cleaned)
  const parts = cleaned.split(/[\s-]+/)
  let total = 0
  let current = 0
  let matched = false
  for (const part of parts) {
    if (NUM_WORDS[part] == null) continue
    matched = true
    const v = NUM_WORDS[part]
    if (v === 100) {
      current = Math.max(1, current) * 100
    } else {
      current += v
    }
  }
  total += current
  return matched ? total : null
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  const prev = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1))
      last = tmp
    }
  }
  return prev[b.length]
}

export function similarity(a: string, b: string): number {
  const x = a.toLowerCase().trim()
  const y = b.toLowerCase().trim()
  if (!x || !y) return 0
  if (x === y) return 1
  if (y.includes(x) || x.includes(y)) return 0.92
  const dist = levenshtein(x, y)
  return Math.max(0, 1 - dist / Math.max(x.length, y.length))
}

function resolveTrack(project: Project, phrase: string | undefined): Track | undefined {
  if (!phrase) return undefined
  const cleaned = phrase
    .toLowerCase()
    .replace(/\b(the|a|an|track|channel|clip|bus|please|now|to)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return undefined
  const n = num(cleaned)
  if (n != null && n >= 1 && n <= project.tracks.length) return project.tracks[n - 1]
  let best: Track | undefined
  let bestScore = 0
  for (const track of project.tracks) {
    const score = Math.max(
      similarity(cleaned, track.name.toLowerCase()),
      ...track.name
        .toLowerCase()
        .split(/\s+/)
        .map((w) => similarity(cleaned, w)),
    )
    if (score > bestScore) {
      bestScore = score
      best = track
    }
  }
  return bestScore >= 0.62 ? best : undefined
}

const EFFECT_ALIASES: [RegExp, DeviceType][] = [
  [/\breverb|hall|room|space\b/, 'reverb'],
  [/\bdelay|echo\b/, 'delay'],
  [/\beq|equaliz/, 'eq3'],
  [/\bcompress/, 'comp'],
  [/\blimit/, 'limiter'],
  [/\bchorus/, 'chorus'],
  [/\bflanger/, 'flanger'],
  [/\bphaser/, 'phaser'],
  [/\bdistort|overdrive|fuzz|saturat/, 'distortion'],
  [/\bbitcrush|bit crush|crush/, 'bitcrush'],
  [/\bfilter\b/, 'autofilter'],
  [/\bgate\b/, 'gate'],
  [/\bpitch shift|pitchshift\b/, 'pitchshift'],
  [/\bautotune|auto tune|tuner|tune\b/, 'autotune'],
  [/\butility\b/, 'utility'],
]

const INSTRUMENT_ALIASES: [RegExp, DeviceType][] = [
  [/\bdrums?\b/, 'drums'],
  [/\b808\b/, 'eight08'],
  [/\bbass\b/, 'bass'],
  [/\bkeys|piano|rhodes|ep\b/, 'keys'],
  [/\bpad\b/, 'pad'],
  [/\bpluck|harp|guitar\b/, 'pluck'],
  [/\bstrings?\b/, 'strings'],
  [/\bfm\b/, 'fm'],
  [/\bsampler?\b/, 'sampler'],
  [/\bsynth|lead\b/, 'synth'],
]

export const VOICE_HELP: { phrase: string; note: string }[] = [
  { phrase: 'play / stop / record', note: 'Transport control' },
  { phrase: 'loop bars 5 to 9', note: 'Set the loop region' },
  { phrase: 'set tempo to 140', note: 'Change project tempo' },
  { phrase: 'open mixer / racks / sequencer', note: 'Switch workspace' },
  { phrase: 'add a drum track', note: 'Create a new track' },
  { phrase: 'add reverb to the vocal', note: 'Insert an effect' },
  { phrase: 'mute track 3', note: 'Mute by number or name' },
  { phrase: 'solo the bass', note: 'Solo by name' },
  { phrase: 'raise the master 3 decibels', note: 'Master gain' },
  { phrase: 'make the snare louder', note: 'Relative track gain' },
  { phrase: 'quantize this', note: 'Quantize selected clip' },
  { phrase: 'undo / redo', note: 'History' },
  { phrase: 'save project / export', note: 'Save or export' },
  { phrase: 'set key to E minor', note: 'Project key & scale' },
  { phrase: 'create dark trap beat 140 bpm in E minor', note: 'Generate an arrangement' },
  { phrase: 'rename track 2 to Lead Vocal', note: 'Name a track by voice' },
  { phrase: 'arm track 4', note: 'Record-arm a track' },
  { phrase: 'jump to bar 17', note: 'Move the playhead' },
  { phrase: 'add a marker here', note: 'Drop a marker' },
  { phrase: 'record a vocal', note: 'Vocal Booth: track, chain, arm and record' },
  { phrase: 'warp this clip to the project tempo', note: 'Time-stretch audio to the grid' },
  { phrase: 'sidechain the bass to the kick', note: 'Duck one track from another' },
  { phrase: 'export stems', note: 'Render one WAV per track' },
  { phrase: 'install all packs', note: 'Download every sound pack' },
  { phrase: 'use the rap vocal chain', note: 'Load a vocal channel strip' },
  { phrase: 'master for streaming', note: 'Glue / EQ / limiter at −14 LUFS' },
  { phrase: 'hall reverb on the vocal', note: 'Return preset + send' },
  { phrase: 'apply mpc 16 swing', note: 'Groove template' },
  { phrase: 'freeze the strings', note: 'Freeze a track to audio' },
  { phrase: 'flatten the drums', note: 'Bounce a track to one clip' },
  { phrase: 'consolidate this clip', note: 'Bounce the clip' },
  { phrase: 'transcribe this audio to midi', note: 'Audio → MIDI' },
  { phrase: 'auto comp the vocal', note: 'Build a comp from the takes' },
  { phrase: 'add a trap loop', note: 'Drop a real loop that follows the tempo' },
  { phrase: 'detect the tempo of this clip', note: 'Transient BPM analysis' },
  { phrase: 'fade in this clip / swell it / pump it', note: 'Draw a clip envelope' },
  { phrase: 'show the meters', note: 'Spectrum, phase and loudness view' },
  { phrase: 'tempo 90 at bar 9', note: 'Tempo automation' },
  { phrase: '6/8 from bar 5', note: 'Time-signature change' },
  { phrase: 'open the sample editor', note: 'Trim, loop, slice and pads' },
  { phrase: 'slice this clip by transients', note: 'Sample slicing' },
  { phrase: 'arpeggiate this / chordify it / humanize', note: 'MIDI effects' },
  { phrase: 'open the drum rack', note: 'Per-pad chains and choke groups' },
  { phrase: 'separate the stems', note: 'Vocals / drums / bass / other, in a worker' },
  { phrase: 'master the mix for streaming', note: 'Mastering assistant' },
  { phrase: 'check the mix', note: 'Mix assistant suggestions' },
  { phrase: 'make it darker / brighter', note: 'Mood shift on the selected clip' },
  { phrase: 'regenerate this section', note: 'New notes for the selected clip' },
  { phrase: 'write a variation', note: 'Rhythmic variation' },
  { phrase: 'compose a dark trap song at 140', note: 'Full song structure' },
  { phrase: 'lyrics to melody', note: 'Turn the lyric into notes' },
  { phrase: 'chord progression', note: 'Insert a progression' },
  { phrase: 'studio mode', note: 'Hands-free continuous commands' },
  { phrase: 'open the command palette', note: 'Search every action' },
  { phrase: 'light theme / dark theme', note: 'Appearance' },
  { phrase: 'storage cleanup', note: 'Free space safely' },
  { phrase: 'share this project', note: 'Read-only player link' },
  { phrase: 'cloud save', note: 'Account and cloud' },
]

export function parseCommand(rawText: string): ParsedCommand | null {
  const raw = rawText.trim()
  if (!raw) return null
  const text = raw
    .toLowerCase()
    .replace(/[.,!?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const { project } = getState()
  const mk = (intent: string, args: Record<string, string | number | boolean>, label: string, confidence = 0.96): ParsedCommand => ({
    intent,
    args,
    raw,
    confidence,
    label,
  })

  // ---- early, unambiguous pro-tool phrases -------------------------------
  if (/\b(drum rack|drum pads|pad chains)\b/.test(text)) return mk('drumRack', {}, 'Drum Rack')
  if (/\b(make (it|this|the mix) (darker|brighter)|go (darker|brighter)|sound (darker|brighter))\b/.test(text)) {
    return mk('mood', { dir: /brighter/.test(text) ? 'brighter' : 'darker' }, /brighter/.test(text) ? 'Make brighter' : 'Make darker')
  }
  if (/\b(separate the stems|split into stems|stem separation)\b/.test(text)) return mk('stems', {}, 'Stem separation')
  if (/\bmastering assistant\b/.test(text)) return mk('mastering', {}, 'Mastering assistant')
  if (/\bmix assistant\b/.test(text)) return mk('mixAssistant', {}, 'Mix assistant')

  // ---- loop region -------------------------------------------------------
  let m = text.match(/\bloop\b(?:\s+bars?)?\s*(\d+)\s*(?:to|through|until|-|and)\s*(\d+)/)
  if (m) {
    const a = Number(m[1])
    const b = Number(m[2])
    return mk('loopRegion', { start: (a - 1) * 4, end: b * 4 }, `Loop bars ${a} to ${b}`)
  }
  if (/\bloop\b/.test(text) && !/loop\s*(off|on)/.test(text) === false) {
    return mk('loopToggle', {}, 'Toggle loop')
  }
  if (/\bloop\b/.test(text) && /\b(off|on|toggle|enable|disable)\b/.test(text)) {
    return mk('loopToggle', {}, 'Toggle loop')
  }
  if (/\bmetronome|click track\b/.test(text)) return mk('metronome', {}, 'Toggle metronome')

  // ---- tempo -------------------------------------------------------------
  m = text.match(/(?:tempo|bpm|speed)\D{0,15}?(\d{2,3})/) || text.match(/(\d{2,3})\s*(?:bpm|beats per minute)/)
  if (m) {
    return mk('tempo', { bpm: Number(m[1]) }, `Tempo ${m[1]} BPM`)
  }

  // ---- key ---------------------------------------------------------------
  m = text.match(/\b(?:key|scale)\b[^a-g]{0,8}([a-g][#b]?)(?:\s*(minor|major|min|maj|dorian|phrygian|lydian|mixolydian))?/)
  if (m) {
    const keyRoot = m[1].toUpperCase()
    const scaleWord = m[2]
    const scaleMap: Record<string, string> = {
      minor: 'Minor',
      min: 'Minor',
      major: 'Major',
      maj: 'Major',
      dorian: 'Dorian',
      phrygian: 'Phrygian',
      lydian: 'Lydian',
      mixolydian: 'Mixolydian',
    }
    return mk('key', { keyRoot, scale: scaleWord ? scaleMap[scaleWord] ?? 'Minor' : '' }, `Key ${keyRoot}`)
  }

  // ---- master / track level ---------------------------------------------
  const isMaster = /\b(master|main|mix)\b/.test(text)
  const louder = /\b(raise|up|increase|louder|boost|more|turn up|hotter)\b/.test(text)
  const quieter = /\b(lower|down|decrease|quieter|reduce|less|turn down|softer)\b/.test(text)
  if (isMaster && (louder || quieter)) {
    const amount = num(text.match(/(\d+(?:\.\d+)?)\s*(?:db|decibel|decibels)/)?.[1]) ?? 3
    return mk('masterVolume', { delta: louder ? amount : -amount }, `${louder ? 'Raise' : 'Lower'} master ${amount} dB`)
  }
  if (/\bvolume\b|\bvol\b/.test(text) || (louder || quieter)) {
    const trackPhrase =
      text.match(/(?:the|track|channel)?\s*([a-z0-9 ]+?)\s+(?:by|up|down|louder|quieter)/)?.[1] ??
      text.match(/(?:mute|solo|raise|lower|boost|reduce)\s+(?:the\s+)?(.+)/)?.[1]
    const track = isMaster ? undefined : resolveTrack(project, trackPhrase ?? '')
    const amount = num(text.match(/(\d+(?:\.\d+)?)\s*(?:db|decibel|decibels)/)?.[1]) ?? 3
    if (isMaster) return mk('masterVolume', { delta: louder ? amount : -amount }, `Adjust master ${amount} dB`)
    if (track) return mk('trackVolume', { trackId: track.id, delta: louder ? amount : -amount }, `${louder ? 'Raise' : 'Lower'} ${track.name} ${amount} dB`)
  }

  // ---- quantize ----------------------------------------------------------
  if (/\bquantiz/.test(text)) {
    const gridMatch = text.match(/1\s*\/\s*(4|8|16|32)/) || text.match(/\b(4|8|16|32)(?:nd|th|s)?\b/)
    const grid = gridMatch ? (4 / Number(gridMatch[1])) : 0.25
    return mk('quantize', { grid }, `Quantize to 1/${gridMatch ? gridMatch[1] : '16'}`)
  }

  // ---- navigation --------------------------------------------------------
  m = text.match(/\b(?:open|show|go to|switch to|take me to)\b.*?\b(mixer|mix|racks?|sequencer|arrangement|timeline|home|studio)\b/)
  if (m) {
    const v = m[1]
    const view = v === 'mix' ? 'mix' : v === 'mixer' ? 'mix' : v.startsWith('rack') ? 'rack' : v === 'home' || v === 'studio' ? 'home' : 'seq'
    return mk('view', { view }, `Open ${view === 'seq' ? 'sequencer' : view}`)
  }
  m = text.match(/\b(?:jump|go)\s+to\s+(?:the\s+)?bar\s+(\d+)/)
  if (m) return mk('jump', { bar: Number(m[1]) }, `Jump to bar ${m[1]}`)

  // ---- add effect --------------------------------------------------------
  m = text.match(/\b(?:add|insert|put|apply)\b(.*?)\b(?:to|on)\b\s*(?:the\s+)?(.+)/)
  if (m) {
    const effectPhrase = m[1]
    const matchedEffect = EFFECT_ALIASES.find(([re]) => re.test(effectPhrase))
    if (matchedEffect) {
      const track = resolveTrack(project, m[2]) ?? selectedTrack()
      if (track) return mk('addEffect', { trackId: track.id, type: matchedEffect[1] }, `Add ${matchedEffect[1]} to ${track.name}`)
    }
  }
  m = text.match(/\b(?:add|insert|put)\b\s*(?:an?\s+)?([a-z0-9 ]+?)\s*(?:effect|plugin|device)?\s*(?:to|on)\s+(?:the\s+)?(.+)/)
  if (m) {
    const matchedEffect = EFFECT_ALIASES.find(([re]) => re.test(m![1]))
    const track = resolveTrack(project, m[2])
    if (matchedEffect && track) return mk('addEffect', { trackId: track.id, type: matchedEffect[1] }, `Add ${matchedEffect[1]} to ${track.name}`)
  }

  // ---- add track ---------------------------------------------------------
  if (/\b(add|create|new|make)\b/.test(text) && /\btrack\b/.test(text)) {
    const inst = INSTRUMENT_ALIASES.find(([re]) => re.test(text))
    if (inst) return mk('addTrack', { kind: inst[1] === 'drums' ? 'drum' : 'midi', device: inst[1] }, `Add ${inst[1]} track`)
    if (/\bvocals?|audio\b/.test(text)) return mk('addTrack', { kind: 'audio' }, 'Add audio track')
    if (/\bgroup|bus\b/.test(text)) return mk('addTrack', { kind: 'group' }, 'Add group track')
    return mk('addTrack', { kind: 'midi' }, 'Add instrument track')
  }

  // ---- mute / solo / arm -------------------------------------------------
  m = text.match(/\b(mute|unmute|solo|unsolo|arm|disarm)\b\s*(?:the\s+|track\s+)?(.+)/)
  if (m) {
    const verb = m[1]
    const track = resolveTrack(project, m[2])
    if (track) {
      if (verb === 'mute' || verb === 'unmute') return mk('mute', { trackId: track.id, on: verb === 'mute' }, `${verb} ${track.name}`)
      if (verb === 'solo' || verb === 'unsolo') return mk('solo', { trackId: track.id, on: verb === 'solo' }, `${verb} ${track.name}`)
      return mk('arm', { trackId: track.id }, `Arm ${track.name}`)
    }
  }

  // ---- rename ------------------------------------------------------------
  m = text.match(/\brename\b\s+(?:the\s+)?(?:track\s+)?(.+?)\s+(?:to|as)\s+(.+)/)
  if (m) {
    const track = resolveTrack(project, m[1])
    if (track) return mk('rename', { trackId: track.id, name: m[2].trim() }, `Rename ${track.name}`)
  }

  // ---- generation --------------------------------------------------------
  if (/\b(create|generate|make|compose|produce)\b/.test(text) && !/\bclip\b/.test(text)) {
    const prompt = raw.replace(/^(hey ils[,\s]*)?/i, '').replace(/^(create|generate|make|compose|produce)\s+(me\s+)?/i, '')
    return mk('create', { prompt }, 'Generate arrangement')
  }

  // ---- clip actions ------------------------------------------------------
  if (/\bdelete|remove\b/.test(text) && /\btrack\b/.test(text)) {
    const track = resolveTrack(project, text.replace(/.*\btrack\b/, ''))
    if (track) return mk('deleteTrack', { trackId: track.id }, `Delete ${track.name}`)
  }
  if (/\bdelete|remove\b/.test(text) && /\bclip|region\b/.test(text)) return mk('deleteClip', {}, 'Delete selected clip')
  if (/\bduplicate\b/.test(text) && /\bclip|region\b/.test(text)) return mk('duplicateClip', {}, 'Duplicate clip')
  if (/\bsplit\b/.test(text)) return mk('split', {}, 'Split clip at playhead')
  if (/\btranspose\b/.test(text)) {
    const amount = num(text.match(/transpose.*?(\d+)/)?.[1]) ?? 1
    const down = /\bdown|lower|minus\b/.test(text)
    return mk('transpose', { semis: down ? -amount : amount }, `Transpose ${down ? '-' : '+'}${amount}`)
  }
  if (/\bmarker\b/.test(text) && /\badd|drop|place\b/.test(text)) {
    const name = text.match(/\bmarker\s+(?:called|named)\s+(.+)/)?.[1]
    return mk('marker', { name: name ?? '' }, 'Add marker')
  }
  if (/\bnote\b/.test(text) && /\b(add|write|dictate)\b/.test(text)) {
    const body = raw.replace(/^.*?\b(add|write|dictate)\b\s*(a\s+)?(note|lyric)?\s*(that\s+says\s+)?/i, '')
    return mk('lyric', { text: body }, 'Add lyric note')
  }

  // ---- new feature commands ---------------------------------------------
  if (/\b(vocal booth|record (a |my )?vocals?|record a vocal take|start a vocal)\b/.test(text)) {
    return mk('vocalBooth', {}, 'Vocal booth')
  }
  if (/\b(warp|time.?stretch|stretch to tempo)\b/.test(text) && !/\btempo\b\s*\d/.test(text)) {
    return mk('warpClip', { bpm: num(text.match(/(\d{2,3})\s*bpm/)?.[1]) ?? 0 }, 'Warp clip to project tempo')
  }
  if (/\b(sidechain|side chain|duck)\b/.test(text)) {
    const m2 = text.match(/(?:sidechain|side chain|duck)\s+(?:the\s+)?(.+?)\s+(?:to|from|by|with|under)\s+(?:the\s+)?(.+)/)
    if (m2) {
      const target = resolveTrack(project, m2[1]) ?? selectedTrack()
      // “the kick” is almost always the drum track, which may be called Drums.
      const source =
        resolveTrack(project, m2[2]) ??
        project.tracks.find((t) => /kick|drum|beat/i.test(t.name)) ??
        project.tracks.find((t) => t.kind === 'drum')
      if (target && source && target.id !== source.id) {
        return mk('sidechain', { trackId: target.id, sourceId: source.id }, `Duck ${target.name} from ${source.name}`)
      }
    }
  }
  if (/\bexport\b/.test(text) && /\bstems?\b/.test(text)) return mk('exportStems', {}, 'Export stems')
  if (/\b(install|download|get)\b/.test(text) && /\b(packs?|sounds?|instruments?)\b/.test(text)) {
    return mk('installPacks', { all: /\ball\b/.test(text) }, 'Install sound packs')
  }
  m = text.match(/\b(freeze|unfreeze|flatten|consolidate|bounce)\b(?:\s+(?:the\s+|this\s+)?(.+))?/)
  if (m) {
    const verb = m[1]
    const track = m[2] ? resolveTrack(project, m[2]) : selectedTrack() ?? undefined
    if (track) return mk(`${verb}Track`, { trackId: track.id, all: /\bproject|everything|all\b/.test(text) }, `${verb} ${track.name}`)
  }
  if (/\b(swing|groove|shuffle)\b/.test(text)) {
    const preset = /mpc\s*16/.test(text) ? 'mpc16' : /mpc\s*8/.test(text) ? 'mpc8' : /triplet/.test(text) ? 'triplet' : /dilla/.test(text) ? 'dilla' : /latin/.test(text) ? 'latin' : /rock/.test(text) ? 'rock' : /straight/.test(text) ? 'straight' : 'mpc16'
    return mk('groove', { preset }, `Groove ${preset}`)
  }
  if (/\bmaster\b/.test(text) && /(stream|club|lufs|mastering|glue|limiter)/.test(text)) {
    const preset = /club/.test(text) ? 'club' : /glue/.test(text) ? 'glue' : /off|bypass/.test(text) ? 'off' : 'streaming'
    return mk('masterPreset', { preset }, `Master: ${preset}`)
  }
  if (/\bvocal chain\b|\brap vocal\b|\bclean vocal\b|\bauto.?tune chain\b|\bradio voice\b|\blofi vocal\b/.test(text)) {
    const preset = /rap/.test(text) ? 'vocal_rap' : /tune/.test(text) ? 'vocal_tune' : /radio/.test(text) ? 'vocal_radio' : /lofi|lo-fi/.test(text) ? 'vocal_lofi' : 'vocal_clean'
    return mk('vocalChain', { preset }, `Vocal chain ${preset}`)
  }
  if (/\b(plate|hall|slap|tape) (reverb|delay|echo)\b/.test(text)) {
    const preset = /plate/.test(text) ? 'plate' : /hall/.test(text) ? 'hall' : /slap/.test(text) ? 'slap' : 'tape'
    const track = resolveTrack(project, text) ?? selectedTrack() ?? undefined
    return mk('returnPreset', { preset, trackId: track?.id ?? '' }, `${preset} return`)
  }
  if (/\b(transcribe|audio to midi|convert.*to midi|to midi)\b/.test(text)) {
    const kind = /drum/.test(text) ? 'drums' : /harmon|chord/.test(text) ? 'harmony' : 'melody'
    return mk('audioToMidi', { kind }, `Audio to MIDI (${kind})`)
  }
  if (/\b(auto.?comp|comping|comp the|comp this)\b/.test(text)) return mk('autoComp', {}, 'Auto comp takes')
  if (/\b(fade in|fade out|swell|pump|clip envelope|envelope)\b/.test(text)) {
    const shape = /fade out/.test(text) ? 'fade' : /swell/.test(text) ? 'swell' : /pump/.test(text) ? 'pump' : 'fade'
    return mk('clipEnvelope', { shape }, `Clip envelope: ${shape}`)
  }
  if (/\b(detect|analyse|analyze|find|read)\b.*\b(tempo|bpm)\b|\bwhat.?s the (bpm|tempo)\b/.test(text)) {
    return mk('detectTempo', {}, 'Detect clip tempo')
  }
  if (/\b(meters?|spectrum|phase|loudness)\b/.test(text) && /\b(show|open|view|see|check)\b/.test(text)) {
    return mk('meters', {}, 'Open the meters')
  }
  m = text.match(/(?:add|drop|place|insert)\b.*?\b(boom ?bap|trap|drill|rnb|r&b|edm|house|pop|rock|soul|lofi|lo-fi)\b.*?\bloop\b/i)
  if (m) return mk('addLoop', { genre: m[1].toLowerCase().replace(/[^a-z]/g, '') }, `Add ${m[1]} loop`)
  if (/(?:add|drop|place|insert)\b.*\bloop\b/.test(text)) return mk('addLoop', { genre: '' }, 'Add a loop')
  m = text.match(/\b(\d{2,3})\s*(?:bpm|tempo)\b.*?\bbar\s+(\d+)/) || text.match(/\bbar\s+(\d+).*?\b(\d{2,3})\s*bpm/)
  if (m) {
    const bpm = Number(m[1])
    const bar = Number(m[2])
    return mk('tempoPoint', { bpm, beat: (bar - 1) * 4 }, `${bpm} BPM from bar ${bar}`)
  }
  m = text.match(/\b(\d{1,2})\s*\/\s*(\d{1,2})\b.*?\bbar\s+(\d+)/)
  if (m) return mk('timeSig', { num: Number(m[1]), den: Number(m[2]), bar: Number(m[3]) - 1 }, `${m[1]}/${m[2]} from bar ${m[3]}`)

  // ---- transport / project ----------------------------------------------
  if (/\b(play|start|resume|go)\b/.test(text) && !/\bplayback\b/.test(text)) return mk('play', {}, 'Play')
  if (/\b(stop|pause|halt)\b/.test(text)) return mk('stop', {}, 'Stop')
  if (/\b(record|recording|rec)\b/.test(text)) return mk('record', {}, 'Toggle recording')
  // ---- pro tools, creative and workspace ---------------------------------
  if (/\b(stop|end|exit|leave)\b.*\bstudio mode\b|\bstudio mode off\b/.test(text)) return mk('studioMode', { on: false }, 'Studio mode off')
  if (/\bstudio mode\b|\bhands.?free\b|\bcontinuous listening\b/.test(text)) return mk('studioMode', { on: true }, 'Studio mode')
  if (/\b(command palette|palette|quick search)\b/.test(text)) return mk('palette', {}, 'Command palette')
  if (/\b(sample editor|simpler|slice editor|sample tools)\b/.test(text)) return mk('sampleEditor', {}, 'Sample editor')
  if (/\bslice\b/.test(text) && /\b(drum|percussive|transient)\b/.test(text)) return mk('sliceSample', { mode: 'transients' }, 'Slice by transients')
  if (/\bslice\b/.test(text) && /\b(grid|sixteenth|sixteenths|half)\b/.test(text)) return mk('sliceSample', { mode: 'grid' }, 'Slice to grid')
  if (/\bslice\b/.test(text)) return mk('sliceSample', { mode: 'beats' }, 'Slice by beats')
  if (/\bchromatic\b/.test(text)) return mk('chromaticSample', {}, 'Chromatic sample copies')
  if (/\bdrum rack|drum pads|pad chains\b/.test(text)) return mk('drumRack', {}, 'Drum Rack')
  if (/\b(stem separation|separate|split|stem(s)? out|isolate)\b/.test(text) && /\b(stem|stems|vocal|vocals|drums|bass)\b/.test(text)) return mk('stems', {}, 'Stem separation')
  if (/\bmaster(ing)?\b/.test(text) && /\b(assistant|analyse|analyze|analyzed|loudness|master the mix)\b/.test(text)) return mk('mastering', {}, 'Mastering assistant')
  if (/\bmix assistant\b|\bcheck the mix|\banalyse the mix|\banalyze the mix|\bmix check\b/.test(text)) return mk('mixAssistant', {}, 'Mix assistant')
  if (/\btemplate(s)?\b/.test(text)) return mk('templates', {}, 'Templates')
  if (/\b(storage|disk space|clean.?up|free space|quota)\b/.test(text)) return mk('storage', {}, 'Storage & cleanup')
  if (/\b(account|sign in|log ?in|cloud save|my projects in the cloud)\b/.test(text)) return mk('account', {}, 'Account & cloud')
  if (/\b(share|share link|link to this project)\b/.test(text)) return mk('share', {}, 'Share project')
  if (/\b(light|dark) (theme|mode)\b|\bswitch (the )?theme\b/.test(text)) return mk('theme', { theme: /\blight\b/.test(text) ? 'light' : 'studio' }, 'Theme')
  if (/\b(darker)\b/.test(text)) return mk('mood', { dir: 'darker' }, 'Make darker')
  if (/\b(brighter)\b/.test(text)) return mk('mood', { dir: 'brighter' }, 'Make brighter')
  if (/\bregenerate\b/.test(text)) return mk('regenerateSection', {}, 'Regenerate section')
  if (/\bvariation\b|\bvariations\b/.test(text)) return mk('variation', {}, 'Variation')
  if (/\blyrics? to (a )?melody\b|\bsing the lyri/.test(text)) return mk('lyricsToMelody', {}, 'Lyrics → melody')
  if (/\bchord (progression|library|suggestions?)\b/.test(text)) return mk('chords', {}, 'Chord progression')
  if (/\b(humanize|humanise)\b/.test(text)) return mk('midiFx', { id: 'humanize' }, 'Humanize clip')
  if (/\b(arpeggiate|arpeggiator|arp)\b/.test(text)) return mk('midiFx', { id: 'arp_up' }, 'Arpeggiate clip')
  if (/\bchordify\b|\badd chords to\b/.test(text)) return mk('midiFx', { id: 'chord_triad' }, 'Chordify clip')
  if (/\bscale quanti[sz]e\b|\bquantize to (the )?scale\b/.test(text)) return mk('midiFx', { id: 'quantize' }, 'Scale quantize')
  if (/\b(generate|compose|write|make)\b/.test(text) && /\b(song|track|beat|arrangement)\b/.test(text) && !/\bshortcut\b/.test(text)) {
    return mk('song', { prompt: raw }, 'Compose a song')
  }
  if (/\bundo\b/.test(text)) return mk('undo', {}, 'Undo')
  if (/\bredo\b/.test(text)) return mk('redo', {}, 'Redo')
  if (/\bsave\b/.test(text)) return mk('save', {}, 'Save project')
  if (/\bexport\b/.test(text)) return mk('export', {}, 'Open export')
  if (/\bnew project\b/.test(text)) return mk('newProject', {}, 'New project')
  if (/\bopen project|projects\b/.test(text)) return mk('openProjects', {}, 'Open project browser')
  if (/\b(help|commands|what can you do)\b/.test(text)) return mk('help', {}, 'Show command help')
  if (/\bzoom in\b/.test(text)) return mk('zoom', { dir: 1 }, 'Zoom in')
  if (/\bzoom out\b/.test(text)) return mk('zoom', { dir: -1 }, 'Zoom out')

  // ---- fuzzy single word fallback ---------------------------------------
  const first = text.split(' ')[0]
  const verbs: [string, string, string][] = [
    ['play', 'play', 'Play'],
    ['stop', 'stop', 'Stop'],
    ['record', 'record', 'Record'],
    ['undo', 'undo', 'Undo'],
    ['redo', 'redo', 'Redo'],
    ['save', 'save', 'Save'],
    ['mute', 'mute', 'Mute'],
    ['solo', 'solo', 'Solo'],
  ]
  let best: [string, string, string] | null = null
  let bestScore = 0
  for (const v of verbs) {
    const s = similarity(first, v[0])
    if (s > bestScore) {
      bestScore = s
      best = v
    }
  }
  if (best && bestScore >= 0.72) {
    return { intent: best[1], args: {}, raw, confidence: bestScore, label: best[2] }
  }
  return null
}

export async function executeCommand(cmd: ParsedCommand): Promise<string> {
  const { project, ui } = getState()
  // User-defined spoken shortcuts run the command they were mapped to.
  const spoken = cmd.raw.trim().toLowerCase()
  const custom = ui.customShortcuts.find((c) => c.phrase.trim().toLowerCase() === spoken)
  if (custom && custom.intent !== cmd.intent) {
    const target = parseCommand(custom.intent)
    if (target) return executeCommand(target)
  }
  switch (cmd.intent) {
    case 'play':
      if (!engine.isPlaying) await togglePlay()
      return 'Playing'
    case 'stop':
      stopTransport()
      return 'Stopped'
    case 'record':
      if (getState().ui.recording) {
        await stopRecording()
        return 'Recording stopped'
      }
      await startRecording()
      return 'Recording started'
    case 'undo':
      (await import('../state/store')).undo()
      return 'Undid last action'
    case 'redo':
      (await import('../state/store')).redo()
      return 'Redid action'
    case 'save':
      await saveProjectNow()
      return 'Project saved'
    case 'export':
      setUi({ modal: 'export' })
      return 'Export panel opened'
    case 'view':
      setUi({ view: cmd.args.view as 'home' | 'seq' | 'mix' | 'rack' })
      return `Opened ${String(cmd.args.view)}`
    case 'tempo':
      setBpm(Number(cmd.args.bpm))
      return `Tempo set to ${cmd.args.bpm} BPM`
    case 'loopRegion':
      setLoop(Number(cmd.args.start), Number(cmd.args.end), true)
      return `Loop set to bars ${Number(cmd.args.start) / 4 + 1} to ${Number(cmd.args.end) / 4}`
    case 'loopToggle': {
      const { project: p } = getState()
      setLoop(p.loop.start, p.loop.end, !p.loop.enabled)
      return `Loop ${!p.loop.enabled ? 'on' : 'off'}`
    }
    case 'metronome': {
      const { settings } = getState()
      setSettings({ metronome: !settings.metronome })
      return `Metronome ${!settings.metronome ? 'on' : 'off'}`
    }
    case 'key':
      setKey(String(cmd.args.keyRoot), (cmd.args.scale as string) || undefined)
      return `Key set to ${cmd.args.keyRoot} ${cmd.args.scale ?? ''}`.trim()
    case 'addTrack':
      addTrack(cmd.args.kind as 'midi' | 'drum' | 'audio' | 'group', cmd.args.device ? { device: cmd.args.device as DeviceType } : {})
      return `Added ${String(cmd.args.kind)} track`
    case 'addEffect': {
      const track = project.tracks.find((t) => t.id === cmd.args.trackId)
      if (!track) return 'I could not find that track'
      addDevice(track.id, cmd.args.type as DeviceType)
      return `${cmd.args.type} added to ${track.name}`
    }
    case 'mute':
    case 'solo': {
      const track = project.tracks.find((t) => t.id === cmd.args.trackId)
      if (!track) return 'I could not find that track'
      const want = cmd.args.on as boolean | undefined
      if (cmd.intent === 'mute') {
        if (want === undefined || track.mute !== want) toggleMute(track.id)
      } else if (want === undefined || track.solo !== want) toggleSolo(track.id)
      return `${track.name} ${cmd.intent === 'mute' ? 'muted' : 'soloed'}`
    }
    case 'arm': {
      const track = project.tracks.find((t) => t.id === cmd.args.trackId)
      if (!track) return 'I could not find that track'
      toggleArm(track.id)
      return `${track.name} armed`
    }
    case 'trackVolume': {
      const track = project.tracks.find((t) => t.id === cmd.args.trackId)
      if (!track) return 'I could not find that track'
      const delta = Number(cmd.args.delta) || 0
      const newVol = clamp(track.volume * Math.pow(10, delta / 20), 0, 1.5)
      setTrackVolume(track.id, newVol, true)
      return `${track.name} ${delta > 0 ? 'raised' : 'lowered'} ${Math.abs(delta)} dB`
    }
    case 'masterVolume': {
      const delta = Number(cmd.args.delta) || 0
      commit('Master level', (p) => {
        p.master.volume = clamp(p.master.volume * Math.pow(10, delta / 20), 0, 1.5)
      })
      return `Master ${delta > 0 ? 'raised' : 'lowered'} ${Math.abs(delta)} dB`
    }
    case 'quantize': {
      const ids = getState().ui.selectedClipIds
      if (!ids.length) return 'Select a clip first'
      quantizeClip(ids[0], Number(cmd.args.grid) || 0.25)
      return 'Quantized'
    }
    case 'jump': {
      const beat = (Number(cmd.args.bar) - 1) * 4
      engine.seek(beat)
      setUi({ positionBeat: beat })
      return `Jumped to bar ${cmd.args.bar}`
    }
    case 'marker': {
      addMarker(engine.getBeat(), String(cmd.args.name || '') || undefined)
      return 'Marker added'
    }
    case 'rename': {
      renameTrack(String(cmd.args.trackId), String(cmd.args.name))
      return `Renamed to ${cmd.args.name}`
    }
    case 'deleteTrack': {
      deleteTrack(String(cmd.args.trackId))
      return 'Track deleted'
    }
    case 'deleteClip': {
      const ids = getState().ui.selectedClipIds
      ids.forEach(deleteClip)
      return ids.length ? 'Clip deleted' : 'No clip selected'
    }
    case 'duplicateClip': {
      const ids = getState().ui.selectedClipIds
      ids.forEach(duplicateClip)
      return 'Clip duplicated'
    }
    case 'split': {
      const ids = getState().ui.selectedClipIds
      if (!ids.length) return 'Select a clip first'
      splitClipAt(ids[0], engine.getBeat())
      return 'Clip split'
    }
    case 'transpose': {
      const ids = getState().ui.selectedClipIds
      if (!ids.length) return 'Select a clip first'
      const { transposeClip } = await import('../state/actions')
      ids.forEach((id) => transposeClip(id, Number(cmd.args.semis) || 1))
      return 'Transposed'
    }
    case 'vocalBooth':
      setUi({ view: 'seq' })
      await startVocalBooth()
      return 'Vocal booth armed — recording'
    case 'warpClip': {
      const id = getState().ui.selectedClipIds[0]
      if (!id) return 'Select an audio clip first'
      warpClipToTempo(id)
      return `Warped to ${getState().project.bpm} BPM`
    }
    case 'sidechain':
      setSidechain(String(cmd.args.trackId), String(cmd.args.sourceId))
      return 'Sidechain on'
    case 'exportStems': {
      const files = await exportStems()
      return files ? `Exported ${files} stems` : 'Nothing to export'
    }
    case 'installPacks':
      void installAllPacks((id, s) => {
        if (s.status === 'installed') toast(`${id} installed`, 'ok')
      })
      return 'Installing every sound pack — progress is in the Packs tab'
    case 'freezeTrack': {
      const { freezeTrack: freeze } = await import('../state/actions')
      await freeze(String(cmd.args.trackId))
      return 'Track frozen'
    }
    case 'unfreezeTrack': {
      const { freezeTrack: freeze } = await import('../state/actions')
      await freeze(String(cmd.args.trackId))
      return 'Track unfrozen'
    }
    case 'flattenTrack':
      await flattenTrack(String(cmd.args.trackId))
      return 'Track flattened'
    case 'consolidateTrack':
    case 'bounceTrack': {
      const id = getState().ui.selectedClipIds[0]
      if (!id) return 'Select a clip first'
      await consolidateClip(id)
      return 'Clip consolidated'
    }
    case 'groove':
      applyGrooveToProject(String(cmd.args.preset))
      return `Groove ${cmd.args.preset}`
    case 'clipEnvelope': {
      const id = getState().ui.selectedClipIds[0]
      if (!id) return 'Select a clip first'
      autoEnvelope(id, cmd.args.shape as 'fade' | 'pump' | 'swell')
      return `${cmd.args.shape} envelope drawn`
    }
    case 'detectTempo': {
      const id = getState().ui.selectedClipIds[0]
      if (!id) return 'Select an audio clip first'
      const bpm = detectClipTempo(id)
      return bpm ? `Detected ${bpm.toFixed(1)} BPM` : 'No tempo detected in that clip'
    }
    case 'meters':
      setUi({ view: 'mix' })
      return 'Spectrum, phase and loudness are in the mixer'
    case 'addLoop': {
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '')
      const wanted = norm(String(cmd.args.genre || ''))
      const all = loopsByGenre()
      const matching = wanted ? all.filter((l) => norm(l.genreLabel).includes(wanted) || wanted.includes(norm(l.genreLabel))) : all
      const pool = (matching.length ? matching : all).filter((l) => l.role === 'drums' || l.role === 'full')
      const pick = [...(pool.length ? pool : all)].sort((a, b) => Math.abs(a.bpm - project.bpm) - Math.abs(b.bpm - project.bpm))[0]
      if (!pick) return 'No loops available — install the Real Loops pack'
      await dropLoop(pick.id, getState().ui.selectedTrackId ?? undefined, Math.round(engine.getBeat() * 4) / 4)
      return `Added ${pick.name} (${pick.bpm} BPM, ${pick.key})`
    }
    case 'masterPreset':
      applyMasterPreset(String(cmd.args.preset))
      return `Master preset ${cmd.args.preset}`
    case 'vocalChain': {
      const track = getState().project.tracks.find((t) => t.id === cmd.args.trackId) ?? project.tracks.find((t) => /vocal/i.test(t.name)) ?? project.tracks[0]
      if (!track) return 'No track available'
      applyVocalChain(track.id, String(cmd.args.preset))
      return `Vocal chain loaded on ${track.name}`
    }
    case 'returnPreset':
      applyReturnPreset((cmd.args.trackId as string) || null, String(cmd.args.preset))
      return `${cmd.args.preset} return`
    case 'audioToMidi': {
      const id = getState().ui.selectedClipIds[0]
      if (!id) return 'Select an audio clip first'
      await clipToMidi(id, cmd.args.kind as 'melody' | 'harmony' | 'drums')
      return 'Audio transcribed to MIDI'
    }
    case 'autoComp': {
      const id = getState().ui.selectedClipIds[0]
      if (!id) return 'Select a clip first'
      autoComp(id)
      return 'Comp built'
    }
    case 'tempoPoint':
      addTempoPoint(Number(cmd.args.bpm), Number(cmd.args.beat))
      return `Tempo ${cmd.args.bpm} from bar ${Number(cmd.args.beat) / 4 + 1}`
    case 'timeSig':
      addTimeSignature(Number(cmd.args.bar), Number(cmd.args.num), Number(cmd.args.den))
      return `Time signature ${cmd.args.num}/${cmd.args.den}`
    case 'create':
      generateFromText(String(cmd.args.prompt))
      return 'Arrangement generated'
    case 'lyric': {
      const text = String(cmd.args.text || '').trim()
      if (!text) return 'Nothing to add'
      commit('Add lyric', (p) => {
        p.lyrics.push({ id: `ly_${Date.now()}`, text, note: 'Voice note' })
      })
      return 'Lyric note added'
    }
    case 'zoom':
      setUi((ui) => ({ zoom: clamp(ui.zoom * (Number(cmd.args.dir) > 0 ? 1.3 : 0.77), 8, 220) }))
      return 'Zoomed'
    case 'help':
      setUi({ rightPanel: 'help', modal: 'help' })
      return 'Here are the commands I know'
    case 'studioMode':
      setUi({ studioMode: Boolean(cmd.args.on), rightPanel: 'voice' })
      return cmd.args.on ? 'Studio mode — I will keep listening' : 'Studio mode off'
    case 'palette':
      setUi({ palette: true })
      return 'Command palette open'
    case 'sampleEditor':
      setUi({ modal: 'sample' })
      return 'Sample editor open'
    case 'sliceSample': {
      const id = getState().ui.selectedClipIds[0]
      if (!id) return 'Select an audio clip first'
      const n = sliceClipToTimeline(id, (cmd.args.mode as 'beats') ?? 'beats')
      return n ? `Sliced into ${n} clips` : 'That clip has no audio'
    }
    case 'chromaticSample': {
      const id = getState().ui.selectedClipIds[0]
      if (!id) return 'Select an audio clip first'
      const n = chromaticCopies(id)
      return n ? `${n} chromatic copies` : 'Nothing to copy'
    }
    case 'drumRack':
      setUi({ modal: 'drumrack' })
      return 'Drum Rack open'
    case 'stems':
      setUi({ modal: 'stems' })
      return 'Stem separation ready'
    case 'mastering':
      setUi({ modal: 'mastering' })
      return 'Mastering assistant open'
    case 'mixAssistant': {
      const { openMixAssistant } = await import('../audio/mixassist')
      openMixAssistant()
      return 'Mix assistant open'
    }
    case 'templates':
      setUi({ modal: 'templates' })
      return 'Templates open'
    case 'storage':
      setUi({ modal: 'storage' })
      return 'Storage screen open'
    case 'account':
      setUi({ modal: 'account' })
      return 'Account & cloud open'
    case 'share':
      setUi({ modal: 'share' })
      return 'Share & export open'
    case 'theme': {
      const { setSettings } = await import('../state/store')
      setSettings({ theme: cmd.args.theme === 'light' ? 'light' : 'studio' })
      return cmd.args.theme === 'light' ? 'Light theme' : 'Studio theme'
    }
    case 'mood': {
      const id = getState().ui.selectedClipIds[0]
      if (!id) return 'Select a MIDI clip first'
      const { shiftMood } = await import('../music/songwriter')
      shiftMood(id, cmd.args.dir === 'darker' ? 'darker' : 'brighter')
      return cmd.args.dir === 'darker' ? 'Darker' : 'Brighter'
    }
    case 'regenerateSection': {
      const id = getState().ui.selectedClipIds[0]
      if (!id) return 'Select a section clip first'
      const { regenerateClip } = await import('../music/songwriter')
      regenerateClip(id)
      return 'Section regenerated'
    }
    case 'variation': {
      const id = getState().ui.selectedClipIds[0]
      if (!id) return 'Select a MIDI clip first'
      const { makeVariation } = await import('../music/songwriter')
      makeVariation(id)
      return 'Variation created'
    }
    case 'lyricsToMelody': {
      const text = project.lyrics.map((l) => l.text).join(' ') || String(cmd.raw)
      const { addLyricMelody } = await import('../music/songwriter')
      addLyricMelody(text)
      return 'Melody written from the lyric'
    }
    case 'chords': {
      const track = selectedTrack()
      if (!track) return 'No track selected'
      const { PROGRESSIONS, progressionChords } = await import('../data/chords')
      const { SCALES, makeClip, uid } = await import('../state/types')
      const preset = PROGRESSIONS[0]
      const rootPc = Math.max(0, ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].indexOf(project.keyRoot))
      const chords = progressionChords(rootPc, SCALES[project.keyScale] ?? SCALES.Minor, preset)
      const notes = chords.flatMap((c, bar) =>
        c.pitches.map((pitch, i) => ({ id: uid('nt'), pitch, start: bar * 4 + i * 0.02, len: 3.8, vel: 0.7 })),
      )
      addClip(track.id, makeClip({ name: preset.name, start: Math.round(engine.getBeat() * 4) / 4, len: chords.length * 4, contentLen: chords.length * 4, kind: 'midi', notes }))
      return `${preset.name} inserted`
    }
    case 'midiFx': {
      const id = getState().ui.selectedClipIds[0]
      if (!id) return 'Select a MIDI clip first'
      const { applyMidiFx, humanizeClip, scaleQuantizeClip } = await import('../state/features')
      const fx = String(cmd.args.id)
      if (fx === 'humanize') humanizeClip(id)
      else if (fx === 'quantize') scaleQuantizeClip(id)
      else applyMidiFx(id, fx)
      return 'MIDI effect applied'
    }
    case 'song': {
      const { composeSong, applySong } = await import('../music/songwriter')
      const idea = composeSong({ prompt: String(cmd.args.prompt ?? cmd.raw) })
      applySong(idea, true)
      return `${idea.title} — ${idea.sections.length} sections`
    }
    case 'newProject': {
      const { newProject } = await import('../state/store')
      newProject()
      return 'New project created'
    }
    case 'openProjects':
      setUi({ modal: 'projects' })
      return 'Project browser opened'
    default:
      toast('I did not catch an action in that phrase', 'warn')
      return 'Command not understood'
  }
}
