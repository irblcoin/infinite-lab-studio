// ---------------------------------------------------------------------------
// Sound pack store: catalogue, one-click install into IndexedDB, uninstall,
// resume, and drag-and-drop import of WAV / FLAC / MP3 / OGG / SFZ / SF2.
// ---------------------------------------------------------------------------

import { db, type StoredPackFile, type StoredPackMeta } from '../state/db'
import {
  dropPackBuffers,
  registerPatch,
  registerPatches,
  setSampleLoader,
  type Patch,
} from '../audio/patch'
import { parseSfz } from '../audio/sfz'
import { encodeWav16, parseSf2 } from '../audio/sf2'

export interface PackFileRef {
  path: string
  bytes: number
}

export interface PackMeta {
  id: string
  name: string
  author: string
  license: string
  licenseUrl: string
  source: string
  description: string
  category: string
  core?: boolean
  bytes: number
  files: PackFileRef[]
  instruments: Patch[]
}

export interface Catalog {
  generated: string
  packs: PackMeta[]
}

export type PackStatus = 'idle' | 'queued' | 'installing' | 'installed' | 'error'

export interface PackState {
  status: PackStatus
  done: number
  total: number
  bytes: number
  totalBytes: number
  error?: string
}

const EMPTY: PackState = { status: 'idle', done: 0, total: 0, bytes: 0, totalBytes: 0 }

let catalog: Catalog | null = null
let catalogPromise: Promise<Catalog> | null = null
const states = new Map<string, PackState>()
const installed = new Set<string>()
const subs = new Set<() => void>()

function notify(): void {
  for (const s of subs) s()
}

export function subscribePacks(cb: () => void): () => void {
  subs.add(cb)
  return () => subs.delete(cb)
}

function setState(id: string, patch: Partial<PackState>): void {
  states.set(id, { ...(states.get(id) ?? EMPTY), ...patch })
  notify()
}

function baseUrl(): URL {
  return new URL('packs/', document.baseURI)
}

export function packFileUrl(packId: string, file: string): string {
  return new URL(`${packId}/${file.split('/').map(encodeURIComponent).join('/')}`, baseUrl()).href
}

export async function loadCatalog(): Promise<Catalog> {
  if (catalog) return catalog
  if (!catalogPromise) {
    catalogPromise = (async () => {
      const res = await fetch(new URL('index.json', baseUrl()).href)
      if (!res.ok) throw new Error(`Sound pack index missing (HTTP ${res.status})`)
      const data = (await res.json()) as Catalog
      catalog = data
      registerPatches(data.packs.flatMap((p) => p.instruments))
      return data
    })()
  }
  return catalogPromise
}

export function getCatalog(): Catalog | null {
  return catalog
}

export function packMeta(id: string): PackMeta | null {
  return catalog?.packs.find((p) => p.id === id) ?? null
}

/** All pack instruments, in catalogue order. */
export function packInstruments(): Patch[] {
  return catalog?.packs.flatMap((p) => p.instruments) ?? []
}

export function instrumentCategories(): string[] {
  const cats = new Set<string>()
  for (const p of packInstruments()) cats.add(p.category)
  return [...cats].sort()
}

// ---------------------------------------------------------------------------
// Installed state
// ---------------------------------------------------------------------------

export function packState(id: string): PackState {
  return states.get(id) ?? EMPTY
}

export function isInstalled(id: string): boolean {
  return installed.has(id)
}

export function installedBytes(): number {
  let total = 0
  for (const id of installed) total += packMeta(id)?.bytes ?? 0
  return total
}

export async function refreshInstalled(): Promise<void> {
  try {
    const metas = (await db.allPackMeta()) ?? []
    installed.clear()
    for (const m of metas) {
      installed.add(m.id)
      setState(m.id, { status: 'installed', done: m.files, total: m.files, bytes: m.bytes, totalBytes: m.bytes })
    }
  } catch (err) {
    console.warn('[ILS] pack state unavailable', err)
  }
  notify()
}

// ---------------------------------------------------------------------------
// Sample loader: installed blob first, static pack file as the fallback, so an
// instrument always makes sound even before the pack is "installed".
// ---------------------------------------------------------------------------

let loaderReady = false

export function initSampleLoader(): void {
  if (loaderReady) return
  loaderReady = true
  setSampleLoader(async (packId, file) => {
    if (packId === 'user' || installed.has(packId)) {
      try {
        const rec = await db.getPackFile(`${packId}/${file}`)
        if (rec?.blob) return await rec.blob.arrayBuffer()
      } catch {
        /* fall through to static file */
      }
    }
    if (packId === 'user') return null
    try {
      const res = await fetch(packFileUrl(packId, file))
      if (!res.ok) return null
      return await res.arrayBuffer()
    } catch {
      return null
    }
  })
}

// ---------------------------------------------------------------------------
// Install / uninstall
// ---------------------------------------------------------------------------

const cancelled = new Set<string>()

export function cancelInstall(id: string): void {
  cancelled.add(id)
}

export interface InstallOptions {
  onProgress?: (s: PackState) => void
}

export async function installPack(id: string, opts: InstallOptions = {}): Promise<boolean> {
  const pack = packMeta(id)
  if (!pack) {
    setState(id, { status: 'error', error: 'Unknown pack' })
    return false
  }
  if (installed.has(id)) {
    setState(id, { status: 'installed' })
    return true
  }
  cancelled.delete(id)
  initSampleLoader()
  const total = pack.files.length
  const totalBytes = pack.bytes
  const have = new Set(((await db.packFilesFor(id)) ?? []).map((f) => f.file))
  let done = have.size
  let bytes = 0
  for (const f of pack.files) if (have.has(f.path)) bytes += f.bytes
  setState(id, { status: 'installing', done, total, bytes, totalBytes, error: undefined })
  opts.onProgress?.(packState(id))

  const queue = pack.files.filter((f) => !have.has(f.path))
  let failed = 0
  let firstError = ''

  const worker = async (): Promise<void> => {
    for (;;) {
      if (cancelled.has(id)) return
      const file = queue.shift()
      if (!file) return
      try {
        const res = await fetch(packFileUrl(id, file.path))
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const blob = await res.blob()
        // A dev/preview server that rewrites unknown paths to index.html would
        // otherwise "install" HTML pages as if they were audio.
        const head = new Uint8Array(await blob.slice(0, 32).arrayBuffer())
        const text = String.fromCharCode(...head).trim().toLowerCase()
        if (blob.type.includes('text/html') || text.startsWith('<!doctype') || text.startsWith('<html')) {
          throw new Error(`${file.path} is missing from the pack (server returned a web page)`)
        }
        if (blob.size < 64) throw new Error(`${file.path} is empty`)
        const rec: StoredPackFile = {
          key: `${id}/${file.path}`,
          packId: id,
          file: file.path,
          blob,
          size: blob.size,
          addedAt: Date.now(),
        }
        await db.putPackFile(rec)
        done++
        bytes += blob.size
        setState(id, { status: 'installing', done, bytes, total, totalBytes })
        opts.onProgress?.(packState(id))
      } catch (err) {
        failed++
        if (!firstError) firstError = `${file.path}: ${(err as Error).message}`
      }
    }
  }

  const workers = Array.from({ length: Math.min(5, Math.max(1, queue.length)) }, worker)
  await Promise.all(workers)

  if (cancelled.has(id)) {
    setState(id, { status: 'error', error: 'Install cancelled' })
    cancelled.delete(id)
    return false
  }

  const remaining = (await db.packFilesFor(id)) ?? []
  if (remaining.length === pack.files.length) {
    const meta: StoredPackMeta = {
      id,
      installedAt: Date.now(),
      bytes: remaining.reduce((n, f) => n + f.size, 0),
      files: remaining.length,
    }
    await db.setPackMeta(meta)
    installed.add(id)
    setState(id, { status: 'installed', done: remaining.length, total, bytes: meta.bytes, totalBytes: meta.bytes })
    return true
  }
  setState(id, {
    status: 'error',
    done: remaining.length,
    total,
    bytes,
    totalBytes,
    error:
      failed > 0
        ? `${failed} file${failed === 1 ? '' : 's'} failed (${firstError}). Press Retry to resume — finished files are kept.`
        : 'Install incomplete. Press Retry to resume.',
  })
  return false
}

export async function installPackWithRetry(id: string): Promise<boolean> {
  let ok = await installPack(id)
  if (!ok) ok = await installPack(id)
  return ok
}

export async function installAllPacks(onProgress?: (id: string, s: PackState) => void): Promise<{ ok: string[]; failed: string[] }> {
  const cat = await loadCatalog()
  const ok: string[] = []
  const failed: string[] = []
  for (const pack of cat.packs) {
    if (installed.has(pack.id)) {
      ok.push(pack.id)
      continue
    }
    const done = await installPack(pack.id, { onProgress: (s) => onProgress?.(pack.id, s) })
    if (done) ok.push(pack.id)
    else failed.push(pack.id)
  }
  return { ok, failed }
}

export async function uninstallPack(id: string): Promise<void> {
  const files = (await db.packFilesFor(id)) ?? []
  await db.deletePackFiles(files.map((f) => f.key))
  await db.deletePackMeta(id)
  installed.delete(id)
  dropPackBuffers(id)
  setState(id, { status: 'idle', done: 0, bytes: 0 })
  notify()
}

/** Auto-install the core starter set (piano + drum machines) on first launch. */
export async function autoInstallCore(onProgress?: (id: string, s: PackState) => void): Promise<void> {
  const cat = await loadCatalog()
  const core = cat.packs.filter((p) => p.core && !installed.has(p.id))
  for (const pack of core) {
    await installPack(pack.id, { onProgress: (s) => onProgress?.(pack.id, s) })
  }
}

export function pendingCoreBytes(): number {
  const cat = catalog
  if (!cat) return 0
  let n = 0
  for (const p of cat.packs) if (p.core && !installed.has(p.id)) n += p.bytes
  return n
}

// ---------------------------------------------------------------------------
// Imported instruments (drag and drop)
// ---------------------------------------------------------------------------

const AUDIO_EXT = /\.(wav|mp3|ogg|oga|flac|m4a|aac|aif|aiff)$/i

function fileKey(f: File): string {
  const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name
  return rel.replace(/\\/g, '/')
}

function baseName(p: string): string {
  return p.split('/').pop() ?? p
}

async function storeUserFile(packId: string, path: string, blob: Blob): Promise<void> {
  await db.putPackFile({
    key: `${packId}/${path}`,
    packId,
    file: path,
    blob,
    size: blob.size,
    addedAt: Date.now(),
  })
}

async function persistPatch(p: Patch): Promise<void> {
  await db.putPatchDef({ id: p.id, packId: p.packId, json: JSON.stringify(p), addedAt: Date.now() })
}

/** Load user-imported patches on boot. */
export async function loadImportedPatches(): Promise<void> {
  try {
    const defs = (await db.allPatchDefs()) ?? []
    for (const d of defs) {
      try {
        registerPatch(JSON.parse(d.json) as Patch)
      } catch {
        /* skip a corrupt definition rather than break boot */
      }
    }
  } catch (err) {
    console.warn('[ILS] imported patches unavailable', err)
  }
}

export interface ImportResult {
  added: number
  message: string
}

/**
 * Import any mix of audio files, SFZ mappings and SF2 soundfonts. Everything is
 * copied into IndexedDB so it survives reloads and does not need the original
 * files again.
 */
export async function importSampleFiles(files: File[]): Promise<ImportResult> {
  const audio = files.filter((f) => AUDIO_EXT.test(f.name))
  const sfz = files.filter((f) => /\.sfz$/i.test(f.name))
  const sf2 = files.filter((f) => /\.sf2$/i.test(f.name))
  let added = 0
  const byName = new Map<string, File>()
  for (const f of audio) {
    byName.set(baseName(fileKey(f)).toLowerCase(), f)
    byName.set(fileKey(f).toLowerCase(), f)
  }
  const stamp = Date.now().toString(36)
  // Audio files that an SFZ mapping already references must not also appear as
  // standalone one-shots, but any leftover audio in the same drop still should.
  const consumed = new Set<File>()

  for (const map of sfz) {
    const text = await map.text()
    const folder = `sfz_${stamp}_${baseName(map.name).replace(/[^a-z0-9]+/gi, '_')}`
    const used = new Map<string, File>()
    const patches = parseSfz(text, baseName(map.name).replace(/\.sfz$/i, ''), {
      packId: 'user',
      idPrefix: `user_${stamp}`,
      defaultCategory: 'Imported',
      resolveFile: (p) => {
        const hit = byName.get(p.toLowerCase()) ?? byName.get(baseName(p).toLowerCase())
        if (!hit) return null
        const name = baseName(fileKey(hit))
        used.set(name, hit)
        consumed.add(hit)
        return `${folder}/${name}`
      },
    })
    for (const [name, file] of used) await storeUserFile('user', `${folder}/${name}`, file)
    for (const p of patches) {
      p.bundled = true
      registerPatch(p)
      await persistPatch(p)
      added++
    }
    if (patches.length) {
      await db.setPackMeta({
        id: 'user',
        installedAt: Date.now(),
        bytes: [...used.values()].reduce((n, f) => n + f.size, 0),
        files: used.size,
      })
      installed.add('user')
    }
  }

  for (const font of sf2) {
    try {
      const buffer = await font.arrayBuffer()
      const parsed = parseSf2(buffer)
      const folder = `sf2_${stamp}_${baseName(font.name).replace(/[^a-z0-9]+/gi, '_')}`
      for (let pi = 0; pi < parsed.presets.length; pi++) {
        const preset = parsed.presets[pi]
        if (!preset.zones.length) continue
        const usedSamples = new Map<number, string>()
        const zones: Patch['zones'] = []
        for (const z of preset.zones) {
          const sample = parsed.samples[z.sampleIndex]
          if (!sample || !sample.data.length) continue
          let file = usedSamples.get(z.sampleIndex)
          if (!file) {
            file = `${folder}/${String(z.sampleIndex).padStart(4, '0')}_${sample.name.replace(/[^a-z0-9]+/gi, '_').slice(0, 24)}.wav`
            const wav = encodeWav16([sample.data], sample.sampleRate)
            await storeUserFile('user', file, new Blob([wav], { type: 'audio/wav' }))
            usedSamples.set(z.sampleIndex, file)
          }
          zones.push({
            file,
            root: z.root,
            lo: z.keyLo,
            hi: z.keyHi,
            velLo: z.velLo,
            velHi: z.velHi,
            tune: z.tune,
            gain: z.gain,
            pan: z.pan,
          })
        }
        if (!zones.length) continue
        const patch: Patch = {
          id: `user_${stamp}_${folder}_${pi}`,
          name: `${preset.name}${parsed.presets.length > 1 ? ` (${preset.bank}:${preset.program})` : ''}`,
          category: 'SoundFont',
          packId: 'user',
          source: 'sf2',
          gain: 0.9,
          bundled: true,
          description: `Imported from ${font.name}`,
          zones,
        }
        registerPatch(patch)
        await persistPatch(patch)
        added++
      }
      installed.add('user')
      await db.setPackMeta({ id: 'user', installedAt: Date.now(), bytes: 0, files: 0 })
    } catch (err) {
      console.warn('[ILS] SF2 import failed', font.name, err)
    }
  }

  {
    for (const file of audio.filter((f) => !consumed.has(f))) {
      const name = baseName(fileKey(file)).replace(/\.[^.]+$/, '')
      const path = `one_shots/${stamp}_${baseName(fileKey(file)).replace(/[^a-z0-9._-]+/gi, '_')}`
      await storeUserFile('user', path, file)
      const patch: Patch = {
        id: `user_one_${stamp}_${added}`,
        name,
        category: 'Imported',
        packId: 'user',
        source: 'import',
        gain: 1,
        bundled: true,
        description: `Imported one-shot (${(file.size / 1024).toFixed(0)} KB)`,
        zones: [{ file: path, root: 60, lo: 0, hi: 127, velLo: 0, velHi: 127 }],
      }
      registerPatch(patch)
      await persistPatch(patch)
      added++
    }
    if (added) {
      installed.add('user')
      await db.setPackMeta({ id: 'user', installedAt: Date.now(), bytes: 0, files: added })
    }
  }

  const detail =
    added === 0
      ? files.length
        ? 'Nothing usable found. Drop WAV/FLAC/MP3/OGG audio, an .sfz mapping with its samples, or an .sf2 soundfont.'
        : 'No files were dropped.'
      : `Added ${added} instrument${added === 1 ? '' : 's'} to the browser.`
  return { added, message: detail }
}

export async function removeImportedPatch(patch: Patch): Promise<void> {
  await db.deletePatchDef(patch.id)
  const files = (await db.packFilesFor(patch.packId)) ?? []
  const owned = patch.zones.map((z) => z.file)
  const keys = files.filter((f) => owned.some((o) => f.file === o || f.file.startsWith(o.split('/')[0] + '/'))).map((f) => f.key)
  if (keys.length) await db.deletePackFiles(keys)
  dropPackBuffers(patch.packId)
}
