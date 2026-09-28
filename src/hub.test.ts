import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ago,
  countsLine,
  formatHub,
  markRunning,
  markSettled,
  publish,
  renderDigest,
  STALE_MS,
  STUCK_MS,
  snapshot,
} from './hub'
import type { NotifyConfig } from './notify'

let stateDir: string
let savedStateDir: string | undefined

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'herdr-desk-hub-'))
  savedStateDir = process.env.HERDR_PLUGIN_STATE_DIR
  process.env.HERDR_PLUGIN_STATE_DIR = stateDir
})

afterEach(() => {
  if (savedStateDir === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR
  else process.env.HERDR_PLUGIN_STATE_DIR = savedStateDir
  rmSync(stateDir, { recursive: true, force: true })
})

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000)

describe('markRunning / markSettled', () => {
  test('a job is running until something settles it', () => {
    // The count is the whole point of the hub, so "running" has to be a real
    // state that a fire creates and a report clears.
    markRunning({
      repo: '/p/anyrouter',
      task: 'local:collect',
      desk: 'anyrouter',
    })
    expect(snapshot().jobs[0].state).toBe('running')
    markSettled({
      repo: '/p/anyrouter',
      task: 'local:collect',
      level: 'ok',
      headline: 'merged 2 PRs',
    })
    const [job] = snapshot().jobs
    expect(job.state).toBe('ok')
    expect(job.headline).toBe('merged 2 PRs')
  })

  test('a settle keeps the start it was given, so the age means something', () => {
    // Without this, a job that ran 20 minutes would be reported as 0m old the
    // moment it finished, which is a lie in the direction of "everything is
    // fine".
    markRunning({ repo: '/p/a', task: 't', desk: 'a', at: at(20) })
    const [job] = snapshot().jobs
    expect(ago(job.ageMs)).toBe('20m')
  })

  test('two repos with the same desk name are still two jobs', () => {
    // `anyrouter` is checked out twice on some machines. Keying on the name
    // would merge them into one row and hide one of them.
    markRunning({ repo: '/w1/anyrouter', task: 't', desk: 'anyrouter' })
    markRunning({ repo: '/w2/anyrouter', task: 't', desk: 'anyrouter' })
    expect(snapshot().jobs).toHaveLength(2)
  })
})

describe('snapshot', () => {
  test('a job that never reported reads as stuck, not as running', () => {
    // A manager that died leaves no status.md and no thrown error. Silence is
    // the only evidence, and it has to be reported as a problem.
    markRunning({ repo: '/p/a', task: 't', desk: 'a', at: at(60) })
    const snap = snapshot()
    expect(snap.stuck).toBe(1)
    expect(snap.running).toBe(0)
    expect(snap.attention).toBe(true)
  })

  test('a fresh run is not stuck', () => {
    markRunning({ repo: '/p/a', task: 't', desk: 'a', at: at(2) })
    const snap = snapshot()
    expect(snap.running).toBe(1)
    expect(snap.stuck).toBe(0)
    expect(snap.attention).toBe(false)
  })

  test('a job that settles is no longer stuck however long it took', () => {
    // Slow is not broken. A two-hour run that reported `ok` is a success.
    markRunning({ repo: '/p/a', task: 't', desk: 'a', at: at(200) })
    markSettled({ repo: '/p/a', task: 't', level: 'ok', headline: 'done' })
    const snap = snapshot()
    expect(snap.stuck).toBe(0)
    expect(snap.byLevel.ok).toBe(1)
  })

  test('attention is blocked or fail, and nothing else', () => {
    // The quiet-window gate keys off this. If `info` counted as attention, an
    // ordinary run would wake someone up.
    markSettled({ repo: '/p/a', task: 't', level: 'info' })
    markSettled({ repo: '/p/b', task: 't', level: 'ok' })
    expect(snapshot().attention).toBe(false)
    markSettled({ repo: '/p/c', task: 't', level: 'blocked' })
    expect(snapshot().attention).toBe(true)
  })

  test('the worst state wins the dot', () => {
    markSettled({ repo: '/p/a', task: 't', level: 'ok' })
    markRunning({ repo: '/p/b', task: 't', desk: 'b' })
    markSettled({ repo: '/p/c', task: 't', level: 'fail' })
    expect(snapshot().worst).toBe('fail')
  })

  test('the signature ignores age but not state', () => {
    // Age changes every second; if it were in the signature, the dedupe below
    // would never fire and the channel would fill with identical messages.
    markRunning({ repo: '/p/a', task: 't', desk: 'a', at: at(5) })
    const first = snapshot().signature
    expect(snapshot().signature).toBe(first)
    markSettled({ repo: '/p/a', task: 't', level: 'ok' })
    expect(snapshot().signature).not.toBe(first)
  })
})

describe('countsLine', () => {
  test('counts by state, in the order a person asks', () => {
    // running -> stuck -> done -> blocked is the order of "is anything moving,
    // is anything wrong, did anything land".
    markRunning({ repo: '/p/a', task: 't', desk: 'a' })
    markRunning({ repo: '/p/b', task: 't', desk: 'b' })
    markSettled({ repo: '/p/c', task: 't', level: 'ok' })
    markSettled({ repo: '/p/d', task: 't', level: 'blocked' })
    expect(countsLine(snapshot())).toBe('2 running · 1 done · 1 blocked')
  })

  test('an empty machine says so instead of showing zeroes', () => {
    expect(countsLine(snapshot())).toBe('nothing running')
  })
})

describe('renderDigest', () => {
  test('many running jobs share one line', () => {
    // Eleven separate `running` lines is the wall of text this replaces.
    for (let i = 0; i < 11; i++) {
      markRunning({
        repo: `/p/repo${i}`,
        task: 't',
        desk: `repo${i}`,
        at: at(4),
      })
    }
    const body = renderDigest(snapshot())
    const runningLines = body.split('\n').filter((l) => l.startsWith('• '))
    expect(runningLines).toHaveLength(1)
    expect(runningLines[0]).toContain('+5 more')
  })

  test('a job that needs a human gets its own line with the reason', () => {
    markSettled({
      repo: '/p/a',
      task: 't',
      desk: 'a',
      level: 'blocked',
      headline: 'needs a decision on the squash policy',
    })
    const body = renderDigest(snapshot())
    expect(body).toContain(
      'blocked a/t — needs a decision on the squash policy',
    )
    expect(body).toContain('#attention')
  })

  test('a stuck job renders with a dot and a searchable tag', () => {
    // `stuck` is a hub state, not a NoticeLevel. Indexing the dot table with it
    // produced the literal text "undefined" in front of the most urgent line on
    // the message, so this pins the mapping.
    markRunning({ repo: '/p/a', task: 't', desk: 'a', at: at(90) })
    const body = renderDigest(snapshot())
    expect(body).toContain('🔴')
    expect(body).not.toContain('undefined')
    expect(body).toContain('#fail')
  })

  test('a job that needs a human gets its own line with the reason', () => {
    markRunning({ repo: '/p/a', task: 't', desk: 'a', at: at(90) })
    const body = renderDigest(snapshot())
    expect(body).toContain('stuck a/t')
    expect(body).toContain('(90m)')
  })

  test('agent text cannot break the message', () => {
    markSettled({
      repo: '/p/a',
      task: 't',
      desk: 'a',
      level: 'blocked',
      headline: 'fix *auth* in _middleware_',
    })
    const body = renderDigest(snapshot())
    expect(body).toContain('fix \\*auth\\* in \\_middleware\\_')
  })

  test('no jobs renders as nothing to send', () => {
    expect(renderDigest(snapshot())).toBe('')
  })
})

describe('publish', () => {
  const dest: NotifyConfig = {
    enabled: true,
    token: 't',
    chatId: 'c',
    topicId: '',
  }

  test('an unchanged hub is never re-sent', () => {
    // The daemon ticks every 20s. Without this, one message every tick.
    let sends = 0
    const send = async () => {
      sends++
      return { sent: true, machine: 'm', repo: 'r' }
    }
    markRunning({ repo: '/p/a', task: 't', desk: 'a' })
    return Promise.all([
      publish({ dest, send, force: true }),
      publish({ dest, send }),
    ]).then(([first, second]) => {
      expect(first.sent).toBe(true)
      expect(sends).toBe(1)
      expect(second.sent).toBe(false)
      expect(second.reason).toBe('unchanged since last hub')
    })
  })

  test('a routine change waits for the quiet window', () => {
    const send = async () => ({ sent: true, machine: 'm', repo: 'r' })
    const first = new Date()
    markRunning({ repo: '/p/a', task: 't', desk: 'a' })
    return publish({ dest, send, force: true })
      .then(() => {
        markRunning({ repo: '/p/b', task: 't', desk: 'b' })
        return publish({ dest, send, now: new Date(first.getTime() + 60_000) })
      })
      .then((res) => {
        // 2 running instead of 1 is not news.
        expect(res.sent).toBe(false)
        expect(res.reason).toBe('inside the quiet window')
      })
  })

  test('a job that needs a human bypasses the quiet window', () => {
    // The entire cost of the throttling above is that this one case must not
    // wait for a timer.
    const send = async () => ({ sent: true, machine: 'm', repo: 'r' })
    const start = Date.now()
    return publish({ dest, send, force: true })
      .then(() => {
        markSettled({
          repo: '/p/a',
          task: 't',
          level: 'fail',
          headline: 'gh down',
        })
        return publish({ dest, send, now: new Date(start + 1_000) })
      })
      .then((res) => {
        expect(res.sent).toBe(true)
      })
  })

  test('a failed send is not recorded, so the next tick retries', () => {
    // Claiming the state first would make a send that never left the machine
    // look delivered, and the failure would never be reported at all.
    const send = async () => ({
      sent: false,
      reason: 'telegram HTTP 500',
      machine: 'm',
      repo: 'r',
    })
    return publish({ dest, send, force: true })
      .then((res) => {
        expect(res.sent).toBe(false)
        markSettled({
          repo: '/p/a',
          task: 't',
          level: 'fail',
          headline: 'still broken',
        })
        return publish({ dest, send, force: true })
      })
      .then((res) => {
        expect(res.sent).toBe(false)
        expect(res.reason).toBe('telegram HTTP 500')
      })
  })
})

describe('unreadable state', () => {
  test('a corrupt file is ignored, and does not hide the real jobs', () => {
    // State is written tmp-then-rename, so a truncated file can only be a crash
    // mid-write. It must not take the hub down with it — the whole point of the
    // hub is to be readable when something has gone wrong.
    const hub = join(stateDir, 'hub')
    mkdirSync(hub, { recursive: true })
    writeFileSync(join(hub, 'garbage--1.json'), '{"repo": ')
    writeFileSync(join(hub, 'null--2.json'), 'null')
    writeFileSync(join(hub, 'array--3.json'), '["a"]')
    markRunning({ repo: '/p/a', task: 't', desk: 'a' })
    expect(snapshot().jobs).toHaveLength(1)
  })

  test('an unreadable file is removed, so the state dir cannot fill up', () => {
    const hub = join(stateDir, 'hub')
    mkdirSync(hub, { recursive: true })
    writeFileSync(join(hub, 'garbage--1.json'), 'not json')
    markSettled({ repo: '/p/a', task: 't', level: 'ok' })
    snapshot()
    expect(existsSync(join(hub, 'garbage--1.json'))).toBe(false)
  })

  test('a job that has not run in weeks is dropped from the hub', () => {
    // Otherwise a repo deleted from the machine keeps a row forever, and the
    // counts say "1 done" about a job that has not existed for a month.
    markSettled({
      repo: '/p/old',
      task: 't',
      level: 'ok',
      at: new Date(Date.now() - STALE_MS - 1000),
    })
    markSettled({ repo: '/p/fresh', task: 't', level: 'ok' })
    expect(snapshot().jobs.map((j) => j.repo)).toEqual(['/p/fresh'])
  })
})

describe('formatHub', () => {
  test('says so when the machine has never run a job', () => {
    expect(formatHub(snapshot())).toContain('hub empty')
  })

  test('lists every job with its state and insight', () => {
    markSettled({
      repo: '/p/a',
      task: 't',
      desk: 'a',
      level: 'ok',
      headline: 'merged 2',
    })
    const text = formatHub(snapshot())
    expect(text).toContain('a/t')
    expect(text).toContain('merged 2')
  })
})

describe('ago', () => {
  test('is short enough to sit next to a job name', () => {
    expect(ago(4 * 60_000)).toBe('4m')
    expect(ago(3 * 3_600_000)).toBe('3h')
    expect(ago(50 * 3_600_000)).toBe('2d')
  })
})

describe('STUCK_MS', () => {
  test('is long enough that a working job is not accused of hanging', () => {
    // A false `stuck` is what teaches a reader to ignore the channel.
    expect(STUCK_MS).toBeGreaterThan(30 * 60 * 1000)
  })
})
