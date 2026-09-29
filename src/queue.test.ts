import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hold, MAX_HELD_MS, next, queued, requeue, view } from './queue'

let stateDir: string
let saved: string | undefined

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'herdr-desk-queue-'))
  saved = process.env.HERDR_PLUGIN_STATE_DIR
  process.env.HERDR_PLUGIN_STATE_DIR = stateDir
})

afterEach(() => {
  if (saved === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR
  else process.env.HERDR_PLUGIN_STATE_DIR = saved
  rmSync(stateDir, { recursive: true, force: true })
})

const REPO = '/p/chmonitor'
const TASK = 'local:babysit'

describe('queue', () => {
  const job = (task: string) => ({
    repo: REPO,
    task,
    slot: '14:40',
    reason: 'load 2.1/core over 1.5',
  })

  test('a held job is kept, not dropped', () => {
    // The whole point of the gate: a job held because the host is busy is still
    // owed a run. Dropping it makes a busy machine look like a desk where
    // everything is fine.
    hold(job(TASK))
    expect(queued()).toHaveLength(1)
    expect(next()?.task).toBe(TASK)
  })

  test('the oldest job is offered first', () => {
    const t0 = new Date('2026-09-28T10:00:00Z')
    hold(job('a'), t0)
    hold(job('b'), new Date(t0.getTime() + 60_000))
    expect(next()?.task).toBe('a')
  })

  test('holding the same job twice keeps its original age', () => {
    // Otherwise `tries` alone would let a job held every tick for days stay
    // queued forever, and a broken desk would look like a busy one.
    const t0 = new Date('2026-09-28T10:00:00Z')
    hold(job(TASK), t0)
    hold(job(TASK), new Date(t0.getTime() + 3_600_000))
    expect(queued()[0]?.since).toBe(t0.toISOString())
    expect(queued()[0]?.tries).toBe(2)
  })

  test('a failed attempt goes back without losing its age', () => {
    const t0 = new Date('2026-09-28T10:00:00Z')
    hold(job(TASK), t0)
    const first = next()
    expect(first).not.toBeNull()
    requeue(first as never, 'still busy')
    expect(queued()[0]?.since).toBe(t0.toISOString())
  })

  test('a job held past its age is reported, not silently dropped', () => {
    // A job that waited six hours and never ran is a fact about the desk, and
    // deleting it quietly would hide a permanently overloaded host.
    hold(job(TASK), new Date(Date.now() - MAX_HELD_MS - 1000))
    const v = view()
    expect(v.jobs).toHaveLength(0)
    expect(v.expired).toHaveLength(1)
  })

  test('reports how long the oldest job has waited', () => {
    hold(job(TASK), new Date(Date.now() - 5 * 60_000))
    expect(view().oldestMs).toBeGreaterThanOrEqual(5 * 60_000)
  })
})
