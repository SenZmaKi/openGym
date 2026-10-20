import { z } from 'zod/v3'
import { TOOLS } from './tools.js'
import { withRemoteState } from './state.js'
import { apiTools } from './api-tools.js'
import { nativeApiTools } from './api-native-tools.js'
import { domainTools } from './domain-tools.js'
import { trainingTools } from './training-tools.js'
import { workflowTools, invoke } from './workflow.js'

export function createTools(api = null) {
  const analytics = TOOLS.map(tool => ({ ...tool,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    handler: async params => {
      if (!api) return tool.handler(params)
      const [{ state }, me] = await Promise.all([api.request('/api/data'), api.request('/api/me')])
      return withRemoteState(state, me.user, () => tool.handler(params))
    }
  }))
  const overview = {
    name: 'get_training_overview',
    description: 'Answer a training check-in in ONE call: saved routines, upcoming schedule, recent workouts, latest bodyweight, PR table and muscle balance. All analytics share one fresh profile snapshot. Prefer this over six separate read calls; use batch_read for a custom selection. Weigh-in history is compacted to latest/count/goal here; get_bodyweight returns full history.',
    schema: { workout_limit: z.number().int().min(1).max(50).default(10), period: z.enum(['week', 'month', 'all']).default('week') },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    handler: async ({ workout_limit = 10, period = 'week' }) => {
      const names = ['list_routines', 'get_week_plan', 'list_workouts', 'get_bodyweight', 'estimate_1rm', 'muscle_balance']
      const values = await Promise.all(names.map(name => invoke(analytics.find(t => t.name === name),
        name === 'list_workouts' ? { limit: workout_limit } : name === 'muscle_balance' ? { period } : {})))
      const results = Object.fromEntries(names.map((name, i) => [name, values[i]]))
      const { entries, ...weightSummary } = results.get_bodyweight
      results.get_bodyweight = weightSummary
      return results
    }
  }
  const base = [...analytics, overview, ...(api ? [...apiTools(api), ...nativeApiTools(api), ...trainingTools(api), ...domainTools(api)] : [])]
  return [...base, ...workflowTools(base)]
}
