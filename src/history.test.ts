import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendRun,
  failureStreak,
  historyPath,
  loadRuns,
  MAX_DETAIL,
  type RunRecord,
  truncateDetail,
} from './history'

const job = { repo: '/repo', task: 'desk:github-issues' }

function rec(
  partial: Partial<RunRecord> & { at: string; ok: boolean },
): RunRecord {
  return {
    name: 'chmonitor',
    repo: job.repo,
    task: job.task,
    mode: 'run',
    ...partial,
  }
}

describe('failureStreak', () => {
  test('counts consecutive failures back from the newest record', () => {
    const runs: RunRecord[] = [
      rec({ at: '2026-09-01T00:00:00.000Z', ok: true }),
      rec({ at: '2026-09-02T00:00:00.000Z', ok: false, detail: 'EISDIR' }),
      rec({ at: '2026-09-03T00:00:00.000Z', ok: false, detail: 'EISDIR' }),
      rec({ at: '2026-09-04T00:00:00.000Z', ok: false, detail: 'EISDIR' }),
    ]
    expect(failureStreak(runs, job)).toEqual({
      count: 3,
      since: '2026-09-02T00:00:00.000Z',
      detail: 'EISDIR',
    })
  })

  test('reports the full run of failures while the job is still broken', () => {
    // The 24 days of chmonitor runs that died on EISDIR: the streak is the
    // number that says "this desk is going quiet", which the last-fire column
    // alone could not express at a glance.
    const runs: RunRecord[] = Array.from({ length: 24 }, (_, i) =>
      rec({
        at: `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
        ok: false,
        detail: 'EISDIR',
      }),
    )
    const streak = failureStreak(runs, job)
    expect(streak.count).toBe(24)
    expect(streak.since).toBe('2026-09-01T00:00:00.000Z')
    expect(streak.detail).toBe('EISDIR')
  })

  test('resets after a recovery, leaving the failures in the ledger', () => {
    const runs: RunRecord[] = [
      ...Array.from({ length: 3 }, (_, i) =>
        rec({
          at: `2026-09-0${i + 1}T00:00:00.000Z`,
          ok: false,
          detail: 'EISDIR',
        }),
      ),
      rec({ at: '2026-09-04T00:00:00.000Z', ok: true }),
      rec({ at: '2026-09-05T00:00:00.000Z', ok: true }),
    ]
    expect(failureStreak(runs, job).count).toBe(0)
    expect(runs.filter((r) => !r.ok)).toHaveLength(3)
  })

  test('stops at the first success', () => {
    const runs: RunRecord[] = [
      rec({ at: '2026-09-01T00:00:00.000Z', ok: false, detail: 'boom' }),
      rec({ at: '2026-09-02T00:00:00.000Z', ok: true }),
      rec({ at: '2026-09-03T00:00:00.000Z', ok: false, detail: 'boom' }),
    ]
    expect(failureStreak(runs, job)).toEqual({
      count: 1,
      since: '2026-09-03T00:00:00.000Z',
      detail: 'boom',
    })
  })

  test('is per job, so one broken repo does not implicate another', () => {
    const runs: RunRecord[] = [
      rec({ at: '2026-09-01T00:00:00.000Z', ok: false, detail: 'boom' }),
      rec({
        at: '2026-09-01T00:00:00.000Z',
        ok: true,
        name: 'anyrouter',
        repo: '/other',
      }),
    ]
    expect(failureStreak(runs, job).count).toBe(1)
    expect(failureStreak(runs, { repo: '/other', task: job.task }).count).toBe(
      0,
    )
  })

  test('two checkouts sharing a display name keep separate streaks', () => {
    // Regression: keying on `name` merged these into one number belonging to
    // neither repo. Both are legitimately called `chmonitor`.
    const runs: RunRecord[] = [
      ...Array.from({ length: 3 }, (_, i) =>
        rec({
          at: `2026-09-0${i + 1}T00:00:00.000Z`,
          ok: false,
          detail: 'boom',
          repo: '/src/chmonitor',
        }),
      ),
      rec({
        at: '2026-09-04T00:00:00.000Z',
        ok: false,
        detail: 'other',
        repo: '/tmp/chmonitor',
      }),
    ]
    expect(
      failureStreak(runs, { repo: '/src/chmonitor', task: job.task }).count,
    ).toBe(3)
    expect(
      failureStreak(runs, { repo: '/tmp/chmonitor', task: job.task }).count,
    ).toBe(1)
  })

  test('reports nothing for a job with no records', () => {
    expect(failureStreak([], job)).toEqual({
      count: 0,
      since: null,
      detail: null,
    })
  })

  test('is not truncated by other jobs filling the shared window', () => {
    // Regression (#32). The ledger holds every repo and every job, so the last
    // 200 lines of a busy desk are mostly someone else's fires. Ten of them
    // land between each pair of this job's, which pushes the first failures of
    // the streak out of a global window entirely and left `Fails` reporting a
    // floor instead of a count.
    const dir = mkdtempSync(join(tmpdir(), 'desk-streak-'))
    const prev = process.env.HERDR_PLUGIN_STATE_DIR
    process.env.HERDR_PLUGIN_STATE_DIR = dir
    try {
      const base = Date.parse('2026-09-28T08:57:00.000Z')
      const lines: string[] = []
      for (let i = 0; i < 31; i++) {
        const at = base + i * 10_000
        lines.push(
          JSON.stringify(
            rec({ at: new Date(at).toISOString(), ok: false, detail: 'boom' }),
          ),
        )
        for (let j = 0; j < 10; j++) {
          lines.push(
            JSON.stringify(
              rec({
                at: new Date(at + j * 1000).toISOString(),
                name: 'anyrouter',
                repo: '/other',
                ok: true,
              }),
            ),
          )
        }
      }
      writeFileSync(historyPath(), `${lines.join('\n')}\n`)
      // The window is crowded enough that a global read misses most of it.
      expect(failureStreak(loadRuns(200), job).count).toBeLessThan(31)
      expect(failureStreak(loadRuns(200, job), job)).toEqual({
        count: 31,
        since: '2026-09-28T08:57:00.000Z',
        detail: 'boom',
      })
    } finally {
      if (prev === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR
      else process.env.HERDR_PLUGIN_STATE_DIR = prev
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('truncateDetail', () => {
  test('a short detail is untouched', () => {
    expect(truncateDetail('boom')).toBe('boom')
    expect(truncateDetail(undefined)).toBeUndefined()
  })

  test('a multi-kilobyte detail is capped at the sink', () => {
    // The backstop: even if a caller passes a whole prompt, it cannot reach the
    // ledger, `history`, or any notification built from a run detail.
    const huge = `You are duyetbot${' pad'.repeat(2000)}`
    const out = truncateDetail(huge) as string
    expect(huge.length).toBeGreaterThan(8000)
    expect(out.length).toBeLessThanOrEqual(MAX_DETAIL + 24)
    expect(out).toContain(`(${huge.length} chars)`)
  })

  test('the cap is enforced on write, not only on display', () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-hist-'))
    const prev = process.env.HERDR_PLUGIN_STATE_DIR
    process.env.HERDR_PLUGIN_STATE_DIR = dir
    try {
      appendRun({
        at: '2026-09-27T00:00:00.000Z',
        name: 'x',
        repo: '/r',
        task: 't',
        mode: 'run',
        ok: false,
        detail: 'y'.repeat(9000),
      })
      const line = readFileSync(historyPath(), 'utf8').trim()
      expect(line.length).toBeLessThan(600)
      expect(JSON.parse(line).detail.length).toBeLessThanOrEqual(
        MAX_DETAIL + 24,
      )
    } finally {
      if (prev === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR
      else process.env.HERDR_PLUGIN_STATE_DIR = prev
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
