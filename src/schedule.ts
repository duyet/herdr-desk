import type { Schedule } from './config'

export const DEFAULT_CRON = '0 7 * * *'

/**
 * Normalize an authoring `schedule` into a cron list.
 *
 * `[]` returns `[]`, not the default: that is the event-only form, and a task
 * with `watch` and `"schedule": []` must never be handed a cron slot. Absent
 * (`undefined`) still means the default, because that is the whole inheritance
 * rule — a task that omits `schedule` takes the root cron, which for a watched
 * task is the reconciliation sweep. See `docs/watch.md`.
 */
export function cronsOf(schedule?: Schedule): string[] {
  if (schedule === undefined) return [DEFAULT_CRON]
  const list = Array.isArray(schedule) ? schedule : [schedule]
  return list.map((s) => s.trim()).filter(Boolean)
}

export function scheduleLabel(crons: string[]): string {
  if (crons.length === 0) return '-'
  if (crons.length === 1) return crons[0]
  return crons.join(', ')
}
