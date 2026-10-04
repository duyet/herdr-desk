import { cronNext } from './cron'
import { DAY_NAMES, dayKey } from './day'
import type { Discovered } from './discover'
import {
  describePause,
  emptyPause,
  isPaused,
  type PauseState,
  pausedNow,
} from './pause'
import { textTable } from './table'
import { paint, type TermOpts } from './term'

export type Fire = { at: Date; repo: string; job: string; agent: string }

/** A job firing more often than this in one day is shown as one summary line. */
export const DENSE = 6

const p = (n: number) => String(n).padStart(2, '0')
const hhmm = (d: Date) => `${p(d.getHours())}:${p(d.getMinutes())}`

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
    const k = dayKey(f.at)
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
      `${dayKey(f.at)} ${hhmm(f.at)}`,
      formatIn(f.at.getTime() - from.getTime()),
      f.repo,
      f.job,
      f.agent,
    ]),
  )
  return note ? `${table}\n\n${note}` : table
}

const DAY_SHORT = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/** Local midnight of `from` plus `n` days. */
function dayStart(from: Date, n: number): Date {
  const d = new Date(from)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + n)
  return d
}

/**
 * One lane per job over the next `days` days, one cell per day.
 *
 * A wide cell shows the first fire time, `xN` when the job fires more than once
 * that day, and `·` when it does not fire. Too narrow for that, each day falls
 * back to a one-character mark so the lane still reads left to right.
 */
export function formatTimeline(
  desks: Discovered[],
  opts: TermOpts,
  from = new Date(),
  days = 7,
  paused: PauseState = emptyPause(),
): string {
  const fires = upcomingFires(desks, from, days, paused)
  if (fires.length === 0) return `no fires in the next ${days} day(s)`
  const lanes = new Map<string, Fire[][]>()
  for (const f of fires) {
    const k = `${f.repo}/${f.job}`
    const lane = lanes.get(k) ?? Array.from({ length: days }, () => [])
    const i = Math.round(
      (dayStart(f.at, 0).getTime() - dayStart(from, 0).getTime()) / 86_400_000,
    )
    lane[i]?.push(f)
    lanes.set(k, lane)
  }
  const labelW = Math.min(
    Math.max(...[...lanes.keys()].map((k) => k.length)),
    Math.max(8, Math.floor(opts.width / 3)),
  )
  const wide = labelW + 2 + days * 7 <= opts.width
  const cellW = wide ? 7 : 2
  const cut = (s: string) =>
    s.length > labelW ? `${s.slice(0, labelW - 1)}…` : s.padEnd(labelW)
  const head = Array.from({ length: days }, (_, i) =>
    (wide
      ? DAY_SHORT[dayStart(from, i).getDay()]
      : DAY_SHORT[dayStart(from, i).getDay()][0]
    ).padEnd(cellW),
  ).join('')
  const lines = [`${' '.repeat(labelW)}  ${head}`.trimEnd()]
  for (const [k, lane] of [...lanes].sort((a, b) => a[0].localeCompare(b[0]))) {
    const cells = lane.map((fs) => {
      if (fs.length === 0) return paint(opts.color, '2', '·'.padEnd(cellW))
      if (!wide)
        return paint(
          opts.color,
          '32',
          (fs.length > 1 ? '█' : '▌').padEnd(cellW),
        )
      const text = fs.length > 1 ? `x${fs.length}` : hhmm(fs[0].at)
      return paint(opts.color, '32', text.padEnd(cellW))
    })
    lines.push(`${cut(k)}  ${cells.join('')}`.trimEnd())
  }
  return lines.join('\n')
}

/** 7 rows (Sun..Sat) x 24 hours of counts. */
export type Heat = number[][]

export function heatOf(dates: Date[]): Heat {
  const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0))
  for (const d of dates) grid[d.getDay()][d.getHours()] += 1
  return grid
}

const SHADES = ['·', '░', '▒', '▓', '█']

/**
 * The 7x24 density grid, Monday first.
 *
 * Narrower than 24 hour columns plus the label, hours are merged into 2h or 4h
 * buckets rather than wrapped, so a row is still one day.
 */
export function formatHeatmap(
  heat: Heat,
  opts: TermOpts,
  title: string,
): string {
  const label = 5
  const per = opts.width >= label + 24 ? 1 : opts.width >= label + 12 ? 2 : 4
  const cols = 24 / per
  const bucket = (row: number[]) =>
    Array.from({ length: cols }, (_, c) =>
      row.slice(c * per, c * per + per).reduce((a, b) => a + b, 0),
    )
  const rows = [1, 2, 3, 4, 5, 6, 0].map((d) => ({ d, cells: bucket(heat[d]) }))
  const max = Math.max(0, ...rows.flatMap((r) => r.cells))
  if (max === 0) return `${title}\nnothing to show`
  const axis = Array.from({ length: cols }, (_, c) => {
    const h = c * per
    return h % 6 === 0 ? p(h) : ''
  })
  let axisLine = ''
  for (let c = 0; c < cols; c++) {
    if (axisLine.length <= c && axis[c]) axisLine = axisLine.padEnd(c) + axis[c]
  }
  const lines = [title, `${' '.repeat(label)}${axisLine}`.trimEnd()]
  for (const { d, cells } of rows) {
    const marks = cells.map((n) => {
      const i = n === 0 ? 0 : Math.max(1, Math.ceil((n / max) * 4))
      return paint(opts.color && n > 0, i >= 3 ? '31' : '33', SHADES[i])
    })
    lines.push(`${DAY_SHORT[d].padEnd(label)}${marks.join('')}`)
  }
  lines.push(`max ${max} per cell${per > 1 ? `, ${per}h per column` : ''}`)
  return lines.join('\n')
}

/** Escape a TEXT value per RFC 5545 §3.3.11. */
function icsText(s: string): string {
  return s.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, '\\n')
}

/** Fold a content line at 75 octets per RFC 5545 §3.1. */
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line)
  if (bytes.length <= 75) return line
  const out: string[] = []
  let cur = ''
  for (const ch of line) {
    const limit = out.length === 0 ? 75 : 74
    if (new TextEncoder().encode(cur + ch).length > limit) {
      out.push(cur)
      cur = ''
    }
    cur += ch
  }
  out.push(cur)
  return out.join('\r\n ')
}

const icsDate = (d: Date) =>
  `${d.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`

/**
 * The upcoming fires as an iCalendar file, one VEVENT per fire.
 *
 * Times are UTC so no VTIMEZONE is needed; every calendar app renders them in
 * local time. The UID is stable per job-minute, so re-importing replaces
 * events instead of duplicating them.
 */
export function toIcs(fires: Fire[], stamp = new Date()): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//herdr-desk//agenda//EN',
    'CALSCALE:GREGORIAN',
  ]
  for (const f of fires) {
    const slug = `${f.repo}-${f.job}`.replace(/[^A-Za-z0-9_-]/g, '_')
    lines.push(
      'BEGIN:VEVENT',
      `UID:${icsDate(f.at)}-${slug}@herdr-desk`,
      `DTSTAMP:${icsDate(stamp)}`,
      `DTSTART:${icsDate(f.at)}`,
      'DURATION:PT15M',
      `SUMMARY:${icsText(`${f.repo}/${f.job}`)}`,
      `DESCRIPTION:${icsText(`agent ${f.agent}`)}`,
      'END:VEVENT',
    )
  }
  lines.push('END:VCALENDAR')
  return `${lines.map(fold).join('\r\n')}\r\n`
}
