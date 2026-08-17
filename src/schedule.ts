import type { Schedule } from './config'

export const DEFAULT_CRON = '0 7 * * *'

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
