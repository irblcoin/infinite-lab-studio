// ---------------------------------------------------------------------------
// Channel-strip, return and master presets, plus groove templates.
// ---------------------------------------------------------------------------

import type { DeviceType, GrooveSettings, Params } from '../state/types'

export interface ChainStep {
  type: DeviceType
  params?: Params
  name?: string
}

export interface ChannelPreset {
  id: string
  name: string
  description: string
  chain: ChainStep[]
  /** Reverb / delay send amounts. */
  sends?: [number, number]
}

export const VOCAL_CHAINS: ChannelPreset[] = [
  {
    id: 'vocal_clean',
    name: 'Clean Vocal',
    description: 'Gentle EQ, 3:1 compression and a plate send — natural and open',
    chain: [
      { type: 'eq3', params: { low: -3, mid: 1, high: 2 }, name: 'Vocal EQ' },
      { type: 'comp', params: { threshold: -20, ratio: 3, attack: 12, release: 140 }, name: 'Vocal Comp' },
    ],
    sends: [0.22, 0],
  },
  {
    id: 'vocal_rap',
    name: 'Rap Vocal',
    description: 'Fast compression, presence boost and light saturation for punch',
    chain: [
      { type: 'eq3', params: { low: -2, mid: 2, high: 3 }, name: 'Presence EQ' },
      { type: 'comp', params: { threshold: -24, ratio: 4, attack: 4, release: 90 }, name: 'Rap Comp' },
      { type: 'distortion', params: { mix: 0.18, drive: 3 }, name: 'Saturator' },
      { type: 'limiter', params: { ceiling: -1 }, name: 'Vocal Limiter' },
    ],
    sends: [0.12, 0.1],
  },
  {
    id: 'vocal_tune',
    name: 'Auto-Tune',
    description: 'Pitch correction into a tight compressor — modern tuned vocal',
    chain: [
      { type: 'autotune', params: { speed: 0.75, amount: 0.9 }, name: 'Auto-Tune' },
      { type: 'eq3', params: { low: -4, mid: 0, high: 2 }, name: 'Tune EQ' },
      { type: 'comp', params: { threshold: -22, ratio: 4, attack: 6, release: 110 }, name: 'Tune Comp' },
    ],
    sends: [0.18, 0.08],
  },
  {
    id: 'vocal_radio',
    name: 'Radio',
    description: 'Broadcast squash: band-limited, heavily compressed, bright',
    chain: [
      { type: 'eq3', params: { low: -8, mid: 3, high: 5 }, name: 'Radio EQ' },
      { type: 'comp', params: { threshold: -32, ratio: 8, attack: 2, release: 60 }, name: 'Radio Comp' },
      { type: 'distortion', params: { mix: 0.3, drive: 6 }, name: 'Radio Drive' },
      { type: 'limiter', params: { ceiling: -0.8 }, name: 'Radio Limiter' },
    ],
    sends: [0.05, 0],
  },
  {
    id: 'vocal_lofi',
    name: 'Lo-Fi',
    description: 'Band-limited, crushed and washed out — tape / bedroom texture',
    chain: [
      { type: 'autofilter', params: { cutoff: 3200, q: 0.9 }, name: 'Lo-Fi Filter' },
      { type: 'bitcrush', params: { bits: 8, mix: 0.7 }, name: 'Crush' },
      { type: 'chorus', params: { depth: 0.5, rate: 0.4 }, name: 'Wobble' },
      { type: 'delay', params: { mix: 0.2, time: 0.28, feedback: 0.3 }, name: 'Tape Delay' },
    ],
    sends: [0.35, 0.15],
  },
]

export type ReturnPresetId = 'plate' | 'hall' | 'slap' | 'tape'

export const RETURN_PRESETS: { id: ReturnPresetId; name: string; description: string; sends: [number, number] }[] = [
  { id: 'plate', name: 'Plate Reverb', description: 'Bright, dense plate — great on vocals and snares', sends: [0.28, 0] },
  { id: 'hall', name: 'Hall Reverb', description: 'Long, wide hall for pads, strings and big drums', sends: [0.45, 0.05] },
  { id: 'slap', name: 'Slap Delay', description: 'Short single repeat that widens a vocal', sends: [0.08, 0.26] },
  { id: 'tape', name: 'Tape Echo', description: 'Dark feedback echo with a long tail', sends: [0.1, 0.38] },
]

export type MasterPresetId = 'streaming' | 'club' | 'glue' | 'off'

export const MASTER_PRESETS: {
  id: MasterPresetId
  name: string
  description: string
  target: number
  glue: boolean
  eq: boolean
  limiter: boolean
}[] = [
  { id: 'streaming', name: 'Streaming (−14 LUFS)', description: 'Glue, tone shaping and a −1 dBTP limiter for Spotify/Apple', target: -14, glue: true, eq: true, limiter: true },
  { id: 'club', name: 'Club (−9 LUFS)', description: 'Harder glue and limiting for loud club playback', target: -9, glue: true, eq: true, limiter: true },
  { id: 'glue', name: 'Glue only', description: 'Bus compression and EQ, no limiting', target: -14, glue: true, eq: true, limiter: false },
  { id: 'off', name: 'Bypass', description: 'No master processing', target: -14, glue: false, eq: false, limiter: false },
]

export const GROOVES: { id: string; name: string; swing: number; velocity: number; description: string }[] = [
  { id: 'straight', name: 'Straight', swing: 0, velocity: 0, description: 'No timing or velocity change' },
  { id: 'mpc8', name: 'MPC 8th', swing: 0.18, velocity: 0.12, description: 'Classic MPC 8th-note swing' },
  { id: 'mpc16', name: 'MPC 16th', swing: 0.26, velocity: 0.18, description: 'Tighter 16th-note shuffle' },
  { id: 'triplet', name: 'Triplet', swing: 0.33, velocity: 0.1, description: 'Triplet feel' },
  { id: 'dilla', name: 'Dilla', swing: 0.22, velocity: 0.3, description: 'Loose, late snares' },
  { id: 'latin', name: 'Latin', swing: 0.12, velocity: 0.22, description: 'Light 16th push' },
  { id: 'rock', name: 'Rock', swing: 0.04, velocity: 0.08, description: 'Almost straight, human velocity' },
]

export function grooveById(id: string): GrooveSettings {
  const g = GROOVES.find((x) => x.id === id) ?? GROOVES[0]
  return { preset: g.id, amount: 1 }
}

export function grooveAmount(g: GrooveSettings | undefined): { swing: number; velocity: number } {
  if (!g) return { swing: 0, velocity: 0 }
  const def = GROOVES.find((x) => x.id === g.preset)
  if (!def) return { swing: 0, velocity: 0 }
  return { swing: def.swing * g.amount, velocity: def.velocity * g.amount }
}

export const SIDECHAIN_PRESETS = [
  { id: 'pump', name: 'Pumping', depth: 0.8, attack: 0.005, release: 0.18 },
  { id: 'duck', name: 'Soft Duck', depth: 0.45, attack: 0.01, release: 0.3 },
  { id: 'hard', name: 'Hard Duck', depth: 0.95, attack: 0.003, release: 0.12 },
]
