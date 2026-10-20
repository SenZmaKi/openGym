// Domain boundary shared by the workout screen and remote training clients.
// Device effects (timers, sounds, backups and navigation) belong to the caller.
import { buildCompletedWorkout, sessionEnd } from './finish-workout.js'
import { EXIDX, isCustomEx, betterWeight, beatsWeight } from './exercises.js'
import { bestWeightFor, bestWeightForEntry, workoutVolume } from './history.js'
import { isWarmupRow } from './workout-model.js'
import { entryDbLoad } from './dumbbells.js'
import { is1RMRecord } from './onerm.js'
import { exerciseMuscleSnapshot } from './muscles.js'
import { backfillEnd, completeBackfill } from './backfill.js'
import { stampWorkout } from './sync-merge.js'
import { rebuildPrHistory } from './workout-date.js'
import { refillAfter } from './rotation.js'

export function completeSession(state, active = state.active, { now = Date.now(), end, today } = {}) {
  if (!active) throw new Error('No session to finish')
  const past = !!active.backfill
  const prs = [], e1prs = []
  if (!past) active.entries.forEach(e => {
    const loads = e.sets.filter(s => s.done && !isWarmupRow(s)).map(s => s.w).filter(w => w > 0)
    const mx = loads.length ? loads.reduce((a, b) => betterWeight(e.id, a, b)) : 0
    if (beatsWeight(e.id, mx, bestWeightFor(state, e.id, entryDbLoad(e)))) prs.push(e.id)
    const rec = is1RMRecord(state, e.id, e)
    if (rec && !prs.includes(e.id)) e1prs.push({ id: e.id, ...rec })
  })
  const w = buildCompletedWorkout(active, {
    end: end ?? (past ? backfillEnd(active) : sessionEnd(active, now)), prs,
    snapshotFor: e => isCustomEx(EXIDX[e.id]) ? exerciseMuscleSnapshot(EXIDX[e.id]) : null,
  })
  w.vol = workoutVolume(w)
  let shown = w
  if (past) {
    stampWorkout(w, now)
    const replaced = active.backfill.replaceId ? state.workouts.find(x => x.id === active.backfill.replaceId) : null
    const touched = [...new Set([...(replaced?.entries || []), ...w.entries].map(e => e?.id).filter(id => id != null))]
    state.workouts = rebuildPrHistory(completeBackfill(state.workouts, active, w, now), touched, w)
    shown = state.workouts.find(x => x === w || (w.id != null && x.id === w.id)) || w
    prs.push(...(shown.prs || []))
  } else {
    w.entries.forEach(e => {
      const mx = bestWeightForEntry(e)
      if (mx > 0 && beatsWeight(e.id, mx, (state.exWeights[e.id] || {}).w || 0)) state.exWeights[e.id] = { w: mx, d: w.d }
    })
    state.workouts.push(w)
  }
  state.active = null
  refillAfter(state, w, today, now)
  return { workout: shown, prs, e1prs, past }
}
