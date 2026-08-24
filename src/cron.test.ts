import { describe, expect, test } from 'bun:test'
import { cronDueToday, cronMatches, cronNext } from './cron'

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
