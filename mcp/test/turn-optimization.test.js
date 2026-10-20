import { describe, it, expect } from 'vitest'
import { z } from 'zod/v3'
import { performanceFixture, sampleExercises } from './performance-fixture.js'
import { nativeDefinitions, schemaToZod } from '../src/api-native-tools.js'
import { workflowTools } from '../src/workflow.js'
import { scenarios } from './turn-scenarios.js'

const routine = { name: 'Push A', exercises: [{ exercise: { query: 'Fixture Bench Press' }, prescription: { sets: 3, reps: 8, weight: 40 } }], weekdays: [1, 3], dates: ['2026-10-21'] }
const workout = { name: 'Workout A', date: '2026-10-20', start: 1000, end: 2000,
  entries: [{ exercise: { query: 'Fixture Bench Press' }, sets: [{ w: 40, r: 8, done: true }] }], bodyweight: 80 }
const step = (id, tool, arguments_ = {}, depends_on = []) => ({ id, tool, arguments: arguments_, depends_on })
const ref = path => ({ $ref: path })

describe('turn reductions and shared snapshots', () => {
  it('returns six analytics in one call with one profile and one identity GET', async () => {
    const f = performanceFixture({ delayMs: 5 })
    const result = await f.call('get_training_overview')
    expect(Object.keys(result)).toHaveLength(6)
    expect(f.metrics).toMatchObject({ tool_calls: 1, api_requests: 2, reads: 2, writes: 0, max_concurrency: 2 })
    expect(result.get_bodyweight.entries).toBeUndefined()
  })
  it('reuses the identity validated by HTTP auth without another identity round trip', async () => {
    const f = performanceFixture({ identity: true })
    await f.call('get_training_overview')
    expect(f.metrics.paths).toEqual(['GET /api/data'])
  })
  it('executes a mixed read batch with stable order, shared GETs, and isolated errors', async () => {
    const f = performanceFixture({ delayMs: 5, failPaths: ['/api/config'] })
    const result = await f.call('batch_read', { operations: [
      { tool: 'get_profile' }, { tool: 'list_routines' }, { tool: 'api_getData' },
      { tool: 'api_getConfig' }, { tool: 'api_getMe' }, { tool: 'api_getConfig' },
      { tool: 'edit_profile', arguments: { edits: [{ action: 'set', path: ['theme'], value: 'light' }] } }
    ] })
    expect(result.results.map(r => r.status)).toEqual(['ok', 'ok', 'ok', 'error', 'ok', 'error', 'error'])
    expect(f.metrics.paths.filter(path => path === 'GET /api/data')).toHaveLength(1)
    expect(f.metrics.paths.filter(path => path === 'GET /api/config')).toHaveLength(1)
    expect(f.metrics.writes).toBe(0)
  })
  it('bounds reads to four concurrent operations', async () => {
    const tools = Array.from({ length: 12 }, (_, i) => ({ name: 'r' + i, schema: {}, annotations: { readOnlyHint: true }, handler: async () => {
      active++; max = Math.max(max, active); await new Promise(resolve => setTimeout(resolve, 3)); active--; return i
    } }))
    let active = 0, max = 0
    const batch = workflowTools(tools)[0]
    const result = await batch.handler({ operations: tools.map(t => ({ tool: t.name, arguments: {} })) })
    expect(max).toBe(4)
    expect(result.results.map(r => r.result)).toEqual(Array.from({ length: 12 }, (_, i) => i))
  })
  it('does not keep profile caches between calls or across users', async () => {
    const f = performanceFixture()
    await f.call('get_profile')
    await f.call('edit_profile', { edits: [{ action: 'set', path: ['theme'], value: 'light' }] })
    expect((await f.call('get_profile')).state.theme).toBe('light')
    expect(f.metrics.reads).toBe(3)
    const other = performanceFixture({ state: { theme: 'other' } })
    expect((await other.call('get_profile')).state.theme).toBe('other')
  })
  it('edits multiple records/settings in one call without a prerequisite get_profile', async () => {
    const f = performanceFixture()
    await f.call('edit_profile', { edits: [
      { action: 'upsert', collection: 'bodyweight', record: { d: '2026-10-20', w: 80 } },
      { action: 'set', path: ['theme'], value: 'light' }
    ] })
    expect(f.metrics).toMatchObject({ tool_calls: 1, reads: 1, writes: 1 })
    expect(f.snapshot().bodyweight[0].w).toBe(80)
    await expect(f.call('edit_profile', { expected_rev: 1, edits: [{ action: 'set', path: ['theme'], value: 'dark' }] })).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

describe('combined resolve and write', () => {
  it('searches multiple names and schedules a routine with one read and one write', async () => {
    const f = performanceFixture()
    const result = await f.call('save_routine', routine)
    expect(result.status).toBe('saved')
    expect(result.routine.ex[0].id).toBe('cx_bench')
    expect(f.snapshot().week).toEqual({ 1: result.routine.id, 3: result.routine.id })
    expect(f.snapshot().dayPlan['2026-10-21']).toBe(result.routine.id)
    expect(f.metrics).toMatchObject({ tool_calls: 1, reads: 1, writes: 1 })
  })
  it('updates by unique routine name, preserving unrelated routine fields and other records', async () => {
    const f = performanceFixture({ state: { routines: [{ id: 'existing', name: 'Push A', emoji: 'X', ex: [] }, { id: 'other', name: 'Other', ex: [] }] } })
    const result = await f.call('save_routine', routine)
    expect(result.routine.id).toBe('existing')
    expect(result.routine.emoji).toBe('X')
    expect(f.snapshot().routines).toHaveLength(2)
  })
  it('resolves all exercises before writing; any ambiguity or miss writes nothing', async () => {
    const f = performanceFixture({ state: { customEx: [...sampleExercises, { ...sampleExercises[0], id: 'duplicate' }] } })
    const result = await f.call('save_routine', routine)
    expect(result.status).toBe('needs_selection')
    expect(f.metrics.writes).toBe(0)
    expect(f.snapshot().routines).toEqual([])
    const missing = await f.call('log_workout', { ...workout, entries: [{ ...workout.entries[0], exercise: { id: 'not-there' } }] })
    expect(missing.status).toBe('needs_selection')
    expect(f.metrics.writes).toBe(0)
    const accepted = await f.call('save_routine', { ...routine, first_match: true })
    expect(accepted.status).toBe('saved')
  })
  it('returns duplicate routine-name choices without writing', async () => {
    const f = performanceFixture({ state: { routines: [{ id: 'a', name: 'Push A' }, { id: 'b', name: 'push a' }] } })
    const result = await f.call('save_routine', routine)
    expect(result.status).toBe('needs_selection')
    expect(f.metrics.writes).toBe(0)
  })
  it('searches and appends exercises without reading/replacing existing rows externally', async () => {
    const f = performanceFixture({ state: { routines: [{ id: 'existing', name: 'Push A', ex: [{ id: 'cx_row', sets: 2, reps: 10, weight: 20 }] }] } })
    const result = await f.call('save_routine', { ...routine, exercise_mode: 'append' })
    expect(result.routine.ex.map(ex => ex.id)).toEqual(['cx_row', 'cx_bench'])
    expect(result.routine.ex[0].weight).toBe(20)
    expect(f.metrics).toMatchObject({ tool_calls: 1, reads: 1, writes: 1 })
    const updated = await f.call('save_routine', { routine_id: 'existing', exercise_mode: 'update', exercises: [{ exercise: { query: 'row' }, prescription: { weight: 30 } }] })
    expect(updated.routine.ex[0]).toMatchObject({ sets: 2, reps: 10, weight: 30 })
    const removed = await f.call('save_routine', { routine_id: 'existing', exercise_mode: 'remove', exercises: [{ exercise: { query: 'row' } }] })
    expect(removed.routine.ex.map(ex => ex.id)).toEqual(['cx_bench'])
  })
  it('schedules by routine name/ID and batches rest days without prerequisite lookups', async () => {
    const f = performanceFixture({ state: { routines: [{ id: 'push', name: 'Push' }, { id: 'pull', name: 'Pull' }], week: { 6: 'push' } } })
    await f.call('set_schedule', { assignments: [
      { weekday: 1, routines: ['Push', 'pull'] }, { date: '2026-10-21' }, { date: '2026-10-22', routines: ['Pull'] }
    ] })
    expect(f.snapshot().week).toEqual({ 1: ['push', 'pull'], 6: 'push' })
    expect(f.snapshot().dayPlan).toEqual({ '2026-10-21': 'rest', '2026-10-22': 'pull' })
    expect(f.metrics).toMatchObject({ tool_calls: 1, reads: 1, writes: 1 })
    const missing = await f.call('set_schedule', { assignments: [{ weekday: 2, routines: ['missing'] }] })
    expect(missing.status).toBe('needs_selection')
    expect(f.metrics.writes).toBe(1)
    await f.call('set_schedule', { queue: { routines: ['Push', 'Pull'], starts_on: '2026-10-20' } })
    expect(f.snapshot().queue.ids).toEqual(['push', 'pull'])
    await f.call('set_schedule', { clear_queue: true })
    expect(f.snapshot().queue).toBeUndefined()
  })
  it('logs a workout and weigh-in together; known ID updates rather than duplicates', async () => {
    const f = performanceFixture()
    const result = await f.call('log_workout', { ...workout, workout_id: 'stable' })
    expect(result.workout.entries[0].id).toBe('cx_bench')
    expect(f.snapshot().bodyweight).toHaveLength(1)
    await f.call('log_workout', { ...workout, workout_id: 'stable' })
    expect(f.snapshot().workouts).toHaveLength(1)
    await expect(f.call('log_workout', { ...workout, end: 0 })).rejects.toThrow('end')
  })
  it('resolves exercise batches once, supports filters, and refuses invalid reference shapes', async () => {
    const f = performanceFixture()
    const result = await f.call('resolve_exercises', { exercises: [{ query: 'fixture', equipment: 'barbell', muscle: 'chest' }, { id: 'cx_row' }] })
    expect(result.matches.map(m => m.selected.id)).toEqual(['cx_bench', 'cx_row'])
    expect(f.metrics.reads).toBe(1)
    await expect(f.call('resolve_exercises', { exercises: [{}] })).rejects.toThrow()
    await expect(f.call('resolve_exercises', { exercises: [{ id: 'cx_row', query: 'x' }] })).rejects.toThrow()
  })
})

describe('dependent and parallel workflow execution', () => {
  it('saves then previews using a result reference, fetching fresh state after the write', async () => {
    const f = performanceFixture()
    const result = await f.call('run_workflow', { steps: [
      step('save', 'save_routine', routine),
      step('preview', 'preview_session', { routine_id: ref('save#/routine/id') }),
      step('profile', 'get_profile', {}, ['save'])
    ] })
    expect(result.results.map(r => r.status)).toEqual(['ok', 'ok', 'ok'])
    expect(result.results[1].result.routine_id).toBe(result.results[0].result.routine.id)
    expect(result.results[2].result.state.routines).toHaveLength(1)
    expect(f.metrics).toMatchObject({ tool_calls: 1, reads: 3, writes: 1 })
  })
  it('blocks a write after ambiguous exercise resolution and labels the overall partial result', async () => {
    const f = performanceFixture()
    const result = await f.call('run_workflow', { steps: [
      step('resolve', 'resolve_exercises', { exercises: [{ id: 'missing' }] }),
      step('write', 'edit_profile', { edits: [{ action: 'set', path: ['theme'], value: ref('resolve#/matches/0/selected') }] })
    ] })
    expect(result.status).toBe('partial_failure')
    expect(result.results.map(r => r.status)).toEqual(['needs_selection', 'blocked'])
    expect(f.metrics.writes).toBe(0)
  })
  it('serializes writes so multiple explicit mutations do not conflict with each other', async () => {
    const f = performanceFixture({ delayMs: 5 })
    const result = await f.call('run_workflow', { steps: [
      step('a', 'edit_profile', { edits: [{ action: 'set', path: ['theme'], value: 'light' }] }),
      step('b', 'edit_profile', { edits: [{ action: 'set', path: ['sound'], value: false }] })
    ] })
    expect(result.results.map(r => r.status)).toEqual(['ok', 'ok'])
    expect(f.snapshot()).toMatchObject({ theme: 'light', sound: false })
    expect(f.metrics.max_concurrency).toBe(1)
  })
  it('blocks dependents after ambiguity/errors but continues independent branches', async () => {
    const f = performanceFixture()
    const result = await f.call('run_workflow', { steps: [
      step('missing', 'save_routine', { ...routine, exercises: [{ exercise: { id: 'absent' } }] }),
      step('blocked', 'preview_session', { routine_id: ref('missing#/routine/id') }),
      step('independent', 'api_getConfig')
    ] })
    expect(result.results.map(r => r.status)).toEqual(['needs_selection', 'blocked', 'ok'])
    expect(f.metrics.writes).toBe(0)
  })
  it.each([
    [step('a', 'get_profile'), step('a', 'get_profile')],
    [step('a', 'get_profile', {}, ['b']), step('b', 'get_profile', {}, ['a'])],
    [step('a', 'get_profile', {}, ['missing'])],
    [step('a', 'run_workflow')],
    [step('a', 'api_getConfig', { unknown: true })]
  ])('rejects invalid graphs/static arguments before effects', async (...steps) => {
    const f = performanceFixture()
    await expect(f.call('run_workflow', { steps })).rejects.toThrow()
    expect(f.metrics.api_requests).toBe(0)
  })
  it('reports missing reference values without another write and preserves earlier successful writes', async () => {
    const f = performanceFixture()
    const result = await f.call('run_workflow', { steps: [
      step('saved', 'save_routine', routine),
      step('bad', 'api_pairRedeem', { body: { code: ref('saved#/not-there') } })
    ] })
    expect(result.results.map(r => r.status)).toEqual(['ok', 'error'])
    expect(f.metrics.writes).toBe(1)
    expect(f.snapshot().routines).toHaveLength(1)
  })
})

describe('API operations require no discovery round trip', () => {
  it('exposes all 68 operations with concrete schemas and executes a direct operation in one call', async () => {
    expect(nativeDefinitions).toHaveLength(68)
    const f = performanceFixture()
    await f.call('api_getConfig')
    expect(f.metrics).toMatchObject({ tool_calls: 1, reads: 1 })
    const upload = nativeDefinitions.find(t => t.name === 'api_putMedia')
    expect(Object.keys(upload.schema)).toEqual(['path', 'base64', 'content_type'])
    await expect(f.call('api_putData', { body: { state: {} } })).rejects.toThrow()
  })
  it('converts references, required fields, extensible records, enums, bounds and nullable schemas', () => {
    const record = schemaToZod({ type: 'object', required: ['n'], properties: { n: { type: 'integer', minimum: 1 }, option: { enum: ['a', 'b'], nullable: true } } })
    expect(record.parse({ n: 1, future: true, option: null }).future).toBe(true)
    expect(() => record.parse({ n: 0 })).toThrow()
    const native = nativeDefinitions.find(t => t.name === 'api_getMedia')
    expect(() => z.object(native.schema).parse({ path: { hash: 'bad' } })).toThrow()
    expect(() => schemaToZod({ $ref: '#/components/schemas/Missing' })).toThrow('Missing')
  })
})

describe('scripted performance scenarios (parallel baselines)', () => {
  it.each(scenarios)('$name', async scenario => {
    const baseline = performanceFixture({ state: scenario.state })
    const optimized = performanceFixture({ state: scenario.state })
    await scenario.baseline(baseline)
    await scenario.optimized(optimized)
    expect(baseline.metrics.tool_calls).toBe(scenario.baseline_calls)
    expect(baseline.rounds).toBe(scenario.baseline_rounds)
    expect(optimized.metrics.tool_calls).toBe(1)
    expect(optimized.rounds).toBe(1)
    expect(optimized.metrics.api_requests).toBeLessThanOrEqual(baseline.metrics.api_requests)
    expect(optimized.snapshot().routines).toEqual(baseline.snapshot().routines)
    expect(optimized.snapshot().workouts).toEqual(baseline.snapshot().workouts)
    // Independent runs have different wall-clock stamps; all stored values must match.
    const weights = f => f.snapshot().bodyweight.map(({ t, ...value }) => value)
    expect(weights(optimized)).toEqual(weights(baseline))
    expect(optimized.snapshot().exWeights || {}).toEqual(baseline.snapshot().exWeights || {})
    expect(optimized.snapshot().week).toEqual(baseline.snapshot().week)
    expect(optimized.snapshot().theme).toBe(baseline.snapshot().theme)
  })
})
