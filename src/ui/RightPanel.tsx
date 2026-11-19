import { useState } from 'react'
import { commit, getState, setUi, useProject, useUi } from '../state/store'
import { generateFromText } from '../state/actions'
import { applySong, addLyricMelody, composeSong, makeVariation, moodPalette, regenerateClip, shiftMood } from '../music/songwriter'
import { PROGRESSIONS, progressionChords } from '../data/chords'
import { addClip, findClip, findTrack, setKey } from '../state/actions'
import { makeClip, uid, SCALES, KEY_ROOT_NAMES } from '../state/types'
import { VOICE_HELP } from '../voice/commands'
import { speechSupported } from '../voice/speech'
import { engine } from '../audio/engine'
import { toast } from '../state/store'

export interface VoicePanelState {
  supported: boolean
  listening: boolean
  transcript: string
  lastAction: string
  error: string | null
  onToggle: () => void
  onTyped: (text: string) => void
  wakeWord: boolean
  onWakeWord: (v: boolean) => void
  studioMode: boolean
  onStudioMode: (v: boolean) => void
  history: string[]
  onReplay: (text: string) => void
  customShortcuts: { id: string; phrase: string; intent: string }[]
  onAddShortcut: (phrase: string, intent: string) => void
  onRemoveShortcut: (id: string) => void
}

function VoicePanel({ voice }: { voice: VoicePanelState }) {
  const [text, setText] = useState('')
  const [phrase, setPhrase] = useState('')
  const [intent, setIntent] = useState('')
  const submit = () => {
    if (!text.trim()) return
    voice.onTyped(text)
    setText('')
  }
  return (
    <div className="rp-panel voice-panel">
      <div className="voice-head">
        <button className={`big-mic ${voice.listening ? 'listening' : ''}`} onClick={voice.onToggle} title="Start or stop voice control">
          <span className="mic-ring" />
          <span className="mic-core">🎙</span>
        </button>
        <div>
          <h3>{voice.listening ? 'Listening…' : 'Voice control'}</h3>
          <p className="dim small">
            {voice.supported
              ? voice.listening
                ? 'Say a command, for example “add reverb to the vocal”.'
                : 'Press the mic and speak. Works hands-free once started.'
              : 'Speech recognition is unavailable here (Firefox/Safari). The typed bar below uses the exact same parser.'}
          </p>
        </div>
      </div>
      <div className="row gap wrap">
        <label className="row gap small dim">
          <input type="checkbox" checked={voice.wakeWord} onChange={(e) => voice.onWakeWord(e.target.checked)} />
          Wake word “Hey ILS”
        </label>
        <label className="row gap small dim" title="Keep the microphone open for multi-command sessions">
          <input type="checkbox" checked={voice.studioMode} onChange={(e) => voice.onStudioMode(e.target.checked)} />
          Studio mode (hands-free)
        </label>
      </div>
      {voice.error && <div className="callout warn">{voice.error}</div>}
      <div className="transcript">
        <span className="section-label">Live transcript</span>
        <p>{voice.transcript || '—'}</p>
        {voice.lastAction && <div className="last-action">✓ {voice.lastAction}</div>}
      </div>
      <form
        className="command-bar"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <input
          className="text-input"
          placeholder='Type a command: "mute track 3"'
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button className="btn accent" type="submit">
          Run
        </button>
      </form>
      {voice.history.length > 0 && (
        <div className="section-block voice-history">
          <span className="section-label">Recent commands</span>
          {voice.history.slice(0, 5).map((h) => (
            <button key={h} className="help-phrase" onClick={() => voice.onReplay(h)} title="Run again">
              ↺ “{h}”
            </button>
          ))}
        </div>
      )}
      <div className="section-block">
        <span className="section-label">My voice shortcuts</span>
        {voice.customShortcuts.map((c) => (
          <div key={c.id} className="help-row">
            <code>“{c.phrase}”</code>
            <span className="dim small">→ {c.intent}</span>
            <button className="icon-btn" title="Remove" onClick={() => voice.onRemoveShortcut(c.id)}>
              ✕
            </button>
          </div>
        ))}
        <div className="row gap">
          <input className="text-input tiny" placeholder="When I say…" value={phrase} onChange={(e) => setPhrase(e.target.value)} />
          <input
            className="text-input tiny"
            placeholder="run this command"
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
          />
          <button
            className="chip"
            onClick={() => {
              voice.onAddShortcut(phrase, intent)
              setPhrase('')
              setIntent('')
            }}
          >
            Save
          </button>
        </div>
      </div>
      <div className="help-list compact">
        {VOICE_HELP.slice(0, 8).map((h) => (
          <div key={h.phrase} className="help-row">
            <button className="help-phrase" onClick={() => voice.onTyped(h.phrase)} title={`Try: ${h.phrase}`}>
              “{h.phrase}”
            </button>
            <span className="dim small">{h.note}</span>
          </div>
        ))}
        <button className="link" onClick={() => setUi({ modal: 'help' })}>
          All {VOICE_HELP.length} commands and shortcuts →
        </button>
      </div>
    </div>
  )
}

function CreatePanel() {
  const project = useProject()
  const ui = useUi()
  const [prompt, setPrompt] = useState('dark trap beat at 140 BPM in E minor with a moody melody')
  const [replace, setReplace] = useState(true)
  const [bars, setBars] = useState(48)
  const [genre, setGenre] = useState('trap')
  const [mood, setMood] = useState('dark')
  const [lyric, setLyric] = useState(project.lyrics[0]?.text ?? '')
  const [idea, setIdea] = useState<ReturnType<typeof composeSong> | null>(null)
  const selected = ui.selectedClipIds[0] ? findClip(project, ui.selectedClipIds[0]) : null
  const { keyRoot, keyScale } = project

  const make = () => {
    const song = composeSong({ prompt, genre, mood, bars, keyRoot, scale: keyScale, replace })
    setIdea(song)
    applySong(song, replace)
  }

  const insertProgression = (presetId: string) => {
    const track = findTrack(project, ui.selectedTrackId) ?? project.tracks[0]
    const preset = PROGRESSIONS.find((p) => p.id === presetId)
    if (!track || !preset) return
    const rootPc = Math.max(0, ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'].indexOf(keyRoot))
    const scale = SCALES[keyScale] ?? SCALES.Minor
    const chords = progressionChords(rootPc, scale, preset)
    const notes = chords.flatMap((c, bar) =>
      c.pitches.map((pitch, i) => ({ id: uid('nt'), pitch, start: bar * 4 + i * 0.02, len: 3.8, vel: 0.7 })),
    )
    addClip(
      track.id,
      makeClip({ name: `${preset.name}`, start: Math.round(engine.getBeat() * 4) / 4, len: chords.length * 4, contentLen: chords.length * 4, kind: 'midi', notes }),
    )
    toast(`${preset.name} inserted`, 'ok')
  }

  return (
    <div className="rp-panel create-panel">
      <h3>Create</h3>
      <p className="dim small">
        Full song structures with real sampled instruments: intro, verse, pre-chorus, chorus, bridge and outro. Everything
        is procedural and local — no cloud model, no key.
      </p>
      <textarea className="text-area" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} aria-label="Song description" />
      <div className="chip-row">
        {['dark trap 140', 'lofi hip hop 78', 'dream pop 96', 'house 126', 'rnb 88', 'rock 118', 'cinematic 96', 'drill 142'].map((c) => (
          <button key={c} className="chip" onClick={() => setPrompt(`${c} in ${keyRoot} ${keyScale}`)}>
            {c}
          </button>
        ))}
      </div>
      <div className="grid-2">
        <label className="inline-field">
          Genre
          <select value={genre} onChange={(e) => setGenre(e.target.value)}>
            {['trap', 'drill', 'hiphop', 'lo-fi', 'rnb', 'pop', 'rock', 'edm', 'house', 'cinematic', 'ambient', 'jazz'].map((g) => (
              <option key={g} value={g}>{g}</option>
            ))}
          </select>
        </label>
        <label className="inline-field">
          Mood
          <select value={mood} onChange={(e) => setMood(e.target.value)}>
            {moodPalette().map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </label>
        <label className="inline-field">
          Key
          <select value={keyRoot} onChange={(e) => setKey(e.target.value)}>
            {KEY_ROOT_NAMES.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </label>
        <label className="inline-field">
          Scale
          <select value={keyScale} onChange={(e) => setKey(keyRoot, e.target.value)}>
            {Object.keys(SCALES).map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="inline-field">
          Bars
          <input className="text-input tiny" type="number" min={8} max={128} value={bars} onChange={(e) => setBars(Number(e.target.value))} />
        </label>
        <label className="row gap small dim">
          <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
          Replace arrangement
        </label>
      </div>
      <button className="btn gold wide" onClick={make} title="Generate a full arrangement">
        ✦ Generate song
      </button>
      {idea && (
        <div className="section-block">
          <span className="section-label">Structure — {idea.title}</span>
          <div className="chip-row">
            {idea.sections.map((sec) => (
              <span key={`${sec.name}-${sec.startBar}`} className="chip tiny" title={`Bars ${sec.startBar + 1}–${sec.startBar + sec.bars}`}>
                {sec.name} · {sec.bars}b
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="section-block">
        <span className="section-label">Section tools</span>
        <div className="chip-row">
          <button className="chip" disabled={!selected} onClick={() => selected && regenerateClip(selected.clip.id)}>
            Regenerate selected section
          </button>
          <button className="chip" disabled={!selected} onClick={() => selected && shiftMood(selected.clip.id, 'darker')}>
            Darker
          </button>
          <button className="chip" disabled={!selected} onClick={() => selected && shiftMood(selected.clip.id, 'brighter')}>
            Brighter
          </button>
          <button className="chip" disabled={!selected} onClick={() => selected && makeVariation(selected.clip.id)}>
            Variation
          </button>
        </div>
      </div>
      <div className="section-block">
        <span className="section-label">Chord library</span>
        <div className="chip-row">
          {PROGRESSIONS.slice(0, 6).map((p) => (
            <button key={p.id} className="chip chord" onClick={() => insertProgression(p.id)} title={p.mood.join(', ')}>
              {p.name}
            </button>
          ))}
        </div>
      </div>
      <div className="section-block">
        <span className="section-label">Lyrics → melody</span>
        <div className="row gap">
          <input className="text-input" value={lyric} onChange={(e) => setLyric(e.target.value)} placeholder="A lyric line" />
          <button className="btn" onClick={() => addLyricMelody(lyric)}>
            Write
          </button>
        </div>
      </div>
      <div className="section-block">
        <span className="section-label">Lyrics notepad</span>
        <div className="lyrics">
          {project.lyrics.map((l) => (
            <div key={l.id} className="lyric-row">
              <input
                className="lyric-note"
                value={l.note}
                onChange={(e) =>
                  commit('Lyric note', (p) => {
                    const line = p.lyrics.find((x) => x.id === l.id)
                    if (line) line.note = e.target.value
                  })
                }
              />
              <input
                className="lyric-text"
                value={l.text}
                onChange={(e) =>
                  commit('Lyric', (p) => {
                    const line = p.lyrics.find((x) => x.id === l.id)
                    if (line) line.text = e.target.value
                  })
                }
              />
              <button
                className="icon-btn"
                title="Remove line"
                onClick={() =>
                  commit('Remove lyric', (p) => {
                    p.lyrics = p.lyrics.filter((x) => x.id !== l.id)
                  })
                }
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <form
          className="row gap"
          onSubmit={(e) => {
            e.preventDefault()
            if (!lyric.trim()) return
            commit('Add lyric', (p) => {
              p.lyrics.push({ id: uid('ly'), text: lyric, note: 'Note' })
            })
            setLyric('')
          }}
        >
          <input className="text-input" placeholder="Add a line…" value={lyric} onChange={(e) => setLyric(e.target.value)} />
          <button className="btn" type="submit">Add</button>
        </form>
      </div>
    </div>
  )
}

function engineBeat(): number {
  return getState().ui.positionBeat || 0
}

function HelpPanel() {
  const ui = useUi()
  return (
    <div className="rp-panel help-panel">
      <h3>Command help</h3>
      <p className="dim small">Speak or type any of these. Fuzzy matching tolerates small mistakes.</p>
      <div className="help-list">
        {VOICE_HELP.map((h) => (
          <div key={h.phrase} className="help-row">
            <code>{h.phrase}</code>
            <span className="dim small">{h.note}</span>
          </div>
        ))}
      </div>
      <div className="section-block">
        <span className="section-label">Shortcuts</span>
        <div className="help-row"><code>Space</code><span className="dim small">Play / pause</span></div>
        <div className="help-row"><code>R</code><span className="dim small">Record</span></div>
        <div className="help-row"><code>L / M</code><span className="dim small">Loop / metronome</span></div>
        <div className="help-row"><code>1 2 3 4</code><span className="dim small">Sequencer, Mixer, Racks, Room</span></div>
        <div className="help-row"><code>Ctrl+Z / Ctrl+Shift+Z</code><span className="dim small">Undo / redo</span></div>
        <div className="help-row"><code>Ctrl+D</code><span className="dim small">Duplicate clip</span></div>
        <div className="help-row"><code>Q</code><span className="dim small">Quantize clip</span></div>
        <div className="help-row"><code>S</code><span className="dim small">Split at playhead</span></div>
        <div className="help-row"><code>V</code><span className="dim small">Voice panel</span></div>
        <div className="help-row"><code>?</code><span className="dim small">This help</span></div>
      </div>
      <button className="link" onClick={() => setUi({ modal: 'shortcuts' })}>
        Open full shortcut list
      </button>
      {!speechSupported() && <div className="callout">Web Speech is not available in this browser — the typed bar works identically.</div>}
      {ui.rightPanel === 'help' ? null : null}
    </div>
  )
}

export default function RightPanel({ voice }: { voice: VoicePanelState }) {
  const ui = useUi()
  if (ui.rightPanel === 'none') return null
  return (
    <aside className="right-panel" style={{ width: ui.rightWidth }}>
      <div
        className="panel-resizer"
        title="Drag to resize"
        role="separator"
        aria-orientation="vertical"
        onPointerDown={(e) => {
          const startX = e.clientX
          const startW = ui.rightWidth
          const move = (ev: PointerEvent) => {
            const next = Math.max(280, Math.min(620, startW + (startX - ev.clientX)))
            setUi({ rightWidth: next })
          }
          const up = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
            import('../state/store').then((m) => m.saveLayout())
          }
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', up)
        }}
      />
      <div className="rp-tabs">
        <button className={ui.rightPanel === 'voice' ? 'active' : ''} onClick={() => setUi({ rightPanel: 'voice' })}>
          Voice
        </button>
        <button className={ui.rightPanel === 'create' ? 'active' : ''} onClick={() => setUi({ rightPanel: 'create' })}>
          Create
        </button>
        <button className={ui.rightPanel === 'help' ? 'active' : ''} onClick={() => setUi({ rightPanel: 'help' })}>
          Help
        </button>
        <button className="icon-btn" title="Close panel" onClick={() => setUi({ rightPanel: 'none' })}>
          ✕
        </button>
      </div>
      {ui.rightPanel === 'voice' && <VoicePanel voice={voice} />}
      {ui.rightPanel === 'create' && <CreatePanel />}
      {ui.rightPanel === 'help' && <HelpPanel />}
    </aside>
  )
}
