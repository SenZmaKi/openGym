/* Real API + real MCP stdio client; only disposable fixture data and credentials. */
import { afterAll, beforeAll, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { boundPort } from '../../api/test/helpers.mjs'
import { createApi } from '../src/api.js'
import { png, sha } from '../../api/test/media-samples.mjs'

let child, directory, client, api, url, token
const root = fileURLToPath(new URL('../../', import.meta.url))
beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-mcp-test-'))
  const secret = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(path.join(directory, 'secret'), secret, { mode: 0o600 })
  fs.writeFileSync(path.join(directory, 'db.json'), JSON.stringify({ users: [{ id: 'mcp_test', name: 'MCP test' }], creds: [], subs: [], invites: [] }))
  const payload = `mcp_test:${Date.now() + 86400000}:0`
  token = payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url')
  child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(root, 'api'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: directory, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost', COACH_DISABLED: '1', ADMIN_UIDS: '', MEDIA_UPLOADS: '1', MEDIA_MIN_FREE_MB: '1' }
  })
  let log = ''
  child.stdout.on('data', d => { log += d })
  child.stderr.on('data', d => { log += d })
  url = `http://127.0.0.1:${await boundPort(child, () => log)}`
  api = createApi({ url, token })
  await api.call({ operation_id: 'putData', body: { baseRev: 0, state: {
    unit: 'kg', routines: [{ id: 'r1', name: 'Original', ex: [] }], workouts: [], bodyweight: [], customEx: [], week: {}, dayPlan: {}, unknownSetting: { keep: true }
  } } })
  client = new Client({ name: 'integration-test', version: '1.0.0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'mcp/src/index.js')],
    env: { ...process.env, OPENGYM_URL: url, OPENGYM_TOKEN: token, OPENGYM_DATA: '/does-not-exist' }, stderr: 'pipe' }))
}, 30_000)

afterAll(async () => {
  await client?.close()
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited }
  if (directory) fs.rmSync(directory, { recursive: true, force: true })
})
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args })
  return { error: result.isError, value: JSON.parse(result.content[0].text) }
}

it('exposes API tools, validates arguments, and uses remote state for existing analytics', async () => {
  const { tools } = await client.listTools()
  expect(tools).toHaveLength(91)
  expect(tools.find(t => t.name === 'edit_profile').annotations.destructiveHint).toBe(true)
  const routines = await call('list_routines')
  expect(routines.value.routines[0].name).toBe('Original')
  const invalid = await client.callTool({ name: 'edit_profile', arguments: { expected_rev: -1, edits: [] } })
  expect(invalid.isError).toBe(true)
  expect((await call('list_api_operations')).value).toHaveLength(68)
})

it('creates, edits and deletes profile records through MCP and records sync stamps', async () => {
  const before = (await call('get_profile')).value
  const result = await call('edit_profile', { expected_rev: before.rev, expected_wid: before.state._wid, edits: [
    { action: 'upsert', collection: 'routines', record: { id: 'r1', name: 'Updated' } },
    { action: 'upsert', collection: 'routines', record: { id: 'r2', name: 'New', ex: [] } },
    { action: 'upsert', collection: 'workouts', record: { id: 'w1', d: '2026-10-20', name: 'Updated', start: 1792497600000, end: 1792497660000, entries: [] } },
    { action: 'upsert', collection: 'bodyweight', record: { d: '2026-10-20', w: 80 } },
    { action: 'set', path: ['week', '1'], value: 'r2' },
    { action: 'set', path: ['theme'], value: 'light' }
  ] })
  expect(result.error).toBeFalsy()
  const next = (await call('get_profile')).value
  expect(next.rev).toBeGreaterThan(before.rev)
  expect(next.state.routines.find(r => r.id === 'r1').name).toBe('Updated')
  expect(next.state.routines.find(r => r.id === 'r1')._ts).toBeGreaterThan(0)
  expect(next.state.edited.theme).toBeGreaterThan(0)
  expect(next.state.edited['week.1']).toBeGreaterThan(0)
  expect(next.state.unknownSetting).toEqual({ keep: true })
  expect(next.state.bodyweight[0].w).toBe(80)
  const removed = await call('edit_profile', { expected_rev: next.rev, edits: [{ action: 'remove', collection: 'workouts', key: 'w1' }] })
  expect(removed.error).toBeFalsy()
  const final = await api.request('/api/data')
  expect(final.state.workouts).toEqual([])
  expect(final.state.deleted.workouts.w1).toBeGreaterThan(0)
  const stale = await call('edit_profile', { expected_rev: before.rev, edits: [{ action: 'set', path: ['theme'], value: 'dark' }] })
  expect(stale.error).toBe(true)
  expect(stale.value.code).toBe('CONFLICT')
  expect((await api.request('/api/data')).state.theme).toBe('light')
})

it('runs app-level actions over MCP and persists compatible sync records', async () => {
  const before = (await call('get_profile')).value
  const result = await call('apply_training_actions', { expected_rev: before.rev, actions: [
    { action: 'copy_routine', routine_id: 'r2', name: 'Domain copy' },
    { action: 'save_measurement', date: '2026-10-20', entry: { waist: 82, chest: 98 } },
    { action: 'delete_routine', routine_id: 'r2' }
  ] })
  expect(result.error).toBeFalsy()
  const next = await api.request('/api/data')
  expect(next.state.routines.some(r => r.name === 'Domain copy')).toBe(true)
  expect(next.state.routines.some(r => r.id === 'r2')).toBe(false)
  expect(next.state.week['1']).toBeUndefined()
  expect(next.state.deleted.routines.r2).toBeGreaterThan(0)
  expect(next.state.measurements[0]).toMatchObject({ d: '2026-10-20', waist: 82, chest: 98 })
  expect(next.state.active).toBeUndefined()
  const failed = await call('apply_training_actions', { actions: [
    { action: 'delete_routine', routine_id: 'r1' }, { action: 'delete_workout', workout_id: 'missing' }
  ] })
  expect(failed.error).toBe(true)
  expect((await api.request('/api/data')).rev).toBe(next.rev)
})

it('retains server permission checks and searches the exercise catalogue', async () => {
  const admin = await call('call_api_operation', { operation_id: 'adminUsers' })
  expect(admin.error).toBe(true)
  expect(admin.value.status).toBe(403)
  const search = await call('search_exercises', { query: 'bench press', limit: 3 })
  expect(search.error).toBeFalsy()
  expect(search.value.total).toBeGreaterThan(0)
  expect(search.value.exercises).toHaveLength(3)
})

it('uploads and downloads binary media through the actual API gateway', async () => {
  const bytes = png(100)
  const hash = sha(bytes)
  const upload = await call('call_api_operation', { operation_id: 'putMedia', path: { hash }, base64: bytes.toString('base64'), content_type: 'image/png' })
  expect(upload.error).toBeFalsy()
  expect(upload.value.hash).toBe(hash)
  const download = await call('call_api_operation', { operation_id: 'getMedia', path: { hash } })
  expect(download.error).toBeFalsy()
  expect(download.value.content_type).toBe('image/png')
  expect(Buffer.from(download.value.base64, 'base64')).toEqual(bytes)
})

it('keeps local stdio mode read-only and does not require remote credentials', async () => {
  const local = new Client({ name: 'local-test', version: '1.0.0' })
  try {
    await local.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'mcp/src/index.js')],
      env: { ...process.env, OPENGYM_URL: '', OPENGYM_TOKEN: '', OPENGYM_DATA: directory, OPENGYM_UID: 'mcp_test' }, stderr: 'pipe' }))
    const { tools } = await local.listTools()
    expect(tools).toHaveLength(12)
    expect(tools.every(t => t.annotations.readOnlyHint)).toBe(true)
    const result = await local.callTool({ name: 'list_routines', arguments: {} })
    expect(result.isError).toBeFalsy()
    expect(JSON.parse(result.content[0].text).routines.find(r => r.id === 'r1').name).toBe('Updated')
  } finally { await local.close() }
})
