import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ApiError } from './api.js'
import { createTools } from './toolset.js'
import { readScope } from './read-scope.js'
import { getState, getUser, withRemoteState } from './state.js'

export function createMcpServer(api = null) {
  const server = new McpServer({ name: 'opengym', version: '0.2.0' })
  for (const t of createTools(api)) {
    server.registerTool(t.name, { description: t.description, inputSchema: t.schema, annotations: t.annotations }, async params => {
      try {
        // Scope memoization to this invocation, never to the server or authenticated account.
        const tool = createTools(api ? readScope(api) : null).find(tool => tool.name === t.name)
        const result = api ? await tool.handler(params || {})
          : await withRemoteState(getState(), getUser(), () => tool.handler(params || {}))
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: err.code || 'ERROR', message: err.message,
          ...(err instanceof ApiError ? { status: err.status, response: err.result } : {}) }) }] }
      }
    })
  }
  return server
}
