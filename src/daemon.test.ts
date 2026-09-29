import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  catchUpPlan,
  loadFires,
  pruneFires,
  saveFires,
  skipPausedSlots,
  stopOn,
  tickOnce,
} from './daemon'
import { loadRuns } from './history'
import { hold, queued } from './queue'

// Everything the tick reads off the host, so a run cannot pick up the machine's
// real Herdr, real desk configs, or a real Telegram token.
const HOST_ENV = [
  'HERDR_PLUGIN_STATE_DIR',
  'HERDR_PLUGIN_CONFIG_DIR',
  'HERDR_BIN_PATH',
  'HERDR_BIN',
  'HERDR_SOCKET_PATH',
  'HERDR_DESK_TELEGRAM_TOKEN',
  'HERDR_DESK_TELEGRAM_CHAT_ID',
] as const
const prevEnv = HOST_ENV.map((k) => [k, process.env[k]] as const)
const tempDirs: string[] = []

afterEach(() => {
  for (const [k, v] of prevEnv) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function stateDir(): string {
  const dir = tempDir('desk-fires-')
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

describe('a daemon that is asked to stop', () => {
  test('the stop is logged and the pid file goes', () => {
    // The 2026-09-28 outage: earlyoom sent SIGTERM and `daemon.log` had no end
    // to the hole. Without this line the desk cannot tell a machine killing it
    // from a person stopping it — the log reads the same either way, which is
    // to say it says nothing.
    const dir = stateDir()
    writeFileSync(join(dir, 'daemon.pid'), `${process.pid}\n`)
    const codes: number[] = []

    stopOn('SIGTERM', (code) => codes.push(code))

    const written = readFileSync(join(dir, 'daemon.log'), 'utf8')
    expect(written).toContain('SIGTERM')
    expect(written).toContain(`pid=${process.pid}`)
    expect(existsSync(join(dir, 'daemon.pid'))).toBe(false)
    // Asked to stop is not a crash. A supervisor that read it as one would
    // restart the daemon into whatever was pressuring it.
    expect(codes).toEqual([0])
  })

  test('a terminal stop and an outside stop do not read the same', () => {
    // They are different incidents. One line for both makes the 3am read
    // "the desk stopped" when the answer is "something killed the desk".
    const dir = stateDir()
    stopOn('SIGINT', () => {})
    stopOn('SIGTERM', () => {})
    const lines = readFileSync(join(dir, 'daemon.log'), 'utf8')
      .split('\n')
      .filter(Boolean)
    expect(lines).toHaveLength(2)
    expect(lines[0]).not.toBe(lines[1])
  })
})

describe('a held job whose slot comes due', () => {
  const TASK = 'local:triage'
  // 09:15, so the newest due slot for a `* * * * *` job is `09:15` itself.
  const AT = new Date(2026, 8, 30, 9, 15)
  const SLOT = '09:15'
  const HELD_AT = new Date(2026, 8, 30, 8, 45)

  /**
   * A one-task desk on a temp repo, and a Herdr that is not running.
   *
   * `herdrUp` chooses which way the run goes without stubbing `runTask`: a
   * missing socket is a precondition skip, so the run resolves, while a missing
   * binary throws. Both are the real path, and neither reaches the network.
   */
  function desk(herdrUp: boolean): string {
    const state = stateDir()
    const repo = tempDir('herdr-desk-repo-')
    writeFileSync(
      join(repo, '.herdr-desk.json'),
      `${JSON.stringify({
        name: 'held-test',
        tasks: [{ id: TASK, schedule: '* * * * *' }],
      })}\n`,
    )
    // `discoverDesks` finds a remembered repo, since Herdr is not here to list
    // the open workspaces.
    writeFileSync(
      join(state, 'known-repos.json'),
      `${JSON.stringify({ repos: [repo] })}\n`,
    )
    // The binary has to exist for a missing socket to be the reported problem.
    process.env.HERDR_BIN_PATH = herdrUp
      ? process.execPath
      : join(state, 'no-herdr')
    process.env.HERDR_SOCKET_PATH = join(state, 'herdr.sock')
    // The global desk config and the notify token both live here, and a dev box
    // has a real Telegram token in the default location.
    process.env.HERDR_PLUGIN_CONFIG_DIR = tempDir('herdr-desk-config-')
    delete process.env.HERDR_DESK_TELEGRAM_TOKEN
    delete process.env.HERDR_DESK_TELEGRAM_CHAT_ID
    // `readHealth` asks Herdr how many sessions are alive, and this is not the
    // moment to learn what the developer's desk is doing.
    process.env.HERDR_BIN = join(state, 'no-herdr')
    return repo
  }

  const heldFor = (repo: string): void => {
    hold(
      { repo, task: TASK, slot: SLOT, reason: 'load 2.1/core over 1.5' },
      HELD_AT,
    )
  }

  // The real gate reads the real host, so these two would assert nothing on a
  // box over budget — and worse, pass, because a held job is also still owed.
  // A fixed verdict keeps the tick hermetic and these tests honest.
  const roomy = () => ({ ok: true, breaches: [], pressure: 0 })

  test('the recovered job runs once, and the queue stops owing it', async () => {
    // The tick fires the due slot, then drains one held job. A held slot is
    // deliberately never written to `fires`, so the ledger cannot tell "still
    // owed" from "just ran" — and it ran twice, with two honest fires recorded
    // for one due slot.
    const repo = desk(true)
    heldFor(repo)

    await tickOnce(AT, roomy)

    expect(loadRuns(50, { repo, task: TASK })).toHaveLength(1)
    expect(queued()).toHaveLength(0)
  })

  test('a job whose run fails is still owed, at the age it had', async () => {
    // The other half. Discharging a failed run would report a job as done that
    // never happened, and would restart the clock that gives up on a desk that
    // can never take the work.
    const repo = desk(false)
    heldFor(repo)

    await tickOnce(AT, roomy)

    expect(queued()).toHaveLength(1)
    expect(queued()[0]?.since).toBe(HELD_AT.toISOString())
  })
})
