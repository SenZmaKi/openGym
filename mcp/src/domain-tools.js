import { z } from 'zod/v3'
import { applyTrainingActions } from '../../frontend/src/lib/training-actions.js'

const id = z.string().min(1)
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const d = new Date(v + 'T12:00:00Z')
  return !Number.isNaN(+d) && d.toISOString().slice(0, 10) === v
}, 'Invalid date')
const record = z.record(z.unknown())
const entry = z.object({ id, sets: z.array(z.object({ done: z.boolean().optional(), w: z.number().optional(), r: z.number().nonnegative().optional() }).passthrough()).min(1) }).passthrough()
export const trainingAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('copy_routine'), routine_id: id, name: id.optional() }),
  z.object({ action: z.literal('delete_routine'), routine_id: id }),
  z.object({ action: z.literal('swap_routine_exercise'), routine_id: id, index: z.number().int().nonnegative(), exercise_id: id }),
  z.object({ action: z.literal('reorder_routine'), routine_id: id, order: z.array(z.number().int().nonnegative()).max(100) }),
  z.object({ action: z.literal('edit_workout'), workout_id: id, name: id.optional(), note: z.string().optional(), bw: z.number().positive().nullable().optional(), entries: z.array(entry).min(1).max(100).optional() }),
  z.object({ action: z.literal('delete_workout'), workout_id: id }),
  z.object({ action: z.literal('move_workout'), workout_id: id, date, time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/) }),
  z.object({ action: z.literal('set_workout_duration'), workout_id: id, minutes: z.number().int().min(1).max(1440) }),
  z.object({ action: z.literal('convert_unit'), unit: z.enum(['kg', 'lb']) }),
  z.object({ action: z.literal('rotation'), operation: z.enum(['save', 'start', 'restart', 'stop', 'choose_rotation', 'choose_week', 'refill']), routine_ids: z.array(id).min(1).max(100).optional(), label: z.string().optional(), today: date.optional() }),
  z.object({ action: z.literal('save_measurement'), date, entry: record.describe('Partial check-in: canonical field names (waist, chest, bodyFat, etc); lengths always cm, bodyFat percent; other contains custom measurement values.') }),
  z.object({ action: z.literal('delete_measurement'), date }),
  z.object({ action: z.literal('import_plan'), text: z.string().min(1).max(8_000_000), schedule: z.boolean().default(false) }),
  z.object({ action: z.literal('import_csv'), text: z.string().min(1).max(8_000_000) }),
])

export async function saveTrainingActions(api, params) {
  const current = await api.request('/api/data')
  if ((params.expected_rev !== undefined && params.expected_rev !== current.rev) ||
      (params.expected_wid !== undefined && params.expected_wid !== current.state?._wid)) throw Object.assign(new Error('Profile changed; review the new revision'), { code: 'CONFLICT' })
  // An explicit date is available for planning, otherwise use the profile's timezone.
  const now = Date.now()
  const tz = current.state?.reminder?.tz || 'UTC'
  const today = params.today || new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  const { state, results } = applyTrainingActions(current.state, params.actions, { now, today })
  const saved = await api.request('/api/data', { method: 'PUT', body: { state, baseRev: current.rev,
    ...(current.state?._wid ? { baseWid: current.state._wid } : {}) } })
  return { status: 'saved', ...saved, results }
}
export function domainTools(api) {
  return [{
    name: 'apply_training_actions',
    description: 'Execute up to 100 app-level training actions in ONE read and ONE conditional write. Actions run in order on a private draft; failure writes nothing. Uses the same pure helpers as the app: routine copy/delete (cleans weekday/date links), exercise swap (resets incompatible prescriptions), reorder by slot indices, completed-workout edit/delete (corrects PRs/remembered weights), date/duration changes, rotation lifecycle/refill, full kg/lb conversion, normalized measurements and CSV imports. Entries use native app IDs and set fields; get_profile returns the complete data including advanced metadata. Dates default to the profile timezone; move_workout time is interpreted in the MCP server timezone. No device-local active session is modified. Copy results return new IDs; use run_workflow refs for dependent follow-up calls. Prefer save_routine/log_workout for name-based combined operations. Raw edit_profile bypasses these domain rules.',
    schema: { actions: z.array(trainingAction).min(1).max(100), today: date.optional(), expected_rev: z.number().int().nonnegative().optional(), expected_wid: id.optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    handler: params => saveTrainingActions(api, params)
  }]
}
