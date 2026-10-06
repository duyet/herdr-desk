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
  giveUpLine,
  loadFires,
  pruneFires,
  saveFires,
  skipPausedSlots,
  startLine,
  stopOn,
  tickOnce,
} from './daemon'
import { loadRuns } from './history'
import { hold, MAX_HELD_MS, queued } from './queue'

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

// The real gate reads the real host, so a tick driven from a test would assert
// nothing on a box over budget — and worse, pass, because a held job is also
// still owed. A fixed verdict keeps these tests hermetic and honest.
const roomy = () => ({ ok: true, breaches: [], pressure: 0 })

/**
 * A one-task desk on a temp repo, and a Herdr that is not running.
 *
 * `herdrUp` chooses which way the run goes without stubbing `runTask`: a
 * missing socket is a precondition skip, so the run resolves, while a missing
 * binary throws. Both are the real path, and neither reaches the network.
 */
function desk(
  herdrUp: boolean,
  taskId = 'local:triage',
  schedule = '* * * * *',
) {
  const state = stateDir()
  const repo = tempDir('herdr-desk-repo-')
  writeFileSync(
    join(repo, '.herdr-desk.json'),
    `${JSON.stringify({
      name: 'held-test',
      tasks: [{ id: taskId, schedule }],
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

/** Every `missed slots` line this tick or the last one wrote. */
function missedLines(): string[] {
  return readFileSync(
    join(process.env.HERDR_PLUGIN_STATE_DIR as string, 'daemon.log'),
    'utf8',
  )
    .split('\n')
    .filter((l) => l.includes('missed slots'))
}

/** Every `give up` line this tick or the last one wrote. */
function giveUpLines(): string[] {
  return readFileSync(
    join(process.env.HERDR_PLUGIN_STATE_DIR as string, 'daemon.log'),
    'utf8',
  )
    .split('\n')
    .filter((l) => l.includes('give up'))
}

/** The stamp a daemon's last tick would have left. */
function aliveAt(at: Date): void {
  writeFileSync(
    join(process.env.HERDR_PLUGIN_STATE_DIR as string, 'alive'),
    `${at.toISOString()}\n`,
  )
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

  const heldFor = (repo: string): void => {
    hold(
      { repo, task: TASK, slot: SLOT, reason: 'load 2.1/core over 1.5' },
      HELD_AT,
    )
  }

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

describe('a job the queue gives up on', () => {
  const AT = new Date(2026, 8, 30, 9, 15)
  // Another repo's job, so the desk below runs its own and the scheduled path
  // does not discharge this one first.
  const gone = {
    repo: '/p/llm-over-dns',
    task: 'local:improve',
    slot: '02:17',
    since: '2026-10-04T19:17:00.000Z',
    tries: 22,
    reason: '30 agents over 24',
  }

  test('the line names the repo', () => {
    // Two repos on this desk run a task called `local:improve`, so the task
    // alone cannot say which job gave up — and nothing else records a give-up.
    // Matching it back to its hold line by timestamp attributed 74 of 94 to the
    // wrong task, and left 11 attributable to nothing at all.
    expect(giveUpLine(gone)).toBe(
      'give up /p/llm-over-dns/local:improve: held since 2026-10-04T19:17:00.000Z without running',
    )
  })

  test('the tick reports it and drops it', async () => {
    // `view()` no longer deletes, so the tick has to. Left queued, the same
    // entry is given up on again by every tick for as long as the desk runs.
    desk(true)
    hold(gone, new Date(AT.getTime() - MAX_HELD_MS - 60_000))

    await tickOnce(AT, roomy)

    expect(giveUpLines()).toEqual([
      expect.stringContaining('give up /p/llm-over-dns/local:improve'),
    ])
    expect(queued()).toHaveLength(0)
  })
})

describe('the line a start leaves', () => {
  // The outage duyet/herdr-desk#60 is about: 27h41m between one start line and
  // the next, and the only way to read that off the log was to compare two
  // timestamps by hand.
  const NOW = new Date(2026, 8, 30, 9, 15)
  const DARK = new Date(2026, 8, 29, 5, 34)

  test('carries the gap when there is a stamp to measure it from', () => {
    const dir = stateDir()
    writeFileSync(join(dir, 'alive'), `${DARK.toISOString()}\n`)

    expect(startLine(4242, NOW)).toBe(
      `daemon start pid=4242: dark for 27h41m, last alive ${DARK.toISOString()}`,
    )
  })

  test('is the bare line when there is nothing true to add', () => {
    // A first ever run, and a stamp that cannot support a claim — unparseable,
    // from a clock that moved backwards, or older than a year and therefore an
    // artifact rather than evidence. Each reads as no record, because a count
    // is only ever as good as the instant behind it.
    const dir = stateDir()
    expect(startLine(4242, NOW)).toBe('daemon start pid=4242')
    for (const raw of [
      'not a date',
      new Date(2026, 8, 30, 9, 16).toISOString(),
      new Date(2024, 8, 30).toISOString(),
    ]) {
      writeFileSync(join(dir, 'alive'), `${raw}\n`)
      expect(startLine(4242, NOW)).toBe('daemon start pid=4242')
    }
  })
})

describe('a tick that finds the desk was gone', () => {
  const TASK = 'local:prod'
  const CRON = '*/30 * * * *'
  // Sep 30 09:15 local. `*/30` is owed 19 slots today, 00:00 through 09:00.
  const AT = new Date(2026, 8, 30, 9, 15)
  // Two days back at 09:00: Sep 28 owes 29 slots after it, Sep 29 owes 48.
  const ONCE = new Date(2026, 8, 28, 9, 0)

  test('counts the slots owed across both dark days, and runs one job', async () => {
    // The defect. A fire key is `repo::task::cron::day::slot`, so the tick's
    // own query — `cronSlotsToday`, local midnight to now — cannot see a slot
    // from an earlier day at all. It reported `18 missed slots` on the day
    // below while 95 had gone by, and read as a quiet morning.
    const repo = desk(true, TASK, CRON)
    aliveAt(ONCE)

    await tickOnce(AT, roomy)

    // 18 stale today + 29 on Sep 28 (after 09:00) + 48 on Sep 29.
    expect(missedLines()).toHaveLength(1)
    expect(missedLines()[0]).toContain(
      '95 missed slots, oldest 2026-09-28 09:30',
    )
    // The count widened; what fires did not. One job, the newest slot.
    expect(loadRuns(50, { repo, task: TASK })).toHaveLength(1)
  })

  test('a fresh stamp leaves today exactly as it was', async () => {
    // The normal path, one tick after the last. The horizon is now, there are
    // no dead days in it, and the line is byte-for-byte what it said before the
    // horizon existed — a bare `00:00`, with no day to imply otherwise.
    const repo = desk(true, TASK, CRON)
    aliveAt(new Date(2026, 8, 30, 9, 14, 40))

    await tickOnce(AT, roomy)

    expect(missedLines()[0]).toContain('18 missed slots, oldest 00:00')
    expect(missedLines()[0]).not.toContain('2026-09-30')
    expect(loadRuns(50, { repo, task: TASK })).toHaveLength(1)
  })

  test('the gap is counted once, not on every tick after it', async () => {
    // The stamp advances every tick, so the next tick's horizon is the present
    // and the dead days fall out of the window. A horizon that did not advance
    // would bill the same 27 hours on every tick for as long as the desk ran.
    const repo = desk(true, TASK, CRON)
    aliveAt(ONCE)

    await tickOnce(AT, roomy)
    await tickOnce(new Date(2026, 8, 30, 9, 15, 20), roomy)

    expect(missedLines()).toHaveLength(1)
    expect(loadRuns(50, { repo, task: TASK })).toHaveLength(1)
  })

  test('a first ever run claims no gap it cannot measure', async () => {
    // No stamp means no horizon, so the count is today's and the start line is
    // bare. A desk that had never run must not open by reporting slots missed
    // before it existed.
    desk(true, TASK, CRON)

    expect(startLine(4242, AT)).toBe('daemon start pid=4242')

    await tickOnce(AT, roomy)

    expect(missedLines()).toEqual([
      expect.stringContaining('18 missed slots, oldest 00:00'),
    ])
  })
})
