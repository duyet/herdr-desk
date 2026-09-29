import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clear, hold, MAX_HELD_MS, next, queued, requeue, view } from './queue'

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

  test('a job that ran is no longer owed', () => {
    // A queued job owes one run, not one run per slot, so whatever ran it has
    // paid the debt. Left queued, it sat at the head and the desk ran it again
    // on every tick until it aged out.
    hold(job(TASK))
    clear(REPO, TASK)
    expect(queued()).toHaveLength(0)
  })

  test('clearing one job leaves the rest of the desk owed', () => {
    // One queue for every task on the machine. A discharge that emptied it would
    // drop work for jobs that never got their turn.
    hold(job('a'))
    hold(job('b'))
    clear(REPO, 'a')
    expect(queued().map((j) => j.task)).toEqual(['b'])
  })
})
