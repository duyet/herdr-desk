/** 5-field cron: min hour dom mon dow. Local wall clock. */

const DOW_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
}

function intToken(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null
  return Number(raw)
}

/** Expand one cron field. Null if a token is NaN, unordered, or out of range. */
function expand(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>()
  if (field === '*') {
    for (let n = min; n <= max; n++) out.add(n)
    return out
  }
  for (const part of field.split(',')) {
    const [range, stepRaw] = part.split('/')
    const step = stepRaw === undefined ? 1 : intToken(stepRaw)
    if (step === null || Number.isNaN(step) || step < 1) return null
    if (range === '*') {
      for (let n = min; n <= max; n += step) out.add(n)
      continue
    }
    const [a, b] = range.split('-')
    const start = intToken(a)
    const end = b === undefined ? start : intToken(b)
    if (start === null || end === null) return null
    if (Number.isNaN(start) || Number.isNaN(end) || start > end) return null
    if (start < min || end > max) return null
    for (let n = start; n <= end; n += step) out.add(n)
  }
  return out
}

function dowField(field: string): string {
  return field
    .toLowerCase()
    .replace(/sun|mon|tue|wed|thu|fri|sat/g, (n) => String(DOW_NAMES[n]))
}

export type CompiledCron = {
  expr: string
  minutes: number[]
  hours: number[]
  doms: number[]
  months: number[]
  dows: number[]
  /** Vixie: when both are restricted, either may match. */
  domRestricted: boolean
  dowRestricted: boolean
}

/**
 * Parsed form of one cron expression.
 *
 * The daemon evaluates the same handful of expressions on every tick, so
 * parsing is done once and memoised. `null` means the expression is invalid
 * (a bad step like star-slash-q, or an unordered range like `10-2`).
 */
export function compileCron(expr: string): CompiledCron | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [min, hour, dom, mon, dow] = parts
  const minutes = expand(min, 0, 59)
  const hours = expand(hour, 0, 23)
  const doms = expand(dom, 1, 31)
  const months = expand(mon, 1, 12)
  const dows = expand(dowField(dow), 0, 6)
  if (!minutes || !hours || !doms || !months || !dows) return null
  return {
    expr,
    minutes: [...minutes].sort((a, b) => a - b),
    hours: [...hours].sort((a, b) => a - b),
    doms: [...doms].sort((a, b) => a - b),
    months: [...months].sort((a, b) => a - b),
    dows: [...dows].sort((a, b) => a - b),
    domRestricted: dom !== '*',
    dowRestricted: dow !== '*',
  }
}

const CACHE_LIMIT = 256
const cache = new Map<string, CompiledCron | null>()

/** Memoised {@link compileCron}. Only a handful of expressions are ever live. */
function compiled(expr: string): CompiledCron | null {
  const hit = cache.get(expr)
  if (hit !== undefined) return hit
  const value = compileCron(expr)
  if (cache.size >= CACHE_LIMIT) cache.clear()
  cache.set(expr, value)
  return value
}

/** True when every field expands (typos like star-slash-q and 10-2 fail here). */
export function cronExprOk(expr: string): boolean {
  return compiled(expr) !== null
}

function dayMatches(c: CompiledCron, at: Date): boolean {
  if (!c.months.includes(at.getMonth() + 1)) return false
  const domOk = c.doms.includes(at.getDate())
  const dowOk = c.dows.includes(at.getDay())
  if (c.domRestricted && c.dowRestricted) return domOk || dowOk
  return (!c.domRestricted || domOk) && (!c.dowRestricted || dowOk)
}

export function cronMatches(expr: string, at: Date): boolean {
  const c = compiled(expr)
  if (!c) return false
  return (
    c.minutes.includes(at.getMinutes()) &&
    c.hours.includes(at.getHours()) &&
    dayMatches(c, at)
  )
}

/** 8-day horizon, matching the documented `cronNext` contract. */
const HORIZON_MINUTES = 8 * 24 * 60

/**
 * Next matching minute at or after `from` (seconds cleared). Null if none in 8 days.
 *
 * Jumps by the largest mismatching field instead of stepping one minute at a
 * time. A minute-stepping search costs up to 11,520 evaluations for a sparse
 * daily cron; this costs a handful, and the daemon plus `status` call it
 * constantly.
 */
export function cronNext(expr: string, from = new Date()): Date | null {
  const c = compiled(expr)
  if (!c) return null

  const cur = new Date(from)
  cur.setSeconds(0, 0)
  // A cron matches a whole minute, so a partial current minute is already past.
  cur.setMinutes(cur.getMinutes() + 1)

  const limit = new Date(from.getTime() + HORIZON_MINUTES * 60_000)
  let guard = 0
  while (cur.getTime() <= limit.getTime()) {
    if (++guard > 10_000) return null
    if (!c.months.includes(cur.getMonth() + 1)) {
      // Skip to the first instant of the next month.
      cur.setMonth(cur.getMonth() + 1, 1)
      cur.setHours(0, 0, 0, 0)
      continue
    }
    if (!dayMatches(c, cur)) {
      cur.setDate(cur.getDate() + 1)
      cur.setHours(0, 0, 0, 0)
      continue
    }
    if (!c.hours.includes(cur.getHours())) {
      const nextHour = c.hours.find((h) => h > cur.getHours())
      if (nextHour === undefined) {
        cur.setDate(cur.getDate() + 1)
        cur.setHours(0, 0, 0, 0)
        continue
      }
      cur.setHours(nextHour, 0, 0, 0)
      continue
    }
    if (!c.minutes.includes(cur.getMinutes())) {
      const nextMinute = c.minutes.find((m) => m > cur.getMinutes())
      if (nextMinute === undefined) {
        cur.setHours(cur.getHours() + 1, 0, 0, 0)
        continue
      }
      cur.setMinutes(nextMinute, 0, 0)
      continue
    }
    return new Date(cur)
  }
  return null
}

/**
 * Every `(hour, minute)` slot `expr` matches today, up to and including the
 * minute of `at`, as `HH:MM` strings in ascending order.
 *
 * This is the slot-level primitive. `cronDueToday` collapses it to a boolean,
 * which is fine for "is there anything to do" but loses *which* slot — and a
 * day-keyed fire ledger built on that boolean fires any expression at most
 * once per day, so a half-hourly cron runs 48 times less often than configured.
 */
export function cronSlotsToday(expr: string, at = new Date()): string[] {
  const c = compiled(expr)
  if (!c) return []
  if (!dayMatches(c, at)) return []
  const nowH = at.getHours()
  const nowM = at.getMinutes()
  const p = (n: number) => String(n).padStart(2, '0')
  const out: string[] = []
  for (const h of c.hours) {
    if (h > nowH) continue
    for (const m of c.minutes) {
      if (h === nowH && m > nowM) continue
      out.push(`${p(h)}:${p(m)}`)
    }
  }
  return out.sort()
}

/**
 * True if `expr` matches this minute, or already matched earlier today.
 *
 * Only `(hour, minute)` pairs the expression can actually produce are
 * considered, so this is bounded by the size of the compiled sets rather than
 * by the 1,440 minutes in a day.
 */
export function cronDueToday(expr: string, at = new Date()): boolean {
  return cronSlotsToday(expr, at).length > 0
}
