import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { getState, newProject, setUi, toast } from '../state/store'
import { toggleArm } from '../state/actions'
import { HOME_PHOTO, HOME_PHOTO_ALT, homeSrcSet } from './homePhoto'
import HomeScene from './HomeScene'

const PHOTO_SIZES = '(max-width: 760px) 96vw, (max-width: 1120px) 88vw, 46vw'

type Spot = {
  id: string
  /** Percent of the photo, from the left and from the top. */
  x: number
  y: number
  label: string
  run: () => void
  edge?: 'left' | 'right' | 'top'
}

/** Live mini-mixer painted onto the wall monitor in the photo. */
function MonitorScreen() {
  const ref = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    let context: CanvasRenderingContext2D | null = null
    try {
      context = canvas.getContext('2d')
    } catch {
      context = null
    }
    if (!context) return
    const ctx = context
    const w = canvas.width
    const h = canvas.height
    const levels = Array.from({ length: 11 }, () => 0.45)
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const paint = (t: number) => {
      const g = ctx.createLinearGradient(0, 0, 0, h)
      g.addColorStop(0, '#0a1b22')
      g.addColorStop(1, '#04090c')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = 'rgba(215,169,81,.5)'
      ctx.fillRect(5, 4, w - 10, 2)
      const pad = 6
      const top = 12
      const bottom = h - 6
      const bw = (w - pad * 2) / levels.length
      for (let i = 0; i < levels.length; i++) {
        const x = pad + i * bw + bw * 0.22
        const barW = Math.max(2, bw * 0.5)
        const target = 0.22 + Math.random() * 0.72
        levels[i] += (target - levels[i]) * 0.2
        const barH = levels[i] * (bottom - top)
        ctx.fillStyle = 'rgba(255,255,255,.06)'
        ctx.fillRect(x, top, barW, bottom - top)
        const mg = ctx.createLinearGradient(0, bottom - barH, 0, bottom)
        mg.addColorStop(0, 'rgba(94,234,212,.95)')
        mg.addColorStop(0.72, 'rgba(94,234,212,.5)')
        mg.addColorStop(1, 'rgba(215,169,81,.4)')
        ctx.fillStyle = mg
        ctx.fillRect(x, bottom - barH, barW, barH)
      }
      const beat = (t / 900) % levels.length
      ctx.fillStyle = 'rgba(232,198,122,.65)'
      ctx.fillRect(pad + beat * bw, top - 1, 1, bottom - top + 1)
    }

    if (reduce) {
      paint(0)
      return
    }
    let raf = 0
    let last = -1000
    const loop = (t: number) => {
      if (t - last > 90) {
        paint(t)
        last = t
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])
  const box = HOME_PHOTO.screen
  return (
    <canvas
      ref={ref}
      className="monitor-screen"
      width={220}
      height={140}
      aria-hidden="true"
      style={{
        left: `${box.left}%`,
        top: `${box.top}%`,
        width: `${box.width}%`,
        height: `${box.height}%`,
      }}
    />
  )
}

export default function Home({ onStartVoice }: { onStartVoice: () => void }) {
  const [intro, setIntro] = useState(() => {
    try {
      return localStorage.getItem('ils.intro') !== 'off'
    } catch {
      return true
    }
  })
  const [lights, setLights] = useState(0)
  const [parallax, setParallax] = useState({ x: 0, y: 0 })
  const [photoOk, setPhotoOk] = useState(true)
  const [showHotspots, setShowHotspots] = useState(false)
  const [tone, setTone] = useState(false)
  const toneRef = useRef<{ ctx: AudioContext; gain: GainNode } | null>(null)

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const x = (e.clientX / Math.max(1, window.innerWidth)) * 2 - 1
      const y = (e.clientY / Math.max(1, window.innerHeight)) * 2 - 1
      setParallax({ x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) })
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [])

  useEffect(() => {
    return () => {
      if (toneRef.current) {
        void toneRef.current.ctx.close()
        toneRef.current = null
      }
    }
  }, [])

  const toggleTone = async () => {
    if (toneRef.current) {
      await toneRef.current.ctx.close()
      toneRef.current = null
      setTone(false)
      return
    }
    const ctx = new AudioContext()
    await ctx.resume()
    const buffer = ctx.createBuffer(2, ctx.sampleRate * 4, ctx.sampleRate)
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch)
      let last = 0
      for (let i = 0; i < data.length; i++) {
        const white = Math.random() * 2 - 1
        last = (last + 0.02 * white) / 1.02
        data[i] = last * 2.4
      }
    }
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.loop = true
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 420
    const gain = ctx.createGain()
    gain.gain.value = 0.018
    src.connect(filter).connect(gain).connect(ctx.destination)
    src.start()
    toneRef.current = { ctx, gain }
    setTone(true)
  }

  useEffect(() => {
    const t = window.setInterval(() => setLights((v) => (v + 1) % 40), 260)
    return () => window.clearInterval(t)
  }, [])

  const startNew = () => {
    newProject()
    setUi({ view: 'seq' })
  }

  const openBooth = () => {
    const { project } = getState()
    const audio = project.tracks.find((t) => t.kind === 'audio') ?? project.tracks[0]
    if (audio) {
      if (!audio.armed) toggleArm(audio.id)
      setUi({ selectedTrackId: audio.id, view: 'seq', modal: 'record' })
      toast(`Vocal booth ready — "${audio.name}" armed. Press record when you are.`, 'ok', 4200)
    } else {
      setUi({ view: 'seq' })
    }
  }

  const openPads = () => {
    const { project } = getState()
    const drum = project.tracks.find((t) => t.kind === 'drum') ?? project.tracks.find((t) => t.kind === 'midi')
    setUi({ view: 'seq', editor: 'drum', selectedTrackId: drum?.id ?? null })
  }

  const openSettings = (focus: 'audio' | 'latency') => setUi({ modal: 'settings', settingsFocus: focus })

  const openLibrary = () => setUi({ view: 'seq', libraryOpen: true, libraryTab: 'All' })

  const spots: Spot[] = [
    { id: 'monitor', x: 48, y: 19, label: 'Wall monitor · Sequencer', run: () => setUi({ view: 'seq' }) },
    { id: 'console', x: 48, y: 42, label: 'Mixing console · Mixer', run: () => setUi({ view: 'mix' }) },
    { id: 'rack', x: 50, y: 47, label: 'Rack unit · Rack browser', run: () => setUi({ view: 'rack' }) },
    { id: 'pads', x: 56, y: 49, label: 'Pads & keys · Piano roll / drum pads', run: openPads, edge: 'right' },
    { id: 'mic', x: 10, y: 37, label: 'Microphone · Vocal booth', run: openBooth, edge: 'left' },
    { id: 'turntable', x: 21, y: 62, label: 'Turntable · Sound library', run: openLibrary },
    { id: 'monitor-l', x: 35, y: 40, label: 'Left monitor · Audio interface', run: () => openSettings('audio') },
    { id: 'monitor-r', x: 55, y: 40, label: 'Right monitor · Audio interface', run: () => openSettings('audio') },
    { id: 'headphones', x: 56, y: 31, label: 'Headphones · Monitoring & latency', run: () => openSettings('latency'), edge: 'right' },
    { id: 'pc', x: 43, y: 71, label: 'PC tower · Open project & cloud saves', run: () => setUi({ modal: 'projects' }) },
    { id: 'chart', x: 26, y: 27, label: 'Chord chart · Help', run: () => setUi({ modal: 'help', rightPanel: 'help' }) },
    {
      id: 'chair',
      x: 66,
      y: 59,
      label: 'Chair · Create',
      run: () => setUi({ view: 'seq', rightPanel: 'create' }),
      edge: 'right',
    },
  ]

  const frameStyle = {
    '--photo-ratio': HOME_PHOTO.ratio,
    '--photo-ar': 1 / HOME_PHOTO.ratio,
    transform: `translate3d(${parallax.x * -7}px, ${parallax.y * -5}px, 0)`,
    backgroundImage: `url(${HOME_PHOTO.placeholder})`,
  } as CSSProperties

  const copy = (
    <div className="hero">
      <p className="eyebrow">The room is the interface</p>
      <h1>
        ILS <span className="dash">–</span> Infinite Lab Studio
      </h1>
      <p className="tagline">
        A full production suite in your browser: arrange, record, mix and design sound with your voice.
      </p>
      <div className="hero-actions">
        <button className="primary big" onClick={startNew}>
          New Project
        </button>
        <button className="ghost big" onClick={() => setUi({ modal: 'projects' })}>
          Open Project
        </button>
        <button
          className="gold big"
          onClick={() => {
            onStartVoice()
            setUi({ view: 'seq' })
          }}
        >
          Start with Voice
        </button>
      </div>
      <p className="company-line">A Building Billions LLC Product</p>
      <p className="hero-hint">
        Try: “create a dark trap beat at 140 in E minor” · “add reverb to the vocal” · “loop bars 5 to 9”
      </p>
    </div>
  )

  const footer = (
    <footer className="home-footer">
      <span className="mono small legal">© 2026 Building Billions LLC. All rights reserved.</span>
      <div className="row gap wrap">
        <button className="link" onClick={() => setUi({ modal: 'about' })}>
          About
        </button>
        <button className="link" onClick={() => setUi({ modal: 'help' })}>
          Help
        </button>
        <button className={`link ${tone ? 'on' : ''}`} onClick={() => void toggleTone()} title="Ambient room tone (off by default)">
          {tone ? 'Room tone on' : 'Room tone off'}
        </button>
        <button
          className="link"
          onClick={() => {
            localStorage.setItem('ils.intro', 'off')
            setIntro(false)
          }}
        >
          Skip intro
        </button>
      </div>
    </footer>
  )

  return (
    <div className={`home ${intro ? 'cinematic' : 'simple'} ${showHotspots ? 'hotspots-on' : ''}`}>
      {photoOk ? (
        <div className="home-backdrop" aria-hidden="true">
          <img src={`${HOME_PHOTO.base}-480.jpg`} srcSet={homeSrcSet('webp')} sizes="100vw" alt="" />
        </div>
      ) : (
        <div className="home-scene" aria-hidden="true">
          <HomeScene parallax={parallax} lights={lights} />
        </div>
      )}

      <div className="home-overlay">
        <div className="home-topline">
          <span className="badge">Control Room A</span>
          <div className="row gap">
            {photoOk && (
              <button
                className="hotspot-toggle"
                aria-pressed={showHotspots}
                onClick={() => setShowHotspots((v) => !v)}
                title="Reveal the clickable points on the photo"
              >
                <i aria-hidden="true" />
                Show hotspots
              </button>
            )}
            <span className="badge ghost">Zero setup · Browser native · Local first</span>
          </div>
        </div>

        <div className={`home-hero ${photoOk ? 'with-photo' : 'classic'}`}>
          {photoOk ? null : copy}
          {photoOk ? (
            <>
              {copy}
              <div className="home-stage">
                <div className="home-frame" style={frameStyle}>
                  <picture>
                    <source type="image/webp" srcSet={homeSrcSet('webp')} sizes={PHOTO_SIZES} />
                    <img
                      className="home-photo"
                      src={`${HOME_PHOTO.base}-768.jpg`}
                      srcSet={homeSrcSet('jpg')}
                      sizes={PHOTO_SIZES}
                      alt={HOME_PHOTO_ALT}
                      decoding="async"
                      fetchPriority="high"
                      onError={() => setPhotoOk(false)}
                    />
                  </picture>
                  <span className="photo-warmth" aria-hidden="true" />
                  <span className="photo-shimmer" aria-hidden="true" />
                  <span className="glow monitor" aria-hidden="true" />
                  <span className="glow cone left" aria-hidden="true" />
                  <span className="glow cone right" aria-hidden="true" />
                  <MonitorScreen />
                  <div className="hotspot-layer">
                    {spots.map((spot) => (
                      <button
                        key={spot.id}
                        className={`hotspot ${spot.edge ? `edge-${spot.edge}` : ''}`}
                        style={{ left: `${spot.x}%`, top: `${spot.y}%` }}
                        onClick={spot.run}
                        aria-label={`${spot.label} — open`}
                        title={spot.label}
                      >
                        <span className="hs-dot" aria-hidden="true" />
                        <span className="hs-label">{spot.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <span className="stage-caption mono">Your room, every control one click away</span>
              </div>
            </>
          ) : (
            <div className="hotspot-layer">
              <button className="hotspot edge-left" style={{ left: '3%', top: '68%' }} onClick={() => setUi({ view: 'mix' })} aria-label="Mixing console — open the mixer">
                <span className="hs-dot" aria-hidden="true" />
                <span className="hs-label">Mixing console → Mixer</span>
              </button>
              <button className="hotspot edge-right" style={{ left: '93%', top: '43%' }} onClick={() => setUi({ view: 'rack' })} aria-label="Rack gear — open the rack browser">
                <span className="hs-dot" aria-hidden="true" />
                <span className="hs-label">Rack gear → Racks</span>
              </button>
              <button className="hotspot" style={{ left: '33%', top: '88%' }} onClick={() => setUi({ view: 'seq' })} aria-label="Desk screen — open the sequencer">
                <span className="hs-dot" aria-hidden="true" />
                <span className="hs-label">Desk screen → Sequencer</span>
              </button>
              <button className="hotspot edge-right" style={{ left: '87%', top: '9%' }} onClick={openBooth} aria-label="Vocal booth — start a recording session">
                <span className="hs-dot" aria-hidden="true" />
                <span className="hs-label">Vocal booth → Record</span>
              </button>
            </div>
          )}
        </div>

        {footer}
      </div>
    </div>
  )
}
