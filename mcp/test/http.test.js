/* OAuth authorization-code/PKCE, real MCP HTTP client, and real OpenGym API. */
import { beforeAll, afterAll, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { createServer, request as nodeRequest } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { boundPort } from '../../api/test/helpers.mjs'
import { createAuth, authSettings } from '../src/auth.js'
import { symmetricEncrypt, symmetricDecrypt } from 'better-auth/crypto'
import { createHttpHandler, toNodeHandler, httpOptions } from '../src/http.js'

let directory, apiChild, httpServer, runtime, settings, baseURL, gymUrl, secret
const root = fileURLToPath(new URL('../../', import.meta.url))
const accounts = {}
const cookieOf = response => response.headers.getSetCookie().map(s => s.split(';')[0]).join('; ')
const req = (route, init = {}) => fetch(baseURL + route, { redirect: 'manual', ...init })
const post = (route, body, cookie = '') => req(route, { method: 'POST', headers: { origin: baseURL, cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })
const mint = uid => {
  const payload = `${uid}:${Date.now() + 86400000}:0`
  return payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url')
}
const gym = (uid, route, init = {}) => fetch(gymUrl + route, { ...init, headers: { Authorization: `Bearer ${mint(uid)}`, 'content-type': 'application/json' } })

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-http-mcp-'))
  const data = path.join(directory, 'gym')
  fs.mkdirSync(data)
  secret = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(path.join(data, 'secret'), secret, { mode: 0o600 })
  fs.writeFileSync(path.join(data, 'db.json'), JSON.stringify({ users: [{ id: 'a', name: 'Alice' }, { id: 'b', name: 'Bob' }], creds: [], invites: [], subs: [] }))
  for (const id of ['a', 'b']) fs.writeFileSync(path.join(data, `state-${id}.json`), JSON.stringify({ unit: 'kg', routines: [{ id: 'r1', name: `Routine ${id}`, ex: [] }], workouts: [], bodyweight: [], customEx: [], _rev: 1 }))
  apiChild = spawn(process.execPath, ['server.js'], { cwd: path.join(root, 'api'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATA_DIR: data, PORT: '0', ORIGIN: 'http://localhost:8080', RP_ID: 'localhost', ADMIN_UIDS: '', COACH_DISABLED: '1' } })
  let log = ''
  apiChild.stdout.on('data', d => { log += d }); apiChild.stderr.on('data', d => { log += d })
  gymUrl = `http://127.0.0.1:${await boundPort(apiChild, () => log)}`
  let handle = (_, res) => res.writeHead(503).end()
  httpServer = createServer((...args) => handle(...args))
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve))
  baseURL = `http://127.0.0.1:${httpServer.address().port}`
  settings = { baseURL, gymUrl, secret: crypto.randomBytes(32).toString('hex'), databasePath: path.join(directory, 'auth.sqlite') }
  runtime = await createAuth(settings)
  handle = toNodeHandler(request => createHttpHandler(runtime)(request), [new URL(baseURL).host])
  for (const id of ['a', 'b']) {
    const pairResponse = await gym(id, '/api/pair/create', { method: 'POST', body: '{}' })
    expect(pairResponse.status).toBe(200)
    const { code } = await pairResponse.json()
    const signedIn = await post('/api/auth/sign-in/opengym', { code })
    expect(signedIn.status).toBe(200)
    const cookie = cookieOf(signedIn)
    const session = await (await req('/api/auth/get-session', { headers: { cookie } })).json()
    accounts[id] = { cookie, user: session.user, code }
  }
}, 30_000)

afterAll(async () => {
  if (httpServer) { httpServer.closeAllConnections(); await new Promise(resolve => httpServer.close(resolve)) }
  runtime?.database.close()
  if (apiChild?.exitCode === null) { const exited = once(apiChild, 'exit'); apiChild.kill('SIGKILL'); await exited }
  if (directory) fs.rmSync(directory, { recursive: true, force: true })
})

async function makeClient(cookie) {
  return runtime.auth.api.createOAuthClient({ headers: new Headers({ cookie }), body: {
    client_name: 'Test client', redirect_uris: ['https://client.example/callback'], token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'openid offline_access opengym:tools'
  } })
}
function paramsFor(client, overrides = {}) {
  const verifier = crypto.randomBytes(32).toString('base64url')
  return { verifier, params: new URLSearchParams({ response_type: 'code', client_id: client.client_id,
    redirect_uri: 'https://client.example/callback', scope: 'openid offline_access opengym:tools', resource: runtime.resource,
    state: 'test-state', code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', ...overrides }) }
}
async function authorize(client, cookie, overrides = {}, accept = true) {
  const { params, verifier } = paramsFor(client, overrides)
  const response = await req('/api/auth/oauth2/authorize?' + params, { headers: { cookie, accept: 'text/html', 'sec-fetch-mode': 'navigate' } })
  expect([200, 302]).toContain(response.status)
  const data = response.status === 200 ? await response.json() : null
  let destination = new URL(data?.url || data?.redirect_uri || response.headers.get('location'), baseURL)
  if (destination.pathname === '/consent') {
    const consent = await post('/api/auth/oauth2/consent', { accept, oauth_query: destination.search.slice(1) }, cookie)
    expect(consent.status).toBe(200)
    const result = await consent.json()
    destination = new URL(result.url || result.redirect_uri, baseURL)
  }
  return { code: destination.searchParams.get('code'), verifier, destination }
}
const exchange = (client, auth, overrides = {}) => req('/api/auth/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: 'https://client.example/callback', resource: runtime.resource, code: auth.code, code_verifier: auth.verifier, ...overrides }) })
const tokenFor = async id => {
  const client = await makeClient(accounts[id].cookie)
  const auth = await authorize(client, accounts[id].cookie)
  const response = await exchange(client, auth)
  expect(response.status).toBe(200)
  return { client, auth, tokens: await response.json() }
}

it('validates HTTP configuration and forbids shared credentials', () => {
  expect(() => authSettings({})).toThrow('BETTER_AUTH_URL')
  expect(() => authSettings({ BETTER_AUTH_URL: 'http://public.example' })).toThrow('HTTPS')
  expect(() => authSettings({ BETTER_AUTH_URL: baseURL, BETTER_AUTH_SECRET: 'x' })).toThrow('32')
  expect(() => authSettings({ BETTER_AUTH_URL: baseURL, BETTER_AUTH_SECRET: secret, OPENGYM_URL: gymUrl, OPENGYM_TOKEN: 'shared' })).toThrow('per-user')
  expect(() => httpOptions({ MCP_HTTP_PORT: '-1' })).toThrow()
})
it('advertises public resource metadata, CIMD and PKCE and challenges unauthenticated calls', async () => {
  const resource = await (await req('/.well-known/oauth-protected-resource/mcp')).json()
  expect(resource.resource).toBe(runtime.resource)
  const metadata = await (await req('/.well-known/oauth-authorization-server/api/auth')).json()
  expect(metadata.client_id_metadata_document_supported).toBe(true)
  expect(metadata.code_challenge_methods_supported).toEqual(['S256'])
  expect(metadata.grant_types_supported).toEqual(['authorization_code', 'refresh_token'])
  expect(metadata.registration_endpoint).toBeUndefined()
  const denied = await req('/mcp')
  expect(denied.status).toBe(401)
  expect(denied.headers.get('www-authenticate')).toContain('resource_metadata=')
})
it('refuses invalid/replayed pairing codes, cross-origin mutations and host spoofing', async () => {
  expect((await post('/api/auth/sign-in/opengym', { code: accounts.a.code })).status).toBe(401)
  expect([401, 429]).toContain((await post('/api/auth/sign-in/opengym', { code: 'AAAAAAAA' })).status)
  expect((await req('/api/auth/sign-in/opengym', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{"code":"AAAAAAAA"}' })).status).toBe(403)
  const wrongHost = await new Promise((resolve, reject) => {
    const r = nodeRequest(baseURL + '/health', { headers: { host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode) })
    r.on('error', reject); r.end()
  })
  expect(wrongHost).toBe(403)
  expect((await req('/mcp', { headers: { origin: 'https://evil.example' } })).status).toBe(403)
  expect((await req('/consent?sig=forged')).status).toBe(400)
  expect((await req('/health')).status).toBe(200)
  runtime.database.exec('DELETE FROM rateLimit')
})
it('bounds unauthenticated auth request bodies', async () => {
  const response = await req('/api/auth/sign-in/opengym', { method: 'POST', headers: { origin: baseURL, 'content-type': 'application/json' }, body: 'x'.repeat(65537) })
  expect(response.status).toBe(413)
})

it('encrypts backend tokens and keeps credentials out of browser session JSON', async () => {
  const rows = runtime.database.prepare('SELECT * FROM gym_connection').all()
  expect(rows).toHaveLength(2)
  for (const row of rows) {
    expect(row.token).not.toContain(row.gym_uid + ':')
    expect(row.token).not.toBe(mint(row.gym_uid))
  }
  const session = await (await req('/api/auth/get-session', { headers: { cookie: accounts.a.cookie } })).json()
  expect(JSON.stringify(session)).not.toContain('gym_connection')
  expect(session.user.name).toBe('Alice')
})
it('executes concurrent MCP clients with separate account permissions and supports edits', async () => {
  await Promise.all(['a', 'b'].map(async id => {
    const { tokens } = await tokenFor(id)
    const client = new Client({ name: 'http-test-' + id, version: '1' })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(runtime.resource), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }))
      expect((await client.listTools()).tools).toHaveLength(91)
      const result = await client.callTool({ name: 'list_routines', arguments: {} })
      expect(JSON.parse(result.content[0].text).routines[0].name).toBe(`Routine ${id}`)
      const snapshot = JSON.parse((await client.callTool({ name: 'get_profile', arguments: {} })).content[0].text)
      const edited = await client.callTool({ name: 'edit_profile', arguments: { expected_rev: snapshot.rev, edits: [{ action: 'set', path: ['theme'], value: id === 'a' ? 'dark' : 'light' }] } })
      expect(edited.isError).toBeFalsy()
      const pairing = JSON.parse((await client.callTool({ name: 'call_api_operation', arguments: { operation_id: 'pairCreate' } })).content[0].text)
      const redeemed = await client.callTool({ name: 'call_api_operation', arguments: { operation_id: 'pairRedeem', body: { code: pairing.code } } })
      expect(redeemed.isError).toBeFalsy()
      expect(JSON.parse(redeemed.content[0].text).token).toBe('[kept on server]')
      const workflow = await client.callTool({ name: 'run_workflow', arguments: { steps: [
        { id: 'custom', tool: 'edit_profile', arguments: { edits: [{ action: 'upsert', collection: 'customEx', record: { id: 'http_bench', n: 'HTTP Bench', bp: 'chest', eq: 'barbell', tg: 'pectorals', custom: true } }] } },
        { id: 'save', tool: 'save_routine', depends_on: ['custom'], arguments: { name: 'HTTP ' + id, exercises: [{ exercise: { query: 'HTTP Bench' }, prescription: { sets: 3, reps: 8, weight: 40 } }], weekdays: [2] } },
        { id: 'preview', tool: 'preview_session', arguments: { routine_id: { $ref: 'save#/routine/id' } } },
        { id: 'config', tool: 'api_getConfig' }
      ] } })
      expect(workflow.isError).toBeFalsy()
      const outcomes = JSON.parse(workflow.content[0].text).results
      expect(outcomes.map(r => r.status)).toEqual(['ok', 'ok', 'ok', 'ok'])
      expect(outcomes[2].result.routine_name).toBe('HTTP ' + id)

    } finally { await client.close() }
  }))
  for (const id of ['a', 'b']) {
    const { state } = await (await gym(id, '/api/data')).json()
    expect(state.theme).toBe(id === 'a' ? 'dark' : 'light')
  }
})
it('rejects consent denial, wrong PKCE verifier, code replay, bad audience and missing scope', async () => {
  const client = await makeClient(accounts.a.cookie)
  const denied = await authorize(client, accounts.a.cookie, {}, false)
  expect(denied.code).toBeNull()
  expect(denied.destination.searchParams.get('error')).toBe('access_denied')
  const wrong = await authorize(client, accounts.a.cookie)
  expect((await exchange(client, wrong, { code_verifier: 'x'.repeat(43) })).status).toBeGreaterThanOrEqual(400)
  const valid = await tokenFor('a')
  expect((await exchange(valid.client, valid.auth)).status).toBeGreaterThanOrEqual(400)
  const forged = valid.tokens.access_token.slice(0, -8) + 'forgedxx'
  expect((await req('/mcp', { headers: { Authorization: `Bearer ${forged}` } })).status).toBe(401)
  const other = await authorize(client, accounts.a.cookie, { resource: baseURL + '/other' })
  expect(other.code).toBeNull()
  const limited = await authorize(client, accounts.a.cookie, { scope: 'openid' })
  const limitedTokens = await (await exchange(client, limited)).json()
  expect((await req('/mcp', { headers: { Authorization: `Bearer ${limitedTokens.access_token}` } })).status).toBe(403)
})
it('rejects correctly signed tokens with expired claims, wrong issuer, or wrong audience', async () => {
  const valid = { sub: accounts.a.user.id, iss: baseURL + '/api/auth', aud: runtime.resource, scope: 'opengym:tools' }
  for (const bad of [{ exp: Math.floor(Date.now() / 1000) - 60 }, { iss: 'https://other.example/api/auth' }, { aud: baseURL + '/other' }]) {
    const { token } = await runtime.auth.api.signJWT({ body: { payload: { ...valid, ...bad } } })
    expect((await req('/mcp', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401)
  }
})

it('accepts CIMD client metadata without manual client registration', async () => {
  const cimdDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-cimd-'))
  const fetched = []
  const metadataRuntime = await createAuth({ ...settings, databasePath: path.join(cimdDirectory, 'cimd.sqlite') }, {
    metadataFetch: async input => {
      const url = input instanceof Request ? input.url : String(input)
      fetched.push(url)
      return Response.json({ client_id: 'https://client.example/client.json', client_name: 'Metadata client',
        redirect_uris: ['https://client.example/callback'], token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] })
    }
  })
  try {
    const { params } = paramsFor({ client_id: 'https://client.example/client.json' })
    const response = await createHttpHandler(metadataRuntime)(new Request(baseURL + '/api/auth/oauth2/authorize?' + params, { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' } }))
    expect(response.status).toBe(302)
    expect(new URL(response.headers.get('location'), baseURL).pathname).toBe('/sign-in')
    expect(fetched).toContain('https://client.example/client.json')
  } finally { metadataRuntime.database.close(); fs.rmSync(cimdDirectory, { recursive: true, force: true }) }
})

it('serializes backend session renewal and persists the renewed token encrypted', async () => {
  const oldToken = mint('a')
  const encrypted = await symmetricEncrypt({ key: settings.secret, data: oldToken })
  runtime.database.prepare('UPDATE gym_connection SET token = ? WHERE user_id = ?').run(encrypted, accounts.a.user.id)
  const results = await Promise.all(Array.from({ length: 5 }, () => runtime.accountApi(accounts.a.user.id)))
  expect(new Set(results).size).toBe(1)
  const stored = runtime.database.prepare('SELECT token FROM gym_connection WHERE user_id = ?').get(accounts.a.user.id)
  const renewed = await symmetricDecrypt({ key: settings.secret, data: stored.token })
  expect(renewed).not.toBe(oldToken)
  expect(Number(renewed.split(':')[1])).toBeGreaterThan(Date.now() + 30 * 86400000)
})

it('rotates refresh grants and survives database restart', async () => {
  const { client, tokens } = await tokenFor('a')
  runtime.database.close()
  runtime = await createAuth(settings)
  const refresh = () => req('/api/auth/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token, resource: runtime.resource }) })
  const response = await refresh()
  expect(response.status).toBe(200)
  const rotated = await response.json()
  expect(rotated.refresh_token).not.toBe(tokens.refresh_token)
  expect((await refresh()).status).toBeGreaterThanOrEqual(400)
  expect((await runtime.accountApi(accounts.a.user.id)).request).toBeTypeOf('function')
})
it('resumes OAuth after pairing and requires explicit consent', async () => {
  const client = await makeClient(accounts.a.cookie)
  const { params } = paramsFor(client)
  const started = await req('/api/auth/oauth2/authorize?' + params, { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' } })
  expect([200, 302]).toContain(started.status)
  const data = started.status === 200 ? await started.json() : null
  const signInUrl = new URL(data?.url || data?.redirect_uri || started.headers.get('location'), baseURL)
  expect(signInUrl.pathname).toBe('/sign-in')
  const page = await req(signInUrl.pathname + signInUrl.search)
  expect(page.status).toBe(200)
  expect(await page.text()).toContain('Pairing code')
  const pair = await (await gym('a', '/api/pair/create', { method: 'POST', body: '{}' })).json()
  const signedIn = await post('/api/auth/sign-in/opengym', { code: pair.code, oauth_query: signInUrl.search.slice(1) })
  expect(signedIn.status).toBe(200)
  const next = await signedIn.json()
  const destination = new URL(next.url || next.redirect_uri, baseURL)
  expect(destination.pathname).toBe('/consent')
  expect(destination.searchParams.has('code')).toBe(false)
})
it('stops one user immediately after OpenGym sign-out-everywhere without affecting another', async () => {
  const [a, b] = await Promise.all(['a', 'b'].map(tokenFor))
  expect((await gym('a', '/api/logout/all', { method: 'POST', body: '{}' })).status).toBe(200)
  expect((await req('/mcp', { headers: { Authorization: `Bearer ${a.tokens.access_token}` } })).status).toBe(401)
  expect((await runtime.accountApi(accounts.b.user.id)).request).toBeTypeOf('function')
  const disconnected = await post('/api/auth/disconnect-opengym', {}, accounts.b.cookie)
  expect(disconnected.status).toBe(200)
  expect((await req('/mcp', { headers: { Authorization: `Bearer ${b.tokens.access_token}` } })).status).toBe(401)
})
