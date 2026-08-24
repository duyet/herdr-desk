import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadFires, pruneFires, saveFires } from './daemon'

const prevState = process.env.HERDR_PLUGIN_STATE_DIR

afterEach(() => {
  if (prevState === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR
  else process.env.HERDR_PLUGIN_STATE_DIR = prevState
})

function stateDir(): string {
  const dir = join(tmpdir(), `desk-fires-${Date.now()}-${Math.random()}`)
  mkdirSync(dir, { recursive: true })
  process.env.HERDR_PLUGIN_STATE_DIR = dir
  return dir
}

describe('pruneFires', () => {
  test('drops keys older than 8 days so the file cannot grow forever', () => {
    const at = new Date(2026, 7, 24) // local Aug 24
    const kept = pruneFires(
      {
        'r::t::0 7 * * *::2026-08-16': 'ok',
        'r::t::0 7 * * *::2026-08-15': 'old',
        'r::t::0 7 * * *::2026-08-24': 'today',
        'not-a-key': 'junk',
      },
      at,
    )
    expect(kept).toEqual({
      'r::t::0 7 * * *::2026-08-16': 'ok',
      'r::t::0 7 * * *::2026-08-24': 'today',
    })
  })
})

describe('saveFires', () => {
  test('prunes on write — dropping prune would leave 9-day-old keys on disk', () => {
    const dir = stateDir()
    const at = new Date(2026, 7, 24)
    saveFires(
      {
        'r::t::0 7 * * *::2026-08-15': 'too-old',
        'r::t::0 7 * * *::2026-08-24': 'today',
      },
      at,
    )
    const written = JSON.parse(
      readFileSync(join(dir, 'fires.json'), 'utf8'),
    ) as Record<string, string>
    expect(written['r::t::0 7 * * *::2026-08-15']).toBeUndefined()
    expect(written['r::t::0 7 * * *::2026-08-24']).toBe('today')
  })
})

describe('loadFires', () => {
  test('quarantines corrupt JSON to fires.json.bak instead of silent discard', () => {
    const dir = stateDir()
    const path = join(dir, 'fires.json')
    writeFileSync(path, '{not json')
    expect(loadFires()).toEqual({})
    expect(existsSync(path)).toBe(false)
    expect(readFileSync(join(dir, 'fires.json.bak'), 'utf8')).toBe('{not json')
  })
})
