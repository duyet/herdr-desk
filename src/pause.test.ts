import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  emptyPause,
  isPaused,
  loadPaused,
  parseUntil,
  pauseKey,
  savePaused,
  withoutPause,
  withPause,
} from './pause'

const prev = process.env.HERDR_PLUGIN_STATE_DIR
afterEach(() => {
  if (prev === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR
  else process.env.HERDR_PLUGIN_STATE_DIR = prev
})

function stateDir(): string {
  const dir = join(tmpdir(), `desk-pause-${Date.now()}-${Math.random()}`)
  mkdirSync(dir, { recursive: true })
  process.env.HERDR_PLUGIN_STATE_DIR = dir
  return dir
}

const NOW = new Date(2026, 8, 30, 10, 0)

describe('isPaused', () => {
  test('an indefinite pause holds every future slot until resumed', () => {
    const s = withPause(emptyPause(), pauseKey('/r/a', 'triage'))
    expect(isPaused(s, '/r/a', 'triage', new Date(2027, 0, 1))).toBe(true)
    expect(isPaused(s, '/r/a', 'wrap', NOW)).toBe(false)
    expect(isPaused(s, '/r/b', 'triage', NOW)).toBe(false)
  })

  test('--until holds slots before it and releases the slot at it', () => {
    const until = new Date(2026, 9, 5)
    const s = withPause(emptyPause(), 'all', until)
    expect(isPaused(s, '/r/a', 'x', new Date(2026, 9, 4, 23, 59))).toBe(true)
    expect(isPaused(s, '/r/a', 'x', until)).toBe(false)
  })

  test('resume of one job leaves --all in force; resume all clears both', () => {
    let s = withPause(emptyPause(), 'all')
    s = withPause(s, pauseKey('/r/a', 'x'))
    s = withoutPause(s, pauseKey('/r/a', 'x'))
    expect(isPaused(s, '/r/a', 'x', NOW)).toBe(true)
    expect(isPaused(withoutPause(s, 'all'), '/r/a', 'x', NOW)).toBe(false)
  })
})

describe('parseUntil', () => {
  test('reads a date as local midnight and rejects the past and junk', () => {
    expect(parseUntil('2026-10-05', NOW)).toEqual(new Date(2026, 9, 5))
    expect(parseUntil('2026-10-05T08:30', NOW)).toEqual(
      new Date(2026, 9, 5, 8, 30),
    )
    expect(() => parseUntil('2026-09-01', NOW)).toThrow('past')
    expect(() => parseUntil('tomorrow', NOW)).toThrow('use YYYY')
  })
})

describe('paused.json', () => {
  test('round-trips through the state dir', () => {
    stateDir()
    savePaused(withPause(emptyPause(), 'all'))
    expect(loadPaused().all).toEqual({})
  })

  test('a corrupt file throws: reading it as "nothing paused" would fire stopped jobs', () => {
    const dir = stateDir()
    writeFileSync(join(dir, 'paused.json'), '{nope')
    expect(() => loadPaused()).toThrow('not valid JSON')
  })
})
