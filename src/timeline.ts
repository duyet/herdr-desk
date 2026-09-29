import { cronNext } from './cron'
import type { Discovered } from './discover'

export type Fire = { at: Date; repo: string; job: string; agent: string }

/** A job firing more often than this in one day is shown as one summary line. */
const DENSE = 6

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const p = (n: number) => String(n).padStart(2, '0')
const hhmm = (d: Date) => `${p(d.getHours())}:${p(d.getMinutes())}`
const dayOf = (d: Date) =>
  `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`

/**
 * Every fire of every job from `from` up to `days` ahead, oldest first.
 *
 * Built by chaining `cronNext`, so it agrees with `status` by construction.
 * Days are local wall-clock days, like the crons themselves.
 */
export function upcomingFires(
  desks: Discovered[],
  from = new Date(),
  days = 7,
): Fire[] {
  const end = new Date(from)
  end.setHours(0, 0, 0, 0)
  end.setDate(end.getDate() + days)
  const out: Fire[] = []
  for (const d of desks) {
    for (const t of d.config.tasks) {
      // Two crons can hit the same minute; the daemon fires that slot once.
      const seen = new Set<number>()
      for (const expr of t.crons) {
        let at = cronNext(expr, from)
        while (at && at.getTime() < end.getTime()) {
          if (!seen.has(at.getTime())) {
            seen.add(at.getTime())
            out.push({ at, repo: d.config.name, job: t.id, agent: t.agentName })
          }
          at = cronNext(expr, at)
        }
      }
    }
  }
  return out.sort(
    (a, b) =>
      a.at.getTime() - b.at.getTime() ||
      a.repo.localeCompare(b.repo) ||
      a.job.localeCompare(b.job),
  )
}

/**
 * Upcoming fires grouped by day, one line per slot.
 *
 * A minute where two or more jobs fire is marked, because those jobs contend
 * for the same agent quota and the same machine at the same time. A job that
 * fires more than {@link DENSE} times in a day collapses to one range line so a
 * `*\/5` cron does not bury the rest of the day.
 */
export function formatAgenda(
  desks: Discovered[],
  from = new Date(),
  days = 7,
): string {
  const fires = upcomingFires(desks, from, days)
  if (fires.length === 0) return `no fires in the next ${days} day(s)`

  const perMinute = new Map<number, number>()
  for (const f of fires) {
    const k = f.at.getTime()
    perMinute.set(k, (perMinute.get(k) ?? 0) + 1)
  }

  const byDay = new Map<string, Fire[]>()
  for (const f of fires) {
    const k = dayOf(f.at)
    const list = byDay.get(k) ?? []
    list.push(f)
    byDay.set(k, list)
  }

  const lines: string[] = []
  for (const [day, list] of byDay) {
    lines.push(`${DAY_NAMES[list[0].at.getDay()]} ${day}`)
    const perJob = new Map<string, Fire[]>()
    for (const f of list) {
      const k = `${f.repo}\0${f.job}`
      perJob.set(k, [...(perJob.get(k) ?? []), f])
    }
    const dense = new Set(
      [...perJob].filter(([, js]) => js.length > DENSE).map(([k]) => k),
    )
    const emitted = new Set<string>()
    for (const f of list) {
      const key = `${f.repo}\0${f.job}`
      const who = `${f.repo}  ${f.job}  (${f.agent})`
      if (dense.has(key)) {
        if (emitted.has(key)) continue
        emitted.add(key)
        const js = perJob.get(key) ?? []
        const last = js[js.length - 1]
        lines.push(
          `  ${hhmm(f.at)}-${hhmm(last.at)}  ${who}  x${js.length} fires`,
        )
        continue
      }
      const n = perMinute.get(f.at.getTime()) ?? 1
      lines.push(
        `  ${hhmm(f.at)}  ${who}${n > 1 ? `  [shares slot x${n}]` : ''}`,
      )
    }
  }
  return lines.join('\n')
}
