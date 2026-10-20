import { randomUUID } from 'node:crypto'
import { z } from 'zod/v3'
import { resolveExercises } from './exercise-search.js'
import { applyEdits } from './profile.js'
import { saveTrainingActions } from './domain-tools.js'

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(value + 'T12:00:00Z')
  return !Number.isNaN(+parsed) && parsed.toISOString().slice(0, 10) === value
}, 'Invalid calendar date')
export const exerciseReference = z.object({ id: z.string().min(1).optional(), query: z.string().trim().min(1).optional(), equipment: z.string().optional(), muscle: z.string().optional() })
  .refine(value => Boolean(value.id) !== Boolean(value.query), 'Supply exactly one of id or query')
const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
const write = { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
const expected = { expected_rev: z.number().int().nonnegative().optional(), expected_wid: z.string().optional() }
// Keep the common fields visible in tool metadata so the model need not inspect a
// profile to learn the shape. Passthrough preserves the app's extensible fields.
const prescription = z.object({
  sets: z.number().int().positive().optional(), reps: z.number().nonnegative().optional(), weight: z.number().optional(),
  mode: z.enum(['reps', 'time', 'cardio']).optional(), sec: z.number().nonnegative().optional(),
  min: z.number().nonnegative().optional(), speed: z.number().nonnegative().optional(), restSec: z.number().nonnegative().optional(),
  prog: z.string().optional(), sg: z.string().optional()
}).passthrough()
const workoutSet = z.object({ w: z.number().optional(), r: z.number().nonnegative().optional(), done: z.boolean().optional(),
  sec: z.number().nonnegative().optional(), min: z.number().nonnegative().optional(), speed: z.number().nonnegative().optional(),
  phase: z.enum(['work', 'warmup']).optional(), rir: z.number().optional(), rpe: z.number().optional(), failure: z.boolean().optional()
}).passthrough()


function assertRevision(current, params) {
  if ((params.expected_rev !== undefined && params.expected_rev !== current.rev) ||
      (params.expected_wid !== undefined && params.expected_wid !== current.state?._wid)) throw Object.assign(new Error('Profile changed; review against the new revision'), { code: 'CONFLICT' })
}
function choices(matches) {
  return { status: 'needs_selection', changed: false, matches: matches.map(({ selected, ...match }) => ({ ...match, selected })) }
}
async function save(api, current, edits) {
  const state = applyEdits(current.state, edits)
  return api.request('/api/data', { method: 'PUT', body: { state, baseRev: current.rev, ...(current.state?._wid ? { baseWid: current.state._wid } : {}) } })
}
export function trainingTools(api) {
  return [
    {
      name: 'resolve_exercises',
      description: 'Resolve up to 50 exercise names or IDs in one call, sharing one profile read. Prefer this to repeated search_exercises calls. Returns selected exercise for a unique ID/name, otherwise candidates. Optional equipment/muscle disambiguate. first_match permits choosing the ranked first result only when the user accepts that choice.',
      schema: { exercises: z.array(exerciseReference).min(1).max(50), first_match: z.boolean().default(false) }, annotations: read,
      handler: async ({ exercises, first_match = false }) => {
        const { state } = await api.request('/api/data')
        const matches = resolveExercises(state, exercises, first_match)
        return { status: matches.some(m => !m.selected) ? 'needs_selection' : 'resolved', matches }
      }
    },
    {
      name: 'save_routine',
      description: 'Create or update a routine, resolve all exercises by name/ID, and assign weekdays/dates in ONE call. No prerequisite search or profile read is needed. exercise_mode replaces the list by default, or appends, updates prescriptions, or removes exercises while preserving other rows. For update/remove, names resolve within the routine. All exercises resolve before a single conditional write; any ambiguity returns needs_selection and changes nothing. Upserts by explicit routine_id or a unique exact routine name, creating when absent; duplicate names return choices. Existing routine fields and schedule entries are preserved unless supplied. Nested arrays supplied replace those fields. Generated IDs and the saved routine are returned for follow-up use. Use run_workflow to preview_session after saving without another model turn. first_match is explicit opt-in; never silently choose among ambiguous exercises.',
      schema: { ...expected, routine_id: z.string().min(1).optional(), name: z.string().trim().min(1).optional(),
        exercises: z.array(z.object({ exercise: exerciseReference, prescription: prescription.default({}) })).min(1).max(100),
        settings: z.record(z.unknown()).optional(), weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
        dates: z.array(date).max(366).optional(), exercise_mode: z.enum(['replace', 'append', 'update', 'remove']).default('replace'), first_match: z.boolean().default(false) }, annotations: write,
      handler: async params => {
        if (!params.name && !params.routine_id) throw new Error('Supply name or routine_id')
        const current = await api.request('/api/data')
        assertRevision(current, params)
        const named = params.name ? (current.state?.routines || []).filter(r => r.name?.trim().toLowerCase() === params.name.trim().toLowerCase()) : []
        if (!params.routine_id && named.length > 1) return { status: 'needs_selection', changed: false, routines: named.map(r => ({ id: r.id, name: r.name })) }
        const id = params.routine_id || named[0]?.id || randomUUID()
        const existing = (current.state?.routines || []).find(r => r.id === id)
        if (!existing && !params.name) throw new Error('name is required when creating a routine')
        const mode = params.exercise_mode || 'replace'
        if (['update', 'remove'].includes(mode) && !existing) throw new Error('Routine not found for update/remove')
        const allowed = ['update', 'remove'].includes(mode) ? new Set(existing.ex?.map(ex => ex.id) || []) : undefined
        const matches = resolveExercises(current.state, params.exercises.map(e => e.exercise), params.first_match, allowed)
        if (matches.some(match => !match.selected)) return choices(matches)
        const selected = params.exercises.map((entry, i) => ({ ...entry.prescription, id: matches[i].selected.id }))
        let ex = structuredClone(existing?.ex || [])
        if (mode === 'replace') ex = selected
        else if (mode === 'append') ex.push(...selected)
        else for (const entry of selected) {
          const rows = ex.map((row, i) => row.id === entry.id ? i : -1).filter(i => i >= 0)
          if (rows.length !== 1) return { status: 'needs_selection', changed: false, exercise_id: entry.id, rows,
            note: 'Repeated exercise rows require replace mode with an explicit full list.' }
          if (mode === 'remove') ex.splice(rows[0], 1)
          else ex[rows[0]] = { ...ex[rows[0]], ...entry }
        }
        const record = { ...existing, ...(params.settings || {}), id, name: params.name || existing.name, ex }
        const edits = [{ action: 'upsert', collection: 'routines', record }]
        for (const day of params.weekdays || []) edits.push({ action: 'set', path: ['week', String(day)], value: id })
        for (const day of params.dates || []) edits.push({ action: 'set', path: ['dayPlan', day], value: id })
        return { status: 'saved', ...(await save(api, current, edits)), routine: record }
      }
    },
    {
      name: 'set_schedule',
      description: 'Assign weekdays or date overrides and/or a floating queue in ONE call using routine names or IDs; no prerequisite routine lookup. Each assignment takes exactly one of weekday (0 Sunday to 6) or date, plus routines (empty means rest). Weekdays can combine routines; a date accepts at most one. Missing/duplicate names return needs_selection and write nothing. queue uses ordered routine names/IDs and starts_on; clear_queue explicitly removes it. Existing assignments remain unless targeted. An existing active queue can take precedence over weekday assignments; clear it explicitly if that is intended.',
      schema: { ...expected,
        assignments: z.array(z.object({ weekday: z.number().int().min(0).max(6).optional(), date: date.optional(), routines: z.array(z.string().min(1)).default([]) }).refine(a => (a.weekday !== undefined) !== (a.date !== undefined), 'Supply weekday or date')).max(366).default([]),
        queue: z.object({ routines: z.array(z.string().min(1)).min(1), starts_on: date, label: z.string().optional(), strict: z.boolean().optional() }).optional(), clear_queue: z.boolean().default(false) }, annotations: write,
      handler: async params => {
        if (!params.assignments.length && !params.queue && !params.clear_queue) throw new Error('Supply assignments, queue or clear_queue')
        if (params.queue && params.clear_queue) throw new Error('queue and clear_queue are mutually exclusive')
        if (params.assignments.some(a => a.date && a.routines.length > 1)) throw new Error('A date override accepts at most one routine')
        const current = await api.request('/api/data')
        assertRevision(current, params)
        const selectors = [...new Set([...params.assignments.flatMap(a => a.routines), ...(params.queue?.routines || [])])]
        const routines = current.state?.routines || []
        const matches = selectors.map(query => {
          const direct = routines.find(r => r.id === query)
          const candidates = direct ? [direct] : routines.filter(r => r.name?.trim().toLowerCase() === query.trim().toLowerCase())
          return { query, selected: candidates.length === 1 ? candidates[0].id : null, candidates: candidates.map(r => ({ id: r.id, name: r.name })) }
        })
        if (matches.some(m => !m.selected)) return { status: 'needs_selection', changed: false, matches }
        const resolved = new Map(matches.map(m => [m.query, m.selected]))
        const edits = params.assignments.map(a => ({ action: 'set', path: [a.date ? 'dayPlan' : 'week', a.date || String(a.weekday)],
          value: a.date ? (a.routines.length ? resolved.get(a.routines[0]) : 'rest') : a.routines.map(r => resolved.get(r)) }))
        if (params.clear_queue) edits.push({ action: 'unset', path: ['queue'] })
        if (params.queue) edits.push({ action: 'set', path: ['queue'], value: { ids: [...new Set(params.queue.routines.map(r => resolved.get(r)))], since: Date.now(), startsOn: params.queue.starts_on,
          ...(params.queue.label !== undefined ? { label: params.queue.label } : {}), ...(params.queue.strict !== undefined ? { strict: params.queue.strict } : {}) } })
        return { status: 'saved', ...(await save(api, current, edits)), resolved_routines: Object.fromEntries(resolved),
          note: current.state?.queue && !params.clear_queue && !params.queue ? 'Existing queue retained; it can override weekday assignments.' : undefined }
      }
    },
    {
      name: 'log_workout',
      description: 'Log a completed workout and optionally a weigh-in in ONE call, resolving exercise names/IDs before one conditional profile write. No prerequisite search/get_profile is needed. Any missing or ambiguous exercise returns needs_selection and writes nothing. Uses the profile unit; set done explicitly on completed sets (w/r for load/reps, sec for timed work). start/end are epoch milliseconds. Uses app completion/edit logic for PRs, volume, remembered loads and rotation refill. backfill=true inserts historical sessions chronologically without raising remembered loads. For an existing workout_id, updates name/entries/note/bw; use apply_training_actions to change its date/duration. A caller-provided workout_id updates the matching record and prevents duplicate IDs; otherwise a new ID is generated. Does not control a device-local running workout.',
      schema: { ...expected, workout_id: z.string().min(1).optional(), date, name: z.string().min(1), start: z.number().nonnegative(), end: z.number().nonnegative(),
        entries: z.array(z.object({ exercise: exerciseReference, sets: z.array(workoutSet).min(1), details: z.record(z.unknown()).optional() })).min(1).max(100),
        backfill: z.boolean().default(false), details: z.record(z.unknown()).optional(), bodyweight: z.number().positive().optional(), first_match: z.boolean().default(false) }, annotations: write,
      handler: async params => {
        if (params.end < params.start) throw new Error('end must be at or after start')
        const current = await api.request('/api/data')
        assertRevision(current, params)
        const matches = resolveExercises(current.state, params.entries.map(e => e.exercise), params.first_match)
        if (matches.some(match => !match.selected)) return choices(matches)
        const record = { ...(params.details || {}), id: params.workout_id || randomUUID(), d: params.date,
          name: params.name, start: params.start, end: params.end,
          entries: params.entries.map((entry, i) => ({ ...(entry.details || {}), id: matches[i].selected.id, sets: entry.sets })) }
        // Reuse the app's finish/edit boundaries, including PR and remembered-load repair.
        const existing = current.state?.workouts?.find(w => w.id === record.id)
        const actions = existing
          ? [{ action: 'edit_workout', workout_id: record.id, name: record.name, entries: record.entries,
              ...(record.note !== undefined ? { note: record.note } : {}), ...(record.bw !== undefined ? { bw: record.bw } : {}) }]
          : [{ action: 'complete_workout', workout: { ...record, ...(params.backfill ? { backfill: {} } : {}) }, end: record.end }]
        // saveTrainingActions reuses this already-fetched snapshot; the PUT still guards its revision.
        const scoped = { request: (path, options) => path === '/api/data' && !options ? Promise.resolve(current) : api.request(path, options) }
        if (params.bodyweight !== undefined) {
          const base = structuredClone(current)
          base.state.bodyweight ??= []
          base.state.bodyweight = base.state.bodyweight.filter(w => w.d !== params.date)
          base.state.bodyweight.push({ d: params.date, w: params.bodyweight, t: Date.now() })
          scoped.request = (path, options) => path === '/api/data' && !options ? Promise.resolve(base) : api.request(path, options)
        }
        const result = await saveTrainingActions(scoped, { ...params, actions })
        return { ...result, workout: result.results[0] }
      }
    }
  ]
}
