import { describe, expect, test } from 'bun:test'
import { interpolate } from './interpolate'

describe('interpolate', () => {
  test('replaces known keys', () => {
    expect(interpolate('hi {{name}}', { name: 'duyetbot' })).toBe('hi duyetbot')
  })

  test('leaves unknown keys', () => {
    expect(interpolate('{{missing}}', {})).toBe('{{missing}}')
  })
})
