import { cronNext } from './cron'
import type { Discovered } from './discover'
import {
  describePause,
  emptyPause,
  isPaused,
  type PauseState,
  pausedNow,
} from './pause'
import { textTable } from './table'

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
  paused: PauseState = emptyPause(),
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
          if (!seen.has(at.getTime()) && !isPaused(paused, d.repo, t.id, at)) {
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
  paused: PauseState = emptyPause(),
): string {
  const fires = upcomingFires(desks, from, days, paused)
  const note = pausedNote(desks, paused, from)
  if (fires.length === 0) {
    return [`no fires in the next ${days} day(s)`, note]
      .filter(Boolean)
      .join('\n')
  }

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
  if (note) lines.push('', note)
  return lines.join('\n')
}

/** One line per paused job, so a slot missing from the list is explained. */
function pausedNote(
  desks: Discovered[],
  paused: PauseState,
  now: Date,
): string {
  const lines: string[] = []
  for (const d of desks) {
    for (const t of d.config.tasks) {
      const e = pausedNow(paused, d.repo, t.id, now)
      if (e) lines.push(`  ${d.config.name}  ${t.id}  ${describePause(e)}`)
    }
  }
  return lines.length ? `paused:\n${lines.join('\n')}` : ''
}

/** `2h05m`, `45m`, `1d03h`: how long until a fire, at minute precision. */
export function formatIn(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60_000))
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d > 0) return `${d}d${p(h)}h`
  if (h > 0) return `${h}h${p(m)}m`
  return `${m}m`
}

/**
 * The next `n` fires across the machine, soonest first.
 *
 * Built on {@link upcomingFires}, so `next`, `agenda` and `status` cannot
 * disagree about a slot. It inherits `cronNext`'s 8-day horizon: a job that
 * fires less than weekly does not appear until it is within a week.
 */
export function nextFires(
  desks: Discovered[],
  n: number,
  from = new Date(),
  paused: PauseState = emptyPause(),
): Fire[] {
  return upcomingFires(desks, from, 7, paused).slice(0, n)
}

export function formatNext(
  desks: Discovered[],
  n = 5,
  from = new Date(),
  paused: PauseState = emptyPause(),
): string {
  const fires = nextFires(desks, n, from, paused)
  const note = pausedNote(desks, paused, from)
  if (fires.length === 0) {
    return ['no fires in the next 7 days', note].filter(Boolean).join('\n')
  }
  const table = textTable(
    ['When', 'In', 'Repo', 'Job', 'Agent'],
    fires.map((f) => [
      `${dayOf(f.at)} ${hhmm(f.at)}`,
      formatIn(f.at.getTime() - from.getTime()),
      f.repo,
      f.job,
      f.agent,
    ]),
  )
  return note ? `${table}\n\n${note}` : table
}
