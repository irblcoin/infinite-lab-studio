import { useEffect, useRef, useState } from 'react'
import { engine } from '../audio/engine'
import { hostWamPlugin, type WamHosted } from '../audio/wam'
import { toast } from '../state/store'

const STORE_KEY = 'ils.wamUrl'

export default function WamPanel() {
  const [url, setUrl] = useState(() => localStorage.getItem(STORE_KEY) ?? '')
  const [status, setStatus] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle')
  const [message, setMessage] = useState('')
  const [level, setLevel] = useState(0.8)
  const hosted = useRef<WamHosted | null>(null)

  useEffect(() => {
    return () => {
      hosted.current?.disconnect()
      hosted.current = null
    }
  }, [])

  const load = async () => {
    if (!url.trim()) return
    setStatus('loading')
    setMessage('Fetching module…')
    try {
      const ctx = await engine.start()
      hosted.current?.disconnect()
      const plugin = await hostWamPlugin(url.trim(), ctx, engine.masterInput)
      plugin.output.gain.value = level
      hosted.current = plugin
      localStorage.setItem(STORE_KEY, url.trim())
      setStatus('loaded')
      setMessage(`${plugin.name} is live on the master bus`)
      toast(`${plugin.name} loaded as a WAM plugin`, 'ok')
    } catch (err) {
      setStatus('error')
      setMessage((err as Error).message)
      toast('WAM plugin failed to load', 'err', 5000)
    }
  }

  return (
    <div className="wam-panel">
      <div className="row gap space-between">
        <span className="section-label">WAM plugin</span>
        {status === 'loaded' && <span className="tag ok-tag">live</span>}
      </div>
      <input
        className="text-input"
        placeholder="https://…/plugin.js"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        title="URL of a Web Audio Modules plugin bundle"
      />
      <div className="row gap">
        <button className="chip" onClick={() => void load()} disabled={status === 'loading' || !url.trim()}>
          {status === 'loading' ? 'Loading…' : 'Load plugin'}
        </button>
        {status === 'loaded' && (
          <button
            className="chip"
            onClick={() => {
              hosted.current?.disconnect()
              hosted.current = null
              setStatus('idle')
              setMessage('')
            }}
          >
            Unload
          </button>
        )}
      </div>
      {status === 'loaded' && (
        <label className="row gap space-between small">
          <span>Output</span>
          <input
            type="range"
            min={0}
            max={1.5}
            step={0.01}
            value={level}
            onChange={(e) => {
              const v = Number(e.target.value)
              setLevel(v)
              if (hosted.current) hosted.current.output.gain.value = v
            }}
          />
        </label>
      )}
      {message && <p className={`small ${status === 'error' ? 'error-text' : 'dim'}`}>{message}</p>}
      <p className="dim small">Runs on the master bus after the mixer. Any WAM v2 bundle works.</p>
    </div>
  )
}
