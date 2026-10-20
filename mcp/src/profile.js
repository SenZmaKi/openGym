/* Targeted edits against a freshly read revision. The API stamps edits and tombstones,
   so disconnected devices cannot resurrect removals or overwrite unstamped changes. */
const forbidden = new Set(['__proto__', 'prototype', 'constructor'])
const owned = new Set(['active', '_rev', '_wid', '_wids', '_ts', 'deleted', 'edited', 'resetAt', 'resetIds'])
const collections = new Set(['routines', 'workouts', 'bodyweight', 'customEx', 'equipProfiles', 'gymCards'])
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v)

function checkValue(value) {
  if (!value || typeof value !== 'object') return
  for (const key of Object.keys(value)) {
    if (forbidden.has(key)) throw new Error(`Unsafe key: ${key}`)
    checkValue(value[key])
  }
}
function location(state, path) {
  if (!Array.isArray(path) || !path.length || path.some(k => typeof k !== 'string' || !k || forbidden.has(k)) || owned.has(path[0])) throw new Error('Invalid or server/device-owned profile path')
  let parent = state
  for (const key of path.slice(0, -1)) {
    if (!Object.hasOwn(parent, key)) parent[key] = {}
    if (!object(parent[key])) throw new Error('Paths traverse objects only; use upsert/remove for records or set the full array')
    parent = parent[key]
  }
  return [parent, path.at(-1)]
}
export function applyEdits(snapshot, edits) {
  const state = structuredClone(snapshot || {})
  for (const edit of edits) {
    checkValue(edit)
    if (edit.action === 'set' || edit.action === 'unset') {
      if (edit.action === 'set' && !Object.hasOwn(edit, 'value')) throw new Error('set requires value (use null to clear)')
      const [parent, key] = location(state, edit.path)
      if (edit.action === 'set') parent[key] = structuredClone(edit.value)
      else delete parent[key]
    } else if (edit.action === 'upsert' || edit.action === 'remove') {
      if (!collections.has(edit.collection)) throw new Error('Unsupported record collection')
      const key = edit.collection === 'bodyweight' ? 'd' : 'id'
      const id = edit.action === 'upsert' ? edit.record?.[key] : edit.key
      if (typeof id !== 'string' || !id) throw new Error(`Record requires a nonempty ${key}`)
      if (edit.action === 'upsert' && !object(edit.record)) throw new Error('record must be an object')
      const list = state[edit.collection] ?? []
      if (!Array.isArray(list)) throw new Error('Stored collection is not an array')
      const at = list.findIndex(r => r?.[key] === id)
      if (edit.action === 'remove') {
        if (at < 0) throw new Error(`Record not found: ${id}`)
        list.splice(at, 1)
      } else if (at < 0) list.push(structuredClone(edit.record))
      else list[at] = { ...list[at], ...structuredClone(edit.record) }
      state[edit.collection] = list
    } else throw new Error('Unknown edit action')
  }
  if (Object.hasOwn(state, 'active')) delete state.active
  for (const field of ['routines', 'workouts', 'bodyweight', 'customEx', 'equipProfiles', 'gymCards']) {
    if (state[field] != null && (!Array.isArray(state[field]) || state[field].some(v => !object(v)))) throw new Error(`${field} must contain objects`)
  }
  if (state.unit != null && !['kg', 'lb'].includes(state.unit)) throw new Error('unit must be kg or lb')
  // Changing units alone would reinterpret every stored weight. Use an explicit converted
  // document via putData, or the app's unit-conversion control.
  if (snapshot?.unit && state.unit !== snapshot.unit) throw new Error('Unit changes require converting stored weights; use the app or putData with converted values')
  state._ts = Date.now()
  return state
}
export async function editProfile(api, { expected_rev, expected_wid, edits }) {
  const current = await api.request('/api/data')
  if ((expected_rev !== undefined && current.rev !== expected_rev) || (expected_wid !== undefined && current.state?._wid !== expected_wid)) {
    throw Object.assign(new Error('Profile changed; read get_profile and review edits against the new revision'), { code: 'CONFLICT' })
  }
  const state = applyEdits(current.state, edits)
  const result = await api.request('/api/data', { method: 'PUT', body: {
    state, baseRev: current.rev, ...(current.state?._wid ? { baseWid: current.state._wid } : {})
  } })
  return { ...result, edits_applied: edits.length }
}
