import { cronNext } from './cron'
import { type Discovered } from './discover'
import { loadRuns } from './history'

function fmt(d: Date | null): string {
  if (!d) return '-'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function formatSchedule(desks: Discovered[], now = new Date()): string {
  const runs = loadRuns(200)
  const lines: string[] = []
  for (const d of desks) {
    lines.push(`${d.config.name}  ${d.repo}`)
    for (const t of d.config.tasks) {
      for (const mode of ['morning', 'nightly'] as const) {
        const expr = t.schedule?.[mode]
        if (!expr) continue
        const next = cronNext(expr, now)
        const last = [...runs]
          .reverse()
          .find((r) => r.name === d.config.name && r.task === t.id && r.mode === mode)
        const lastText = last ? `${last.ok ? 'ok' : 'fail'} ${last.at}` : 'never'
        lines.push(
          `  ${t.id} ${mode.padEnd(8)} [${expr}]  next ${fmt(next)}  last ${lastText}`,
        )
      }
    }
  }
  return lines.join('\n') || 'no desks'
}
