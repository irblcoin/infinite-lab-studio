// Waveform peaks are computed off the main thread. The timeline then draws
// from the cached result, so scrolling many clips never blocks the UI.
const BUCKETS = 2048

self.onmessage = (e: MessageEvent<{ id: string; channel: Float32Array; buckets?: number }>) => {
  const { id, channel, buckets } = e.data
  const count = buckets ?? BUCKETS
  const out = new Float32Array(count)
  const step = Math.max(1, Math.floor(channel.length / count))
  for (let i = 0; i < count; i++) {
    let max = 0
    const start = i * step
    const end = Math.min(channel.length, start + step)
    for (let j = start; j < end; j += 2) {
      const v = Math.abs(channel[j] || 0)
      if (v > max) max = v
    }
    out[i] = max
  }
  ;(self as unknown as Worker).postMessage({ id, peaks: out, buckets: count }, [out.buffer])
}

export {}
