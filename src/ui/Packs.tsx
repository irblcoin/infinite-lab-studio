import { useEffect, useMemo, useRef, useState } from 'react'
import {
  autoInstallCore,
  cancelInstall,
  getCatalog,
  importSampleFiles,
  installAllPacks,
  installPack,
  isInstalled,
  loadCatalog,
  packInstruments,
  packState,
  subscribePacks,
  uninstallPack,
  type PackMeta,
} from '../data/packStore'
import { setUi, toast } from '../state/store'
import { allPatches, isMissing, previewPatchNote, type Patch } from '../audio/patch'
import { engine } from '../audio/engine'
import { gainNode } from '../audio/dsp'

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export default function Packs() {
  const [tick, force] = useState(0)
  const [catalog, setCatalog] = useState(getCatalog())
  const [error, setError] = useState<string | null>(null)
  const [busyAll, setBusyAll] = useState(false)
  const [importing, setImporting] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileInput = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const un = subscribePacks(() => force((n) => n + 1))
    let alive = true
    loadCatalog()
      .then((c) => {
        if (alive) setCatalog(c)
      })
      .catch((err: Error) => setError(err.message))
    return () => {
      alive = false
      un()
    }
  }, [])

  const packs = catalog?.packs ?? []
  const installedCount = packs.filter((p) => isInstalled(p.id)).length
  const installedSize = packs.filter((p) => isInstalled(p.id)).reduce((n, p) => n + p.bytes, 0)
  const imported = useMemo(() => allPatches().filter((p) => p.packId === 'user'), [catalog, tick])

  const handleImport = async (files: File[]) => {
    if (!files.length) return
    setImporting(true)
    try {
      const res = await importSampleFiles(files)
      toast(res.message, res.added ? 'ok' : 'warn', 6000)
      force((n) => n + 1)
      if (res.added) setUi({ libraryOpen: true })
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="packs">
      <div className="packs-head">
        <div>
          <h3>Sound Packs</h3>
          <p className="dim small">
            {installedCount}/{packs.length} packs installed · {fmtBytes(installedSize)} stored in this browser.
            Everything is recorded audio under open licences — no accounts, no API keys.
          </p>
        </div>
        <div className="row gap">
          <button className="btn" onClick={() => setUi({ modal: 'credits' })} title="Authors, licences and sources">
            Credits
          </button>
          <button
            className="btn gold"
            disabled={busyAll || packs.every((p) => isInstalled(p.id))}
            onClick={async () => {
              setBusyAll(true)
              try {
                const res = await installAllPacks()
                toast(
                  res.failed.length
                    ? `Installed ${res.ok.length} packs, ${res.failed.length} need a retry`
                    : `All ${res.ok.length} packs installed`,
                  res.failed.length ? 'warn' : 'ok',
                  5000,
                )
              } finally {
                setBusyAll(false)
              }
            }}
          >
            {busyAll ? 'Installing…' : 'Install All'}
          </button>
        </div>
      </div>

      {error && <p className="dim small empty-note">{error}</p>}

      <div className="pack-list">
        {packs.map((pack: PackMeta) => {
          const st = packState(pack.id)
          const pct = st.total > 0 ? Math.round((st.done / st.total) * 100) : isInstalled(pack.id) ? 100 : 0
          return (
            <div key={pack.id} className={`pack-card ${isInstalled(pack.id) ? 'on' : ''}`}>
              <div className="pack-main">
                <div className="pack-title">
                  <strong>{pack.name}</strong>
                  {pack.core && <span className="tag gold-tag">starter</span>}
                  {isInstalled(pack.id) && <span className="tag ok-tag">installed</span>}
                </div>
                <p className="dim small">{pack.description}</p>
                <p className="pack-meta mono small">
                  {pack.instruments.length} instruments · {pack.files.length} files · {fmtBytes(pack.bytes)} ·{' '}
                  {pack.license} · {pack.author}
                </p>
              </div>
              <div className="pack-actions">
                {st.status === 'installing' ? (
                  <>
                    <div className="progress" title={`${st.done}/${st.total} files`}>
                      <span style={{ width: `${pct}%` }} />
                    </div>
                    <span className="mono small dim">
                      {pct}% · {st.done}/{st.total}
                    </span>
                    <button className="chip" onClick={() => cancelInstall(pack.id)}>
                      Cancel
                    </button>
                  </>
                ) : isInstalled(pack.id) ? (
                  <button
                    className="chip"
                    onClick={async () => {
                      await uninstallPack(pack.id)
                      toast(`${pack.name} removed from this browser`, 'ok')
                    }}
                  >
                    Uninstall
                  </button>
                ) : (
                  <button
                    className="btn accent"
                    onClick={async () => {
                      const ok = await installPack(pack.id)
                      toast(ok ? `${pack.name} installed` : `${pack.name} install incomplete — press Retry`, ok ? 'ok' : 'warn', 5000)
                    }}
                  >
                    Install
                  </button>
                )}
                {st.status === 'error' && (
                  <button className="chip warn" onClick={() => void installPack(pack.id)} title={st.error}>
                    Retry
                  </button>
                )}
              </div>
              {st.status === 'error' && <p className="pack-error small">{st.error}</p>}
            </div>
          )
        })}
      </div>

      <div
        className={`pack-drop ${dragOver ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          void handleImport([...e.dataTransfer.files])
        }}
        onClick={() => fileInput.current?.click()}
        title="Drop WAV, FLAC, MP3, OGG, SFZ or SF2 files"
      >
        <strong>{importing ? 'Importing…' : 'Drop your own samples here'}</strong>
        <span className="dim small">
          WAV · FLAC · MP3 · OGG · SFZ (with its samples) · SF2 soundfonts. Files are copied into this browser.
        </span>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept=".wav,.mp3,.ogg,.oga,.flac,.sfz,.sf2,audio/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            void handleImport([...(e.target.files ?? [])])
            e.target.value = ''
          }}
        />
      </div>

      {imported.length > 0 && (
        <div className="pack-imported">
          <h4>Your instruments</h4>
          {imported.map((p: Patch) => (
            <PatchRow key={p.id} patch={p} />
          ))}
        </div>
      )}
    </div>
  )
}

function PatchRow({ patch }: { patch: Patch }) {
  const [state, setState] = useState('')
  return (
    <div className="pack-import-row">
      <div className="li-main">
        <span className="li-name">{patch.name}</span>
        <span className="li-tags">
          {patch.source.toUpperCase()} · {patch.zones.length} zones · {patch.category}
        </span>
      </div>
      <button
        className="li-btn"
        title="Preview"
        onClick={async () => {
          const ctx = await engine.start()
          if (!ctx.destination) return
          const dest = gainNode(ctx, 0.9)
          dest.connect(ctx.destination)
          setState('loading')
          const missing = patch.zones.some((z) => isMissing(patch.packId, z.file))
          if (missing) {
            setState('missing')
            return
          }
          previewPatchNote(ctx, dest, patch, 60)
          setState('')
        }}
      >
        ▶
      </button>
      <span className="mono small dim">{state}</span>
    </div>
  )
}

export async function ensureCorePacks(): Promise<void> {
  try {
    await loadCatalog()
    await autoInstallCore()
  } catch (err) {
    console.warn('[ILS] core packs unavailable', err)
  }
}
