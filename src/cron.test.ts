import { describe, expect, test } from 'bun:test'
import {
  compileCron,
  cronDueToday,
  cronMatches,
  cronNext,
  cronSlotsToday,
} from './cron'

/**
 * Brute-force reference, deliberately naive: step one minute at a time and ask
 * `cronMatches`. The optimised implementations must agree with this on every
 * input, which is the only real proof that field-jumping is safe.
 */
function refNext(expr: string, from: Date): Date | null {
  const cur = new Date(from)
  cur.setSeconds(0, 0)
  cur.setMinutes(cur.getMinutes() + 1)
  for (let i = 0; i < 8 * 24 * 60; i++) {
    if (cronMatches(expr, cur)) return new Date(cur)
    cur.setMinutes(cur.getMinutes() + 1)
  }
  return null
}

function refDueToday(expr: string, at: Date): boolean {
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

const EXPRS = [
  '0 7 * * *',
  '0 8 * * *',
  '*/15 * * * *',
  '0 9 * * mon-fri',
  '30 6 1 * *',
  '0 0 1 1 *',
  '15,45 3-5 * * *',
  '0 0 * * 0',
  '*/7 */3 * * *',
  '59 23 31 12 *',
]

describe('cronMatches', () => {
  test('7:00 daily', () => {
    const at = new Date(2026, 7, 18, 7, 0, 10)
    expect(cronMatches('0 7 * * *', at)).toBe(true)
    expect(cronMatches('0 8 * * *', at)).toBe(false)
  })

  test('rejects bad expr', () => {
    expect(cronMatches('0 7 * *', new Date())).toBe(false)
  })

  test('does not treat NaN step or inverted range as a match', () => {
    const at = new Date(2026, 7, 18, 0, 0, 0)
    expect(cronMatches('*/q * * * *', at)).toBe(false)
    expect(cronMatches('10-2 * * * *', at)).toBe(false)
    expect(cronMatches('61 * * * *', at)).toBe(false)
  })

  test('*/15 still matches the step', () => {
    const at = new Date(2026, 7, 18, 7, 15, 0)
    expect(cronMatches('*/15 * * * *', at)).toBe(true)
    expect(cronMatches('*/15 * * * *', new Date(2026, 7, 18, 7, 16, 0))).toBe(
      false,
    )
  })

  test('next is 07:00', () => {
    const from = new Date(2026, 7, 18, 6, 30, 0)
    const next = cronNext('0 7 * * *', from)
    expect(next?.getHours()).toBe(7)
    expect(next?.getMinutes()).toBe(0)
    expect(next?.getDate()).toBe(18)
  })
})

describe('cronDueToday', () => {
  test('not yet due before the slot', () => {
    expect(cronDueToday('0 8 * * *', new Date(2026, 7, 18, 7, 59, 0))).toBe(
      false,
    )
  })

  test('due on the slot minute', () => {
    expect(cronDueToday('0 8 * * *', new Date(2026, 7, 18, 8, 0, 20))).toBe(
      true,
    )
  })

  test('still due after the slot the same day', () => {
    expect(cronDueToday('0 8 * * *', new Date(2026, 7, 18, 11, 34, 0))).toBe(
      true,
    )
  })
})

describe('compileCron', () => {
  test('rejects the same expressions cronMatches rejects', () => {
    for (const bad of [
      '*/q * * * *',
      '10-2 * * * *',
      '61 * * * *',
      '0 7 * *',
    ]) {
      expect(compileCron(bad), bad).toBeNull()
    }
  })

  test('records which day fields were restricted', () => {
    // Vixie: when both DOM and DOW are restricted, either may match.
    const both = compileCron('0 7 13 * 5')
    expect(both?.domRestricted).toBe(true)
    expect(both?.dowRestricted).toBe(true)
    const domOnly = compileCron('0 7 13 * *')
    expect(domOnly?.domRestricted).toBe(true)
    expect(domOnly?.dowRestricted).toBe(false)
    expect(compileCron('0 7 * * *')?.domRestricted).toBe(false)
  })

  test('expands fields to sorted value lists', () => {
    const c = compileCron('15,45 3-5 * * *')
    expect(c?.minutes).toEqual([15, 45])
    expect(c?.hours).toEqual([3, 4, 5])
  })
})

describe('differential vs brute force', () => {
  // Why: cronNext and cronDueToday were rewritten from minute-stepping to
  // field-jumping and set-pair enumeration. These assert the optimisation did
  // not change any answer, across month/year/day boundaries and DST-ish hours.
  const starts = [
    new Date(2026, 7, 18, 6, 30, 0),
    new Date(2026, 7, 18, 7, 0, 0),
    new Date(2026, 7, 18, 23, 59, 30),
    new Date(2026, 11, 31, 23, 30, 0),
    new Date(2026, 0, 1, 0, 0, 0),
    new Date(2026, 2, 29, 12, 0, 0), // 2026 is not a leap year
    new Date(2027, 2, 28, 12, 0, 0),
  ]

  test('cronNext agrees with minute-stepping on every start', () => {
    for (const expr of EXPRS) {
      for (const from of starts) {
        expect(cronNext(expr, from)?.getTime(), `${expr} @ ${from}`).toBe(
          refNext(expr, from)?.getTime(),
        )
      }
    }
  })

  test('cronDueToday agrees with walking back through the day', () => {
    for (const expr of EXPRS) {
      for (const from of starts) {
        for (const offsetMin of [0, 1, 59, 60, 7 * 60, 13 * 60]) {
          const at = new Date(from.getTime() + offsetMin * 60_000)
          expect(cronDueToday(expr, at), `${expr} @ ${at}`).toBe(
            refDueToday(expr, at),
          )
        }
      }
    }
  })

  test('cronNext never returns a minute that does not match', () => {
    for (const expr of EXPRS) {
      for (const from of starts) {
        const next = cronNext(expr, from)
        if (!next) continue
        expect(cronMatches(expr, next), `${expr} @ ${from}`).toBe(true)
        expect(next.getTime(), `${expr} @ ${from}`).toBeGreaterThan(
          from.getTime(),
        )
      }
    }
  })

  test('cronNext returns null for an expression that cannot fire', () => {
    // 30 February never occurs, so an 8-day horizon can never find one.
    expect(cronNext('0 0 30 2 *', new Date(2026, 0, 1))).toBeNull()
    expect(cronNext('*/q * * * *', new Date())).toBeNull()
  })
})

describe('cronSlotsToday', () => {
  const at = (s: string) => new Date(s)

  test('returns every half-hour slot up to now, not one boolean', () => {
    // The regression: `cronDueToday` was the only primitive, and the daemon
    // keyed its ledger on (repo, task, cron, day), so the first fire of the day
    // consumed the whole schedule and `*/30` ran once a day instead of 48.
    expect(cronSlotsToday('*/30 * * * *', at('2026-09-27T09:20:00'))).toEqual([
      '00:00',
      '00:30',
      '01:00',
      '01:30',
      '02:00',
      '02:30',
      '03:00',
      '03:30',
      '04:00',
      '04:30',
      '05:00',
      '05:30',
      '06:00',
      '06:30',
      '07:00',
      '07:30',
      '08:00',
      '08:30',
      '09:00',
    ])
  })

  test('a two-slot cron yields two keys, so the second one still fires', () => {
    expect(cronSlotsToday('0,30 * * * *', at('2026-09-27T00:40:00'))).toEqual([
      '00:00',
      '00:30',
    ])
  })

  test('includes the current minute so an on-time fire is not skipped', () => {
    expect(cronSlotsToday('*/30 * * * *', at('2026-09-27T00:30:00'))).toEqual([
      '00:00',
      '00:30',
    ])
  })

  test('a daily cron still yields exactly one slot', () => {
    expect(cronSlotsToday('0 7 * * *', at('2026-09-27T09:20:00'))).toEqual([
      '07:00',
    ])
  })

  test('returns nothing before the first slot of the day', () => {
    expect(cronSlotsToday('0 7 * * *', at('2026-09-27T06:59:00'))).toEqual([])
  })

  test('honours day-of-week, so a weekly job does not fire on other days', () => {
    // 2026-09-28 is a Monday.
    expect(cronSlotsToday('0 9 * * 1', at('2026-09-28T10:00:00'))).toEqual([
      '09:00',
    ])
    expect(cronSlotsToday('0 9 * * 1', at('2026-09-27T10:00:00'))).toEqual([])
  })

  test('cronDueToday stays consistent with the slot list', () => {
    expect(cronDueToday('*/30 * * * *', at('2026-09-27T09:20:00'))).toBe(true)
    expect(cronDueToday('0 7 * * *', at('2026-09-27T06:59:00'))).toBe(false)
  })
})
