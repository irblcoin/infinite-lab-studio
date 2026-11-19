import { useEffect, useMemo, useState } from 'react'
import type { LibCategory, LibItem } from '../data/library'
import { LIBRARY, SOUND_COUNT, LOOP_COUNT, searchLibrary } from '../data/library'
import { db, type StoredAsset } from '../state/db'
import { getState, setUi, useUi } from '../state/store'
import { addSamplerInstrument, dropLibraryItem, previewLibraryItem, previewPackInstrument } from '../state/actions'
import { engine } from '../audio/engine'
import { getBuffer, registerBuffer } from '../audio/assets'
import { bufferFromStored } from '../audio/assets'
import { allPatches, type Patch } from '../audio/patch'
import { getCatalog, loadCatalog, packInstruments, subscribePacks } from '../data/packStore'
import Packs from './Packs'
import { LOOPS } from '../data/loops'
import { dropLoop, previewLoop } from '../state/features'

type Tab = LibCategory | 'All' | 'Favorites' | 'My Recordings' | 'Packs'

const TABS: Tab[] = [
  'All',
  'Instruments',
  'Drums',
  'Synth',
  'Effects',
  'Loops',
  'Samples',
  'Packs',
  'My Recordings',
  'Favorites',
]

function loadFavs(): string[] {
  try {
    return JSON.parse(localStorage.getItem('ils.favorites') || '[]') as string[]
  } catch {
    return []
  }
}

export default function Library() {
  const ui = useUi()
  const [tab, setTab] = useState<Tab>('All')
  const [search, setSearch] = useState('')
  const [favs, setFavs] = useState<string[]>(loadFavs)
  const [recordings, setRecordings] = useState<StoredAsset[]>([])
  const [previewing, setPreviewing] = useState<string | null>(null)
  const [, bump] = useState(0)

  // The homepage (or a voice command) can ask for a specific tab.
  useEffect(() => {
    if (ui.libraryTab) setTab(ui.libraryTab as Tab)
  }, [ui.libraryTab])

  useEffect(() => {
    void (async () => {
      try {
        const all = await db.allAssets()
        setRecordings((all || []).sort((a, b) => b.createdAt - a.createdAt))
      } catch {
        setRecordings([])
      }
    })()
    void loadCatalog()
      .then(() => bump((n) => n + 1))
      .catch(() => bump((n) => n + 1))
    return subscribePacks(() => bump((n) => n + 1))
  }, [])

  const toggleFav = (id: string) => {
    const next = favs.includes(id) ? favs.filter((x) => x !== id) : [...favs, id]
    setFavs(next)
    localStorage.setItem('ils.favorites', JSON.stringify(next))
  }

  const q = search.trim().toLowerCase()
  const patches = useMemo(() => {
    if (['My Recordings', 'Favorites', 'Packs', 'Effects', 'Loops', 'Samples'].includes(tab)) return []
    const all = [...packInstruments(), ...allPatches().filter((p) => p.packId === 'user')]
    // Real kit samples lead the Drums tab; the Instruments tab is melodic.
    const list =
      tab === 'Drums'
        ? all.filter((p) => p.category === 'Drums')
        : tab === 'All'
          ? all.filter((p) => p.category !== 'Drums' && p.category !== 'Synth')
          : tab === 'Synth'
            ? all.filter((p) => p.category === 'Synth')
            : all.filter((p) => p.category !== 'Drums')
    if (!q) return list
    return list.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q) ||
        (p.description ?? '').toLowerCase().includes(q),
    )
  }, [tab, q, bump])

  const items = useMemo(() => {
    // “All” shows sampled instruments (rendered separately), so it has no rows here.
    if (
      tab === 'All' ||
      tab === 'Instruments' ||
      tab === 'My Recordings' ||
      tab === 'Favorites' ||
      tab === 'Packs'
    )
      return []
    const list = searchLibrary(search, tab).filter((i) => i.kind !== 'instrument')
    // Generated drum hits sit next to the drum machines in the Synth tab only.
    return tab === 'Drums' ? list.filter((i) => i.kind !== 'drum') : list
  }, [search, tab])

  const synthItems = useMemo(() => {
    // The Synth tab is the only place generated sounds appear: every preset,
    // including the drum machines and their kits.
    if (tab !== 'Synth') return []
    return LIBRARY.filter(
      (i) =>
        (i.kind === 'instrument' || i.kind === 'drum') &&
        (!q || i.name.toLowerCase().includes(q) || i.tags.toLowerCase().includes(q)),
    )
  }, [tab, q])

  const favItems = useMemo(() => LIBRARY.filter((i) => favs.includes(i.id)), [favs])

  const preview = async (item: LibItem) => {
    setPreviewing(item.id)
    try {
      await previewLibraryItem(item)
    } finally {
      window.setTimeout(() => setPreviewing((p) => (p === item.id ? null : p)), 500)
    }
  }

  const previewPatch = async (patch: Patch) => {
    setPreviewing(patch.id)
    try {
      await previewPackInstrument(patch.id)
    } finally {
      window.setTimeout(() => setPreviewing((p) => (p === patch.id ? null : p)), 900)
    }
  }

  const add = async (item: LibItem) => {
    const { ui: u } = getState()
    const track = getState().project.tracks.find((t) => t.id === u.selectedTrackId)
    await dropLibraryItem(item.id, track?.id, Math.round(engine.getBeat() * 4) / 4)
  }

  if (!ui.libraryOpen) {
    return (
      <button className="library-collapsed" onClick={() => setUi({ libraryOpen: true })} title="Open the sound library">
        <span>SOUNDS</span>
        <span className="mono">{SOUND_COUNT + packInstruments().length}</span>
      </button>
    )
  }

  const installed = (getCatalog()?.packs ?? []).length

  return (
    <aside className="library">
      <div className="library-head">
        <div>
          <h2>Sound Library</h2>
          <p className="dim small">
            {packInstruments().length} sampled · {SOUND_COUNT} synth · {LOOP_COUNT} loops
            {installed ? ` · ${installed} packs` : ''}
          </p>
        </div>
        <button className="icon-btn" title="Collapse library" onClick={() => setUi({ libraryOpen: false })}>
          ‹
        </button>
      </div>
      <input
        className="text-input"
        placeholder="Search sounds, instruments, loops…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="library-tabs">
        {TABS.map((t) => (
          <button
            key={t}
            className={tab === t ? 'active' : ''}
            onClick={() => setTab(t)}
            title={t === 'Packs' ? 'Install sampled instruments' : undefined}
          >
            {t}
            {t === 'Favorites' && favs.length > 0 ? ` ${favs.length}` : ''}
          </button>
        ))}
      </div>

      <div className="library-list">
        {tab === 'Packs' && <Packs />}

        {tab === 'My Recordings' &&
          (recordings.length === 0 ? (
            <p className="dim small empty-note">
              Recorded takes appear here. Arm an audio track and hit record — takes are stored in this browser.
            </p>
          ) : (
            recordings.map((a) => (
              <div
                key={a.id}
                className="lib-item"
                draggable
                onDragStart={(e) => e.dataTransfer.setData('text/ils-library', `asset:${a.id}`)}
                onDoubleClick={() => dropLibraryItem(`asset:${a.id}`, getState().ui.selectedTrackId ?? undefined, engine.getBeat())}
                title={`${a.name} · ${a.duration.toFixed(2)}s — drag to the timeline`}
              >
                <div className="li-main">
                  <span className="li-name">{a.name}</span>
                  <span className="li-tags">
                    recording · {a.duration.toFixed(1)}s · {(a.sampleRate / 1000).toFixed(1)}kHz
                  </span>
                </div>
                <button
                  className="li-btn"
                  title="Preview"
                  onClick={async () => {
                    let buf = getBuffer(a.id)
                    if (!buf) {
                      const ctx = engine.ctx ?? (await engine.start())
                      buf = bufferFromStored(ctx, a)
                      registerBuffer(a.id, buf)
                    }
                    await engine.start()
                    engine.previewBuffer(buf)
                    setPreviewing(a.id)
                  }}
                >
                  ▶
                </button>
              </div>
            ))
          ))}

        {tab === 'Favorites' &&
          (favItems.length === 0 ? (
            <p className="dim small empty-note">Tap the star on any sound to keep it here.</p>
          ) : (
            favItems.map((item) => (
              <LibRow
                key={item.id}
                item={item}
                fav={favs}
                onFav={toggleFav}
                onPreview={preview}
                onAdd={add}
                previewing={previewing === item.id}
                onDrag={(e) => e.dataTransfer.setData('text/ils-library', item.id)}
              />
            ))
          ))}

        {patches.length > 0 && (
          <div className="patch-section">
            <span className="section-label">
              {tab === 'Drums' ? 'Sampled drum machines' : tab === 'Synth' ? 'Sampled synths' : 'Sampled instruments'}
            </span>
            {patches.map((p) => (
              <div
                key={p.id}
                className="lib-item patch-item"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/ils-library', `patch:${p.id}`)
                  e.dataTransfer.effectAllowed = 'copy'
                }}
                onDoubleClick={() => addSamplerInstrument(p.id, getState().ui.selectedTrackId ?? undefined)}
                title={`${p.name} — ${p.zones.length} sample zones · double-click to load on the selected track`}
              >
                <span className="li-icon sample">⌁</span>
                <div className="li-main">
                  <span className="li-name">{p.name}</span>
                  <span className="li-tags">
                    {p.category} · {p.zones.length} zones{ p.source !== 'pack' ? ` · ${p.source.toUpperCase()}` : '' }
                  </span>
                </div>
                <button
                  className={`li-btn ${previewing === p.id ? 'on' : ''}`}
                  title="Preview"
                  onClick={() => void previewPatch(p)}
                >
                  {previewing === p.id ? '◼' : '▶'}
                </button>
                <button
                  className="li-btn add"
                  title="Load on the selected track"
                  onClick={() => addSamplerInstrument(p.id, getState().ui.selectedTrackId ?? undefined)}
                >
                  ＋
                </button>
              </div>
            ))}
          </div>
        )}

        {(tab === 'All' || tab === 'Drums' || tab === 'Effects' || tab === 'Loops' || tab === 'Samples' || tab === 'Synth') && (
          <>
            {items.length === 0 && synthItems.length === 0 && patches.length === 0 && !q && (
              <p className="dim small empty-note">Nothing here yet.</p>
            )}
            {tab === 'Loops' && <LoopBrowser />}
            {items.length === 0 && synthItems.length === 0 && patches.length === 0 && q && (
              <p className="dim small empty-note">No sounds match “{search}”.</p>
            )}
            {tab === 'Synth' && <span className="section-label">Synths & generated sounds (not sampled)</span>}
            {tab === 'Samples' && items.length > 0 && <span className="section-label">Synthesized textures</span>}
            {synthItems.map((item) => (
              <LibRow
                key={item.id}
                item={item}
                fav={favs}
                onFav={toggleFav}
                onPreview={preview}
                onAdd={add}
                previewing={previewing === item.id}
                onDrag={(e) => e.dataTransfer.setData('text/ils-library', item.id)}
              />
            ))}
            {items.filter((i) => tab !== 'Loops' || i.kind !== 'loop').map((item) => (
              <LibRow
                key={item.id}
                item={item}
                fav={favs}
                onFav={toggleFav}
                onPreview={preview}
                onAdd={add}
                previewing={previewing === item.id}
                onDrag={(e) => e.dataTransfer.setData('text/ils-library', item.id)}
              />
            ))}
          </>
        )}

        {tab === 'Instruments' && patches.length === 0 && (
          <p className="dim small empty-note">
            No sampled instruments loaded yet. Open the <strong>Packs</strong> tab and press Install All — the starter
            piano and drum machines install automatically on first launch.
          </p>
        )}
      </div>
      <div className="library-foot dim small">
        Drag onto a track · double-click to drop at the playhead · click ▶ to preview
      </div>
    </aside>
  )
}

function LoopBrowser() {
  const [genre, setGenre] = useState('All')
  const [busy, setBusy] = useState<string | null>(null)
  const genres = ['All', ...new Set(LOOPS.map((l) => l.genreLabel))]
  const list = genre === 'All' ? LOOPS : LOOPS.filter((l) => l.genreLabel === genre)
  return (
    <div className="loop-browser">
      <div className="loop-genres">
        {genres.map((g) => (
          <button key={g} className={`chip tiny ${genre === g ? 'on' : ''}`} onClick={() => setGenre(g)}>
            {g}
          </button>
        ))}
      </div>
      {list.map((loop) => (
        <div
          key={loop.id}
          className="lib-item loop-row"
          draggable
          onDragStart={(e) => e.dataTransfer.setData('text/ils-library', `loop:${loop.id}`)}
          onDoubleClick={() => void dropLoop(loop.id, getState().ui.selectedTrackId ?? undefined, Math.round(engine.getBeat() * 4) / 4)}
          title={`${loop.name} — ${loop.bpm} BPM ${loop.key}, warps to the project tempo`}
        >
          <span className="li-icon loop">⟳</span>
          <div className="li-main">
            <span className="li-name">{loop.name}</span>
            <span className="li-tags mono">
              {loop.genreLabel} · {loop.bpm} BPM · {loop.key} · {loop.bars} bars · {(loop.bytes ? loop.bytes / 1024 : 0).toFixed(0)} KB
            </span>
          </div>
          <button
            className={`li-btn ${busy === loop.id ? 'on' : ''}`}
            title="Preview"
            onClick={async () => {
              setBusy(loop.id)
              await previewLoop(loop.id)
              window.setTimeout(() => setBusy((b) => (b === loop.id ? null : b)), 700)
            }}
          >
            ▶
          </button>
          <button
            className="li-btn"
            title="Place on the selected track (warped to the project tempo)"
            onClick={() => void dropLoop(loop.id, getState().ui.selectedTrackId ?? undefined, Math.round(engine.getBeat() * 4) / 4)}
          >
            +
          </button>
        </div>
      ))}
    </div>
  )
}

function LibRow({
  item,
  fav,
  onFav,
  onPreview,
  onAdd,
  onDrag,
  previewing,
}: {
  item: LibItem
  fav: string[]
  onFav: (id: string) => void
  onPreview: (i: LibItem) => void
  onAdd: (i: LibItem) => void
  onDrag: (e: React.DragEvent) => void
  previewing: boolean
}) {
  const isFav = fav.includes(item.id)
  const icon = item.kind === 'drum' ? '●' : item.kind === 'loop' ? '⟳' : item.kind === 'instrument' ? '⌁' : item.kind === 'effect' ? '⌘' : '≈'
  return (
    <div
      className="lib-item"
      draggable
      onDragStart={onDrag}
      onDoubleClick={() => void onAdd(item)}
      title={`${item.name} — ${item.tags}`}
    >
      <span className={`li-icon ${item.kind}`}>{icon}</span>
      <div className="li-main">
        <span className="li-name">{item.name}</span>
        <span className="li-tags">
          {item.category} ·{' '}
          {item.loop ? `${item.loop.bpm} BPM · ${item.loop.bars} bars` : item.tags.split(' ').slice(0, 3).join(' ')}
        </span>
      </div>
      <button className={`li-btn ${previewing ? 'on' : ''}`} title="Preview" onClick={() => void onPreview(item)}>
        {previewing ? '◼' : '▶'}
      </button>
      <button
        className={`li-btn star ${isFav ? 'on' : ''}`}
        title={isFav ? 'Remove favourite' : 'Add favourite'}
        onClick={(e) => {
          e.stopPropagation()
          onFav(item.id)
        }}
      >
        ★
      </button>
    </div>
  )
}
