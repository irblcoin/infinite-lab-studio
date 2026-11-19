// ---------------------------------------------------------------------------
// Multisample patch engine
//
// A Patch is a sample instrument: a set of zones mapping key ranges and
// velocity ranges to audio files. Zones carry an original root note so notes
// between sampled keys are pitch-shifted, plus optional sustain loops and
// round-robin grouping. Audio buffers are decoded once and shared between the
// live AudioContext and the offline render context.
// ---------------------------------------------------------------------------

export interface SampleZone {
  /** File path relative to the patch's pack folder. */
  file: string
  /** MIDI note the file was recorded at. */
  root: number
  lo: number
  hi: number
  velLo: number
  velHi: number
  /** Round-robin slot; zones sharing a root rotate through these. */
  seq?: number
  /** Fine tuning in cents. */
  tune?: number
  gain?: number
  pan?: number
  /** Sustain loop points in seconds. */
  loopStart?: number
  loopEnd?: number
}

export type PatchSource = 'pack' | 'sfz' | 'sf2' | 'import'

export interface Patch {
  id: string
  name: string
  category: string
  packId: string
  source: PatchSource
  gain: number
  zones: SampleZone[]
  description?: string
  /** Pack instruments stream from /packs/<packId>/ when they are not installed. */
  bundled?: boolean
}

export interface PatchNote {
  time: number
  dur: number
  pitch: number
  vel: number
  gain?: number
  attack?: number
  release?: number
  cutoff?: number
  q?: number
  reverse?: boolean
}

const registry = new Map<string, Patch>()

export function registerPatch(p: Patch): void {
  registry.set(p.id, p)
}

export function registerPatches(list: Patch[]): void {
  for (const p of list) registry.set(p.id, p)
}

export function unregisterPatches(packId: string): void {
  for (const [id, p] of registry) if (p.packId === packId) registry.delete(id)
}

export function getPatch(id: string | null | undefined): Patch | null {
  if (!id) return null
  return registry.get(id) ?? null
}

export function allPatches(): Patch[] {
  return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function clearPatchRegistry(): void {
  registry.clear()
}

// ---------------------------------------------------------------------------
// Sample loading
// ---------------------------------------------------------------------------

type Loader = (packId: string, file: string) => Promise<ArrayBuffer | null>

let loader: Loader | null = null

/** Installed by the pack store: returns raw bytes from IndexedDB or the static pack URL. */
export function setSampleLoader(fn: Loader): void {
  loader = fn
}

const fileCache = new Map<string, AudioBuffer>()
const loading = new Map<string, Promise<AudioBuffer | null>>()
const missing = new Set<string>()
const waiters = new Set<() => void>()

let decodeCtx: BaseAudioContext | null = null

function getDecodeCtx(): BaseAudioContext {
  if (!decodeCtx) {
    const Ctor = window.OfflineAudioContext || (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext
    // 48 kHz is the most common device rate; sources are rate-corrected at play time.
    decodeCtx = new Ctor(1, 1, 48000)
  }
  return decodeCtx
}

export function sampleKey(packId: string, file: string): string {
  return `${packId}/${file}`
}

export function cachedBuffer(packId: string, file: string): AudioBuffer | null {
  return fileCache.get(sampleKey(packId, file)) ?? null
}

/** True when at least one zone of the patch is decoded and ready to play. */
export function patchHasAudio(patch: Patch): boolean {
  return patch.zones.some((z) => !!cachedBuffer(patch.packId, z.file))
}

export function onSamplesChanged(cb: () => void): () => void {
  waiters.add(cb)
  return () => waiters.delete(cb)
}

function notify(): void {
  for (const w of waiters) w()
}

/**
 * Level the packs against each other: quiet orchestral and GM recordings are
 * lifted towards a common peak so switching instruments does not jump in
 * volume. Loud one-shots are left untouched, and the lift is capped at +9.5 dB
 * to keep noise floors inaudible.
 */
function normaliseBuffer(buf: AudioBuffer): void {
  let peak = 0
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c)
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.abs(d[i])
      if (v > peak) peak = v
    }
  }
  if (peak < 0.0005 || peak >= 0.55) return
  const gain = Math.min(3, 0.7 / peak)
  if (gain <= 1.02) return
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c)
    for (let i = 0; i < d.length; i++) d[i] *= gain
  }
}

export async function loadSampleBuffer(packId: string, file: string): Promise<AudioBuffer | null> {
  const key = sampleKey(packId, file)
  const hit = fileCache.get(key)
  if (hit) return hit
  const inflight = loading.get(key)
  if (inflight) return inflight
  const task = (async (): Promise<AudioBuffer | null> => {
    try {
      const raw = loader ? await loader(packId, file) : null
      if (!raw) {
        missing.add(key)
        return null
      }
      const buf = await getDecodeCtx().decodeAudioData(raw.slice(0))
      normaliseBuffer(buf)
      fileCache.set(key, buf)
      missing.delete(key)
      notify()
      return buf
    } catch (err) {
      console.warn('[ILS] sample decode failed', key, err)
      missing.add(key)
      return null
    } finally {
      loading.delete(key)
    }
  })()
  loading.set(key, task)
  return task
}

export function isMissing(packId: string, file: string): boolean {
  return missing.has(sampleKey(packId, file))
}

/** Drop decoded buffers for a pack (used when uninstalling). */
export function dropPackBuffers(packId: string): void {
  for (const key of [...fileCache.keys()]) if (key.startsWith(`${packId}/`)) fileCache.delete(key)
  for (const key of [...missing]) if (key.startsWith(`${packId}/`)) missing.delete(key)
  notify()
}

export interface LoadProgress {
  loaded: number
  total: number
  bytes: number
}

/** Decode every sample a patch needs, a few at a time. */
export async function preloadPatch(patch: Patch, onProgress?: (p: LoadProgress) => void): Promise<LoadProgress> {
  const files = [...new Set(patch.zones.map((z) => z.file))]
  let done = 0
  let bytes = 0
  const target = files.filter((f) => !cachedBuffer(patch.packId, f))
  const total = files.length
  onProgress?.({ loaded: total - target.length, total, bytes })
  const queue = [...target]
  const worker = async (): Promise<void> => {
    for (;;) {
      const file = queue.shift()
      if (!file) return
      const buf = await loadSampleBuffer(patch.packId, file)
      done++
      if (buf) bytes += buf.length * buf.numberOfChannels * 4
      onProgress?.({ loaded: total - queue.length, total, bytes })
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, Math.max(1, queue.length)) }, worker))
  return { loaded: done, total, bytes }
}

export function patchStats(patch: Patch): { total: number; loaded: number; missing: number } {
  const files = [...new Set(patch.zones.map((z) => z.file))]
  let loaded = 0
  let miss = 0
  for (const f of files) {
    if (cachedBuffer(patch.packId, f)) loaded++
    else if (isMissing(patch.packId, f)) miss++
  }
  return { total: files.length, loaded, missing: miss }
}

// ---------------------------------------------------------------------------
// Zone selection
// ---------------------------------------------------------------------------

const rr = new Map<string, number>()

export function pickZone(patch: Patch, pitch: number, vel: number): SampleZone | null {
  const v = Math.max(1, Math.min(127, Math.round(vel * 127)))
  const matching = patch.zones.filter((z) => pitch >= z.lo && pitch <= z.hi && v >= z.velLo && v <= z.velHi)
  const pool = matching.length ? matching : patch.zones.filter((z) => pitch >= z.lo && pitch <= z.hi)
  const use = pool.length ? pool : patch.zones
  if (!use.length) return null
  // Closest root wins, then round-robin within that root.
  let bestRoot = use[0].root
  let bestDist = Infinity
  for (const z of use) {
    const d = Math.abs(z.root - pitch)
    if (d < bestDist) {
      bestDist = d
      bestRoot = z.root
    }
  }
  const atRoot = use.filter((z) => z.root === bestRoot)
  if (atRoot.length === 1) return atRoot[0]
  const key = `${patch.id}:${bestRoot}`
  const idx = rr.get(key) ?? 0
  rr.set(key, idx + 1)
  return atRoot[idx % atRoot.length]
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

function env(
  ctx: BaseAudioContext,
  dest: AudioNode,
  time: number,
  dur: number,
  attack: number,
  release: number,
  peak: number,
): { node: GainNode; stopAt: number } {
  const g = ctx.createGain()
  const a = Math.max(0.001, Math.min(4, attack))
  const r = Math.max(0.01, Math.min(6, release))
  const t0 = Math.max(0, time)
  const off = Math.max(t0 + 0.01, time + Math.max(0.01, dur))
  g.gain.setValueAtTime(0, t0)
  g.gain.linearRampToValueAtTime(peak, t0 + Math.min(a, Math.max(0.002, dur)))
  g.gain.setValueAtTime(peak, off)
  g.gain.exponentialRampToValueAtTime(0.0001, off + r)
  g.connect(dest)
  return { node: g, stopAt: off + r + 0.05 }
}

/**
 * Schedule one sampled note. Returns false when the sample is not decoded yet;
 * the buffer is requested in the background so the next note plays.
 */
export function playPatch(ctx: BaseAudioContext, dest: AudioNode, patch: Patch, note: PatchNote): boolean {
  const zone = pickZone(patch, note.pitch, note.vel)
  if (!zone) return false
  const buf = cachedBuffer(patch.packId, zone.file)
  if (!buf) {
    void loadSampleBuffer(patch.packId, zone.file)
    return false
  }
  const semis = note.pitch - zone.root + (zone.tune ?? 0) / 100
  const rate = Math.pow(2, semis / 12) * (buf.sampleRate / Math.max(8000, ctx.sampleRate))
  const peak = Math.max(0, Math.min(4, (note.gain ?? 1) * patch.gain * (zone.gain ?? 1) * (0.25 + 0.75 * note.vel)))
  const { node, stopAt } = env(ctx, dest, note.time, note.dur, note.attack ?? 0.002, note.release ?? 0.14, peak)
  let tail: AudioNode = node
  const cutoff = note.cutoff ?? 0
  if (cutoff > 0 && cutoff < 18000) {
    const f = ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.value = Math.max(80, Math.min(20000, cutoff))
    f.Q.value = Math.max(0.0001, note.q ?? 0.6)
    f.connect(node)
    tail = f
  }
  const src = ctx.createBufferSource()
  src.buffer = buf
  src.playbackRate.value = Math.max(0.03, Math.min(12, rate))
  if (zone.loopStart != null && zone.loopEnd != null && zone.loopEnd > zone.loopStart) {
    src.loop = true
    src.loopStart = zone.loopStart / Math.max(0.03, rate) // loop points are in sample seconds
    src.loopEnd = zone.loopEnd / Math.max(0.03, rate)
  }
  if (zone.pan && ctx.createStereoPanner) {
    const p = ctx.createStereoPanner()
    p.pan.value = Math.max(-1, Math.min(1, zone.pan))
    src.connect(p).connect(tail)
  } else {
    src.connect(tail)
  }
  src.start(Math.max(0, note.time))
  try {
    src.stop(stopAt)
  } catch {
    /* ignore */
  }
  return true
}

/** Single sample preview that ignores envelopes — used by the browser. */
export function previewPatchNote(ctx: BaseAudioContext, dest: AudioNode, patch: Patch, pitch = 60): boolean {
  return playPatch(ctx, dest, patch, { time: ctx.currentTime + 0.03, dur: 0.9, pitch, vel: 0.85 })
}
