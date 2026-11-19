import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Allowed dev-server hosts come from the environment so no preview hostname is
// baked into tracked files. Freebuff previews also use Vite's own env hook.
const env = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
const allowedHosts = (env.VITE_ALLOWED_HOSTS || '')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean)

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,
    allowedHosts,
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1600,
  },
})
