/* ILS service worker: app shell offline, packs cached on first use. */
const VERSION = 'ils-v1'
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(`${VERSION}-shell`)
      .then((cache) => cache.addAll(SHELL).catch(() => undefined))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  // Navigation: network first, fall back to the cached shell (SPA).
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(`${VERSION}-shell`).then((c) => c.put('/index.html', copy)).catch(() => undefined)
          return res
        })
        .catch(() => caches.match('/index.html').then((hit) => hit ?? caches.match('/'))),
    )
    return
  }

  // Sound packs and build assets: cache first, then network.
  if (url.pathname.startsWith('/packs/') || url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ??
          fetch(req).then((res) => {
            if (res.ok && res.headers.get('content-length') !== null) {
              const size = Number(res.headers.get('content-length'))
              // keep the cache sane: skip very large samples
              if (size < 8 * 1024 * 1024) {
                const copy = res.clone()
                caches.open(`${VERSION}-packs`).then((c) => c.put(req, copy)).catch(() => undefined)
              }
            }
            return res
          }),
      ),
    )
    return
  }

  // Everything else: stale-while-revalidate.
  event.respondWith(
    caches.match(req).then((hit) => {
      const network = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone()
            caches.open(`${VERSION}-shell`).then((c) => c.put(req, copy)).catch(() => undefined)
          }
          return res
        })
        .catch(() => hit)
      return hit ?? network
    }),
  )
})
