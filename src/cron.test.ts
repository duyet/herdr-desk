import { describe, expect, test } from 'bun:test'
import { cronMatches } from './cron'

describe('cronMatches', () => {
  test('7:00 daily', () => {
    const at = new Date(2026, 7, 18, 7, 0, 10)
    expect(cronMatches('0 7 * * *', at)).toBe(true)
    expect(cronMatches('0 8 * * *', at)).toBe(false)
  })

  test('rejects bad expr', () => {
    expect(cronMatches('0 7 * *', new Date())).toBe(false)
  })
})
