import { useSyncExternalStore } from 'react'
import { engine } from '../audio/engine'

let current = 0
let raf = 0
const subs = new Set<() => void>()

function loop(): void {
  const beat = engine.getBeat()
  if (Math.abs(beat - current) > 0.0005) {
    current = beat
    for (const fn of subs) fn()
  }
  raf = requestAnimationFrame(loop)
}

function ensureRunning(): void {
  if (!raf) raf = requestAnimationFrame(loop)
}

export function subscribeBeat(fn: () => void): () => void {
  subs.add(fn)
  ensureRunning()
  return () => {
    subs.delete(fn)
  }
}

export function useBeat(): number {
  return useSyncExternalStore(subscribeBeat, () => current)
}

export const getBeatNow = (): number => engine.getBeat()
