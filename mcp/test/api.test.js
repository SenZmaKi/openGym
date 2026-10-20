import { describe, it, expect, vi } from 'vitest'
import { createApi, operations, specification, ApiError } from '../src/api.js'
import { apiTools } from '../src/api-tools.js'
import { applyEdits, editProfile } from '../src/profile.js'
import { withRemoteState, getState, getUser } from '../src/state.js'

const mockApi = () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } }))
  return { ...createApi({ url: 'https://gym.example', token: 'private-token', fetchImpl }), fetchImpl }
}
describe('API gateway', () => {
  it('covers every documented method with unique operation IDs', () => {
    expect(operations.length).toBeGreaterThan(60)
    expect(new Set(operations.map(op => op.operationId)).size).toBe(operations.length)
    const methods = Object.values(specification.paths).flatMap(item => Object.keys(item).filter(k => ['get', 'post', 'put', 'patch', 'delete'].includes(k)))
    expect(operations).toHaveLength(methods.length)
  })
  it.each(['ftp://gym.example', 'https://user:pass@gym.example', 'https://gym.example/path', 'https://gym.example?token=x'])('rejects invalid origins %s', url => {
    expect(() => createApi({ url, token: 'secret' })).toThrow()
  })
  it('requires both remote credentials', () => {
    expect(() => createApi({ url: 'https://gym.example', token: '' })).toThrow('requires')
  })
  it('uses bearer auth, forbids redirects, and sends exact JSON without retry', async () => {
    const api = mockApi()
    await api.call({ operation_id: 'putData', body: { state: { routines: [] }, baseRev: 4, baseWid: 'write' } })
    const [url, options] = api.fetchImpl.mock.calls[0]
    expect(url.href).toBe('https://gym.example/api/data')
    expect(options.headers.Authorization).toBe('Bearer private-token')
    expect(options.redirect).toBe('error')
    expect(JSON.parse(options.body)).toEqual({ state: { routines: [] }, baseRev: 4, baseWid: 'write' })
    expect(api.fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('refuses unknown operations, query parameters, and unconditional state replacement', async () => {
    const api = mockApi()
    await expect(api.call({ operation_id: 'https://evil.example' })).rejects.toThrow('Unknown API operation')
    await expect(api.call({ operation_id: 'getData', query: { token: 'x' } })).rejects.toThrow('Unknown query')
    await expect(api.call({ operation_id: 'putData', body: { state: {} } })).rejects.toThrow('baseRev')
    expect(api.fetchImpl).not.toHaveBeenCalled()
  })
  it('refuses traversal path values and wrong media hashes', async () => {
    const api = mockApi()
    for (const hash of ['..', '../me', 'a?x=1', 'bad', '%2f']) {
      await expect(api.call({ operation_id: 'getMedia', path: { hash } })).rejects.toThrow('Invalid path')
    }
    expect(api.fetchImpl).not.toHaveBeenCalled()
  })
  it('supports binary downloads', async () => {
    const api = createApi({ url: 'http://localhost:3000', token: 't', fetchImpl: async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }) })
    expect(await api.call({ operation_id: 'getMedia', path: { hash: 'a'.repeat(64) } })).toEqual({ content_type: 'image/png', base64: 'AQID' })
  })
  it('returns HTTP failure details for agent recovery', async () => {
    const api = createApi({ url: 'https://gym.example', token: 't', fetchImpl: async () => new Response('{"error":"conflict","rev":7}', { status: 409, headers: { 'content-type': 'application/json' } }) })
    await expect(api.request('/api/data')).rejects.toMatchObject({ status: 409, code: 'HTTP_409', result: { error: 'conflict', rev: 7 } })
  })
  it('returns referenced operation schemas', () => {
    const tool = apiTools(mockApi()).find(t => t.name === 'get_api_operation')
    const result = tool.handler({ operation_id: 'getData' })
    expect(result.components.schemas.State).toBeDefined()
    expect(result.components.schemas.Workout).toBeDefined()
  })
})

describe('profile editing', () => {
  const original = { unit: 'kg', theme: 'dark', routines: [{ id: 'r', name: 'Old', entries: [], unknown: 1 }], workouts: [], bodyweight: [], week: { 1: 'r' }, edited: { theme: 50 }, other: { keep: true } }
  it('batches CRUD and nested settings without mutating the snapshot or unrelated fields', () => {
    const state = applyEdits(original, [
      { action: 'upsert', collection: 'routines', record: { id: 'r', name: 'New' } },
      { action: 'upsert', collection: 'bodyweight', record: { d: '2026-10-20', w: 80 } },
      { action: 'set', path: ['dayPlan', '2026-10-21'], value: 'rest' },
      { action: 'unset', path: ['week', '1'] }
    ])
    expect(original.routines[0].name).toBe('Old')
    expect(state.routines[0]).toEqual({ id: 'r', name: 'New', entries: [], unknown: 1 })
    expect(state.bodyweight).toEqual([{ d: '2026-10-20', w: 80 }])
    expect(state.dayPlan).toEqual({ '2026-10-21': 'rest' })
    expect(state.week).toEqual({})
    expect(state.other).toEqual(original.other)
    expect(state.edited).toEqual(original.edited)
  })
  it('removes records and allows complete array replacement', () => {
    const state = applyEdits(original, [{ action: 'remove', collection: 'routines', key: 'r' }, { action: 'set', path: ['favourites'], value: ['x'] }])
    expect(state.routines).toEqual([])
    expect(state.favourites).toEqual(['x'])
  })
  it.each(['active', '_rev', 'deleted', 'edited', 'resetAt', '__proto__', 'constructor'])('protects owned/unsafe path %s', key => {
    expect(() => applyEdits(original, [{ action: 'set', path: [key], value: {} }])).toThrow()
  })
  it('rejects prototype injection nested inside records', () => {
    expect(() => applyEdits(original, [{ action: 'upsert', collection: 'routines', record: JSON.parse('{"id":"r","nested":{"__proto__":{}}}') }])).toThrow('Unsafe key')
  })
  it('rejects incomplete values, malformed lists, unknown IDs, array traversal and unit reinterpretation', () => {
    for (const edit of [
      { action: 'set', path: ['theme'] },
      { action: 'set', path: ['routines'], value: [null] },
      { action: 'remove', collection: 'routines', key: 'missing' },
      { action: 'set', path: ['routines', '0', 'name'], value: 'x' },
      { action: 'set', path: ['unit'], value: 'lb' }
    ]) expect(() => applyEdits(original, [edit])).toThrow()
  })
  it('does not write a stale revision or write id', async () => {
    const api = { request: vi.fn(async () => ({ rev: 3, state: { ...original, _wid: 'new' } })) }
    for (const params of [{ expected_rev: 2 }, { expected_rev: 3, expected_wid: 'old' }]) {
      await expect(editProfile(api, { ...params, edits: [] })).rejects.toMatchObject({ code: 'CONFLICT' })
    }
    expect(api.request.mock.calls.every(([p]) => p === '/api/data')).toBe(true)
  })
  it('sends baseRev/baseWid and leaves stamping to the server', async () => {
    const api = { request: vi.fn().mockResolvedValueOnce({ rev: 3, state: { ...original, _wid: 'wid' } }).mockResolvedValueOnce({ ok: true, rev: 4 }) }
    await editProfile(api, { expected_rev: 3, edits: [{ action: 'set', path: ['theme'], value: 'light' }] })
    const body = api.request.mock.calls[1][1].body
    expect(body.baseRev).toBe(3)
    expect(body.baseWid).toBe('wid')
    expect(body.stamped).toBeUndefined()
    expect(body.state.theme).toBe('light')
  })
  it('does not retry a write conflict after the initial read', async () => {
    const api = { request: vi.fn().mockResolvedValueOnce({ rev: 3, state: original }).mockRejectedValueOnce(new ApiError(409, { error: 'conflict' })) }
    await expect(editProfile(api, { expected_rev: 3, edits: [{ action: 'set', path: ['theme'], value: 'light' }] })).rejects.toMatchObject({ status: 409 })
    expect(api.request).toHaveBeenCalledTimes(2)
  })
  it('isolates concurrent remote analytics contexts', async () => {
    await Promise.all(['a', 'b'].map(id => withRemoteState({ theme: id }, { id }, async () => {
      await Promise.resolve()
      expect(getState().theme).toBe(id)
      expect(getUser().id).toBe(id)
    })))
  })
})
