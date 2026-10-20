import { describe, it, expect, vi, afterEach } from 'vitest'
import { applyTrainingActions, withTrainingCatalogue } from '../../frontend/src/lib/training-actions.js'
import { completeSession } from '../../frontend/src/lib/complete-session.js'
import { deleteRoutine, copyRoutine, replaceSlotExercise } from '../../frontend/src/lib/routines.js'
import { editCompletedSession, saveWorkoutEdit, deleteEditedWorkout } from '../../frontend/src/lib/session-edit.js'
import { convertStateUnit } from '../../frontend/src/lib/units.js'
import { saveRotation } from '../../frontend/src/lib/rotation.js'
import { EXIDX, registerCustom } from '../../frontend/src/lib/exercises.js'
import { performanceFixture, sampleExercises } from './performance-fixture.js'

const now = Date.parse('2026-10-20T12:00:00Z')
const options = { now, today: '2026-10-20' }
const initial = () => ({ unit: 'kg', routines: [{ id: 'r1', name: 'Push', ex: [{ id: 'cx_bench', weight: 40, sets: 3, reps: 8, note: 'keep' }] }],
  workouts: [], bodyweight: [], exWeights: {}, customEx: structuredClone(sampleExercises), week: { 1: ['r1', 'r2'], 3: 'r1' }, dayPlan: { '2026-10-21': 'r1', '2026-10-22': 'rest' } })
const workout = () => ({ id: 'w1', name: 'Push', d: '2026-10-20', start: now - 3600000, end: now, routineIds: ['r1'], entries: [{ id: 'cx_bench', sets: [{ w: 40, r: 8, done: true, rir: 2 }, { w: 80, r: 1, done: false }] }] })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); registerCustom([]) })

describe('shared training actions', () => {
  it('matches app routine deletion including scalar/list weekdays and date pointers', () => {
    const base = initial(), expected = structuredClone(base)
    deleteRoutine(expected, 'r1')
    const { state } = applyTrainingActions(base, [{ action: 'delete_routine', routine_id: 'r1' }], options)
    delete state._ts
    expect(state).toEqual(expected)
    expect(base.routines).toHaveLength(1)
  })
  it('copies deeply and uses the app swap policy', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now)
    vi.spyOn(Math, 'random').mockReturnValue(0.25)
    const base = initial()
    const { state } = applyTrainingActions(base, [{ action: 'copy_routine', routine_id: 'r1' }, { action: 'swap_routine_exercise', routine_id: 'r1', index: 0, exercise_id: 'cx_row' }], options)
    expect(state.routines[1]).toEqual(copyRoutine(base.routines[0]))
    const expected = withTrainingCatalogue(base, () => replaceSlotExercise(base.routines[0].ex[0], 'cx_row', base, 'r1'))
    expect(state.routines[0].ex[0]).toEqual(expected)
    state.routines[1].ex[0].weight = 999
    expect(base.routines[0].ex[0].weight).toBe(40)
    vi.restoreAllMocks()
  })
  it('rejects invalid permutations without touching the input', () => {
    const base = initial(), before = structuredClone(base)
    expect(() => applyTrainingActions(base, [{ action: 'delete_routine', routine_id: 'r1' }, { action: 'reorder_routine', routine_id: 'r1', order: [0, 0] }], options)).toThrow()
    expect(base).toEqual(before)
  })
  it('uses the app finish boundary for volume, PRs, muscle snapshots and working loads', () => {
    const base = initial(), w = workout(), expected = structuredClone(base)
    const saved = withTrainingCatalogue(base, () => completeSession(expected, w, { ...options, end: now }).workout)
    const result = applyTrainingActions(base, [{ action: 'complete_workout', workout: w, end: now }], options)
    expect(result.results[0]).toEqual(saved)
    expect(result.state.exWeights).toEqual({ cx_bench: { w: 40, d: w.d } })
    expect(saved.entries[0].sets[0].rir).toBe(2)
    expect(saved.entries[0].muscleSnapshot).toBeDefined()
    expect(saved.prs).toContain('cx_bench')
    expect(saved.vol).toBe(320)
    expect(result.state.active).toBeUndefined()
  })
  it('matches edit/delete helpers and repairs remembered weights after a correction', () => {
    const base = applyTrainingActions(initial(), [{ action: 'complete_workout', workout: workout(), end: now }], options).state
    const entries = [{ id: 'cx_bench', sets: [{ w: 20, r: 8, done: true }] }]
    const expected = structuredClone(base)
    withTrainingCatalogue(expected, () => { editCompletedSession(expected, 'w1').entries = entries; saveWorkoutEdit(expected, now) })
    const edited = applyTrainingActions(base, [{ action: 'edit_workout', workout_id: 'w1', entries }], options).state
    expect(edited.workouts).toEqual(expected.workouts)
    expect(edited.exWeights.cx_bench.w).toBe(20)
    withTrainingCatalogue(expected, () => { editCompletedSession(expected, 'w1'); deleteEditedWorkout(expected) })
    const deleted = applyTrainingActions(edited, [{ action: 'delete_workout', workout_id: 'w1' }], options).state
    expect(deleted.workouts).toEqual(expected.workouts)
    expect(deleted.exWeights).toEqual(expected.exWeights)
  })
  it('converts the entire profile using the app helper and stamps unit intent', () => {
    const base = initial(); base.bodyweight = [{ d: '2026-10-20', w: 80 }]
    const expected = withTrainingCatalogue(base, () => convertStateUnit(base, 'lb'))
    const { state } = applyTrainingActions(base, [{ action: 'convert_unit', unit: 'lb' }], options)
    expect(state.routines).toEqual(expected.routines)
    expect(state.bodyweight).toEqual(expected.bodyweight)
    expect(state.unit).toBe('lb')
    expect(state.unitSet).toEqual({ at: now, convert: true })
  })
  it('uses the owned rotation lifecycle', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now)
    vi.spyOn(Math, 'random').mockReturnValue(0.25)
    const base = initial(), expected = structuredClone(base)
    saveRotation(expected, ['r1'], 'Loop', options.today, now)
    const { state } = applyTrainingActions(base, [{ action: 'rotation', operation: 'save', routine_ids: ['r1'], label: 'Loop' }], options)
    expect(state.queue).toEqual(expected.queue)
    expect(state.rotation).toEqual(expected.rotation)
    vi.restoreAllMocks()
  })
  it('normalizes and merges partial measurement check-ins', () => {
    const { state } = applyTrainingActions(initial(), [
      { action: 'save_measurement', date: options.today, entry: { waist: 80 } },
      { action: 'save_measurement', date: options.today, entry: { chest: 95 } }
    ], options)
    expect(state.measurements).toHaveLength(1)
    expect(state.measurements[0]).toMatchObject({ waist: 80, chest: 95 })
  })
  it('preserves an existing catalogue even when an action fails', () => {
    registerCustom([{ id: 'prior-custom', n: 'Prior', custom: true }])
    expect(() => applyTrainingActions(initial(), [{ action: 'delete_workout', workout_id: 'missing' }], options)).toThrow()
    expect(EXIDX['prior-custom']?.n).toBe('Prior')
    expect(EXIDX.cx_bench).toBeUndefined()
  })
  it('backfills chronologically without raising confirmed working loads', () => {
    const base = initial()
    const recent = workout()
    const first = applyTrainingActions(base, [{ action: 'complete_workout', workout: recent, end: now }], options).state
    const older = { ...workout(), id: 'older', d: '2026-10-19', start: now - 86400000, backfill: {}, entries: [{ id: 'cx_bench', sets: [{ w: 60, r: 8, done: true }] }] }
    const { state } = applyTrainingActions(first, [{ action: 'complete_workout', workout: older, end: older.start + 1800000 }], options)
    expect(state.workouts.map(w => w.id)).toEqual(['older', 'w1'])
    expect(state.workouts[0].prs).toContain('cx_bench')
    expect(state.workouts[1].prs).not.toContain('cx_bench')
    expect(state.exWeights.cx_bench.w).toBe(40)
    expect(state.workouts[0].end - state.workouts[0].start).toBe(1800000)
  })
  it('refills an owned rotation when its final session finishes', () => {
    const base = applyTrainingActions(initial(), [{ action: 'rotation', operation: 'save', routine_ids: ['r1'] }], options).state
    const prior = base.queue.since
    const w = { ...workout(), start: now + 1000 }
    const { state } = applyTrainingActions(base, [{ action: 'complete_workout', workout: w, end: now + 3600000 }], { ...options, now: now + 3600000 })
    expect(state.queue.since).toBeGreaterThan(prior)
    expect(state.queue.startsOn).toBe('2026-10-21')
  })
  it('imports shared plans through the same parser and unit conversion', () => {
    const text = JSON.stringify({ opengym_plan: 1, unit: 'lb', routines: [{ id: 'source', name: 'Imported', ex: [{ id: 'cx_bench', sets: 3, reps: 8, weight: 88 }] }], week: { 1: ['source'] } })
    const { state } = applyTrainingActions(initial(), [{ action: 'import_plan', text, schedule: true }], options)
    expect(state.routines).toHaveLength(2)
    const imported = state.routines[1]
    expect(imported.name).toBe('Imported')
    expect(imported.ex[0].weight).toBe(40)
    expect(state.week[1]).toEqual([imported.id])
  })
  it('keeps history when duration is unchanged', () => {
    const base = initial(); base.workouts = [workout()]
    const result = applyTrainingActions(base, [{ action: 'set_workout_duration', workout_id: 'w1', minutes: 60 }], options)
    expect(result.state.workouts).toEqual(base.workouts)
  })
})

describe('MCP domain action transaction and turn cost', () => {
  it('does many operations in one model call, one read and one write', async () => {
    const f = performanceFixture({ state: initial() })
    const result = await f.call('apply_training_actions', { actions: [
      { action: 'copy_routine', routine_id: 'r1', name: 'Push 2' },
      { action: 'save_measurement', date: options.today, entry: { waist: 80 } },
      { action: 'convert_unit', unit: 'lb' },
      { action: 'delete_routine', routine_id: 'r1' }
    ] })
    expect(result.status).toBe('saved')
    expect(f.metrics).toMatchObject({ tool_calls: 1, reads: 1, writes: 1 })
    expect(f.snapshot().routines.map(r => r.name)).toEqual(['Push 2'])
    expect(f.snapshot().unit).toBe('lb')
  })
  it('surfaces a concurrent PUT conflict without retrying or overwriting', async () => {
    const f = performanceFixture({ state: initial() })
    const { saveTrainingActions } = await import('../src/domain-tools.js')
    let putAttempts = 0
    const racing = { request: async (path, opts) => {
      if (opts?.method === 'PUT') {
        putAttempts++
        await f.call('edit_profile', { edits: [{ action: 'set', path: ['theme'], value: 'concurrent' }] })
      }
      return f.api.request(path, opts)
    } }
    await expect(saveTrainingActions(racing, { actions: [{ action: 'delete_routine', routine_id: 'r1' }] })).rejects.toMatchObject({ status: 409 })
    expect(putAttempts).toBe(1)
    expect(f.snapshot().theme).toBe('concurrent')
    expect(f.snapshot().routines).toHaveLength(1)
  })
  it('writes nothing if a later action fails or the expected revision is stale', async () => {
    const f = performanceFixture({ state: initial() }), before = f.snapshot()
    await expect(f.call('apply_training_actions', { actions: [{ action: 'delete_routine', routine_id: 'r1' }, { action: 'delete_workout', workout_id: 'gone' }] })).rejects.toThrow()
    await expect(f.call('apply_training_actions', { expected_rev: 0, actions: [{ action: 'delete_routine', routine_id: 'r1' }] })).rejects.toThrow('Profile changed')
    expect(f.metrics.writes).toBe(0)
    expect(f.snapshot()).toEqual(before)
  })
})
