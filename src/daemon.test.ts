import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  catchUpPlan,
  loadFires,
  pruneFires,
  saveFires,
  skipPausedSlots,
} from './daemon'

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

describe('fireDay with slot-keyed entries', () => {
  test('finds the day in a slot-keyed key so pruning keeps it', () => {
    // fireDay used to read the LAST `::` segment, which is `HH:MM` once keys
    // carry a slot — every entry then looked dayless and pruneFires deleted the
    // whole ledger on the next write, re-firing every job from scratch.
    const { pruneFires } = require('./daemon') as typeof import('./daemon')
    const day = new Date()
    const today = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
    const kept = pruneFires(
      {
        [`/repo::task::*/30 * * * *::${today}::09:30`]:
          '2026-09-27T09:30:00.000Z',
      },
      day,
    )
    expect(Object.keys(kept)).toHaveLength(1)
  })

  test('still understands legacy day-only keys', () => {
    const { pruneFires } = require('./daemon') as typeof import('./daemon')
    const day = new Date()
    const today = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
    const kept = pruneFires(
      { [`/repo::task::0 7 * * *::${today}`]: '2026-09-27T07:00:00.000Z' },
      day,
    )
    expect(Object.keys(kept)).toHaveLength(1)
  })
})

describe('migrateFires', () => {
  const day = '2026-09-27'

  test('claims the WHOLE day, so the first tick after upgrade cannot stampede', () => {
    // The bug this prevents: a half-hourly job recorded at 09:20 under the old
    // day-keyed ledger would find 30 "unfired" slots on the first tick after
    // the upgrade and run 30 times in one go.
    const { migrateFires } = require('./daemon') as typeof import('./daemon')
    const out = migrateFires({
      [`/repo::task::*/30 * * * *::${day}`]: new Date(
        2026,
        8,
        27,
        9,
        20,
      ).toISOString(),
    })
    const slots = Object.keys(out).filter((k) => k.startsWith('/repo::task'))
    expect(slots).toHaveLength(48)
    expect(slots.some((k) => k.endsWith('::00:00'))).toBe(true)
    expect(slots.some((k) => k.endsWith('::23:30'))).toBe(true)
  })

  test('a daily cron claims its one slot', () => {
    const { migrateFires } = require('./daemon') as typeof import('./daemon')
    const out = migrateFires({
      [`/repo::task::0 7 * * *::${day}`]: new Date(
        2026,
        8,
        27,
        7,
        0,
      ).toISOString(),
    })
    expect(Object.keys(out)).toEqual([`/repo::task::0 7 * * *::${day}::07:00`])
  })

  test('passes slot-keyed entries through untouched', () => {
    const { migrateFires } = require('./daemon') as typeof import('./daemon')
    const key = `/repo::task::0 7 * * *::${day}::07:00`
    expect(migrateFires({ [key]: 'x' })).toEqual({ [key]: 'x' })
  })

  test('carries a fail marker through, so the streak survives the migration', () => {
    const { migrateFires } = require('./daemon') as typeof import('./daemon')
    const out = migrateFires({
      [`/repo::task::0 7 * * *::${day}`]: `fail ${new Date(2026, 8, 27, 7, 1).toISOString()}`,
    })
    expect(Object.values(out).every((v) => v.startsWith('fail '))).toBe(true)
  })

  test('ignores a key that is not a legacy day key', () => {
    const { migrateFires } = require('./daemon') as typeof import('./daemon')
    expect(migrateFires({ garbage: 'v' })).toEqual({ garbage: 'v' })
  })
})

describe('catchUpPlan', () => {
  const half = ['00:10', '00:40', '01:10', '01:40', '02:10']
  const noneFired = () => false

  test('runs the newest missed slot and writes off the rest', () => {
    // The live shape on 2026-09-28: a desk off for six hours, 12 missed slots
    // per half-hourly job, every start replaying all twelve at ~300ms each.
    const plan = catchUpPlan(half, noneFired)
    expect(plan.run).toBe('02:10')
    expect(plan.stale).toEqual(['00:10', '00:40', '01:10', '01:40'])
  })

  test('one missed slot still runs', () => {
    const plan = catchUpPlan(half, (slot) => slot !== '02:10')
    expect(plan.run).toBe('02:10')
    expect(plan.stale).toEqual([])
  })

  test('nothing missed means nothing to do', () => {
    expect(catchUpPlan(half, () => true)).toEqual({ run: undefined, stale: [] })
  })

  test('a slot already failed is not re-run as catch-up', () => {
    // A failure is a record, not an invitation: the ledger holds `fail ...` for
    // it, so a job that failed once does not run again until its next slot.
    const plan = catchUpPlan(half, (slot) => slot === '02:10')
    expect(plan.run).toBe('01:40')
    expect(plan.stale).toEqual(['00:10', '00:40', '01:10'])
  })
})

describe('skipPausedSlots', () => {
  test('paused slots are consumed, so resuming does not replay them', () => {
    const fires: Record<string, string> = {}
    const slots = ['07:00', '07:30', '08:00']
    const cron = '*/30 * * * *'
    expect(skipPausedSlots(fires, '/r', 't', cron, '2026-09-30', slots)).toBe(3)
    expect(Object.values(fires).every((v) => v.startsWith('skip paused'))).toBe(
      true,
    )
    // After resume the catch-up plan sees every slot as fired: nothing runs.
    const plan = catchUpPlan(slots, (slot) =>
      Boolean(fires[`/r::t::${cron}::2026-09-30::${slot}`]),
    )
    expect(plan).toEqual({ run: undefined, stale: [] })
  })

  test('a slot that already fired keeps its real record', () => {
    const key = '/r::t::0 7 * * *::2026-09-30::07:00'
    const fires = { [key]: '2026-09-30T07:00:01Z' }
    expect(
      skipPausedSlots(fires, '/r', 't', '0 7 * * *', '2026-09-30', ['07:00']),
    ).toBe(0)
    expect(fires[key]).toBe('2026-09-30T07:00:01Z')
  })
})
