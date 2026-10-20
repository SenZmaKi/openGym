import { applyTrainingActions } from '../../frontend/src/lib/training-actions.js'
/* Scripted dependency phases count model/server interaction rounds. Independent calls
   already run in parallel in the baseline; these are not measurements of an LLM. */
export const references = ['Fixture Bench Press', 'Fixture Cable Row', 'Fixture Squat']
const record = { id: 'plan-a', name: 'Plan A', ex: references.map((_, i) => ({ id: ['cx_bench', 'cx_row', 'cx_squat'][i], sets: 3, reps: 8, weight: 40 })) }
const saveRoutine = { routine_id: 'plan-a', name: 'Plan A', exercises: references.map(query => ({ exercise: { query }, prescription: { sets: 3, reps: 8, weight: 40 } })), weekdays: [1, 3] }
const workout = { name: 'Workout', date: '2026-10-20', start: 1000, end: 2000, entries: record.ex.map(ex => ({ id: ex.id, sets: [{ w: 40, r: 8, done: true }] })) }
const phaseSearch = f => references.map(query => ['search_exercises', { query }])
const editRoutine = rev => ({ expected_rev: rev, edits: [{ action: 'upsert', collection: 'routines', record }, { action: 'set', path: ['week', '1'], value: record.id }, { action: 'set', path: ['week', '3'], value: record.id }] })
const phase = async (f, calls) => { f.rounds = (f.rounds || 0) + 1; return Promise.all(calls.map(([name, args]) => f.call(name, args))) }
export const scenarios = [
  { name: 'Routine removal, unit conversion and measurement', baseline_calls: 3, baseline_rounds: 3, state: { routines: [record] },
    baseline: async f => {
      await phase(f, [['apply_training_actions', { actions: [{ action: 'delete_routine', routine_id: 'plan-a' }] }]])
      await phase(f, [['apply_training_actions', { actions: [{ action: 'convert_unit', unit: 'lb' }] }]])
      return phase(f, [['apply_training_actions', { actions: [{ action: 'save_measurement', date: '2026-10-20', entry: { waist: 80 } }] }]])
    },
    optimized: f => phase(f, [['apply_training_actions', { actions: [
      { action: 'delete_routine', routine_id: 'plan-a' }, { action: 'convert_unit', unit: 'lb' },
      { action: 'save_measurement', date: '2026-10-20', entry: { waist: 80 } }
    ] }]]) },
  { name: 'Six-part training overview', baseline_calls: 6, baseline_rounds: 1,
    baseline: f => phase(f, [['list_routines'], ['get_week_plan'], ['list_workouts'], ['get_bodyweight'], ['estimate_1rm'], ['muscle_balance', { period: 'week' }]]),
    optimized: f => phase(f, [['get_training_overview']]) },
  { name: 'Resolve three exercise names', baseline_calls: 3, baseline_rounds: 1,
    baseline: f => phase(f, phaseSearch(f)), optimized: f => phase(f, [['resolve_exercises', { exercises: references.map(query => ({ query })) }]]) },
  { name: 'Find exercises, create and schedule routine', baseline_calls: 5, baseline_rounds: 2,
    baseline: async f => { const results = await phase(f, [...phaseSearch(f), ['get_profile']]); return phase(f, [['edit_profile', editRoutine(results[3].rev)]]) },
    optimized: f => phase(f, [['save_routine', saveRoutine]]) },
  { name: 'Find exercises, log workout and weigh-in', baseline_calls: 5, baseline_rounds: 2,
    baseline: async f => { const results = await phase(f, [...phaseSearch(f), ['get_profile']]); return phase(f, [['edit_profile', { expected_rev: results[3].rev, edits: [
      ...(() => {
        const canonical = applyTrainingActions(results[3].state, [{ action: 'complete_workout', workout: { id: 'workout-a', d: workout.date, name: workout.name, start: workout.start, entries: workout.entries }, end: workout.end }]).state
        return [{ action: 'set', path: ['workouts'], value: canonical.workouts }, { action: 'set', path: ['exWeights'], value: canonical.exWeights }]
      })(), { action: 'upsert', collection: 'bodyweight', record: { d: workout.date, w: 80, t: Date.now() } }
    ] }]]) },
    optimized: f => phase(f, [['log_workout', { name: workout.name, date: workout.date, start: workout.start, end: workout.end, workout_id: 'workout-a', bodyweight: 80,
      entries: references.map(query => ({ exercise: { query }, sets: [{ w: 40, r: 8, done: true }] })) }]]) },
  { name: 'Create routine, schedule and preview', baseline_calls: 6, baseline_rounds: 3,
    baseline: async f => { const results = await phase(f, [...phaseSearch(f), ['get_profile']]); await phase(f, [['edit_profile', editRoutine(results[3].rev)]]); return phase(f, [['preview_session', { routine_id: 'plan-a' }]]) },
    optimized: f => phase(f, [['run_workflow', { steps: [
      { id: 'save', tool: 'save_routine', arguments: saveRoutine },
      { id: 'preview', tool: 'preview_session', arguments: { routine_id: { $ref: 'save#/routine/id' } } }
    ] }]]) },
  { name: 'Discover and execute configuration API', baseline_calls: 3, baseline_rounds: 3,
    baseline: async f => { await phase(f, [['list_api_operations', { search: 'config' }]]); await phase(f, [['get_api_operation', { operation_id: 'getConfig' }]]); return phase(f, [['call_api_operation', { operation_id: 'getConfig' }]]) },
    optimized: f => phase(f, [['api_getConfig']]) },
  { name: 'Pair code creation and redemption', baseline_calls: 2, baseline_rounds: 2,
    baseline: async f => { const [created] = await phase(f, [['call_api_operation', { operation_id: 'pairCreate' }]]); return phase(f, [['call_api_operation', { operation_id: 'pairRedeem', body: { code: created.code } }]]) },
    optimized: f => phase(f, [['run_workflow', { steps: [
      { id: 'create', tool: 'api_pairCreate' }, { id: 'redeem', tool: 'api_pairRedeem', arguments: { body: { code: { $ref: 'create#/code' } } } }
    ] }]]) },
  { name: 'Repeated configuration reads', baseline_calls: 6, baseline_rounds: 1,
    baseline: f => phase(f, Array.from({ length: 6 }, () => ['call_api_operation', { operation_id: 'getConfig' }])),
    optimized: f => phase(f, [['batch_read', { operations: Array.from({ length: 6 }, () => ({ tool: 'api_getConfig' })) }]]) },
  { name: 'Atomic weigh-in plus settings update', baseline_calls: 2, baseline_rounds: 2,
    baseline: async f => { const [profile] = await phase(f, [['get_profile']]); return phase(f, [['edit_profile', { expected_rev: profile.rev, edits: [
      { action: 'upsert', collection: 'bodyweight', record: { d: '2026-10-20', w: 80 } }, { action: 'set', path: ['theme'], value: 'light' }
    ] }]]) },
    optimized: f => phase(f, [['edit_profile', { edits: [
      { action: 'upsert', collection: 'bodyweight', record: { d: '2026-10-20', w: 80 } }, { action: 'set', path: ['theme'], value: 'light' }
    ] }]]) },
  { name: 'Search and append exercise to routine', baseline_calls: 3, baseline_rounds: 2, state: { routines: [{ ...record, ex: [record.ex[0]] }] },
    baseline: async f => { const [profile] = await phase(f, [['get_profile'], ['search_exercises', { query: 'Fixture Cable Row' }]]); return phase(f, [['edit_profile', { expected_rev: profile.rev, edits: [{ action: 'upsert', collection: 'routines', record: { ...record, ex: record.ex.slice(0, 2) } }] }]]) },
    optimized: f => phase(f, [['save_routine', { name: 'Plan A', exercise_mode: 'append', exercises: [{ exercise: { query: 'Fixture Cable Row' }, prescription: { sets: 3, reps: 8, weight: 40 } }] }]]) },
  { name: 'Assign routine by name plus rest day', baseline_calls: 2, baseline_rounds: 2, state: { routines: [record] },
    baseline: async f => { const [profile] = await phase(f, [['get_profile']]); return phase(f, [['edit_profile', { expected_rev: profile.rev, edits: [
      { action: 'set', path: ['week', '1'], value: ['plan-a'] }, { action: 'set', path: ['dayPlan', '2026-10-21'], value: 'rest' }
    ] }]]) },
    optimized: f => phase(f, [['set_schedule', { assignments: [{ weekday: 1, routines: ['Plan A'] }, { date: '2026-10-21' }] }]]) }

]
