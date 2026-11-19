export interface StoredAsset {
  id: string
  name: string
  sampleRate: number
  channels: Float32Array[]
  duration: number
  createdAt: number
}

export interface StoredProject {
  id: string
  name: string
  updatedAt: number
  createdAt: number
  thumbnail: string
  data: string
}

export interface StoredVersion {
  key: string
  projectId: string
  savedAt: number
  label: string
  data: string
}

export interface StoredPackFile {
  /** `<packId>/<path>` */
  key: string
  packId: string
  file: string
  blob: Blob
  size: number
  addedAt: number
}

export interface StoredPackMeta {
  id: string
  installedAt: number
  bytes: number
  files: number
}

export interface StoredPatchDef {
  id: string
  packId: string
  json: string
  addedAt: number
}

const DB_NAME = 'ils-studio'
const DB_VERSION = 2

let dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('versions')) db.createObjectStore('versions', { keyPath: 'key' })
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv')
      if (!db.objectStoreNames.contains('packfiles')) {
        const s = db.createObjectStore('packfiles', { keyPath: 'key' })
        s.createIndex('packId', 'packId')
      }
      if (!db.objectStoreNames.contains('packmeta')) db.createObjectStore('packmeta', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('patches')) db.createObjectStore('patches', { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  return openDB().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        const t = db.transaction(store, mode)
        const s = t.objectStore(store)
        let req: IDBRequest<T> | void
        try {
          req = fn(s)
        } catch (e) {
          reject(e)
          return
        }
        t.oncomplete = () => resolve(req ? req.result : undefined)
        t.onerror = () => reject(t.error)
        t.onabort = () => reject(t.error)
      }),
  )
}

export const db = {
  putAsset: (a: StoredAsset) => tx('assets', 'readwrite', (s) => s.put(a)),
  getAsset: (id: string) => tx<StoredAsset>('assets', 'readonly', (s) => s.get(id) as IDBRequest<StoredAsset>),
  allAssets: () => tx<StoredAsset[]>('assets', 'readonly', (s) => s.getAll() as IDBRequest<StoredAsset[]>),
  deleteAsset: (id: string) => tx('assets', 'readwrite', (s) => s.delete(id)),
  putProject: (p: StoredProject) => tx('projects', 'readwrite', (s) => s.put(p)),
  getProject: (id: string) => tx<StoredProject>('projects', 'readonly', (s) => s.get(id) as IDBRequest<StoredProject>),
  allProjects: () => tx<StoredProject[]>('projects', 'readonly', (s) => s.getAll() as IDBRequest<StoredProject[]>),
  deleteProject: (id: string) => tx('projects', 'readwrite', (s) => s.delete(id)),
  putVersion: (v: StoredVersion) => tx('versions', 'readwrite', (s) => s.put(v)),
  versionsFor: async (projectId: string) => {
    const all = await tx<StoredVersion[]>('versions', 'readonly', (s) => s.getAll() as IDBRequest<StoredVersion[]>)
    return (all || []).filter((v) => v.projectId === projectId).sort((a, b) => b.savedAt - a.savedAt)
  },
  deleteVersion: (key: string) => tx('versions', 'readwrite', (s) => s.delete(key)),
  setKV: (key: string, value: unknown) => tx('kv', 'readwrite', (s) => s.put(value, key)),
  getKV: <T>(key: string) => tx<T>('kv', 'readonly', (s) => s.get(key) as IDBRequest<T>),
  putPackFile: (f: StoredPackFile) => tx('packfiles', 'readwrite', (s) => s.put(f)),
  getPackFile: (key: string) =>
    tx<StoredPackFile>('packfiles', 'readonly', (s) => s.get(key) as IDBRequest<StoredPackFile>),
  packFilesFor: (packId: string) =>
    tx<StoredPackFile[]>('packfiles', 'readonly', (s) =>
      s.index('packId').getAll(packId) as IDBRequest<StoredPackFile[]>,
    ),
  allPackFiles: () => tx<StoredPackFile[]>('packfiles', 'readonly', (s) => s.getAll() as IDBRequest<StoredPackFile[]>),
  deletePackFiles: (keys: string[]) =>
    tx('packfiles', 'readwrite', (s) => {
      for (const k of keys) s.delete(k)
    }),
  setPackMeta: (m: StoredPackMeta) => tx('packmeta', 'readwrite', (s) => s.put(m)),
  allPackMeta: () => tx<StoredPackMeta[]>('packmeta', 'readonly', (s) => s.getAll() as IDBRequest<StoredPackMeta[]>),
  deletePackMeta: (id: string) => tx('packmeta', 'readwrite', (s) => s.delete(id)),
  putPatchDef: (p: StoredPatchDef) => tx('patches', 'readwrite', (s) => s.put(p)),
  allPatchDefs: () => tx<StoredPatchDef[]>('patches', 'readonly', (s) => s.getAll() as IDBRequest<StoredPatchDef[]>),
  deletePatchDef: (id: string) => tx('patches', 'readwrite', (s) => s.delete(id)),
}

/** Data URLs for microphone recordings are decoded here, independent of audio. */
export async function decodeBlob(blob: Blob): Promise<AudioBuffer> {
  const arrayBuf = await blob.arrayBuffer()
  const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
  try {
    const buf = await ctx.decodeAudioData(arrayBuf.slice(0))
    return buf
  } finally {
    void ctx.close()
  }
}
