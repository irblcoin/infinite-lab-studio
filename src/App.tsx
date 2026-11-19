import { Component, useCallback, useEffect, useState, type ReactNode } from 'react'
import { engine } from './audio/engine'
import {
  applyTheme,
  getState,
  markSessionClean,
  markSessionOpen,
  persistProject,
  pendingRecovery,
  restoreLayout,
  startAutosaveLoop,
  setSettings,
  setUi,
  toast,
  useApp,
  useSettings,
  useUi,
} from './state/store'
import CommandPalette from './ui/CommandPalette'
import SharedPlayer from './ui/SharedPlayer'
import { clearShareHash, readShareFromLocation } from './state/accounts'
import type { Project } from './state/types'
import { parseCommand, executeCommand } from './voice/commands'
import { voice } from './voice/speech'
import { installHotkeys } from './ui/hotkeys'
import Transport from './ui/Transport'
import Home from './ui/Home'
import Sequencer from './ui/Sequencer'
import Mixer from './ui/Mixer'
import Racks from './ui/Racks'
import Library from './ui/Library'
import RightPanel, { type VoicePanelState } from './ui/RightPanel'
import Modals from './ui/Modals'
import { ContextMenu, Toasts } from './ui/bits'
import { loadCatalog, autoInstallCore, initSampleLoader, loadImportedPatches, pendingCoreBytes, refreshInstalled } from './data/packStore'
import { upgradeDefaultInstruments } from './state/actions'
import { midi } from './audio/midi'
import { liveNoteOn, liveNoteOff } from './state/record'

const TOUR_STEPS = [
  {
    title: 'Welcome to the control room',
    body: 'Everything is here: the arrangement, the mixer, the racks, recording and voice control. Nothing needs installing, signing in or an API key.',
  },
  {
    title: 'Transport first',
    body: 'Space plays, R records, L loops. Drag the tempo number, then drag the gold loop strip in the ruler to set the loop region.',
  },
  {
    title: 'Drag anything',
    body: 'Drag sounds and loops from the Sound Library onto tracks, drag clips to move them, drag their edges to resize and loop.',
  },
  {
    title: 'Talk to the studio',
    body: 'Press VOICE and say “add reverb to the vocal” or “loop bars 5 to 9”. No microphone? Type the same commands in the Voice panel.',
  },
  {
    title: 'Create something new',
    body: 'Open Create, describe a track (“dark trap beat at 140 in E minor”), and the generator writes editable drums, bass, chords and melody.',
  },
  {
    title: 'Real sounds, optional packs',
    body: 'The Packs tab installs acoustic kits, boom bap / trap / R&B drums, guitars, pianos, sampled synths and FX. The Loops tab has 56 real loops tagged with tempo and key that warp to your project tempo.',
  },
  {
    title: 'Warp, comp and transcribe',
    body: 'Select an audio clip to warp it to the grid, draw a gain envelope, swipe takes into a comp or turn the audio into MIDI notes. Sidechain, groove and loudness meters live in the mixer.',
  },
  {
    title: 'Pro tools in the Pro menu',
    body: 'Mastering assistant, mix assistant, stem separation, sample editor, MIDI effects, Drum Rack, templates and storage all live in the Pro menu in the transport bar.',
  },
  {
    title: 'Find anything with ⌘K',
    body: 'Ctrl/Cmd+K searches every action, device, sound, loop and template. Arrow keys move, Enter runs, Esc closes.',
  },
  {
    title: 'Your work is saved every 30 seconds',
    body: 'Autosave writes to this browser. If the tab ever crashes, the next launch offers to restore the last session, and Storage & cleanup shows exactly what is using space.',
  },
  {
    title: 'Share and export',
    body: 'Share creates a read-only player link (mute/solo and mix or stem downloads). The project zip contains project.json, MIDI, the mix and every stem.',
  },
]

export default function App() {
  const { project } = useApp()
  const ui = useUi()
  const settings = useSettings()
  const [transcript, setTranscript] = useState('')
  const [lastAction, setLastAction] = useState('')
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [tour, setTour] = useState(0)
  const [starting, setStarting] = useState(false)
  const [packProgress, setPackProgress] = useState<{ done: number; total: number } | null>(null)
  const [audioRunning, setAudioRunning] = useState(false)
  const [shared, setShared] = useState<Project | null>(null)
  const [recovery, setRecovery] = useState<ReturnType<typeof pendingRecovery>>(null)

  const runText = useCallback(async (text: string) => {
    if (!text.trim()) return
    const parsed = parseCommand(text)
    if (!parsed) {
      setVoiceError(`I did not find an action in “${text}”. Try “help” for the command list.`)
      return
    }
    setVoiceError(null)
    try {
      const message = await executeCommand(parsed)
      setLastAction(`${parsed.label} — ${message}`)
      setUi((ui) => ({ commandHistory: [text, ...ui.commandHistory.filter((h) => h !== text)].slice(0, 40) }))
      toast(`${parsed.label} — ${message}`, 'voice', 2800)
    } catch (err) {
      console.warn('command failed', err)
      setVoiceError(err instanceof Error ? err.message : 'That command could not run.')
    }
  }, [])

  useEffect(() => {
    voice.attach({
      onTranscript: (text, final) => {
        if (!final) {
          setTranscript(text)
          return
        }
        const gate = voice.gateWakeWord(text)
        setTranscript(gate.text)
        if (gate.addressed) {
          void runText(gate.text)
          // Studio mode keeps the microphone open across commands.
          if (getState().ui.studioMode) {
            window.setTimeout(() => {
              if (getState().ui.studioMode && !voice.listening) voice.start()
            }, 900)
          }
        }
      },
      onListeningChange: (listening) => setUi({ voiceListening: listening }),
      onError: (message) => {
        setVoiceError(message)
      },
    })
    return () => voice.stop()
  }, [runText])

  useEffect(() => {
    voice.wakeWord = settings.wakeWord
  }, [settings.wakeWord])

  useEffect(() => {
    applyTheme(settings.theme)
  }, [settings.theme])

  useEffect(() => {
    restoreLayout()
    void readShareFromLocation().then((p) => {
      if (p) setShared(p)
    })
    setRecovery(pendingRecovery())
    markSessionOpen()
    startAutosaveLoop()
    const clean = () => {
      markSessionClean()
      if (getState().settings.autosave) void persistProject(getState().project, false)
    }
    window.addEventListener('beforeunload', clean)
    return () => window.removeEventListener('beforeunload', clean)
  }, [])

  useEffect(() => {
    engine.setMetronome(settings.metronome)
    engine.setMonitoring(settings.monitoring)
  }, [settings.metronome, settings.monitoring])

  useEffect(() => {
    engine.sync(getState().project)
    const unlock = () => {
      void engine.start().then(() => engine.sync(getState().project))
    }
    window.addEventListener('pointerdown', unlock, { once: true })
    const onBeforeUnload = () => {
      if (getState().settings.autosave) void persistProject(getState().project, false)
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [])

  const toggleVoice = useCallback(async () => {
    await engine.start()
    const started = voice.toggle()
    setUi({ voiceListening: started, rightPanel: 'voice' })
    if (!started && !voice.supported) {
      setVoiceError('Voice capture is unavailable in this browser. Type your command in the bar below — same parser, same fuzzy matching.')
    }
  }, [])

  useEffect(() => {
    return installHotkeys({
      openHelp: () => setUi({ modal: 'help' }),
      toggleVoice: () => void toggleVoice(),
    })
  }, [toggleVoice])

  const startStudio = async () => {
    setStarting(true)
    try {
      initSampleLoader()
      await engine.start()
      engine.sync(getState().project)
      setUi({ booted: true })
      const seen = localStorage.getItem('ils.tourDone')
      if (!seen) {
        setTour(1)
        localStorage.setItem('ils.tourDone', 'done')
      }
      // MIDI permission is requested alongside audio so keyboards are live.
      void midi.enable()
    } finally {
      setStarting(false)
    }
    // Catalogue + starter samples load in the background with a visible bar.
    void (async () => {
      try {
        await loadCatalog()
        await loadImportedPatches()
        if (pendingCoreBytes() > 0) {
          setPackProgress({ done: 0, total: pendingCoreBytes() })
          await autoInstallCore((_id, s) => setPackProgress({ done: s.bytes, total: Math.max(1, s.totalBytes) }))
          setPackProgress(null)
        }
        upgradeDefaultInstruments()
      } catch (err) {
        console.warn('[ILS] sample packs unavailable', err)
        setPackProgress(null)
      }
      try {
        const ir = await engine.restoreImpulseResponse()
        if (ir) console.info(`[ILS] reverb impulse restored: ${ir}`)
      } catch {
        /* generated IR stays in place */
      }
    })()
  }

  // Whenever an empty project appears, swap its default synths for the real
  // sampled instruments as soon as the catalogue is available.
  useEffect(() => {
    if (!ui.booted) return
    let alive = true
    void loadCatalog()
      .then(() => {
        if (alive) upgradeDefaultInstruments()
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [ui.booted, project.id, project.tracks.length])

  useEffect(() => {
    initSampleLoader()
    void loadCatalog()
      .then(() => refreshInstalled())
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    const un = midi.onNote((e) => {
      if (e.on) liveNoteOn(e.pitch, e.vel)
      else liveNoteOff(e.pitch)
    })
    return () => {
      un()
    }
  }, [])

  useEffect(() => {
    const tick = () => setAudioRunning(engine.ctx?.state === 'running')
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [ui.booted])

  const voiceState: VoicePanelState = {
    supported: voice.supported,
    listening: ui.voiceListening,
    transcript,
    lastAction,
    error: voiceError,
    onToggle: () => void toggleVoice(),
    onTyped: (text) => {
      setTranscript(text)
      void runText(text)
    },
    wakeWord: settings.wakeWord,
    onWakeWord: (v) => {
      setSettings({ wakeWord: v })
      voice.wakeWord = v
    },
    studioMode: ui.studioMode,
    onStudioMode: (v) => {
      setUi({ studioMode: v })
      if (v) {
        if (!ui.voiceListening) void toggleVoice()
      } else if (ui.voiceListening) {
        voice.stop()
        setUi({ voiceListening: false })
      }
    },
    history: ui.commandHistory,
    onReplay: (text) => {
      setTranscript(text)
      void runText(text)
    },
    customShortcuts: ui.customShortcuts,
    onAddShortcut: (phrase, intent) => {
      if (!phrase.trim() || !intent.trim()) return
      setUi((state) => ({
        customShortcuts: [
          ...state.customShortcuts.filter((c) => c.phrase.toLowerCase() !== phrase.toLowerCase()),
          { id: `sc_${Date.now().toString(36)}`, phrase: phrase.trim(), intent: intent.trim(), args: '' },
        ],
      }))
      toast(`Shortcut “${phrase}” saved`, 'ok')
    },
    onRemoveShortcut: (id) => setUi((state) => ({ customShortcuts: state.customShortcuts.filter((c) => c.id !== id) })),
  }

  if (shared) {
    return (
      <div className="shared-root">
        <ShareBoundary
          onExit={() => {
            clearShareHash()
            setShared(null)
          }}
        >
          <SharedPlayer
            project={shared}
            onExit={() => {
              clearShareHash()
              setShared(null)
            }}
          />
        </ShareBoundary>
      </div>
    )
  }

  if (!ui.booted) {
    return (
      <div className="start-gate">
        <div className="gate-bg" />
        <div className="gate-inner">
          <span className="badge">ILS · Infinite Lab Studio</span>
          <h1>Infinite Lab Studio</h1>
          <p className="gate-company">A Building Billions LLC Product</p>
          <p>
            A professional DAW that runs entirely in your browser. Real sampled grand piano, orchestra, guitars and drum
            machines alongside the synths — plus mixer, racks, recording, voice control and a procedural composer. No
            installs, no accounts, no API keys.
          </p>
          <button className="gold big" onClick={() => void startStudio()} disabled={starting}>
            {starting ? 'Starting audio engine…' : 'Start Studio'}
          </button>
          <p className="dim small">
            Browsers block audio until you interact with the page. This button unlocks the audio engine and microphone
            access is only requested when you record.
          </p>
          <p className="dim small gate-legal">© 2026 Building Billions LLC. All rights reserved.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <a className="skip-link" href="#workspace">
        Skip to the workspace
      </a>
      {ui.view === 'home' ? (
        <Home onStartVoice={() => void toggleVoice()} />
      ) : (
        <div className="studio">
          <Transport onVoiceToggle={() => void toggleVoice()} voiceListening={ui.voiceListening} />
          <div className="studio-body">
            <Library />
            <main className="workspace" id="workspace" tabIndex={-1}>
              {ui.view === 'seq' && <Sequencer />}
              {ui.view === 'mix' && <Mixer />}
              {ui.view === 'rack' && <Racks />}
            </main>
            <RightPanel voice={voiceState} />
          </div>
        </div>
      )}
      <Modals />
      <CommandPalette />
      <ContextMenu />
      <Toasts />
      {recovery && (
        <div className="recovery-banner" role="alert">
          <div>
            <strong>Recovered session available</strong>
            <p className="dim small">
              ILS closed unexpectedly. The autosave from {new Date(recovery.at).toLocaleTimeString()} can be restored.
            </p>
          </div>
          <div className="row gap">
            <button
              className="btn"
              onClick={() => {
                localStorage.removeItem('ils.sessionOpen')
                setRecovery(null)
              }}
            >
              Dismiss
            </button>
            <button
              className="btn gold"
              onClick={async () => {
                const { openProjectById } = await import('./state/store')
                const ok = await openProjectById(recovery.projectId)
                localStorage.removeItem('ils.sessionOpen')
                setRecovery(null)
                if (ok) toast('Session restored', 'ok')
                else toast('No saved copy found for that session', 'warn')
              }}
            >
              Restore autosave
            </button>
          </div>
        </div>
      )}
      {tour > 0 && (
        <div className="tour">
          <div className="tour-card">
            <span className="badge">Guided tour {tour}/{TOUR_STEPS.length}</span>
            <h2>{TOUR_STEPS[tour - 1].title}</h2>
            <p>{TOUR_STEPS[tour - 1].body}</p>
            <div className="row gap end">
              <button className="link" onClick={() => setTour(0)}>
                Skip tour
              </button>
              {tour > 1 && (
                <button className="btn" onClick={() => setTour(tour - 1)}>
                  Back
                </button>
              )}
              <button className="btn gold" onClick={() => setTour(tour >= TOUR_STEPS.length ? 0 : tour + 1)}>
                {tour >= TOUR_STEPS.length ? 'Finish' : 'Next'}
              </button>
            </div>
          </div>
        </div>
      )}
      {ui.booted && (
        <button
          className={`audio-status ${audioRunning ? 'on' : 'off'}`}
          title={audioRunning ? 'The audio engine is running — click for a test tone' : 'Audio is suspended — click to resume'}
          onClick={async () => {
            const ctx = await engine.start()
            setAudioRunning(ctx.state === 'running')
            if (ctx.state === 'running') engine.testTone()
          }}
        >
          <i />
          {audioRunning ? 'AUDIO' : 'RESUME AUDIO'}
        </button>
      )}
      {packProgress && (
        <div className="pack-boot" role="status">
          <span>Installing starter samples…</span>
          <div className="progress">
            <span style={{ width: `${Math.min(100, (packProgress.done / packProgress.total) * 100)}%` }} />
          </div>
          <span className="mono small">
            {Math.min(100, Math.round((packProgress.done / packProgress.total) * 100))}%
          </span>
        </div>
      )}
      {ui.voiceListening && <div className="listening-indicator" title="Voice control is listening">🎙 listening…</div>}
      <span className="sr-only">{project.name}</span>
    </div>
  )
}

class ShareBoundary extends Component<{ children: ReactNode; onExit: () => void }, { error: string | null }> {
  state = { error: null as string | null }

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : 'This share link could not be opened.' }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="share-error">
          <h1>This shared project could not open</h1>
          <p className="dim">{this.state.error}</p>
          <button className="btn gold" onClick={this.props.onExit}>
            Open the studio instead
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
