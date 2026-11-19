// ---------------------------------------------------------------------------
// Sample editor tools: trimming, loop points, transient/beat/grid slicing,
// chromatic copies and slice-to-pad playback. Works on any audio clip.
// ---------------------------------------------------------------------------

import type { Clip } from '../state/types'
import { makeClip, uid } from '../state/types'
import { commit, getState, setUi, toast } from '../state/store'
import { addClip, addTrack, findClip } from '../state/actions'
import { getBuffer } from './assets'
import { detectTransients } from './warp'

export type SliceMode = 'transients' | 'beats' | 'grid'

export interface Slice {
  index: number
  startSec: number
  endSec: number
  startBeat: number
  beats: number
}

export function clipBuffer(clip: Clip): AudioBuffer | null {
  if (clip.assetId) return getBuffer(clip.assetId)
  if (clip.libId) return getBuffer(clip.libId)
  return null
}

/** Compute slice boundaries in seconds from the source buffer. */
export function computeSlices(buffer: AudioBuffer, bpm: number, mode: SliceMode, divisions = 4): Slice[] {
  const spb = 60 / bpm
  const duration = buffer.duration
  const bounds: number[] = [0]
  if (mode === 'transients') {
    const onsets = detectTransients(buffer, 0.9).filter((t) => t > 0.02 && t < duration - 0.02)
    const minGap = Math.max(0.04, spb / 8)
    let last = 0
    for (const t of onsets) {
      if (t - last >= minGap) {
        bounds.push(t)
        last = t
      }
    }
  } else if (mode === 'beats') {
    const beat = spb
    for (let t = beat; t < duration - 0.01; t += beat) bounds.push(Math.round(t * 1000) / 1000)
  } else {
    const step = spb / Math.max(1, divisions)
    for (let t = step; t < duration - 0.01; t += step) bounds.push(Math.round(t * 1000) / 1000)
  }
  bounds.sort((a, b) => a - b)
  const slices: Slice[] = []
  for (let i = 0; i < bounds.length; i++) {
    const startSec = bounds[i]
    const endSec = i + 1 < bounds.length ? bounds[i + 1] : duration
    if (endSec - startSec < 0.02) continue
    slices.push({
      index: slices.length,
      startSec,
      endSec,
      startBeat: startSec / spb,
      beats: (endSec - startSec) / spb,
    })
  }
  return slices
}

/** Trim a clip to a sample range (in beats, relative to the source). */
export function setSampleRange(clipId: string, startBeat: number, endBeat: number): void {
  const hit = findClip(getState().project, clipId)
  if (!hit) return
  const len = Math.max(0.05, endBeat - startBeat)
  commit('Trim sample', (p) => {
    const c = p.tracks.flatMap((t) => t.clips).find((x) => x.id === clipId)
    if (!c) return
    c.offset = Math.max(0, startBeat)
    c.len = len
    c.contentLen = len
    c.loop = false
  })
}

/** Set loop points; the clip repeats between them. */
export function setLoopPoints(clipId: string, startBeat: number, endBeat: number): void {
  const hit = findClip(getState().project, clipId)
  if (!hit) return
  const loopLen = Math.max(0.05, endBeat - startBeat)
  commit('Set loop points', (p) => {
    const c = p.tracks.flatMap((t) => t.clips).find((x) => x.id === clipId)
    if (!c) return
    c.offset = Math.max(0, startBeat)
    c.contentLen = loopLen
    c.len = Math.max(c.len, loopLen)
    c.loop = true
  })
  toast(`Loop ${loopLen.toFixed(2)} beats`, 'ok')
}

/** Chop the clip into one clip per slice, placed end to end from the playhead. */
export function sliceClipToTimeline(clipId: string, mode: SliceMode, divisions = 4): number {
  const { project } = getState()
  const hit = findClip(project, clipId)
  if (!hit || hit.clip.kind !== 'audio') {
    toast('Select an audio clip first', 'warn')
    return 0
  }
  const buffer = clipBuffer(hit.clip)
  if (!buffer) {
    toast('The audio is still loading — try again in a moment', 'warn')
    return 0
  }
  const slices = computeSlices(buffer, project.bpm, mode, divisions)
  if (!slices.length) return 0
  const baseStart = hit.clip.start
  const trackId = hit.track.id
  commit(`Slice ${slices.length} parts`, (p) => {
    const track = p.tracks.find((t) => t.id === trackId)
    if (!track) return
    track.clips = track.clips.filter((c) => c.id !== clipId)
    let at = baseStart
    for (const s of slices) {
      track.clips.push(
        makeClip({
          name: `${hit.clip.name} ${s.index + 1}`,
          start: at,
          len: s.beats,
          contentLen: s.beats,
          kind: 'audio',
          assetId: hit.clip.assetId,
          libId: hit.clip.libId,
          offset: hit.clip.offset + s.startBeat,
          gain: hit.clip.gain,
          warp: hit.clip.warp,
        }),
      )
      at += s.beats
    }
  })
  setUi({ selectedClipIds: [] })
  toast(`Sliced into ${slices.length} clips by ${mode}`, 'ok')
  return slices.length
}

/** Reproduce the clip at twelve semitone offsets, one per chromatic step. */
export function chromaticCopies(clipId: string, from = -12, to = 12): number {
  const { project } = getState()
  const hit = findClip(project, clipId)
  if (!hit) return 0
  const step = hit.clip.len
  let made = 0
  commit('Chromatic sample', (p) => {
    const track = p.tracks.find((t) => t.id === hit.track.id)
    if (!track) return
    let at = hit.clip.start + step
    for (let semi = from; semi <= to; semi += 1) {
      if (semi === 0) continue
      const copy = makeClip({
        ...hit.clip,
        name: `${hit.clip.name} ${semi > 0 ? '+' : ''}${semi}`,
        start: at,
        pitch: (hit.clip.pitch ?? 0) + semi,
      })
      copy.id = uid('clip')
      copy.notes = []
      track.clips.push(copy)
      at += step
      made++
    }
  })
  toast(`${made} chromatic copies created`, 'ok')
  return made
}

/** Create a dedicated sampler track from the clip's audio. */
export function clipToSamplerTrack(clipId: string): string | null {
  const { project } = getState()
  const hit = findClip(project, clipId)
  if (!hit) return null
  const id = addTrack('midi', { name: `${hit.clip.name} Sampler` })
  const track = getState().project.tracks.find((t) => t.id === id)
  if (track) {
    commit('Sampler track', (p) => {
      const t = p.tracks.find((x) => x.id === id)
      if (!t) return
      t.devices = [
        {
          id: uid('dev'),
          type: 'sampler',
          name: hit.clip.name,
          bypass: false,
          params: { root: 60, gain: 1, attack: 0.002, release: 0.2, cutoff: 16000, pitch: 0, reverb: 0, res: 0.5 },
          sampleId: hit.clip.assetId ?? hit.clip.libId,
        },
      ]
    })
  }
  toast('Sampler track created — play it chromatically', 'ok')
  return id
}

/** Read the current trim of a clip in beats. */
export function clipRange(clip: Clip): { start: number; end: number; contentEnd: number } {
  return { start: clip.offset, end: clip.offset + clip.len, contentEnd: clip.offset + clip.contentLen }
}
