import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { requireMcpAuth } from '@better-auth/mcp'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { createAuth } from './auth.js'
import { createMcpServer } from './server.js'
import { createWebAuth } from './web-auth.js'

export function httpOptions(env = process.env) {
  const port = Number(env.MCP_HTTP_PORT ?? 3001)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid MCP_HTTP_PORT')
  return { host: env.MCP_HTTP_HOST || '127.0.0.1', port }
}

export function createHttpHandler(runtime) {
  const protectedMcp = requireMcpAuth(runtime.auth, async (request, claims) => {
    if (typeof claims.sub !== 'string' || !claims.sub) return new Response('User authorization required', { status: 401 })
    let api
    try { api = await runtime.accountApi(claims.sub) }
    catch { return new Response('Reconnect OpenGym on the MCP sign-in page', { status: 401 }) }
    // Fresh server/transport per request: no shared tool closures or cross-user sessions.
    const server = createMcpServer({ ...api, call: async (params, execute) => {
      const result = await api.call(params, execute)
      // API operations that issue paired sessions must not expose backend bearer tokens.
      if (result && typeof result === 'object' && Object.hasOwn(result, 'token')) {
        const { token, ...rest } = result
        return { ...rest, token: '[kept on server]' }
      }
      return result
    } })
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    try {
      await server.connect(transport)
      return await transport.handleRequest(request)
    } finally { await server.close() }
  }, { resource: runtime.resource, requiredScopes: ['opengym:tools'] })
  const web = createWebAuth(runtime)
  const clientEndpoints = new Set(['/api/auth/oauth2/token', '/api/auth/oauth2/introspect', '/api/auth/oauth2/revoke'])
  return async input => {
    const incoming = new URL(input.url)
    const request = new Request(runtime.baseURL + incoming.pathname + incoming.search, input)
    const url = new URL(request.url)
    const origin = request.headers.get('origin')
    if (url.pathname === '/mcp' && origin && origin !== runtime.baseURL) return new Response('Invalid origin', { status: 403 })
    if (request.method !== 'GET' && request.method !== 'HEAD' && url.pathname.startsWith('/api/auth/') && !clientEndpoints.has(url.pathname) && origin !== runtime.baseURL) return new Response('Invalid origin', { status: 403 })
    let response
    if (url.pathname === '/health' && request.method === 'GET') response = new Response('ok')
    else if (url.pathname === '/mcp') response = await protectedMcp(request)
    else if (url.pathname.startsWith('/api/auth/') || url.pathname.startsWith('/.well-known/')) response = await runtime.auth.handler(request)
    else response = await web(request) || new Response('Not found', { status: 404 })
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Referrer-Policy', 'no-referrer')
    response.headers.set('X-Content-Type-Options', 'nosniff')
    response.headers.set('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
    return response
  }
}

// Bounded Node adapter; preserve every Set-Cookie needed by OAuth state/session handling.
export function toNodeHandler(handler, allowedHosts) {
  return async (req, res) => {
    try {
      if (!allowedHosts.includes(req.headers.host)) { res.writeHead(403).end('Invalid host'); return }
      const controller = new AbortController()
      res.once('close', () => { if (!res.writableFinished) controller.abort() })
      const maxBody = req.url?.split('?')[0] === '/mcp' ? 64 * 1024 * 1024 : 64 * 1024
      if (Number(req.headers['content-length']) > maxBody) { res.writeHead(413, { Connection: 'close' }).end(); return }
      const chunks = []
      let size = 0
      // Keep-alive requests with rejected oversized bodies must close the connection.
      for await (const chunk of req) {
        size += chunk.length
        if (size > maxBody) { res.writeHead(413, { Connection: 'close' }).end(); return }
        chunks.push(chunk)
      }
      const body = Buffer.concat(chunks)
      const headers = new Headers()
      for (const [key, value] of Object.entries(req.headers)) for (const v of [].concat(value || [])) headers.append(key, v)
      headers.set('x-opengym-client-ip', req.socket.remoteAddress || 'unknown')
      const request = new Request('http://' + req.headers.host + req.url, {
        method: req.method, headers, signal: controller.signal,
        ...(!['GET', 'HEAD'].includes(req.method) ? { body } : {})
      })
      const response = await handler(request)
      for (const [name, value] of response.headers) if (name !== 'set-cookie') res.setHeader(name, value)
      const cookies = response.headers.getSetCookie()
      if (cookies.length) res.setHeader('Set-Cookie', cookies)
      res.writeHead(response.status)
      if (response.body) await pipeline(Readable.fromWeb(response.body), res)
      else res.end()
    } catch {
      if (!res.headersSent) res.writeHead(500)
      if (!res.destroyed) res.end()
      console.error('[opengym-mcp] HTTP request failed')
    }
  }
}

export async function serveHttp(options = httpOptions(), suppliedRuntime) {
  const runtime = suppliedRuntime || await createAuth()
  const allowedHosts = [new URL(runtime.baseURL).host]
  const handler = toNodeHandler(createHttpHandler(runtime), allowedHosts)
  const server = createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') { res.writeHead(200).end('ok'); return }
    void handler(req, res)
  })
  server.requestTimeout = 30_000
  server.headersTimeout = 15_000
  server.on('listening', () => {
    const address = server.address()
    if (['127.0.0.1', '::1'].includes(address.address)) allowedHosts.push(`127.0.0.1:${address.port}`, `localhost:${address.port}`, `[::1]:${address.port}`)
    console.error(`[opengym-mcp] HTTP listening on ${address.port}`)
  })
  if (!suppliedRuntime) server.once('close', () => runtime.database.close())
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port, options.host, resolve) })
    return server
  } catch (error) { if (!suppliedRuntime) runtime.database.close(); throw error }
}
