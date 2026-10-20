/* OAuth for AI clients is separate from the paired OpenGym session. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { betterAuth } from 'better-auth'
import { createAuthEndpoint, APIError, getSessionFromCtx } from 'better-auth/api'
import { setSessionCookie } from 'better-auth/cookies'
import { symmetricEncrypt, symmetricDecrypt } from 'better-auth/crypto'
import { getMigrations } from 'better-auth/db/migration'
import { jwt } from 'better-auth/plugins'
import { mcp } from '@better-auth/mcp'
import { cimd } from '@better-auth/cimd'
import { fetchClientMetadataResource } from '@better-auth/cimd/node'
import { z } from 'zod'
import { createApi } from './api.js'

export function authSettings(env = process.env) {
  const required = key => { if (!env[key]) throw new Error(`Set ${key}`); return env[key] }
  const publicUrl = new URL(required('BETTER_AUTH_URL'))
  if (publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname !== '/' ||
      !(publicUrl.protocol === 'https:' || (publicUrl.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(publicUrl.hostname)))) {
    throw new Error('BETTER_AUTH_URL must be an HTTPS origin (or loopback HTTP)')
  }
  const secret = required('BETTER_AUTH_SECRET')
  if (secret.length < 32) throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters')
  const gymUrl = required('OPENGYM_URL')
  createApi({ url: gymUrl, token: 'validate-origin' })
  if (env.OPENGYM_TOKEN) throw new Error('HTTP mode uses per-user pairing; remove shared OPENGYM_TOKEN')
  return { baseURL: publicUrl.origin, secret, gymUrl, databasePath: env.DATABASE_PATH || './data/opengym-mcp.sqlite' }
}

export async function createAuth(settings = authSettings(), { metadataFetch = fetchClientMetadataResource } = {}) {
  fs.mkdirSync(path.dirname(settings.databasePath), { recursive: true, mode: 0o700 })
  const database = new DatabaseSync(settings.databasePath)
  fs.chmodSync(settings.databasePath, 0o600)
  database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  database.exec('CREATE TABLE IF NOT EXISTS gym_connection (user_id TEXT PRIMARY KEY, gym_uid TEXT NOT NULL, token TEXT NOT NULL)')
  const resource = settings.baseURL + '/mcp'
  const save = async (userId, uid, token) => {
    const encrypted = await symmetricEncrypt({ key: settings.secret, data: token })
    database.prepare('INSERT INTO gym_connection (user_id, gym_uid, token) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET gym_uid=excluded.gym_uid, token=excluded.token').run(userId, uid, encrypted)
  }
  const pairPlugin = {
    id: 'opengym-pairing',
    endpoints: {
      signInOpenGym: createAuthEndpoint('/sign-in/opengym', {
        method: 'POST', body: z.object({ code: z.string().trim().regex(/^[A-Z2-9]{8}$/i), oauth_query: z.string().optional() })
      }, async ctx => {
        // The configured instance is the only destination. A caller cannot choose a host or uid.
        let paired, me
        try {
          const bootstrap = createApi({ url: settings.gymUrl, token: 'pairing' })
          paired = await bootstrap.request('/api/pair/redeem', { method: 'POST', body: { code: ctx.body.code.toUpperCase() } })
          me = await createApi({ url: settings.gymUrl, token: paired.token }).request('/api/me')
          if (typeof paired.token !== 'string' || typeof me.user?.id !== 'string') throw new Error('Invalid pairing response')
        } catch { throw new APIError('UNAUTHORIZED', { message: 'Pairing failed. Create a new code in OpenGym Settings and try again.' }) }
        const email = createHash('sha256').update(me.user.id).digest('hex') + '@opengym.invalid'
        const adapter = ctx.context.internalAdapter
        let user = (await adapter.findUserByEmail(email))?.user
        if (!user) user = await adapter.createUser({ email, name: me.user.name || 'OpenGym', emailVerified: true })
        await save(user.id, me.user.id, me.token || paired.token)
        const session = await adapter.createSession(user.id)
        await setSessionCookie(ctx, { session, user })
        // The OAuth provider's signed-query hook resumes authorization after this login.
        return ctx.json({ url: '/' })
      }),
      disconnectOpenGym: createAuthEndpoint('/disconnect-opengym', { method: 'POST' }, async ctx => {
        const session = await getSessionFromCtx(ctx)
        if (!session) throw new APIError('UNAUTHORIZED')
        database.prepare('DELETE FROM gym_connection WHERE user_id = ?').run(session.user.id)
        return ctx.json({ ok: true })
      })
    }
  }
  const options = {
    appName: 'OpenGym MCP', baseURL: settings.baseURL, secret: settings.secret, database,
    advanced: { ipAddress: { ipAddressHeaders: ['x-opengym-client-ip'] } },
    trustedOrigins: [settings.baseURL], rateLimit: { enabled: true, storage: 'database', window: 60, max: 60 },
    disabledPaths: ['/token', '/get-access-token', '/refresh-token', '/update-user', '/change-email', '/delete-user'],
    plugins: [jwt(), pairPlugin, mcp({ loginPage: '/sign-in', consentPage: '/consent', resource,
      scopes: ['openid', 'profile', 'offline_access', 'opengym:tools'],
      grantTypes: ['authorization_code', 'refresh_token'], accessTokenExpiresIn: 15 * 60, refreshTokenReuseInterval: 0
    }), cimd({ fetchClientMetadataResource: metadataFetch, metadataProfile: 'mcp-2026-07-28' })]
  }
  try {
    await (await getMigrations(options)).runMigrations()
    const auth = betterAuth(options)
    await auth.$context
    const pending = new Map()
    async function accountApi(userId) {
      let result = pending.get(userId)
      if (!result) {
        result = (async () => {
          const context = await auth.$context
          if (!(await context.internalAdapter.findUserById(userId))) throw new Error('Account unavailable')
          const row = database.prepare('SELECT * FROM gym_connection WHERE user_id = ?').get(userId)
          if (!row) throw new Error('Reconnect OpenGym on the MCP sign-in page')
          const token = await symmetricDecrypt({ key: settings.secret, data: row.token })
          const api = createApi({ url: settings.gymUrl, token })
          // Enforce expiry, disablement and sign-out-everywhere even for an unexpired MCP JWT.
          const me = await api.request('/api/me')
          if (me.user?.id !== row.gym_uid) throw new Error('Account identity mismatch')
          if (me.token) {
            // Do not resurrect a connection removed while the network read was in flight.
            const encrypted = await symmetricEncrypt({ key: settings.secret, data: me.token })
            const changed = database.prepare('UPDATE gym_connection SET token = ? WHERE user_id = ? AND token = ?').run(encrypted, userId, row.token)
            if (changed.changes !== 1) throw new Error('Connection changed; retry')
            return { ...createApi({ url: settings.gymUrl, token: me.token }), identity: me.user }
          }
          if (!database.prepare('SELECT 1 FROM gym_connection WHERE user_id = ?').get(userId)) throw new Error('Connection removed')
          return { ...api, identity: me.user }
        })().finally(() => pending.delete(userId))
        pending.set(userId, result)
      }
      return result
    }
    return { auth, database, resource, baseURL: settings.baseURL, gymUrl: settings.gymUrl, accountApi }
  } catch (error) { database.close(); throw error }
}
