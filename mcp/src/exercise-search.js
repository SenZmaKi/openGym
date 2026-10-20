import { EXDB } from '../../frontend/src/lib/exercises-data.js'

const normalized = value => String(value || '').trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const catalogue = EXDB.map(ex => ({ ex, text: normalized([ex.id, ex.n, ex.bp, ex.eq, ex.tg, ex.mg, ...(ex.sm || [])].join(' ')) }))
const byId = new Map(EXDB.map(ex => [ex.id, ex]))
const rowsByState = new WeakMap()
function rowsFor(state) {
  if (!state || !state.customEx?.length) return catalogue
  if (rowsByState.has(state)) return rowsByState.get(state)
  const customIds = new Set(state.customEx.map(ex => ex.id))
  const rows = [...catalogue.filter(({ ex }) => !customIds.has(ex.id)), ...state.customEx.map(ex => ({ ex, text: normalized(JSON.stringify(ex)) }))]
  rowsByState.set(state, rows)
  return rows
}
export function searchExercises(state, { query, offset = 0, limit = 25, equipment, muscle }, allowedIds) {
  const rows = rowsFor(state)
  const words = normalized(query).split(' ').filter(Boolean)
  const matches = rows.filter(({ ex, text }) => (!allowedIds || allowedIds.has(ex.id)) && words.every(word => text.includes(word))
    && (!equipment || normalized(ex.eq) === normalized(equipment))
    && (!muscle || normalized([ex.bp, ex.tg, ex.mg, ...(ex.sm || [])].join(' ')).includes(normalized(muscle))))
    .sort((a, b) => Number(normalized(b.ex.n) === normalized(query)) - Number(normalized(a.ex.n) === normalized(query)))
  return { total: matches.length, offset, exercises: matches.slice(offset, offset + limit).map(({ ex }) => ex) }
}

export function resolveExercises(state, requests, firstMatch = false, allowedIds) {
  return requests.map(request => {
    const query = request.query || request.id
    const found = request.id ? null : searchExercises(state, { ...request, query, limit: 10 }, allowedIds)
    const results = request.id
      ? [(state?.customEx || []).find(ex => ex.id === request.id) || byId.get(request.id)].filter(ex => ex && (!allowedIds || allowedIds.has(ex.id)))
      : found.exercises
    const exact = request.id ? results : results.filter(ex => normalized(ex.n) === normalized(query))
    const total = request.id ? results.length : found.total
    const selected = exact.length === 1 ? exact[0] : (total === 1 || firstMatch) ? results[0] : null
    return { query, total, selected: selected || null, candidates: results }
  })
}
