import { describe, expect, test } from 'bun:test'
import { cronMatches, cronNext } from './cron'

describe('cronMatches', () => {
  test('7:00 daily', () => {
    const at = new Date(2026, 7, 18, 7, 0, 10)
    expect(cronMatches('0 7 * * *', at)).toBe(true)
    expect(cronMatches('0 8 * * *', at)).toBe(false)
  })

  test('rejects bad expr', () => {
    expect(cronMatches('0 7 * *', new Date())).toBe(false)
  })

  test('next is 07:00', () => {
    const from = new Date(2026, 7, 18, 6, 30, 0)
    const next = cronNext('0 7 * * *', from)
    expect(next?.getHours()).toBe(7)
    expect(next?.getMinutes()).toBe(0)
    expect(next?.getDate()).toBe(18)
  })
})
