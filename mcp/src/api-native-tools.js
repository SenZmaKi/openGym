/* OpenAPI is the only API contract. Expose typed tools so discovery is optional. */
import { z } from 'zod/v3'
import { operations, specification } from './api.js'

export function schemaToZod(schema, seen = new Set()) {
  if (schema === false) return z.never()
  if (!schema || schema === true) return z.unknown()
  if (schema.$ref) {
    if (!schema.$ref.startsWith('#/components/')) throw new Error('Only local OpenAPI references are supported')
    if (seen.has(schema.$ref)) return z.unknown()
    const target = schema.$ref.split('/').slice(1).reduce((value, key) => value?.[key], specification)
    if (!target) throw new Error(`Missing schema reference: ${schema.$ref}`)
    return schemaToZod({ ...target, ...Object.fromEntries(Object.entries(schema).filter(([k]) => k !== '$ref')) }, new Set([...seen, schema.$ref]))
  }
  const convert = child => schemaToZod(child, seen)
  const union = alternatives => alternatives.length === 1 ? alternatives[0] : z.union(alternatives)
  let result
  if (schema.const !== undefined) result = z.literal(schema.const)
  else if (schema.enum?.length) result = union(schema.enum.map(v => v === null ? z.null() : z.literal(v)))
  else if (schema.oneOf || schema.anyOf) result = union((schema.oneOf || schema.anyOf).map(convert))
  else if (schema.allOf) result = schema.allOf.map(convert).reduce((a, b) => z.intersection(a, b))
  else if (Array.isArray(schema.type)) result = union(schema.type.map(type => convert({ ...schema, type })))
  else if (schema.type === 'object' || schema.properties) {
    const required = new Set(schema.required || [])
    const fields = Object.fromEntries(Object.entries(schema.properties || {}).map(([key, value]) => [key, required.has(key) ? convert(value) : convert(value).optional()]))
    result = z.object(fields)
    if (schema.additionalProperties === false) result = result.strict()
    else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') result = result.catchall(convert(schema.additionalProperties))
    else result = result.passthrough()
  } else if (schema.type === 'array') {
    result = z.array(convert(schema.items))
    if (schema.minItems !== undefined) result = result.min(schema.minItems)
    if (schema.maxItems !== undefined) result = result.max(schema.maxItems)
  } else if (schema.type === 'string') {
    result = z.string()
    if (schema.minLength !== undefined) result = result.min(schema.minLength)
    if (schema.maxLength !== undefined) result = result.max(schema.maxLength)
    if (schema.pattern) result = result.regex(new RegExp(schema.pattern))
  } else if (schema.type === 'number' || schema.type === 'integer') {
    result = z.number()
    if (schema.type === 'integer') result = result.int()
    if (schema.minimum !== undefined) result = result.min(schema.minimum)
    if (schema.maximum !== undefined) result = result.max(schema.maximum)
  } else if (schema.type === 'boolean') result = z.boolean()
  else if (schema.type === 'null') result = z.null()
  else result = z.unknown()
  if (schema.nullable) result = result.nullable()
  if (schema.default !== undefined) result = result.default(schema.default)
  if (schema.description) result = result.describe(schema.description)
  return result
}

export const nativeDefinitions = operations.map(op => {
  const schema = {}
  for (const location of ['path', 'query']) {
    const params = op.parameters.filter(p => p.in === location)
    if (params.length) {
      const fields = Object.fromEntries(params.map(p => [p.name, p.required ? schemaToZod(p.schema) : schemaToZod(p.schema).optional()]))
      schema[location] = z.object(fields).strict()
      if (!params.some(p => p.required)) schema[location] = schema[location].optional()
    }
  }
  const content = op.requestBody?.content
  if (content?.['application/json']) {
    schema.body = schemaToZod(content['application/json'].schema)
    if (!op.requestBody.required) schema.body = schema.body.optional()
  } else if (content) {
    schema.base64 = z.string().max(60_000_000).describe('The raw file encoded as base64')
    schema.content_type = z.enum(Object.keys(content))
  }
  if (op.operationId === 'putData') schema.body = z.object({ state: z.record(z.unknown()), baseRev: z.number().int().nonnegative(), baseWid: z.string().optional() }).passthrough()
  return { name: 'api_' + op.operationId, description: `${op.summary}. Invoke directly using this input schema; get_api_operation provides extended documentation when needed.${op.operationId === 'putData' ? ' Prefer edit_profile for targeted updates without first reading a document.' : ''}`,
    schema, annotations: { readOnlyHint: op.method === 'GET', destructiveHint: op.method !== 'GET', openWorldHint: true }, operationId: op.operationId }
})
export const nativeApiTools = api => nativeDefinitions.map(def => ({ ...def, handler: params => api.call({ ...params, operation_id: def.operationId }) }))
