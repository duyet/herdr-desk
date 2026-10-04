import { cronNext } from './cron'
import { formatLocal } from './day'
import { describeJob } from './describe'
import type { Discovered } from './discover'
import { failureStreak, loadRuns } from './history'
import { describePause, emptyPause, type PauseState, pausedNow } from './pause'
import { scheduleLabel } from './schedule'
import { textTable } from './table'

function fmt(d: Date | null): string {
  if (!d) return '-'
  return formatLocal(d)
}

export function formatSchedule(
  desks: Discovered[],
  now = new Date(),
  paused: PauseState = emptyPause(),
): string {
  const rows: string[][] = []
  for (const d of desks) {
    for (const t of d.config.tasks) {
      const nexts = t.crons
        .map((expr) => cronNext(expr, now))
        .filter((x): x is Date => x !== null)
        .sort((a, b) => a.getTime() - b.getTime())
      const job = { repo: d.repo, task: t.id }
      const hold = pausedNow(paused, d.repo, t.id, now)
      // One read, scoped to this job. A global tail answers "did anything run
      // recently", not "did *this* job run" — so on a busy desk the `Last`
      // column fell out of the window and rendered `never` for jobs that had
      // fired, including ones whose last fire failed. The streak already needed
      // this read, so the global load was a second, redundant one.
      const runs = loadRuns(200, job)
      const last = runs.at(-1)
      const lastText = last
        ? `${last.ok ? 'ok' : 'fail'} ${last.at.slice(0, 16).replace('T', ' ')}`
        : 'never'
      const streak = failureStreak(runs, job)
      // A non-zero streak is a job that broke, even if a later fire recovered.
      const failText =
        streak.count > 0
          ? `${streak.count} from ${streak.since?.slice(0, 10)}`
          : '-'
      rows.push([
        d.config.name,
        t.id,
        scheduleLabel(t.crons),
        hold ? describePause(hold) : fmt(nexts[0] ?? null),
        lastText,
        failText,
        t.agentName,
        describeJob(d.repo, t),
      ])
    }
  }
  if (rows.length === 0) return 'no desks'
  return textTable(
    ['Repo', 'Job', 'Cron', 'Next', 'Last', 'Fails', 'Agent', 'What'],
    rows,
  )
}
