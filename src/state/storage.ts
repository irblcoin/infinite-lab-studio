// ---------------------------------------------------------------------------
// Storage usage reporting and cleanup.
// ---------------------------------------------------------------------------

import { db } from './db'
import { getState, toast } from './store'

export interface StorageReport {
  quota: number
  usage: number
  projects: number
  versions: number
  assets: number
  assetBytes: number
  packFiles: number
  packBytes: number
  persisted: boolean
  supported: boolean
}

export async function storageReport(): Promise<StorageReport> {
  const supported = typeof navigator !== 'undefined' && !!navigator.storage?.estimate
  let quota = 0
  let usage = 0
  let persisted = false
  if (supported) {
    const est = await navigator.storage.estimate()
    quota = est.quota ?? 0
    usage = est.usage ?? 0
    try {
      persisted = await navigator.storage.persisted()
    } catch {
      persisted = false
    }
  }
  const projects = (await db.allProjects().catch(() => [])) ?? []
  const assets = (await db.allAssets().catch(() => [])) ?? []
  const packs = (await db.allPackFiles().catch(() => [])) ?? []
  const versions: number[] = []
  for (const p of projects) {
    const vs = await db.versionsFor(p.id).catch(() => [])
    versions.push(vs.length)
  }
  let assetBytes = 0
  for (const a of assets) assetBytes += a.channels.reduce((s, c) => s + c.byteLength, 0)
  let packBytes = 0
  for (const f of packs) packBytes += f.size
  return {
    quota,
    usage,
    projects: projects.length,
    versions: versions.reduce((a, b) => a + b, 0),
    assets: assets.length,
    assetBytes,
    packFiles: packs.length,
    packBytes,
    persisted,
    supported,
  }
}

export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false
  const ok = await navigator.storage.persist()
  toast(ok ? 'Storage is now protected from automatic eviction' : 'The browser declined persistence', ok ? 'ok' : 'warn')
  return ok
}

export type CleanupMode = 'versions' | 'orphan-assets' | 'old-projects' | 'recordings'

export async function cleanupStorage(mode: CleanupMode): Promise<string> {
  if (mode === 'versions') {
    let n = 0
    const projects = (await db.allProjects()) ?? []
    for (const p of projects) {
      const versions = await db.versionsFor(p.id)
      for (const v of versions.slice(5)) {
        await db.deleteVersion(v.key)
        n++
      }
    }
    return `${n} old versions removed`
  }
  if (mode === 'orphan-assets') {
    const used = new Set<string>()
    const { project } = getState()
    const collect = (p: typeof project) => {
      for (const t of p.tracks) {
        if (t.frozenAssetId) used.add(t.frozenAssetId)
        for (const d of t.devices) if (d.sampleId) used.add(d.sampleId)
        for (const c of t.clips) {
          if (c.assetId) used.add(c.assetId)
          for (const take of c.takes ?? []) used.add(take.assetId)
        }
      }
    }
    collect(project)
    for (const rec of (await db.allProjects()) ?? []) {
      try {
        collect(JSON.parse(rec.data) as typeof project)
      } catch {
        /* skip corrupt */
      }
    }
    let n = 0
    for (const a of (await db.allAssets()) ?? []) {
      if (!used.has(a.id)) {
        await db.deleteAsset(a.id)
        n++
      }
    }
    return `${n} unused audio assets removed`
  }
  if (mode === 'old-projects') {
    const projects = ((await db.allProjects()) ?? []).sort((a, b) => b.updatedAt - a.updatedAt)
    const current = getState().project.id
    let n = 0
    for (const p of projects.slice(10)) {
      if (p.id === current) continue
      await db.deleteProject(p.id)
      n++
    }
    return `${n} old projects removed (ten newest kept)`
  }
  // recordings: delete assets not referenced by the current project
  const used = new Set<string>()
  const { project } = getState()
  for (const t of project.tracks) {
    for (const c of t.clips) {
      if (c.assetId) used.add(c.assetId)
      for (const take of c.takes ?? []) used.add(take.assetId)
    }
  }
  let n = 0
  for (const a of (await db.allAssets()) ?? []) {
    if (!used.has(a.id) && /\.(wav|mp3|m4a|webm)$/i.test(a.name)) {
      await db.deleteAsset(a.id)
      n++
    }
  }
  return `${n} recordings not used by this project removed`
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}
