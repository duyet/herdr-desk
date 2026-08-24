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

/** True when every field expands (typos like star-slash-q and 10-2 fail here). */
export function cronExprOk(expr: string): boolean {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return false
  const [min, hour, dom, mon, dow] = parts
  return (
    expand(min, 0, 59) !== null &&
    expand(hour, 0, 23) !== null &&
    expand(dom, 1, 31) !== null &&
    expand(mon, 1, 12) !== null &&
    expand(dowField(dow), 0, 6) !== null
  )
}

function dowField(field: string): string {
  return field
    .toLowerCase()
    .replace(/sun|mon|tue|wed|thu|fri|sat/g, (n) => String(DOW_NAMES[n]))
}

export function cronMatches(expr: string, at: Date): boolean {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return false
  const [min, hour, dom, mon, dow] = parts
  const minutes = expand(min, 0, 59)
  const hours = expand(hour, 0, 23)
  const months = expand(mon, 1, 12)
  const days = expand(dom, 1, 31)
  const weekdays = expand(dowField(dow), 0, 6)
  if (!minutes || !hours || !months || !days || !weekdays) return false
  const minuteOk = minutes.has(at.getMinutes())
  const hourOk = hours.has(at.getHours())
  const monOk = months.has(at.getMonth() + 1)
  const domRestricted = dom !== '*'
  const dowRestricted = dow !== '*'
  const domOk = days.has(at.getDate())
  const dowOk = weekdays.has(at.getDay())
  // Vixie: if both DOM and DOW are restricted, either may match.
  const dayOk =
    domRestricted && dowRestricted
      ? domOk || dowOk
      : (!domRestricted || domOk) && (!dowRestricted || dowOk)
  return minuteOk && hourOk && monOk && dayOk
}

/** Next matching minute at or after `from` (seconds cleared). Null if none in 8 days. */
export function cronNext(expr: string, from = new Date()): Date | null {
  const start = new Date(from)
  start.setSeconds(0, 0)
  const cur = new Date(start)
  // if we're mid-minute and already matched, skip to next minute
  cur.setMinutes(cur.getMinutes() + 1)
  const limit = 8 * 24 * 60
  for (let i = 0; i < limit; i++) {
    if (cronMatches(expr, cur)) return new Date(cur)
    cur.setMinutes(cur.getMinutes() + 1)
  }
  return null
}

/** True if `expr` matches this minute, or already matched earlier today. */
export function cronDueToday(expr: string, at = new Date()): boolean {
  if (cronMatches(expr, at)) return true
  const cur = new Date(at)
  cur.setSeconds(0, 0)
  const y = cur.getFullYear()
  const mo = cur.getMonth()
  const d = cur.getDate()
  cur.setMinutes(cur.getMinutes() - 1)
  while (
    cur.getFullYear() === y &&
    cur.getMonth() === mo &&
    cur.getDate() === d
  ) {
    if (cronMatches(expr, cur)) return true
    cur.setMinutes(cur.getMinutes() - 1)
  }
  return false
}
