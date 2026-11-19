// ---------------------------------------------------------------------------
// Accounts and cloud sync.
//
// Local accounts work immediately in this browser (PBKDF2 hashed, never sent
// anywhere). When the Cloudflare Pages Functions in /functions are deployed the
// same calls transparently use D1 + R2 through /api, so no keys are involved.
// ---------------------------------------------------------------------------

import type { Project } from './types'
import { uid } from './types'
import { getState, toast } from './store'

export interface Account {
  id: string
  email: string
  name: string
  createdAt: number
  cloud: boolean
  token?: string
}

interface StoredUser {
  id: string
  email: string
  name: string
  createdAt: number
  salt: string
  hash: string
}

const USERS_KEY = 'ils.users.v1'
const SESSION_KEY = 'ils.session.v1'
const API_BASE = '/api'

function readUsers(): StoredUser[] {
  try {
    return JSON.parse(localStorage.getItem(USERS_KEY) ?? '[]') as StoredUser[]
  } catch {
    return []
  }
}

function writeUsers(users: StoredUser[]): void {
  localStorage.setItem(USERS_KEY, JSON.stringify(users))
}

function b64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function fromB64(text: string): Uint8Array {
  const bin = atob(text)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function hashPassword(password: string, salt: Uint8Array): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations: 120000, hash: 'SHA-256' },
    key,
    256,
  )
  return b64(new Uint8Array(bits))
}

export function localAccounts(): Account[] {
  return readUsers().map((u) => ({ id: u.id, email: u.email, name: u.name, createdAt: u.createdAt, cloud: false }))
}

export function currentAccount(): Account | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    return JSON.parse(raw) as Account
  } catch {
    return null
  }
}

function saveSession(account: Account | null): void {
  if (!account) localStorage.removeItem(SESSION_KEY)
  else localStorage.setItem(SESSION_KEY, JSON.stringify(account))
}

export async function signUpLocal(email: string, password: string, name?: string): Promise<Account> {
  const clean = email.trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) throw new Error('Enter a valid email address')
  if (password.length < 6) throw new Error('Use at least 6 characters for the password')
  const users = readUsers()
  if (users.some((u) => u.email === clean)) throw new Error('That email already has an account here')
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const hash = await hashPassword(password, salt)
  const user: StoredUser = {
    id: uid('user'),
    email: clean,
    name: name?.trim() || clean.split('@')[0],
    createdAt: Date.now(),
    salt: b64(salt),
    hash,
  }
  users.push(user)
  writeUsers(users)
  const account: Account = { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt, cloud: false }
  saveSession(account)
  return account
}

export async function signInLocal(email: string, password: string): Promise<Account> {
  const clean = email.trim().toLowerCase()
  const user = readUsers().find((u) => u.email === clean)
  if (!user) throw new Error('No local account with that email')
  const hash = await hashPassword(password, fromB64(user.salt))
  if (hash !== user.hash) throw new Error('Wrong password')
  const account: Account = { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt, cloud: false }
  saveSession(account)
  return account
}

export function signOut(): void {
  saveSession(null)
  toast('Signed out — local projects stay on this device', 'ok')
}

export function signInAs(account: Account): void {
  saveSession(account)
}

// ---------------------------------------------------------------------------
// Cloud (Cloudflare Pages Functions, optional)
// ---------------------------------------------------------------------------
let apiStatus: 'unknown' | 'ready' | 'missing' = 'unknown'

export async function cloudAvailable(): Promise<boolean> {
  if (apiStatus === 'ready') return true
  if (apiStatus === 'missing') return false
  try {
    const res = await fetch(`${API_BASE}/health`, { method: 'GET' })
    if (!res.ok) throw new Error('no api')
    const data = (await res.json()) as { ok?: boolean; d1?: boolean }
    apiStatus = data.ok ? 'ready' : 'missing'
    return apiStatus === 'ready'
  } catch {
    apiStatus = 'missing'
    return false
  }
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const account = currentAccount()
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (account?.token) headers.authorization = `Bearer ${account.token}`
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || `Request failed (${res.status})`)
  }
  return (await res.json()) as T
}

export async function cloudSignUp(email: string, password: string, name?: string): Promise<Account> {
  if (!(await cloudAvailable())) throw new Error('Cloud is not configured — local accounts are available')
  const data = await api<{ user: Account; token: string }>('/auth/signup', { method: 'POST', body: JSON.stringify({ email, password, name }) })
  const account = { ...data.user, cloud: true, token: data.token }
  saveSession(account)
  return account
}

export async function cloudSignIn(email: string, password: string): Promise<Account> {
  if (!(await cloudAvailable())) throw new Error('Cloud is not configured — sign in locally instead')
  const data = await api<{ user: Account; token: string }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
  const account = { ...data.user, cloud: true, token: data.token }
  saveSession(account)
  return account
}

export async function cloudSave(project: Project): Promise<void> {
  if (!currentAccount()) throw new Error('Sign in first')
  await api(`/projects/${project.id}`, { method: 'PUT', body: JSON.stringify({ name: project.name, data: JSON.stringify(project) }) })
  toast('Saved to the cloud', 'ok')
}

export async function cloudList(): Promise<{ id: string; name: string; updatedAt: number }[]> {
  const data = await api<{ projects: { id: string; name: string; updatedAt: number }[] }>('/projects')
  return data.projects ?? []
}

export async function cloudLoad(id: string): Promise<Project> {
  const data = await api<{ project: { data: string } }>(`/projects/${id}`)
  return JSON.parse(data.project.data) as Project
}

// ---------------------------------------------------------------------------
// Share links
// ---------------------------------------------------------------------------
function toBase64Url(bytes: Uint8Array): string {
  return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(text: string): Uint8Array {
  const b = text.replace(/-/g, '+').replace(/_/g, '/')
  return fromB64(b + '='.repeat((4 - (b.length % 4)) % 4))
}

async function gzip(text: string): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') return new TextEncoder().encode(text)
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function gunzip(bytes: Uint8Array): Promise<string> {
  if (typeof DecompressionStream === 'undefined') return new TextDecoder().decode(bytes)
  const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).text()
}

export interface ShareInfo {
  url: string
  cloud: boolean
}

/** Build a self-contained link that carries the arrangement, no server needed. */
/** Links made by older builds (or by the composer) can miss newer fields. */
export function normalizeSharedProject(input: Partial<Project> | null | undefined): Project | null {
  if (!input || !Array.isArray(input.tracks)) return null
  const tracks = input.tracks
  const length = Math.max(4, Number(input.length) || tracks.reduce((m, t) => Math.max(m, ...(t.clips || []).map((c) => c.start + c.len)), 0) || 64)
  return {
    ...(input as Project),
    id: input.id || `share_${uid()}`,
    name: input.name || 'Shared project',
    bpm: Number(input.bpm) || 120,
    timeSig: input.timeSig || [4, 4],
    keyRoot: input.keyRoot || 'C',
    keyScale: input.keyScale || 'Minor',
    tracks: tracks.map((t) => ({ ...t, clips: t.clips || [], devices: t.devices || [] })),
    master: { volume: 0.85, limiterOn: true, ceiling: -0.3, ...(input.master || {}) },
    loop: { start: 0, end: length, enabled: false, ...(input.loop || {}) },
    markers: input.markers || [],
    scenes: input.scenes || 8,
    length,
    lyrics: input.lyrics || [],
    snapshots: input.snapshots || [],
    createdAt: input.createdAt || Date.now(),
    updatedAt: input.updatedAt || Date.now(),
  }
}

export async function createShareLink(project: Project): Promise<ShareInfo> {
  const payload = JSON.stringify({ kind: 'ils-share', v: 1, project: normalizeSharedProject(project) ?? project })
  const encoded = toBase64Url(await gzip(payload))
  const base = `${location.origin}${location.pathname}`
  if (await cloudAvailable()) {
    try {
      const data = await api<{ id: string }>('/share', { method: 'POST', body: JSON.stringify({ data: payload }) })
      return { url: `${base}#s=${data.id}`, cloud: true }
    } catch {
      /* fall back to the embedded link */
    }
  }
  return { url: `${base}#p=${encoded}`, cloud: false }
}

export async function readShareFromLocation(): Promise<Project | null> {
  const hash = location.hash
  if (!hash.startsWith('#')) return null
  const params = new URLSearchParams(hash.slice(1))
  const embedded = params.get('p')
  if (embedded) {
    try {
      const json = await gunzip(fromBase64Url(embedded))
      const parsed = JSON.parse(json) as { kind?: string; project?: Project }
      if (parsed.kind === 'ils-share' && parsed.project) return normalizeSharedProject(parsed.project)
    } catch {
      return null
    }
  }
  const shared = params.get('s')
  if (shared && (await cloudAvailable())) {
    try {
      const data = await api<{ data: string }>(`/share/${shared}`)
      const parsed = JSON.parse(data.data) as { project?: Project }
      return normalizeSharedProject(parsed.project)
    } catch {
      return null
    }
  }
  return null
}

export function clearShareHash(): void {
  if (location.hash) history.replaceState(null, '', location.pathname + location.search)
}

export function projectShareUrl(project: Project): string {
  return createShareLink(project) as unknown as string
}

export function shareSlug(project: Project): string {
  return `${getState().project.name}-${project.id.slice(-6)}`
}
