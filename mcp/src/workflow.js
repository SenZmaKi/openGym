import { z } from 'zod/v3'

const args = z.record(z.unknown())
const step = z.object({ id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/), tool: z.string(), arguments: args.default({}), depends_on: z.array(z.string()).default([]) })
const refParts = text => {
  if (typeof text !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*#(?:\/.*)?$/.test(text)) throw new Error('References use step_id#/json/pointer')
  const separator = text.indexOf('#')
  const id = text.slice(0, separator)
  const pointer = text.slice(separator + 1)
  return { id, keys: pointer ? pointer.slice(1).split('/').map(key => key.replace(/~1/g, '/').replace(/~0/g, '~')) : [] }
}
function walk(value, reference) {
  if (Array.isArray(value)) return value.map(v => walk(v, reference))
  if (value && typeof value === 'object') {
    if (Object.hasOwn(value, '$ref')) {
      if (Object.keys(value).length !== 1) throw new Error('A result reference must contain only $ref')
      return reference(refParts(value.$ref))
    }
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, walk(v, reference)]))
  }
  return value
}
function errorResult(error) {
  return { status: 'error', error: { code: error.code || 'ERROR', message: error.message,
    ...(error.status ? { status: error.status, response: error.result } : {}) } }
}
export async function invoke(tool, arguments_) {
  if (!tool) throw new Error('Unknown tool')
  return tool.handler(z.object(tool.schema).strict().parse(arguments_))
}
export async function parallelMap(items, callback, concurrency = 4) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await callback(items[index], index) }
  }))
  return results
}

export function workflowTools(tools) {
  const byName = new Map(tools.map(tool => [tool.name, tool]))
  return [
    {
      name: 'batch_read',
      description: 'Perform up to 50 independent read-only tool calls in ONE model call, at most four concurrently. Supports analytics, exercise resolution/search, get_profile, API contracts and every api_<GET operation> tool. Shares one fresh profile/identity snapshot and deduplicates GETs within this call. Results preserve input order; failures are per-item. No writes, nested batches or workflows. Use run_workflow when later steps need earlier results.',
      schema: { operations: z.array(z.object({ tool: z.string(), arguments: args.default({}) })).min(1).max(50) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      handler: async ({ operations }) => {
        const results = await parallelMap(operations, async operation => {
        try {
          const tool = byName.get(operation.tool)
          if (!tool?.annotations?.readOnlyHint) throw new Error('batch_read accepts only known read-only tools')
          const result = await invoke(tool, operation.arguments)
          return { tool: operation.tool, status: result?.status === 'needs_selection' ? 'needs_selection' : 'ok', result }
        } catch (error) { return { tool: operation.tool, ...errorResult(error) } }
        })
        return { status: results.every(r => r.status === 'ok') ? 'ok' : 'partial_failure', results }
      }
    },
    {
      name: 'run_workflow',
      description: 'Execute up to 50 tool steps in ONE model call. Independent reads run up to four at a time; writes run sequentially. Supply step id, tool, arguments and optional depends_on IDs. A value {"$ref":"save#/routine/id"} injects a prior successful result and automatically adds a dependency; JSON Pointer escapes ~0/~1 work. Example save_routine then preview_session with routine_id from save#/routine/id. Unknown tools/references/cycles and errors in reference-free arguments fail before any operation. A failed or needs_selection step blocks dependents; independent steps continue. Results retain input order. This is NOT a transaction across server operations: earlier successful writes remain if a later step fails. Use edit_profile for atomic multi-record edits; save_routine/log_workout for combined resolution+write. No nested workflows/batches. Reads after a write must depend on it; GET caches are invalidated by writes.',
      schema: { steps: z.array(step).min(1).max(50) },
      annotations: { readOnlyHint: tools.every(t => t.annotations?.readOnlyHint), destructiveHint: tools.some(t => !t.annotations?.readOnlyHint), idempotentHint: false, openWorldHint: true },
      handler: async ({ steps }) => {
        const ids = new Set(steps.map(s => s.id))
        if (ids.size !== steps.length) throw new Error('Step IDs must be unique')
        const dependencies = new Map()
        for (const item of steps) {
          const tool = byName.get(item.tool)
          if (!tool) throw new Error(`Unknown workflow tool: ${item.tool}`)
          let hasRefs = false
          const deps = new Set(item.depends_on)
          walk(item.arguments, ({ id }) => { hasRefs = true; deps.add(id); return null })
          for (const id of deps) if (!ids.has(id) || id === item.id) throw new Error(`Invalid dependency: ${id}`)
          if (!hasRefs) z.object(tool.schema).strict().parse(item.arguments)
          dependencies.set(item.id, deps)
        }
        // Validate the whole graph before any effects, including cycles disconnected from roots.
        const visited = new Set()
        while (visited.size < steps.length) {
          const ready = steps.filter(s => !visited.has(s.id) && [...dependencies.get(s.id)].every(id => visited.has(id)))
          if (!ready.length) throw new Error('Workflow dependency cycle')
          for (const s of ready) visited.add(s.id)
        }
        const results = new Map()
        async function execute(item) {
          if ([...dependencies.get(item.id)].some(id => results.get(id).status !== 'ok')) {
            results.set(item.id, { status: 'blocked', reason: 'A dependency failed or needs selection' }); return
          }
          try {
            const resolved = walk(item.arguments, ({ id, keys }) => {
              let value = results.get(id).result
              for (const key of keys) {
                if (!value || !Object.hasOwn(value, key)) throw new Error(`Reference not found: ${id}#/${keys.join('/')}`)
                value = value[key]
              }
              return structuredClone(value)
            })
            const result = await invoke(byName.get(item.tool), resolved)
            results.set(item.id, { status: result?.status === 'needs_selection' ? 'needs_selection' : 'ok', result })
          } catch (error) { results.set(item.id, errorResult(error)) }
        }
        while (results.size < steps.length) {
          const ready = steps.filter(s => !results.has(s.id) && [...dependencies.get(s.id)].every(id => results.has(id)))
          await parallelMap(ready.filter(s => byName.get(s.tool).annotations?.readOnlyHint), execute)
          for (const item of ready.filter(s => !byName.get(s.tool).annotations?.readOnlyHint)) await execute(item)
        }
        const ordered = steps.map(item => ({ id: item.id, tool: item.tool, ...results.get(item.id) }))
        return { status: ordered.every(r => r.status === 'ok') ? 'ok' : 'partial_failure', results: ordered }
      }
    }
  ]
}
