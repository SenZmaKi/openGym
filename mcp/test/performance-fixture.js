/* Deterministic simulated backend for request-count/concurrency tests and benchmarks.
   The production API client and production tools are used; network time is simulated. */
import { createApi } from '../src/api.js'
import { createTools } from '../src/toolset.js'
import { readScope } from '../src/read-scope.js'
import { invoke } from '../src/workflow.js'

export const sampleExercises = [
  { id: 'cx_bench', n: 'Fixture Bench Press', bp: 'chest', eq: 'barbell', tg: 'pectorals', custom: true },
  { id: 'cx_row', n: 'Fixture Cable Row', bp: 'back', eq: 'cable', tg: 'back', custom: true },
  { id: 'cx_squat', n: 'Fixture Squat', bp: 'upper legs', eq: 'barbell', tg: 'quadriceps', custom: true }
]
export function performanceFixture({ state: initial, delayMs = 0, failPaths = [], identity = false } = {}) {
  let state = { unit: 'kg', theme: 'dark', routines: [], workouts: [], bodyweight: [], customEx: structuredClone(sampleExercises), week: {}, dayPlan: {}, _rev: 1, _wid: 'write-1', ...structuredClone(initial || {}) }
  let active = 0
  const metrics = { tool_calls: 0, api_requests: 0, reads: 0, writes: 0, max_concurrency: 0, paths: [] }
  const api = createApi({ url: 'https://gym.fixture', token: 'fixture-token', fetchImpl: async (url, options) => {
    const method = options.method || 'GET'
    const path = url.pathname
    metrics.api_requests++; metrics.paths.push(method + ' ' + path)
    metrics[method === 'GET' ? 'reads' : 'writes']++
    active++; metrics.max_concurrency = Math.max(metrics.max_concurrency, active)
    const respond = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
    try {
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs))
      if (failPaths.includes(path)) return respond({ error: 'fixture failure' }, 503)
      if (path === '/api/me') return respond({ user: { id: 'fixture-user', name: 'Fixture' } })
      if (path === '/api/data' && method === 'GET') return respond({ state, rev: state._rev })
      if (path === '/api/data' && method === 'PUT') {
        const body = JSON.parse(options.body)
        if (body.baseRev !== state._rev || (body.baseWid && body.baseWid !== state._wid)) return respond({ error: 'conflict', state, rev: state._rev }, 409)
        state = { ...body.state, _rev: state._rev + 1, _wid: 'write-' + (state._rev + 1) }
        return respond({ ok: true, rev: state._rev, wid: state._wid })
      }
      if (path === '/api/pair/create') return respond({ code: 'FIXTURE2' })
      if (path === '/api/pair/redeem') return respond({ token: 'fixture-paired', redeemed: JSON.parse(options.body).code })
      return respond({ fixture: path, ok: true })
    } finally { active-- }
  } })
  if (identity) api.identity = { id: 'fixture-user', name: 'Fixture' }
  return { api, metrics, snapshot: () => structuredClone(state),
    call: async (name, arguments_ = {}) => {
      metrics.tool_calls++
      return invoke(createTools(readScope(api)).find(tool => tool.name === name), arguments_)
    }
  }
}
