import { cronNext } from './cron'
import { describeJob } from './describe'
import { type Discovered } from './discover'
import { loadRuns } from './history'
import { textTable } from './table'

function fmt(d: Date | null): string {
  if (!d) return '-'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function formatSchedule(desks: Discovered[], now = new Date()): string {
  const runs = loadRuns(200)
  const rows: string[][] = []
  for (const d of desks) {
    for (const t of d.config.tasks) {
      for (const mode of ['morning', 'nightly'] as const) {
        const expr = t.schedule?.[mode]
        if (!expr) continue
        const next = cronNext(expr, now)
        const last = [...runs]
          .reverse()
          .find((r) => r.name === d.config.name && r.task === t.id && r.mode === mode)
        const lastText = last
          ? `${last.ok ? 'ok' : 'fail'} ${last.at.slice(0, 16).replace('T', ' ')}`
          : 'never'
        rows.push([
          d.config.name,
          `${t.id}/${mode}`,
          expr,
          fmt(next),
          lastText,
          t.agentName,
          describeJob(d.repo, t, mode),
        ])
      }
    }
  }
  if (rows.length === 0) return 'no desks'
  return textTable(
    ['Repo', 'Job', 'Cron', 'Next', 'Last', 'Agent', 'What'],
    rows,
  )
}
