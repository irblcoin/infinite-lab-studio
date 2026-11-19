import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

const el = document.getElementById('root')!
createRoot(el).render(<App />)

// Offline support: the app shell is cached, sound packs are cached as they are
// used, so an installed PWA works without a connection.
if ('serviceWorker' in navigator && !isDevRuntime()) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined)
  })
}

function isDevRuntime(): boolean {
  return (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV ?? false
}

// Development-only inspection hook (stripped from production builds): lets the
// audio graph, store and sample registry be measured from the console.
const isDev = (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV ?? false
if (isDev) {
  void Promise.all([
    import('./audio/engine'),
    import('./state/store'),
    import('./audio/patch'),
    import('./data/packStore'),
    import('./state/actions'),
    import('./state/features'),
    import('./data/loops'),
    import('./audio/warp'),
    import('./voice/commands'),
  ]).then(([e, s, p, packs, actions, features, loops, warp, commands]) => {
    ;(window as unknown as { __ils?: unknown }).__ils = {
      engine: e.engine,
      store: s,
      patch: p,
      packs,
      actions,
      features,
      loops,
      warp,
      commands,
    }
  })
}
