import { useEffect, useRef, useState } from 'react'
import { engine } from '../audio/engine'
import { phaseCorrelation } from '../audio/analysis'
import { useProject } from '../state/store'
import { setLufsTarget } from '../state/features'

/** Real-time master spectrum analyser. */
export function SpectrumAnalyzer({ height = 64 }: { height?: number }) {
  const canvas = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    let raf = 0
    const bins = new Uint8Array(1024)
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const el = canvas.current
      if (!el) return
      const ctx = el.getContext('2d')
      if (!ctx) return
      engine.spectrum(bins)
      const w = el.width
      const h = el.height
      ctx.clearRect(0, 0, w, h)
      ctx.fillStyle = 'rgba(255,255,255,0.04)'
      ctx.fillRect(0, 0, w, h)
      const bars = 64
      const step = Math.floor(bins.length / bars)
      for (let i = 0; i < bars; i++) {
        let v = 0
        for (let j = 0; j < step; j++) v = Math.max(v, bins[i * step + j])
        const bh = (v / 255) * h
        const hue = 190 - (i / bars) * 150
        ctx.fillStyle = `hsl(${hue} 80% 60%)`
        ctx.fillRect((i * w) / bars, h - bh, w / bars - 1, bh)
      }
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [])
  return <canvas ref={canvas} className="spectrum-canvas" width={320} height={height} />
}

/** Phase scope (goniometer) — mono content sits vertical, wide content spreads. */
export function PhaseScope({ size = 96 }: { size?: number }) {
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const [corr, setCorr] = useState(0)
  useEffect(() => {
    let raf = 0
    const l = new Float32Array(1024)
    const r = new Float32Array(1024)
    let last = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const el = canvas.current
      if (!el) return
      const ctx = el.getContext('2d')
      if (!ctx) return
      if (!engine.masterStereo(l, r)) return
      const w = el.width
      const h = el.height
      ctx.fillStyle = 'rgba(10,14,20,0.35)'
      ctx.fillRect(0, 0, w, h)
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'
      ctx.beginPath()
      ctx.arc(w / 2, h / 2, w / 2 - 2, 0, Math.PI * 2)
      ctx.stroke()
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'
      ctx.beginPath()
      ctx.moveTo(w / 2, 4)
      ctx.lineTo(w / 2, h - 4)
      ctx.stroke()
      ctx.fillStyle = 'rgba(120, 220, 255, 0.75)'
      const step = Math.max(1, Math.floor(l.length / 380))
      for (let i = 0; i < l.length; i += step) {
        const mid = (l[i] + r[i]) * 0.5
        const side = (l[i] - r[i]) * 0.5
        const x = w / 2 + side * (w / 2 - 6)
        const y = h / 2 - mid * (h / 2 - 6)
        ctx.fillRect(x, y, 1.5, 1.5)
      }
      const now = performance.now()
      if (now - last > 220) {
        last = now
        setCorr(phaseCorrelation(l, r))
      }
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <div className="phase-wrap">
      <canvas ref={canvas} width={size} height={size} className="phase-canvas" />
      <span className="dim small mono">corr {corr.toFixed(2)}</span>
    </div>
  )
}

/** Master loudness against the project's target. */
export function LoudnessMeter() {
  const project = useProject()
  const [lufs, setLufs] = useState(-Infinity)
  const [peak, setPeak] = useState(0)
  const target = project.masterChain?.target ?? -14
  useEffect(() => {
    const id = window.setInterval(() => {
      setLufs(engine.masterLufs())
      setPeak(engine.masterMeter().peak)
    }, 180)
    return () => window.clearInterval(id)
  }, [])
  const ok = Number.isFinite(lufs) ? Math.abs(lufs - target) < 1.5 : false
  const pct = Number.isFinite(lufs) ? Math.max(0, Math.min(1, (lufs + 30) / 30)) : 0
  return (
    <div className="loudness-meter" title="Short-term master loudness (K-weighted)">
      <div className="loudness-row">
        <span className="mono">{Number.isFinite(lufs) ? lufs.toFixed(1) : '−∞'} LUFS</span>
        <select
          className="text-input small"
          value={target}
          onChange={(e) => setLufsTarget(Number(e.target.value))}
          title="Loudness target for this project"
        >
          {[-9, -11, -14, -16, -20, -23].map((t) => (
            <option key={t} value={t}>
              target {t} LUFS
            </option>
          ))}
        </select>
        <span className={`chip tiny ${ok ? 'on' : ''}`}>{ok ? 'on target' : 'off target'}</span>
        <span className="dim small mono">peak {(20 * Math.log10(Math.max(0.00001, peak))).toFixed(1)} dB</span>
      </div>
      <div className="loudness-bar">
        <div className="loudness-fill" style={{ width: `${pct * 100}%` }} />
        <div className="loudness-target" style={{ left: `${Math.max(0, Math.min(100, ((target + 30) / 30) * 100))}%` }} />
      </div>
    </div>
  )
}

export function MixerMeters() {
  return (
    <div className="mixer-meters">
      <SpectrumAnalyzer />
      <PhaseScope />
      <LoudnessMeter />
    </div>
  )
}
