/* A cache lives for one MCP call only. Writes invalidate it; tenants never share it. */
export function readScope(api) {
  const cache = new Map()
  if (api.identity) cache.set('/api/me', Promise.resolve({ user: api.identity }))
  async function request(path, options = {}) {
    if ((options.method || 'GET') !== 'GET') {
      cache.clear()
      try { return await api.request(path, options) } finally { cache.clear() }
    }
    if (options.body !== undefined) return api.request(path, options)
    if (!cache.has(path)) cache.set(path, Promise.resolve().then(() => api.request(path, options)))
    return cache.get(path)
  }
  return { ...api, request, call: params => api.call(params, request) }
}
