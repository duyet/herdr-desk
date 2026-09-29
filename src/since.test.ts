import { describe, expect, test } from 'bun:test'
import { parseSince } from './since'

const now = Date.parse('2026-09-30T12:00:00Z')

describe('parseSince', () => {
  test.each([
    ['30m', 30 * 60_000],
    ['12h', 12 * 3_600_000],
    ['7d', 7 * 86_400_000],
    ['2w', 14 * 86_400_000],
  ])('%s is that far before now', (text, ms) => {
    expect(parseSince(text, now)).toBe(now - ms)
  })

  test('trims whitespace', () => {
    expect(parseSince(' 1h ', now)).toBe(now - 3_600_000)
  })

  test.each(['', 'soon', '7', 'd', '1.5h', '-1d', '7y', '7dd'])(
    'rejects %p loudly',
    (text) => {
      expect(() => parseSince(text, now)).toThrow(/bad --since/)
    },
  )
})
