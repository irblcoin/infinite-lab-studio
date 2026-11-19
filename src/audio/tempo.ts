// ---------------------------------------------------------------------------
// Tempo map: constant tempo unless the project has tempo automation, in which
// case beats and seconds are converted through the piecewise-constant map.
// ---------------------------------------------------------------------------

import type { Project, SigPoint, TempoPoint } from '../state/types'

export function tempoPoints(project: Project): TempoPoint[] {
  const list = (project.tempoMap ?? []).filter((p) => p.bpm > 0).slice().sort((a, b) => a.beat - b.beat)
  if (!list.length || list[0].beat > 0) list.unshift({ beat: 0, bpm: project.bpm })
  return list
}

export function bpmAt(project: Project, beat: number): number {
  const list = tempoPoints(project)
  let bpm = list[0].bpm
  for (const p of list) {
    if (p.beat <= beat + 1e-9) bpm = p.bpm
    else break
  }
  return bpm
}

/** Seconds between two beats, honouring every tempo change in between. */
export function secondsBetween(project: Project, fromBeat: number, toBeat: number): number {
  if (toBeat === fromBeat) return 0
  const dir = toBeat > fromBeat ? 1 : -1
  const a = Math.min(fromBeat, toBeat)
  const b = Math.max(fromBeat, toBeat)
  const list = tempoPoints(project)
  let seconds = 0
  for (let i = 0; i < list.length; i++) {
    const start = Math.max(a, list[i].beat)
    const end = Math.min(b, list[i + 1]?.beat ?? Infinity)
    if (end > start) seconds += ((end - start) * 60) / list[i].bpm
  }
  return seconds * dir
}

/** Inverse of secondsBetween: which beat is `seconds` after `fromBeat`. */
export function beatAfter(project: Project, fromBeat: number, seconds: number): number {
  if (seconds <= 0) return fromBeat
  const list = tempoPoints(project)
  let beat = fromBeat
  let left = seconds
  for (let i = 0; i < list.length; i++) {
    if (list[i].beat > beat) continue
    const next = list[i + 1]?.beat ?? Infinity
    const segSeconds = ((next - beat) * 60) / list[i].bpm
    if (left <= segSeconds || !isFinite(segSeconds)) {
      return beat + (left * list[i].bpm) / 60
    }
    left -= segSeconds
    beat = next
  }
  return beat
}

/** Time signature active at a beat, using the bar map. */
export function sigAt(project: Project, beat: number): [number, number] {
  const map = (project.sigMap ?? []).slice().sort((a, b) => a.bar - b.bar)
  let sig: [number, number] = project.timeSig
  let barStart = 0
  let num = project.timeSig[0] || 4
  for (const point of map) {
    // walk bars to find where this signature starts
    const startBeat = barStartBeat(project, point.bar)
    if (startBeat <= beat + 1e-9) {
      sig = [point.num, point.den]
      num = point.num
    }
    barStart = startBeat
  }
  void num
  return sig
}

/** Beat at which a 0-based bar starts, walking the signature map. */
export function barStartBeat(project: Project, bar: number): number {
  const map = (project.sigMap ?? []).slice().sort((a, b) => a.bar - b.bar)
  let beat = 0
  let currentBar = 0
  let perBar = project.timeSig[0] || 4
  for (const point of map) {
    if (point.bar <= currentBar) {
      perBar = point.num
      continue
    }
    const barsToAdd = Math.min(point.bar, bar) - currentBar
    beat += barsToAdd * perBar
    currentBar += barsToAdd
    perBar = point.num
    if (currentBar >= bar) return beat
  }
  return beat + (bar - currentBar) * perBar
}

export function barAt(project: Project, beat: number): { bar: number; beatInBar: number; perBar: number } {
  const map = (project.sigMap ?? []).slice().sort((a, b) => a.bar - b.bar)
  let currentBar = 0
  let start = 0
  let perBar = project.timeSig[0] || 4
  for (const point of map) {
    const nextStart = barStartBeat(project, point.bar)
    if (nextStart > beat + 1e-9) break
    currentBar = point.bar
    start = nextStart
    perBar = point.num
  }
  const bar = currentBar + Math.floor((beat - start) / perBar)
  return { bar, beatInBar: beat - (start + (bar - currentBar) * perBar), perBar }
}

export function sigLabel(sig: [number, number]): string {
  return `${sig[0]}/${sig[1]}`
}

export function addSigPoint(map: SigPoint[] | undefined, point: SigPoint): SigPoint[] {
  const list = (map ?? []).filter((p) => p.bar !== point.bar)
  return [...list, point].sort((a, b) => a.bar - b.bar)
}
