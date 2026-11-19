import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { engine } from '../audio/engine'
import { getState, setUi, useUi } from '../state/store'
import { clamp } from '../state/types'

export function Tip({ text, children, className = '' }: { text: string; children: ReactNode; className?: string }) {
  const tooltips = getState().settings.tooltips
  return (
    <span className={`tip ${className}`} data-tip={tooltips ? text : undefined}>
      {children}
    </span>
  )
}

export function Knob({
  value,
  min,
  max,
  def,
  onChange,
  onStart,
  label,
  unit = '',
  size = 40,
  format,
}: {
  value: number
  min: number
  max: number
  def?: number
  onChange: (v: number) => void
  onStart?: () => void
  label?: string
  unit?: string
  size?: number
  format?: (v: number) => string
}) {
  const dragging = useRef<{ y: number; value: number } | null>(null)
  const norm = (value - min) / (max - min || 1)
  const angle = -135 + clamp(norm, 0, 1) * 270
  const display = format ? format(value) : `${Math.round(value * 100) / 100}${unit}`

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    dragging.current = { y: e.clientY, value }
    onStart?.()
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return
    const dy = dragging.current.y - e.clientY
    const speed = e.shiftKey ? 0.0015 : 0.006
    const next = dragging.current.value + dy * (max - min) * speed
    onChange(clamp(next, min, max))
  }
  const onPointerUp = () => {
    dragging.current = null
  }
  const r = size / 2
  const startAngle = (-135 * Math.PI) / 180
  const endAngle = (135 * Math.PI) / 180
  const a = (angle * Math.PI) / 180
  const arc = (from: number, to: number) => {
    const x1 = r + Math.cos(from - Math.PI / 2) * (r - 4)
    const y1 = r + Math.sin(from - Math.PI / 2) * (r - 4)
    const x2 = r + Math.cos(to - Math.PI / 2) * (r - 4)
    const y2 = r + Math.sin(to - Math.PI / 2) * (r - 4)
    const large = Math.abs(to - from) > Math.PI ? 1 : 0
    return `M ${x1} ${y1} A ${r - 4} ${r - 4} 0 ${large} 1 ${x2} ${y2}`
  }
  return (
    <div className="knob-wrap" title={label ? `${label}: ${display}` : display}>
      <svg
        width={size}
        height={size}
        className="knob"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => def != null && onChange(def)}
      >
        <path d={arc(startAngle, endAngle)} className="knob-track" fill="none" />
        <path d={arc(startAngle, a)} className="knob-fill" fill="none" />
        <circle cx={r} cy={r} r={r - 8} className="knob-cap" />
        <line
          x1={r}
          y1={r}
          x2={r + Math.cos(a - Math.PI / 2) * (r - 9)}
          y2={r + Math.sin(a - Math.PI / 2) * (r - 9)}
          className="knob-pointer"
        />
      </svg>
      {label && <span className="knob-label">{label}</span>}
      <span className="knob-value">{display}</span>
    </div>
  )
}

export function Fader({
  value,
  min = 0,
  max = 1.5,
  onChange,
  onStart,
  height = 150,
  label,
}: {
  value: number
  min?: number
  max?: number
  onChange: (v: number) => void
  onStart?: () => void
  height?: number
  label?: string
}) {
  const dragging = useRef<{ y: number; value: number } | null>(null)
  const norm = clamp((value - min) / (max - min || 1), 0, 1)
  const db = value <= 0.0001 ? '-∞' : `${(20 * Math.log10(value)).toFixed(1)}`
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    dragging.current = { y: e.clientY, value }
    onStart?.()
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return
    const dy = dragging.current.y - e.clientY
    onChange(clamp(dragging.current.value + (dy / height) * (max - min) * (e.shiftKey ? 0.25 : 1), min, max))
  }
  return (
    <div className="fader-wrap" title={label ? `${label} ${db} dB` : `${db} dB`}>
      <div
        className="fader"
        style={{ height }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => (dragging.current = null)}
        onPointerCancel={() => (dragging.current = null)}
        onDoubleClick={() => onChange(0.8)}
      >
        <div className="fader-track" />
        <div className="fader-fill" style={{ height: `${norm * 100}%` }} />
        <div className="fader-thumb" style={{ bottom: `calc(${norm * 100}% - 7px)` }} />
      </div>
      <span className="fader-db">{db}</span>
    </div>
  )
}

export function Meter({ read, height = 120, width = 10 }: { read: () => { peak: number; rms: number }; height?: number; width?: number }) {
  const [level, setLevel] = useState({ peak: 0, rms: 0 })
  useEffect(() => {
    let raf = 0
    let hold = 0
    let holdV = 0
    const tick = () => {
      const v = read()
      if (v.peak > holdV) {
        holdV = v.peak
        hold = 18
      } else if (hold > 0) hold--
      else holdV = Math.max(v.peak, holdV * 0.94)
      setLevel({ peak: holdV, rms: v.rms })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const toPct = (v: number) => `${Math.min(100, Math.max(0, (20 * Math.log10(Math.max(0.00001, v)) + 60) / 60 * 100))}%`
  return (
    <div className="meter" style={{ height, width }} title={`Peak ${(level.peak * 100).toFixed(0)}%`}>
      <div className="meter-rms" style={{ height: toPct(level.rms) }} />
      <div className="meter-peak" style={{ bottom: toPct(level.peak) }} />
    </div>
  )
}

export function MasterMeter({ horizontal = false }: { horizontal?: boolean }) {
  const [level, setLevel] = useState(0)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const m = engine.masterMeter()
      setLevel((prev) => Math.max(m.peak, prev * 0.9))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <div className={`master-meter ${horizontal ? 'horizontal' : ''}`} title="Master output level">
      <div className="mm-fill" style={{ width: horizontal ? `${Math.min(100, level * 100)}%` : undefined, height: horizontal ? undefined : `${Math.min(100, level * 100)}%` }} />
    </div>
  )
}

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            ✕
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}

export function Toasts() {
  const ui = useUi()
  return (
    <div className="toasts">
      {ui.toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === 'voice' ? '🎙 ' : ''}
          {t.text}
        </div>
      ))}
    </div>
  )
}

export function ContextMenu() {
  const ui = useUi()
  useEffect(() => {
    if (!ui.contextMenu) return
    const close = () => setUi({ contextMenu: null })
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', close)
    }
  }, [ui.contextMenu])
  if (!ui.contextMenu) return null
  const { x, y, items } = ui.contextMenu
  return (
    <div className="context-menu" style={{ left: x, top: y }} onPointerDown={(e) => e.stopPropagation()}>
      {items.map((item, i) => (
        <button
          key={i}
          className={item.danger ? 'danger' : ''}
          onClick={() => {
            item.action()
            setUi({ contextMenu: null })
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

export function Toggle({
  on,
  onChange,
  label,
  hint,
}: {
  on: boolean
  onChange: (v: boolean) => void
  label: string
  hint?: string
}) {
  return (
    <button className={`toggle ${on ? 'on' : ''}`} onClick={() => onChange(!on)} title={hint ?? label}>
      <span className="dot" />
      {label}
    </button>
  )
}

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  title,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  title?: string
}) {
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value as T)} title={title}>
      {options.map((o) => (
        <option key={String(o.value)} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function useAnimationFrame(cb: () => void, active = true): void {
  const saved = useRef(cb)
  saved.current = cb
  useEffect(() => {
    if (!active) return
    let raf = 0
    const tick = () => {
      saved.current()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [active])
}

export function CanvasScope({ height = 120 }: { height?: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const data = new Uint8Array(1024)
    let raf = 0
    const draw = () => {
      const dpr = window.devicePixelRatio || 1
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (canvas.width !== w * dpr) {
        canvas.width = w * dpr
        canvas.height = h * dpr
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      engine.spectrum(data)
      const bars = 96
      const step = Math.floor(data.length / bars)
      for (let i = 0; i < bars; i++) {
        let sum = 0
        for (let j = 0; j < step; j++) sum += data[i * step + j]
        const v = sum / step / 255
        const bh = Math.pow(v, 1.4) * h
        const hue = 178 + (i / bars) * 30
        ctx.fillStyle = `hsla(${hue}, 80%, ${48 + v * 24}%, 0.85)`
        ctx.fillRect((i / bars) * w + 1, h - bh, w / bars - 2, bh)
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])
  return <canvas ref={ref} className="scope" style={{ height }} />
}

export function EqGraph({ params, height = 110 }: { params: Record<string, number>; height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const pts = useCallback(() => {
    const out: string[] = []
    const sr = 48000
    const nyq = sr / 2
    const gains = [
      { f: params.lowFreq ?? 120, g: params.lowGain ?? 0, q: 0.7, type: 'low' },
      { f: params.midFreq ?? 1200, g: params.midGain ?? 0, q: params.midQ ?? 1, type: 'peak' },
      { f: params.highFreq ?? 8000, g: params.highGain ?? 0, q: 0.7, type: 'high' },
    ]
    for (let i = 0; i <= 120; i++) {
      const f = 20 * Math.pow(nyq / 20, i / 120)
      let db = 0
      for (const band of gains) {
        if (band.type === 'low') db += band.g / (1 + Math.pow(f / band.f, 2))
        else if (band.type === 'high') db += band.g / (1 + Math.pow(band.f / f, 2))
        else db += band.g * Math.exp(-Math.pow(Math.log2(f / band.f) * band.q, 2))
      }
      const x = (i / 120) * 100
      const y = 50 - (db / 20) * 40
      out.push(`${x.toFixed(2)},${clamp(y, 2, 98).toFixed(2)}`)
    }
    return out.join(' ')
  }, [params])
  return (
    <svg className="eq-graph" viewBox="0 0 100 100" preserveAspectRatio="none" style={{ height }}>
      <defs>
        <linearGradient id="eqfill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#d7a951" stopOpacity="0.45" />
          <stop offset="100%" stopColor="#d7a951" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {[20, 50, 80].map((y) => (
        <line key={y} x1="0" y1={y} x2="100" y2={y} className="eq-grid" />
      ))}
      <polyline points={`0,50 ${pts()} 100,50`} fill="url(#eqfill)" stroke="none" />
      <polyline points={pts()} fill="none" stroke="#e8c67a" strokeWidth="0.9" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

export function IconBtn({
  children,
  onClick,
  active,
  title,
  className = '',
  disabled,
}: {
  children: ReactNode
  onClick: (e: React.MouseEvent) => void
  active?: boolean
  title: string
  className?: string
  disabled?: boolean
}) {
  return (
    <button
      className={`icon-btn ${active ? 'active' : ''} ${className}`}
      onClick={onClick}
      title={title}
      disabled={disabled}
      aria-label={title}
    >
      {children}
    </button>
  )
}
