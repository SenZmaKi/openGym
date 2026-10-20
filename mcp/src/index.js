#!/usr/bin/env node
/* Local analytics, paired API stdio, or multi-user OAuth-protected HTTP. */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { init, getUser } from './state.js'
import { createApi } from './api.js'
import { createMcpServer } from './server.js'

if (process.env.MCP_TRANSPORT === 'http') {
  const { serveHttp } = await import('./http.js')
  await serveHttp()
} else {
  if (process.env.MCP_TRANSPORT && process.env.MCP_TRANSPORT !== 'stdio') throw new Error('MCP_TRANSPORT must be stdio or http')
  const remote = Boolean(process.env.OPENGYM_URL || process.env.OPENGYM_TOKEN)
  const api = remote ? createApi() : null
  if (!remote) {
    try {
      init()
      const u = getUser()
      console.error(`[opengym-mcp] serving local read-only profile ${u.name} (${u.id})`)
    } catch (err) { console.error(`[opengym-mcp] ${err.message}`) }
  } else console.error('[opengym-mcp] authenticated API mode')
  await createMcpServer(api).connect(new StdioServerTransport())
}
