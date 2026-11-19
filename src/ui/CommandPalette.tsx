import { useEffect, useMemo, useRef, useState } from 'react'
import { DEVICE_DEFS } from '../data/deviceDefs'
import { LIBRARY } from '../data/library'
import { addDevice, addTrack } from '../state/actions'
import { dropLibraryItem } from '../state/actions'
import { applyTrackTemplate, listTrackTemplates } from '../state/templates'
import { getState, setSettings, setUi, useUi } from '../state/store'
import { engine } from '../audio/engine'
import { stopTransport, togglePlay } from '../state/actions'
import { runMixAssistant, openMixAssistant } from '../audio/mixassist'
import { openMastering } from '../audio/mastering'
import { createShareLink } from '../state/accounts'
import { toast } from '../state/store'

interface PaletteItem {
  id: string
  title: string
  hint: string
  group: 'Action' | 'View' | 'Device' | 'Sound' | 'Template'
  run: () => void
}

export default function CommandPalette() {
  const ui = useUi()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (ui.palette) {
      setQuery('')
      setIndex(0)
      window.setTimeout(() => inputRef.current?.focus(), 20)
    }
  }, [ui.palette])

  const items = useMemo<PaletteItem[]>(() => {
    const actions: PaletteItem[] = [
      { id: 'view-seq', title: 'Open Sequencer', hint: 'Arrangement view', group: 'View', run: () => setUi({ view: 'seq', palette: false }) },
      { id: 'view-mix', title: 'Open Mixer', hint: 'Faders, sends, meters', group: 'View', run: () => setUi({ view: 'mix', palette: false }) },
      { id: 'view-rack', title: 'Open Racks', hint: 'Devices and macros', group: 'View', run: () => setUi({ view: 'rack', palette: false }) },
      { id: 'view-home', title: 'Open the room', hint: 'Cinematic studio home', group: 'View', run: () => setUi({ view: 'home', palette: false }) },
      { id: 'play', title: 'Play / pause', hint: 'Transport', group: 'Action', run: () => void togglePlay() },
      { id: 'stop', title: 'Stop and return to zero', hint: 'Transport', group: 'Action', run: () => stopTransport() },
      {
        id: 'light',
        title: `Switch to ${getState().settings.theme === 'light' ? 'studio dark' : 'light'} theme`,
        hint: 'Appearance',
        group: 'Action',
        run: () => setSettings({ theme: getState().settings.theme === 'light' ? 'studio' : 'light' }),
      },
      { id: 'sample', title: 'Sample editor', hint: 'Trim, slice, pads', group: 'Action', run: () => setUi({ modal: 'sample', palette: false }) },
      { id: 'midifx', title: 'MIDI effects', hint: 'Arp, chords, humanize', group: 'Action', run: () => setUi({ modal: 'midifx', palette: false }) },
      { id: 'drumrack', title: 'Drum Rack', hint: 'Per-pad chains and choke', group: 'Action', run: () => setUi({ modal: 'drumrack', palette: false }) },
      { id: 'stems', title: 'Separate stems', hint: 'Vocals / drums / bass / other', group: 'Action', run: () => setUi({ modal: 'stems', palette: false }) },
      { id: 'master', title: 'Mastering assistant', hint: 'Loudness target and A/B', group: 'Action', run: () => openMastering() },
      { id: 'mixassist', title: 'Mix assistant', hint: 'Balance, clipping, EQ clash', group: 'Action', run: () => openMixAssistant() },
      { id: 'templates', title: 'Templates', hint: 'Track and project templates', group: 'Action', run: () => setUi({ modal: 'templates', palette: false }) },
      { id: 'storage', title: 'Storage & cleanup', hint: 'Quota, versions, assets', group: 'Action', run: () => setUi({ modal: 'storage', palette: false }) },
      { id: 'account', title: 'Account & cloud', hint: 'Local or Cloudflare account', group: 'Action', run: () => setUi({ modal: 'account', palette: false }) },
      { id: 'share', title: 'Share project', hint: 'Link, mix and stems', group: 'Action', run: () => setUi({ modal: 'share', palette: false }) },
      { id: 'help', title: 'Help & shortcuts', hint: 'Every command', group: 'Action', run: () => setUi({ modal: 'help', palette: false }) },
      {
        id: 'select-all',
        title: 'Select all clips',
        hint: 'Current track',
        group: 'Action',
        run: () => { const st = getState(); const t = st.project.tracks.find((x) => x.id === st.ui.selectedTrackId) ?? st.project.tracks[0]; if (t) setUi({ selectedClipIds: t.clips.map((c) => c.id) }) },
      },
      {
        id: 'run-mixassist',
        title: 'Run the mix assistant now',
        hint: 'Analyses every track',
        group: 'Action',
        run: () => {
          setUi({ palette: false })
          void runMixAssistant().then((s) => toast(`${s.length} suggestions ready`, 'ok'))
        },
      },
      {
        id: 'copy-share',
        title: 'Copy a share link',
        hint: 'Read-only player',
        group: 'Action',
        run: async () => {
          const link = await createShareLink(getState().project)
          try {
            await navigator.clipboard.writeText(link.url)
            toast('Share link copied', 'ok')
          } catch {
            toast('Open Share to copy the link', 'warn')
          }
        },
      },
      {
        id: 'new-audio',
        title: 'Add an audio track',
        hint: 'For recordings and samples',
        group: 'Action',
        run: () => addTrack('audio'),
      },
      {
        id: 'new-midi',
        title: 'Add an instrument track',
        hint: 'MIDI',
        group: 'Action',
        run: () => addTrack('midi'),
      },
      { id: 'audio-test', title: 'Play a test chord', hint: 'Check the speakers', group: 'Action', run: () => engine.testTone() },
    ]
    const devices: PaletteItem[] = (Object.keys(DEVICE_DEFS) as (keyof typeof DEVICE_DEFS)[]).map((type) => {
      const def = DEVICE_DEFS[type]
      return {
        id: `dev-${type}`,
        title: `Add ${def.name}`,
        hint: def.category === 'instrument' ? 'Instrument' : 'Effect',
        group: 'Device',
        run: () => {
          const track = getState().ui.selectedTrackId ?? getState().project.tracks[0]?.id
          if (track) addDevice(track, type)
          setUi({ palette: false })
        },
      }
    })
    const sounds: PaletteItem[] = LIBRARY.slice(0, 700).map((item) => ({
      id: `sound-${item.id}`,
      title: item.name,
      hint: item.category,
      group: 'Sound',
      run: () => {
        void dropLibraryItem(item.id, getState().ui.selectedTrackId ?? undefined)
        setUi({ palette: false })
      },
    }))
    const templates: PaletteItem[] = listTrackTemplates().map((t) => ({
      id: `tpl-${t.id}`,
      title: `Add “${t.name}”`,
      hint: t.blurb,
      group: 'Template',
      run: () => {
        applyTrackTemplate(t.id)
        setUi({ palette: false })
      },
    }))
    return [...actions, ...templates, ...devices, ...sounds]
  }, [ui.palette])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items.slice(0, 40)
    const scored = items
      .map((item) => {
        const hay = `${item.title} ${item.hint} ${item.group}`.toLowerCase()
        const idx = hay.indexOf(q)
        if (idx < 0) return null
        return { item, score: idx + hay.length * 0.001 }
      })
      .filter(Boolean) as { item: PaletteItem; score: number }[]
    scored.sort((a, b) => a.score - b.score)
    return scored.slice(0, 60).map((s) => s.item)
  }, [items, query])

  useEffect(() => setIndex(0), [query])

  if (!ui.palette) return null

  return (
    <div className="palette-backdrop" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={() => setUi({ palette: false })}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Search actions, devices and sounds…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search commands"
          onKeyDown={(e) => {
            if (e.key === 'Escape') setUi({ palette: false })
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIndex((i) => Math.min(filtered.length - 1, i + 1))
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIndex((i) => Math.max(0, i - 1))
            }
            if (e.key === 'Enter') {
              e.preventDefault()
              const chosen = filtered[index]
              if (chosen) chosen.run()
            }
          }}
        />
        <div className="palette-list" role="listbox" aria-label="Results">
          {filtered.map((item, i) => (
            <button
              key={item.id}
              role="option"
              aria-selected={i === index}
              className={`palette-item ${i === index ? 'active' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => item.run()}
            >
              <span className={`palette-group ${item.group.toLowerCase()}`}>{item.group}</span>
              <span className="palette-title">{item.title}</span>
              <span className="palette-hint dim small">{item.hint}</span>
            </button>
          ))}
          {filtered.length === 0 && <p className="dim small pad">No match — try “reverb”, “stems” or “mixer”.</p>}
        </div>
        <div className="palette-foot dim small">
          <kbd>↑</kbd> <kbd>↓</kbd> navigate · <kbd>Enter</kbd> run · <kbd>Esc</kbd> close
        </div>
      </div>
    </div>
  )
}
