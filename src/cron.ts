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

function expand(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>()
  if (field === '*') {
    for (let n = min; n <= max; n++) out.add(n)
    return out
  }
  for (const part of field.split(',')) {
    const [range, stepRaw] = part.split('/')
    const step = stepRaw ? Number(stepRaw) : 1
    if (range === '*') {
      for (let n = min; n <= max; n += step) out.add(n)
      continue
    }
    const [a, b] = range.split('-')
    const start = Number(a)
    const end = b === undefined ? start : Number(b)
    for (let n = start; n <= end; n += step) {
      if (n >= min && n <= max) out.add(n)
    }
  }
  return out
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
  const minuteOk = expand(min, 0, 59).has(at.getMinutes())
  const hourOk = expand(hour, 0, 23).has(at.getHours())
  const monOk = expand(mon, 1, 12).has(at.getMonth() + 1)
  const domRestricted = dom !== '*'
  const dowRestricted = dow !== '*'
  const domOk = expand(dom, 1, 31).has(at.getDate())
  const dowOk = expand(dowField(dow), 0, 6).has(at.getDay())
  // Vixie: if both DOM and DOW are restricted, either may match.
  const dayOk =
    domRestricted && dowRestricted ? domOk || dowOk : (!domRestricted || domOk) && (!dowRestricted || dowOk)
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
