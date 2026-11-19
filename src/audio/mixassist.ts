// ---------------------------------------------------------------------------
// Mix assistant: renders each track, measures it and returns one-click fixes
// for level balance, clipping, EQ masking and mono problems.
// ---------------------------------------------------------------------------

import type { Track } from '../state/types'
import { clamp } from '../state/types'
import { getState, setUi, toast } from '../state/store'
import { addDevice, setTrackPan, setTrackProp } from '../state/actions'
import { renderTrackBuffer } from './render'
import { analyzeMix, type MixAnalysis } from './mastering'

export interface MixSuggestion {
  id: string
  trackId: string
  trackName: string
  severity: 'info' | 'warn' | 'critical'
  title: string
  detail: string
  fixLabel: string
  fix: () => void
}

interface TrackReport {
  track: Track
  analysis: MixAnalysis | null
  error?: string
}

const TARGET_RMS = -18

function levelFix(track: Track, deltaDb: number): () => void {
  return () => {
    const next = clamp(track.volume * Math.pow(10, deltaDb / 20), 0.02, 1.6)
    setTrackProp(track.id, { volume: Math.round(next * 1000) / 1000 })
    toast(`${track.name} → ${Math.round(next * 100)}%`, 'ok')
  }
}

function eqFix(track: Track, low: number, high: number): () => void {
  return () => {
    addDevice(track.id, 'eq3', { lowGain: low, midGain: 0, highGain: high, lowFreq: 140, midFreq: 1200, highFreq: 7200 }, 'Assistant EQ')
    toast(`Assistant EQ on ${track.name}`, 'ok')
  }
}

export async function analyzeTracks(onProgress?: (done: number, total: number, name: string) => void): Promise<TrackReport[]> {
  const { project } = getState()
  const tracks = project.tracks.filter((t) => t.kind !== 'group' && t.clips.length > 0)
  const out: TrackReport[] = []
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i]
    onProgress?.(i, tracks.length, track.name)
    try {
      const buf = await renderTrackBuffer(project, track.id)
      out.push({ track, analysis: buf ? analyzeMix(buf) : null })
    } catch (err) {
      out.push({ track, analysis: null, error: err instanceof Error ? err.message : 'render failed' })
    }
    await new Promise((r) => setTimeout(r, 0))
  }
  onProgress?.(tracks.length, tracks.length, '')
  return out
}

export function suggestionsFrom(reports: TrackReport[]): MixSuggestion[] {
  const out: MixSuggestion[] = []
  for (const { track, analysis } of reports) {
    if (!analysis) continue
    const diff = TARGET_RMS - analysis.rmsDb
    if (diff > 5) {
      out.push({
        id: `${track.id}:level-up`,
        trackId: track.id,
        trackName: track.name,
        severity: diff > 10 ? 'warn' : 'info',
        title: `${track.name} sits ${Math.round(diff)} dB under the mix`,
        detail: `Measured ${analysis.rmsDb} dBFS RMS against a ${TARGET_RMS} dBFS target. Raising it now keeps the balance intact.`,
        fixLabel: `Raise ${Math.round(diff)} dB`,
        fix: levelFix(track, Math.min(9, diff)),
      })
    } else if (diff < -4) {
      out.push({
        id: `${track.id}:level-down`,
        trackId: track.id,
        trackName: track.name,
        severity: 'info',
        title: `${track.name} is ${Math.round(-diff)} dB too loud`,
        detail: `It masks the other parts at ${analysis.rmsDb} dBFS RMS.`,
        fixLabel: `Lower ${Math.round(-diff)} dB`,
        fix: levelFix(track, Math.max(-9, diff)),
      })
    }
    if (analysis.peakDb > -0.2) {
      out.push({
        id: `${track.id}:clip`,
        trackId: track.id,
        trackName: track.name,
        severity: 'critical',
        title: `${track.name} is clipping`,
        detail: `Peak ${analysis.peakDb} dBFS. A 1 dB pull plus a soft clip keeps the transient without distortion.`,
        fixLabel: 'Fix clipping',
        fix: () => {
          setTrackProp(track.id, { volume: Math.round(track.volume * 0.89 * 1000) / 1000 })
          addDevice(track.id, 'limiter', { threshold: -1, ceiling: -0.3 }, 'Safety Limiter')
          toast(`${track.name} tamed — limiter inserted`, 'ok')
        },
      })
    }
    if (analysis.lowDb > -10 && /bass|808|kick|drum/i.test(track.name)) {
      out.push({
        id: `${track.id}:low`,
        trackId: track.id,
        trackName: track.name,
        severity: 'info',
        title: `${track.name} owns the sub range`,
        detail: 'If another bass part is playing, a 1.5 dB shelf at 140 Hz keeps them from masking each other.',
        fixLabel: 'Cut 140 Hz',
        fix: eqFix(track, -1.5, 0),
      })
    }
    if (analysis.highDb < -26 && /vocal|vox|lead|melody/i.test(track.name)) {
      out.push({
        id: `${track.id}:air`,
        trackName: track.name,
        trackId: track.id,
        severity: 'info',
        title: `${track.name} lacks air`,
        detail: 'A gentle high shelf at 7 kHz lifts presence without harshness.',
        fixLabel: 'Add presence',
        fix: eqFix(track, 0, 1.6),
      })
    }
    if (analysis.width < 0.08 && track.kind !== 'drum') {
      out.push({
        id: `${track.id}:mono`,
        trackId: track.id,
        trackName: track.name,
        severity: 'info',
        title: `${track.name} is fully mono`,
        detail: 'Panning it slightly opens space for the centre vocal and kick.',
        fixLabel: 'Pan 18%',
        fix: () => {
          setTrackPan(track.id, track.pan >= 0 ? 0.18 : -0.18)
          toast(`${track.name} panned`, 'ok')
        },
      })
    }
  }

  // Frequency-clash heuristics between bass-heavy parts.
  const bassy = reports.filter((r) => /bass|808|sub|kick/i.test(r.track.name))
  if (bassy.length > 1) {
    const [a, b] = bassy
    out.push({
      id: `${a.track.id}:${b.track.id}:clash`,
      trackId: b.track.id,
      trackName: b.track.name,
      severity: 'warn',
      title: `${a.track.name} and ${b.track.name} share the low end`,
      detail: 'Two sub sources fight for the same 40–120 Hz window. Ducking one keeps the kick and bass legible.',
      fixLabel: 'Duck the second',
      fix: () => {
        setTrackProp(b.track.id, { volume: Math.round(b.track.volume * 0.72 * 1000) / 1000 })
        addDevice(b.track.id, 'autofilter', { cutoff: 90, res: 0.6, type: 0, mix: 0 }, 'Low guard')
        toast(`${b.track.name} ducked in the sub range`, 'ok')
      },
    })
  }
  return out
}

export async function runMixAssistant(): Promise<MixSuggestion[]> {
  const reports = await analyzeTracks()
  return suggestionsFrom(reports)
}

export function openMixAssistant(): void {
  setUi({ modal: 'mixassistant' })
}

export type { MixAnalysis }
