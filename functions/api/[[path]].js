// Cloudflare Pages Functions for ILS accounts and shares.
// Routes (all under /api):
//   GET  /health                  → { ok, d1 }
//   POST /auth/signup             → { user, token }
//   POST /auth/login              → { user, token }
//   GET  /projects                → list for the signed-in user
//   PUT  /projects/:id            → save
//   GET  /projects/:id            → load
//   DELETE /projects/:id
//   POST /share                   → { id } (read-only project snapshot)
//   GET  /share/:id               → { data }
//
// Binds: env.DB (D1), env.FILES (R2). No third-party service, no API keys.

const enc = new TextEncoder()

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

function b64(bytes) {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function fromB64(text) {
  const bin = atob(text)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function hash(password, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' },
    key,
    256,
  )
  return b64(new Uint8Array(bits))
}

function uid(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
}

async function currentUser(context) {
  const auth = context.request.headers.get('authorization') || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token) return null
  const row = await context.env.DB.prepare(
    'SELECT u.id, u.email, u.name, u.created_at AS createdAt FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?',
  )
    .bind(token)
    .first()
  return row || null
}

async function body(context) {
  try {
    return await context.request.json()
  } catch {
    return {}
  }
}

export async function onRequest(context) {
  const url = new URL(context.request.url)
  const path = url.pathname.replace(/^\/api/, '') || '/'
  const method = context.request.method
  const env = context.env

  if (path === '/health') {
    let d1 = false
    try {
      if (env.DB) {
        await env.DB.prepare('SELECT 1').first()
        d1 = true
      }
    } catch {
      d1 = false
    }
    return json({ ok: d1, d1, app: env.APP_NAME || 'ILS' })
  }

  if (!env.DB) return json({ error: 'D1 binding missing — run the schema and redeploy' }, 503)

  if (path === '/auth/signup' && method === 'POST') {
    const { email, password, name } = await body(context)
    const clean = String(email || '').trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) return json({ error: 'Enter a valid email address' }, 400)
    if (String(password || '').length < 6) return json({ error: 'Password needs 6+ characters' }, 400)
    const exists = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(clean).first()
    if (exists) return json({ error: 'That email is already registered' }, 409)
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const passHash = await hash(String(password), salt)
    const id = uid('user')
    const createdAt = Date.now()
    await env.DB.prepare('INSERT INTO users (id,email,name,salt,hash,created_at) VALUES (?,?,?,?,?,?)')
      .bind(id, clean, String(name || clean.split('@')[0]), b64(salt), passHash, createdAt)
      .run()
    const token = uid('tok')
    await env.DB.prepare('INSERT INTO sessions (token,user_id,created_at) VALUES (?,?,?)').bind(token, id, createdAt).run()
    return json({ user: { id, email: clean, name: name || clean.split('@')[0], createdAt, cloud: true }, token })
  }

  if (path === '/auth/login' && method === 'POST') {
    const { email, password } = await body(context)
    const clean = String(email || '').trim().toLowerCase()
    const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(clean).first()
    if (!user) return json({ error: 'No account with that email' }, 404)
    const passHash = await hash(String(password || ''), fromB64(user.salt))
    if (passHash !== user.hash) return json({ error: 'Wrong password' }, 401)
    const token = uid('tok')
    await env.DB.prepare('INSERT INTO sessions (token,user_id,created_at) VALUES (?,?,?)').bind(token, user.id, Date.now()).run()
    return json({ user: { id: user.id, email: user.email, name: user.name, createdAt: user.created_at, cloud: true }, token })
  }

  if (path === '/share' && method === 'POST') {
    const { data } = await body(context)
    if (!data || String(data).length > 4 * 1024 * 1024) return json({ error: 'Project too large to share' }, 413)
    const id = uid('share')
    await env.DB.prepare('INSERT INTO shares (id,user_id,data,created_at) VALUES (?,?,?,?)')
      .bind(id, null, String(data), Date.now())
      .run()
    return json({ id })
  }

  const shareMatch = path.match(/^\/share\/([\w-]+)$/)
  if (shareMatch && method === 'GET') {
    const row = await env.DB.prepare('SELECT data FROM shares WHERE id = ?').bind(shareMatch[1]).first()
    if (!row) return json({ error: 'Share not found' }, 404)
    return json({ data: row.data })
  }

  const user = await currentUser(context)
  if (!user) return json({ error: 'Sign in required' }, 401)

  if (path === '/projects' && method === 'GET') {
    const rows = await env.DB.prepare('SELECT id,name,updated_at AS updatedAt FROM projects WHERE user_id = ? ORDER BY updated_at DESC')
      .bind(user.id)
      .all()
    return json({ projects: rows.results || [] })
  }

  const projMatch = path.match(/^\/projects\/([\w-]+)$/)
  if (projMatch) {
    const id = projMatch[1]
    if (method === 'PUT') {
      const { name, data } = await body(context)
      if (!data) return json({ error: 'Missing project data' }, 400)
      const existing = await env.DB.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').bind(id, user.id).first()
      if (existing) {
        await env.DB.prepare('UPDATE projects SET name = ?, data = ?, updated_at = ? WHERE id = ? AND user_id = ?')
          .bind(String(name || 'Untitled'), String(data), Date.now(), id, user.id)
          .run()
      } else {
        await env.DB.prepare('INSERT INTO projects (id,user_id,name,data,updated_at,created_at) VALUES (?,?,?,?,?,?)')
          .bind(id, user.id, String(name || 'Untitled'), String(data), Date.now(), Date.now())
          .run()
      }
      return json({ ok: true })
    }
    if (method === 'GET') {
      const row = await env.DB.prepare('SELECT id,name,data,updated_at AS updatedAt FROM projects WHERE id = ? AND user_id = ?')
        .bind(id, user.id)
        .first()
      if (!row) return json({ error: 'Not found' }, 404)
      return json({ project: row })
    }
    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM projects WHERE id = ? AND user_id = ?').bind(id, user.id).run()
      return json({ ok: true })
    }
  }

  return json({ error: 'Not found' }, 404)
}
