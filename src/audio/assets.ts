import type { StoredAsset } from '../state/db'

const buffers = new Map<string, AudioBuffer>()
const pending = new Set<string>()
const listeners = new Set<(id: string) => void>()

export function registerBuffer(id: string, buf: AudioBuffer): void {
  buffers.set(id, buf)
  schedulePeaks(id, buf)
  pending.delete(id)
  for (const l of listeners) l(id)
}

export function getBuffer(id: string | undefined | null): AudioBuffer | null {
  if (!id) return null
  return buffers.get(id) ?? null
}

export function hasBuffer(id: string): boolean {
  return buffers.has(id)
}

export function onBuffer(id: string, cb: (id: string) => void): () => void {
  const fn = (got: string) => {
    if (got === id) cb(got)
  }
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function markPending(id: string): boolean {
  if (pending.has(id) || buffers.has(id)) return false
  pending.add(id)
  return true
}

export function clearBufferCache(): void {
  buffers.clear()
  pending.clear()
}

export function bufferFromStored(ctx: BaseAudioContext, asset: StoredAsset): AudioBuffer {
  const len = asset.channels[0]?.length ?? 0
  const buf = ctx.createBuffer(Math.max(1, asset.channels.length), Math.max(1, len), asset.sampleRate)
  asset.channels.forEach((ch, i) => {
    if (i < buf.numberOfChannels) buf.copyToChannel(ch as Float32Array<ArrayBuffer>, i)
  })
  return buf
}

export function storedFromBuffer(name: string, buf: AudioBuffer): StoredAsset {
  const channels: Float32Array[] = []
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const data = buf.getChannelData(c)
    const copy = new Float32Array(data.length)
    copy.set(data)
    channels.push(copy)
  }
  return {
    id: `asset_${Math.random().toString(36).slice(2, 10)}`,
    name,
    sampleRate: buf.sampleRate,
    channels,
    duration: buf.duration,
    createdAt: Date.now(),
  }
}

const peakCache = new WeakMap<AudioBuffer, number[]>()
const fullPeaks = new WeakMap<AudioBuffer, Float32Array>()
let peaksWorker: Worker | null = null

function ensurePeaksWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null
  if (!peaksWorker) {
    try {
      peaksWorker = new Worker(new URL('../workers/peaks.worker.ts', import.meta.url), { type: 'module' })
      peaksWorker.onmessage = (e: MessageEvent<{ id: string; peaks: Float32Array }>) => {
        const { id, peaks } = e.data
        const buf = buffers.get(id)
        if (buf) fullPeaks.set(buf, peaks)
      }
    } catch {
      peaksWorker = null
    }
  }
  return peaksWorker
}

/** Ask the worker for a high-resolution peak map as soon as audio arrives. */
function schedulePeaks(id: string, buf: AudioBuffer): void {
  const worker = ensurePeaksWorker()
  if (!worker) return
  try {
    const channel = buf.getChannelData(0).slice()
    worker.postMessage({ id, channel, buckets: 2048 }, [channel.buffer])
  } catch {
    /* worker unavailable — peaksFor falls back to the main thread */
  }
}

/** Downsampled peaks for waveform drawing (worker peaks when available). */
export function peaksFor(buf: AudioBuffer, buckets = 400): number[] {
  const hit = peakCache.get(buf)
  if (hit && hit.length === buckets) return hit
  const full = fullPeaks.get(buf)
  if (full && full.length) {
    const out = new Array(buckets).fill(0)
    const step = full.length / buckets
    for (let i = 0; i < buckets; i++) {
      let max = 0
      for (let j = Math.floor(i * step); j < Math.min(full.length, Math.floor((i + 1) * step)); j++) {
        if (full[j] > max) max = full[j]
      }
      out[i] = max
    }
    peakCache.set(buf, out)
    return out
  }
  const data = buf.getChannelData(0)
  const out = new Array(buckets).fill(0)
  const step = Math.max(1, Math.floor(data.length / buckets))
  for (let i = 0; i < buckets; i++) {
    let max = 0
    const start = i * step
    for (let j = 0; j < step; j += 2) {
      const v = Math.abs(data[start + j] || 0)
      if (v > max) max = v
    }
    out[i] = max
  }
  peakCache.set(buf, out)
  return out
}
