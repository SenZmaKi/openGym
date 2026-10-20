import { z } from 'zod/v3'
import { operations, operationById, specification } from './api.js'
import { editProfile } from './profile.js'
import { searchExercises } from './exercise-search.js'

const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
const record = z.record(z.unknown())
export const editSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('set'), path: z.array(z.string()).min(1), value: z.unknown() }),
  z.object({ action: z.literal('unset'), path: z.array(z.string()).min(1) }),
  z.object({ action: z.literal('upsert'), collection: z.enum(['routines', 'workouts', 'bodyweight', 'customEx', 'equipProfiles', 'gymCards']), record }),
  z.object({ action: z.literal('remove'), collection: z.enum(['routines', 'workouts', 'bodyweight', 'customEx', 'equipProfiles', 'gymCards']), key: z.string().min(1) })
])

export function apiTools(api) {
  return [
    {
      name: 'list_api_operations',
      description: 'Discover every documented openGym server operation, including account, passkey, media, push, coach and admin controls. Access follows the connected account permissions. Prefer a named api_<operation_id> tool to execute directly without discovery; use this only to explore unfamiliar operations. Hardware passkey ceremonies still require a human device.',
      schema: { search: z.string().optional() }, annotations: read,
      handler: ({ search = '' }) => operations.filter(op => `${op.operationId} ${op.path} ${op.summary} ${op.tags}`.toLowerCase().includes(search.toLowerCase()))
        .map(op => ({ operation_id: op.operationId, method: op.method, path: op.path, summary: op.summary, tags: op.tags }))
    },
    {
      name: 'get_api_operation',
      description: 'Get an operation request/response contract. Includes referenced OpenAPI components. Profile state is extensible; read get_profile to inspect fields beyond the representative State schema.',
      schema: { operation_id: z.string() }, annotations: read,
      handler: ({ operation_id }) => {
        const operation = operationById(operation_id)
        // Include only reachable components, rather than the entire spec on every call.
        const components = {}
        const collect = value => {
          if (!value || typeof value !== 'object') return
          if (typeof value.$ref === 'string' && value.$ref.startsWith('#/components/')) {
            const [, , section, name] = value.$ref.split('/')
            if (!Object.hasOwn(components[section] || {}, name)) {
              const definition = specification.components?.[section]?.[name]
              components[section] ||= {}
              components[section][name] = definition
              collect(definition)
            }
          }
          for (const child of Object.values(value)) collect(child)
        }
        collect(operation)
        return { operation, components }
      }
    },
    {
      name: 'call_api_operation',
      description: 'Execute a documented API operation by operation_id. Prefer a named api_<operation_id> tool, whose input schema includes the contract. This gateway is a fallback for callers already familiar with the operation. Can modify/delete data, manage accounts and credentials, send notifications, or run coach jobs. Admin routes require an admin token. JSON body, path/query parameters, or binary base64 + content_type are supported. putData always requires baseRev; prefer edit_profile for targeted edits. No automatic retries. Binary responses return base64.',
      schema: { operation_id: z.string(), path: z.record(z.string()).optional(), query: z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).optional(), body: z.unknown().optional(), base64: z.string().max(60_000_000).optional(), content_type: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      handler: params => api.call(params)
    },
    {
      name: 'get_profile',
      description: 'Inspect the full synced profile and revision when needed. Explicit mutations can use edit_profile/save_routine/log_workout/set_schedule directly; no prerequisite read is required. Includes routines, workout sets, bodyweight, custom exercises, week/day plans, rotation/queue, equipment, progression, goals, reminders and settings. In-progress workouts and native device controls are not synced. Keep rev and state._wid for edit_profile.',
      schema: {}, annotations: read, handler: () => api.request('/api/data')
    },
    {
      name: 'edit_profile',
      description: 'Apply up to 200 profile edits in one call. No prerequisite read is needed for explicit changes: the tool reads and writes the latest revision internally. If modifying a reviewed snapshot, send expected_rev and optionally expected_wid to refuse intervening changes. set/unset use object-key path arrays, e.g. ["week","1"] or ["dayPlan","2026-10-21"]. upsert merges a record by id (weigh-ins by d), adding it if absent; supply nested arrays in full. remove deletes a record by key. Supports all synced settings via set/unset, including collections beyond the named CRUD lists. Preserve unfamiliar fields and use exercise IDs from search_exercises. Units cannot be changed without converting weights. The API stamps changes for device sync. Conflicts require a fresh read; never blindly retry.',
      schema: { expected_rev: z.number().int().nonnegative().optional(), expected_wid: z.string().optional(), edits: z.array(editSchema).min(1).max(200) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      handler: params => editProfile(api, params)
    },
    {
      name: 'search_exercises',
      description: 'Search the bundled exercise catalogue and this profile’s custom exercises by name, muscle, equipment or id. Returns raw exercise records for building routines and logging workout entries.',
      schema: { query: z.string(), equipment: z.string().optional(), muscle: z.string().optional(), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(25) }, annotations: read,
      handler: async params => {
        const { state } = await api.request('/api/data')
        return searchExercises(state, params)
      }
    }
  ]
}
