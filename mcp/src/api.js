/* One authenticated origin, using the same bearer session as a paired mobile device.
   Never write state files behind the API's cache/revision machinery. */
import fs from 'node:fs'
import yaml from 'js-yaml'

export const specification = yaml.load(fs.readFileSync(new URL('../../api/openapi.yaml', import.meta.url), 'utf8'))
const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options'])
export const operations = Object.entries(specification.paths).flatMap(([path, item]) =>
  Object.entries(item).filter(([method, op]) => methods.has(method) && op.operationId)
    .map(([method, op]) => ({ ...op, method: method.toUpperCase(), path,
      parameters: [...(item.parameters || []), ...(op.parameters || [])] })))

export function operationById(id) {
  const op = operations.find(op => op.operationId === id)
  if (!op) throw new Error(`Unknown API operation: ${id}. Use list_api_operations.`)
  return op
}

export class ApiError extends Error {
  constructor(status, result) {
    super(`openGym API returned ${status}`)
    this.code = `HTTP_${status}`
    this.status = status
    this.result = result
  }
}

export function createApi({ url = process.env.OPENGYM_URL, token = process.env.OPENGYM_TOKEN, fetchImpl = fetch } = {}) {
  if (!url || !token) throw new Error('API mode requires OPENGYM_URL and OPENGYM_TOKEN (a paired-device bearer token)')
  const base = new URL(url)
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || !['', '/'].includes(base.pathname)) {
    throw new Error('OPENGYM_URL must be an HTTP(S) origin, without credentials, a path, query or fragment')
  }
  async function request(path, { method = 'GET', body, contentType = 'application/json' } = {}) {
    // Paths are generated from the operation catalogue, never from a model-supplied URL.
    const target = new URL(path, base)
    if (target.origin !== base.origin || !target.pathname.startsWith('/api/')) throw new Error('Invalid API path')
    const headers = { Authorization: `Bearer ${token}` }
    if (body !== undefined) headers['Content-Type'] = contentType
    const response = await fetchImpl(target, {
      method, headers, body: body === undefined ? undefined : contentType === 'application/json' ? JSON.stringify(body) : body,
      redirect: 'error', signal: AbortSignal.timeout(30_000)
    })
    const type = response.headers.get('content-type') || ''
    const result = type.includes('application/json') ? await response.json()
      : { content_type: type, base64: Buffer.from(await response.arrayBuffer()).toString('base64') }
    if (!response.ok) throw new ApiError(response.status, result)
    return result
  }
  async function call({ operation_id, path = {}, query = {}, body, base64, content_type }, execute = request) {
    const op = operationById(operation_id)
    let route = op.path.replace(/\{([^}]+)\}/g, (_, key) => {
      const value = path[key]
      if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[/\\?#]/.test(value)) throw new Error(`Invalid path parameter: ${key}`)
      const param = op.parameters.find(p => p.in === 'path' && p.name === key)
      if (param?.schema?.pattern && !new RegExp(param.schema.pattern).test(value)) throw new Error(`Invalid path parameter: ${key}`)
      return encodeURIComponent(value)
    })
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (!op.parameters.some(p => p.in === 'query' && p.name === key)) throw new Error(`Unknown query parameter: ${key}`)
      for (const v of [].concat(value)) params.append(key, String(v))
    }
    if (params.size) route += '?' + params
    if (body !== undefined && base64 !== undefined) throw new Error('Supply body or base64, not both')
    // The normal state-save route must always quote the snapshot the caller read.
    if (op.method === 'PUT' && op.path === '/api/data' && (!Number.isInteger(body?.baseRev) || body.baseRev < 0 || !body?.state || typeof body.state !== 'object' || Array.isArray(body.state))) {
      throw new Error('putData requires state and baseRev from getData; prefer edit_profile for targeted changes')
    }
    let payload = body
    let type = 'application/json'
    if (base64 !== undefined) {
      if (!op.requestBody?.content?.[content_type] || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new Error('Invalid binary body or unsupported content_type')
      payload = Buffer.from(base64, 'base64')
      type = content_type
    }
    return execute(route, { method: op.method, body: payload, contentType: type })
  }
  return { request, call }
}
