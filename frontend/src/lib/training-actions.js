// Synchronous, transport-independent operations. Work on a private draft so a failed
// action never changes the caller's snapshot. Persist only after the whole batch succeeds.
import { EXIDX, isCustomEx, registerCustom } from './exercises.js'
import { copyRoutine, deleteRoutine, replaceSlotExercise } from './routines.js'
import { editCompletedSession, saveWorkoutEdit, deleteEditedWorkout } from './session-edit.js'
import { completeSession } from './complete-session.js'
import { moveWorkout, setWorkoutDuration, legacySyncKey } from './workout-date.js'
import { convertStateUnit } from './units.js'
import { highestStamp } from './sync-merge.js'
import { saveRotation, startPass, startNewPass, stopPass, chooseRotation, chooseFixedWeek, refillIfComplete } from './rotation.js'
import { normalizeMeasurementsState } from './measurements.js'
import { parseImport, mergeImport } from './import-csv.js'
import { parsePlan, mergePlan } from './plan-share.js'

export function withTrainingCatalogue(state, run) {
  const previous = Object.values(EXIDX).filter(isCustomEx)
  registerCustom(state.customEx || [])
  try { return run() } finally { registerCustom(previous) }
}
const requireRecord = (list, id, kind) => {
  const found = (list || []).find(x => (x.id ?? legacySyncKey(x)) === id)
  if (!found) throw new Error(`${kind} not found: ${id}`)
  return found
}

export function applyTrainingActions(snapshot, actions, { now = Date.now(), today } = {}) {
  let state = structuredClone(snapshot || {})
  // Active sessions are device-owned and never published in the synced document.
  delete state.active
  for (const k of ['routines', 'workouts', 'bodyweight', 'customEx']) state[k] ??= []
  for (const k of ['exWeights', 'week', 'dayPlan']) state[k] ??= {}
  const results = []
  for (const a of actions) withTrainingCatalogue(state, () => {
    let value
    switch (a.action) {
      case 'copy_routine': {
        value = copyRoutine(requireRecord(state.routines, a.routine_id, 'Routine'))
        if (a.name !== undefined) value.name = a.name
        state.routines.push(value)
        break
      }
      case 'delete_routine':
        requireRecord(state.routines, a.routine_id, 'Routine')
        value = deleteRoutine(state, a.routine_id)
        break
      case 'swap_routine_exercise': {
        const r = requireRecord(state.routines, a.routine_id, 'Routine')
        if (!r.ex?.[a.index]) throw new Error('Routine slot not found')
        if (!EXIDX[a.exercise_id]) throw new Error('Exercise not found')
        r.ex[a.index] = replaceSlotExercise(r.ex[a.index], a.exercise_id, state, r.id)
        value = r
        break
      }
      case 'reorder_routine': {
        const r = requireRecord(state.routines, a.routine_id, 'Routine')
        if (a.order.length !== r.ex.length || new Set(a.order).size !== r.ex.length || a.order.some(i => !Number.isInteger(i) || i < 0 || i >= r.ex.length)) throw new Error('order must be a permutation of all slot indices')
        r.ex = a.order.map(i => r.ex[i])
        value = r
        break
      }
      case 'edit_workout': {
        const active = editCompletedSession(state, a.workout_id)
        for (const key of ['name', 'note', 'bw', 'entries']) if (Object.hasOwn(a, key)) active[key] = structuredClone(a[key])
        value = saveWorkoutEdit(state, now)
        break
      }
      case 'delete_workout':
        editCompletedSession(state, a.workout_id)
        value = deleteEditedWorkout(state)
        break
      case 'move_workout': {
        const ref = requireRecord(state.workouts, a.workout_id, 'Workout')
        state.workouts = moveWorkout(state.workouts, ref, a.date, a.time, now)
        value = requireRecord(state.workouts, a.workout_id, 'Workout')
        break
      }
      case 'set_workout_duration': {
        const ref = requireRecord(state.workouts, a.workout_id, 'Workout')
        state.workouts = setWorkoutDuration(state.workouts, ref, a.minutes, now) || state.workouts
        value = requireRecord(state.workouts, a.workout_id, 'Workout')
        break
      }
      case 'complete_workout': {
        if (state.workouts.some(w => w.id === a.workout.id)) throw new Error('Workout already exists; edit it instead')
        if (!a.workout.entries?.some(e => e.sets?.some(s => s.done || s.sides?.L?.done || s.sides?.R?.done))) throw new Error('Nothing logged yet')
        value = completeSession(state, a.workout, { now, end: a.end, today }).workout
        break
      }
      case 'convert_unit': {
        if (state.unit === a.unit) { value = { unit: a.unit }; break }
        const stamp = Math.max(now, highestStamp(state) + 1)
        state = convertStateUnit(state, a.unit)
        state.unitSet = { at: stamp, convert: true }
        value = { unit: state.unit }
        break
      }
      case 'rotation': {
        const day = a.today || today
        if (a.operation === 'save') {
          if (!a.routine_ids?.length) throw new Error('save requires routine_ids')
          a.routine_ids.forEach(id => requireRecord(state.routines, id, 'Routine'))
          value = saveRotation(state, a.routine_ids, a.label, day, now)
        } else if (a.operation === 'start') value = startPass(state, day, now)
        else if (a.operation === 'restart') value = startNewPass(state, day, now)
        else if (a.operation === 'stop') value = stopPass(state, day)
        else if (a.operation === 'choose_rotation') value = chooseRotation(state, day, now)
        else if (a.operation === 'choose_week') value = chooseFixedWeek(state, day)
        else if (a.operation === 'refill') value = refillIfComplete(state, day, now)
        else throw new Error('Unknown rotation operation')
        value = { result: value, rotation: state.rotation, queue: state.queue, scheduleMode: state.scheduleMode }
        break
      }
      case 'save_measurement':
        state.measurements ??= []
        state.measurements.push({ ...a.entry, d: a.date, t: now })
        normalizeMeasurementsState(state)
        value = state.measurements.find(e => e.d === a.date)
        break
      case 'delete_measurement':
        state.measurements = (state.measurements || []).filter(e => e.d !== a.date)
        value = { date: a.date }
        break
      case 'import_plan':
        value = mergePlan(state, parsePlan(a.text, state.unit || 'kg'), { schedule: a.schedule })
        break
      case 'import_csv': {
        const parsed = parseImport(a.text, { unit: state.unit || 'kg', customEx: state.customEx })
        if (parsed.error) throw new Error(parsed.error)
        value = mergeImport(state, parsed)
        break
      }
      default: throw new Error(`Unknown training action: ${a.action}`)
    }
    results.push(structuredClone(value ?? null))
    delete state.active
  })
  state._ts = now
  return { state, results }
}
