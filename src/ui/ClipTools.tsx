import { useEffect, useMemo, useRef, useState } from 'react'
import type { Clip, Track, WarpMode } from '../state/types'
import { useProject, useUi, setUi } from '../state/store'
import { GROOVES } from '../data/presets'
import {
  addEnvelopePoint,
  addWarpMarker,
  applyGrooveToClip,
  autoComp,
  autoEnvelope,
  clearComp,
  clearEnvelope,
  clearWarpMarkers,
  clipToMidi,
  consolidateClip,
  detectClipTempo,
  setCompRegion,
  setWarp,
  toggleWarp,
  warpClipToTempo,
} from '../state/features'

const MODES: { id: WarpMode; label: string; hint: string }[] = [
  { id: 'beats', label: 'Beats', hint: 'Short frames — keeps drum transients sharp' },
  { id: 'complex', label: 'Complex', hint: 'Balanced — good for full mixes' },
  { id: 'tones', label: 'Tones', hint: 'Long frames — smooth for vocals and bass' },
  { id: 'texture', label: 'Texture', hint: 'Very long frames — pads and ambience' },
]

export function ClipTools({ clip, track }: { clip: Clip; track: Track }) {
  const project = useProject()
  const ui = useUi()
  const warp = clip.warp
  const [busy, setBusy] = useState('')
  const env = useMemo(() => [...(clip.envelope ?? [])].sort((a, b) => a.beat - b.beat), [clip.envelope])
  const svgRef = useRef<SVGSVGElement | null>(null)
  const playhead = clip.start <= ui.positionBeat ? Math.min(clip.len, ui.positionBeat - clip.start) : 0

  const ratio = warp?.sourceBpm ? Math.round((project.bpm / warp.sourceBpm) * 1000) / 1000 : 1

  return (
    <div className="clip-tools">
      <div className="clip-tools-head">
        <strong>{clip.name}</strong>
        <span className="dim small mono">
          {clip.kind === 'audio' ? 'audio' : 'MIDI'} · {clip.len.toFixed(0)} beats · gain {clip.gain.toFixed(2)}
        </span>
        <div className="spacer" />
        <button className="chip" onClick={() => setUi({ modal: 'takes' })}>
          Takes
        </button>
        {clip.kind === 'midi' && (
          <button className="chip" onClick={() => setUi({ modal: 'midifx' })} title="Arpeggiator, chords, scale quantize, humanize">
            MIDI FX
          </button>
        )}
        {clip.kind === 'audio' && (
          <button className="chip" onClick={() => setUi({ modal: 'sample' })} title="Sample editor: trim, slice, pads">
            Sample editor
          </button>
        )}
        {track.kind === 'drum' && (
          <button className="chip" onClick={() => setUi({ modal: 'drumrack' })}>
            Drum Rack
          </button>
        )}
        <button className="chip" onClick={() => void consolidateClip(clip.id)}>
          Consolidate
        </button>
      </div>

      {clip.kind === 'audio' && (
        <div className="tool-block">
          <div className="tool-row">
            <span className="tool-label">Warp</span>
            <button className={`chip ${warp?.enabled ? 'on' : ''}`} onClick={() => toggleWarp(clip.id)}>
              {warp?.enabled ? 'On' : 'Off'}
            </button>
            <select
              className="text-input small"
              value={warp?.mode ?? 'complex'}
              onChange={(e) => setWarp(clip.id, { mode: e.target.value as WarpMode })}
              title={MODES.find((m) => m.id === (warp?.mode ?? 'complex'))?.hint}
            >
              {MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <label className="inline-field">
              Source BPM
              <input
                className="text-input tiny"
                type="number"
                min={30}
                max={300}
                value={warp?.sourceBpm ? Math.round(warp.sourceBpm * 10) / 10 : ''}
                placeholder="—"
                onChange={(e) => setWarp(clip.id, { sourceBpm: Number(e.target.value) || undefined })}
              />
            </label>
            <button className="chip" onClick={() => detectClipTempo(clip.id)}>
              Detect
            </button>
            <button className="chip gold" onClick={() => warpClipToTempo(clip.id)}>
              Warp to {project.bpm} BPM
            </button>
            <span className="dim small mono">
              {warp?.enabled ? `×${ratio} · ${warp.markers.length} markers` : 'time-stretch off'}
            </span>
          </div>
          <div className="tool-row">
            <button className="chip" onClick={() => addWarpMarker(clip.id, Math.max(0, playhead))}>
              + Marker at playhead
            </button>
            <button className="chip" onClick={() => clearWarpMarkers(clip.id)}>
              Clear markers
            </button>
            {warp?.markers.map((m) => (
              <span key={`${m.beat}-${m.sec}`} className="chip marker-chip mono">
                {m.beat.toFixed(1)}b → {m.sec.toFixed(2)}s
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="tool-block">
        <div className="tool-row">
          <span className="tool-label">Envelope</span>
          {(['fade', 'pump', 'swell'] as const).map((s) => (
            <button key={s} className="chip" onClick={() => autoEnvelope(clip.id, s)}>
              {s}
            </button>
          ))}
          <button className="chip" onClick={() => clearEnvelope(clip.id)}>
            clear
          </button>
          <span className="dim small">{env.length} points</span>
        </div>
        <svg
          ref={svgRef}
          className="env-canvas"
          viewBox={`0 0 ${Math.max(1, clip.len) * 20} 100`}
          preserveAspectRatio="none"
          onClick={(e) => {
            const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
            const t = (e.clientX - rect.left) / rect.width
            const v = 1 - (e.clientY - rect.top) / rect.height
            addEnvelopePoint(clip.id, Math.max(0, Math.min(clip.len, t * clip.len)), Math.round(v * 100) / 100)
          }}
        >
          <line x1={0} y1={50} x2={Math.max(1, clip.len) * 20} y2={50} className="env-mid" />
          {env.length > 1 && (
            <polyline
              points={env.map((p) => `${(p.beat / Math.max(0.01, clip.len)) * clip.len * 20},${100 - p.value * 90}`).join(' ')}
              fill="none"
              stroke={track.color}
              strokeWidth="2"
            />
          )}
          {env.map((p) => (
            <circle
              key={p.id}
              cx={(p.beat / Math.max(0.01, clip.len)) * clip.len * 20}
              cy={100 - p.value * 90}
              r={5}
              fill={track.color}
            />
          ))}
          <line
            x1={(playhead / Math.max(0.01, clip.len)) * clip.len * 20}
            y1={0}
            x2={(playhead / Math.max(0.01, clip.len)) * clip.len * 20}
            y2={100}
            className="env-playhead"
          />
        </svg>
        <span className="dim small">Click the envelope to add or drag points · double-click “clear” to start again</span>
      </div>

      <div className="tool-block">
        <div className="tool-row">
          <span className="tool-label">Groove</span>
          <select
            className="text-input small"
            value={clip.groove?.preset ?? project.groove?.preset ?? 'straight'}
            onChange={(e) => applyGrooveToClip(clip.id, e.target.value)}
          >
            {GROOVES.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={clip.groove?.amount ?? 1}
            onChange={(e) => applyGrooveToClip(clip.id, clip.groove?.preset ?? 'straight', Number(e.target.value))}
            title="Groove amount"
          />
          <span className="dim small mono">{(clip.groove?.amount ?? project.groove?.amount ?? 1).toFixed(2)}</span>
        </div>
      </div>

      {clip.kind === 'audio' && (
        <div className="tool-block">
          <div className="tool-row">
            <span className="tool-label">Comping</span>
            <button className="chip" onClick={() => autoComp(clip.id)}>
              Auto comp ({clip.takes?.length ?? 0} takes)
            </button>
            <button className="chip" onClick={() => clearComp(clip.id)}>
              Clear comp
            </button>
            <span className="dim small">{clip.comp?.length ?? 0} regions</span>
          </div>
          {(clip.takes?.length ?? 0) > 1 && (
            <div className="comp-lanes">
              {clip.takes!.map((take, i) => (
                <div key={take.id} className="comp-lane">
                  <span className="comp-lane-name mono">Take {i + 1}</span>
                  <div className="comp-lane-track">
                    {Array.from({ length: Math.max(1, Math.ceil(clip.len / 4)) }, (_, bar) => {
                      const start = bar * 4
                      const end = Math.min(clip.len, start + 4)
                      const active = (clip.comp ?? []).some((r) => r.take === i && Math.abs(r.start - start) < 0.01)
                      return (
                        <button
                          key={bar}
                          className={`comp-cell ${active ? 'on' : ''}`}
                          title={`Use take ${i + 1} for bar ${bar + 1}`}
                          onClick={() => setCompRegion(clip.id, start, end, i)}
                        />
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="tool-block">
        <div className="tool-row">
          <span className="tool-label">Audio → MIDI</span>
          {(['melody', 'harmony', 'drums'] as const).map((kind) => (
            <button
              key={kind}
              className="chip"
              disabled={busy !== ''}
              onClick={async () => {
                setBusy(kind)
                try {
                  await clipToMidi(clip.id, kind)
                } finally {
                  setBusy('')
                }
              }}
            >
              {busy === kind ? 'Transcribing…' : kind}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

