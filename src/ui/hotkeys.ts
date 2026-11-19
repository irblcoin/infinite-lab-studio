import type { Clip, ViewId } from '../state/types'
import { engine } from '../audio/engine'
import { commit, getState, setSettings, setUi, undo, redo, saveProjectNow, toast } from '../state/store'
import {
  deleteClip,
  duplicateClip,
  quantizeClip,
  splitClipAt,
  stopTransport,
  toggleLoop,
  togglePlay,
  findClip,
  selectedTrack,
} from '../state/actions'
import { startRecording, stopRecording } from '../state/record'

let clipboard: Clip | null = null

function typingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

export function copySelection(): void {
  const { ui, project } = getState()
  const id = ui.selectedClipIds[0]
  if (!id) return
  const found = findClip(project, id)
  if (found) {
    clipboard = JSON.parse(JSON.stringify(found.clip))
    toast(`Copied "${found.clip.name}"`, 'ok')
  }
}

export function pasteClipboard(): void {
  if (!clipboard) return
  const { project, ui } = getState()
  const track = selectedTrack()
  if (!track) return
  const clip: Clip = JSON.parse(JSON.stringify(clipboard))
  clip.id = `clip_${Math.random().toString(36).slice(2, 9)}`
  clip.start = Math.round(engine.getBeat() * 4) / 4
  clip.notes = clip.notes.map((n) => ({ ...n, id: `nt_${Math.random().toString(36).slice(2, 9)}` }))
  commit('Paste clip', (p) => {
    const t = p.tracks.find((x) => x.id === track.id)
    if (!t) return
    t.clips.push(clip)
    p.length = Math.max(p.length, Math.ceil(clip.start + clip.len + 8))
  })
  setUi({ selectedClipIds: [clip.id], selectedTrackId: track.id })
  toast('Clip pasted at playhead', 'ok')
}

export interface HotkeyApi {
  openHelp: () => void
  toggleVoice: () => void
}

export function installHotkeys(api: HotkeyApi): () => void {
  const handler = (e: KeyboardEvent) => {
    if (typingTarget(e.target)) return
    const { ui } = getState()
    const mod = e.metaKey || e.ctrlKey
    if (mod) {
      switch (e.key.toLowerCase()) {
        case 'z':
          e.preventDefault()
          if (e.shiftKey) redo()
          else undo()
          return
        case 'y':
          e.preventDefault()
          redo()
          return
        case 's':
          e.preventDefault()
          void saveProjectNow()
          return
        case 'e':
          e.preventDefault()
          setUi({ modal: 'export' })
          return
        case 'k':
          e.preventDefault()
          setUi({ palette: true })
          return
        case 'c':
          e.preventDefault()
          copySelection()
          return
        case 'v':
          e.preventDefault()
          pasteClipboard()
          return
        case 'd':
          e.preventDefault()
          if (ui.selectedClipIds[0]) duplicateClip(ui.selectedClipIds[0])
          return
        case 'a':
          e.preventDefault()
          {
            const track = selectedTrack()
            if (track) setUi({ selectedClipIds: track.clips.map((c) => c.id) })
          }
          return
        default:
          break
      }
    }
    switch (e.key) {
      case ' ':
        e.preventDefault()
        void togglePlay()
        return
      case 'Escape':
        setUi({ modal: null, contextMenu: null, confirm: null, tour: 0 })
        return
      case '?':
        api.openHelp()
        return
      case '1':
        setUi({ view: 'seq' })
        return
      case '2':
        setUi({ view: 'mix' })
        return
      case '3':
        setUi({ view: 'rack' })
        return
      case '4':
        setUi({ view: 'home' })
        return
      case 'Delete':
      case 'Backspace':
        if (ui.selectedClipIds.length) {
          e.preventDefault()
          ui.selectedClipIds.forEach(deleteClip)
          setUi({ selectedClipIds: [] })
        }
        return
      case 'ArrowRight':
        e.preventDefault()
        engine.seek(engine.getBeat() + (e.shiftKey ? 1 : 4))
        return
      case 'ArrowLeft':
        e.preventDefault()
        engine.seek(Math.max(0, engine.getBeat() - (e.shiftKey ? 1 : 4)))
        return
      case '+':
      case '=':
        setUi({ zoom: Math.min(220, ui.zoom * 1.25) })
        return
      case '-':
        setUi({ zoom: Math.max(8, ui.zoom * 0.8) })
        return
      default:
        break
    }
    switch (e.key.toLowerCase()) {
      case 'r':
        e.preventDefault()
        if (getState().ui.recording) void stopRecording()
        else void startRecording()
        break
      case 'l':
        toggleLoop()
        break
      case 'm':
        setSettings({ metronome: !getState().settings.metronome })
        break
      case 'q':
        if (ui.selectedClipIds[0]) quantizeClip(ui.selectedClipIds[0], 0.25)
        break
      case 's':
        if (ui.selectedClipIds[0]) splitClipAt(ui.selectedClipIds[0], engine.getBeat())
        break
      case 'v':
        api.toggleVoice()
        break
      case 'r ':
        break
      case 'home':
        engine.seek(0)
        break
      case 'end':
        engine.seek(getState().project.length)
        break
      case '0':
        stopTransport()
        break
      default:
        break
    }
  }
  window.addEventListener('keydown', handler)
  return () => window.removeEventListener('keydown', handler)
}
