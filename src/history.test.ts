import { describe, expect, test } from 'bun:test'
import { failureStreak, type RunRecord } from './history'

const job = { name: 'chmonitor', task: 'desk:github-issues' }

function rec(
  partial: Partial<RunRecord> & { at: string; ok: boolean },
): RunRecord {
  return {
    name: job.name,
    repo: '/repo',
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
      rec({ at: '2026-09-01T00:00:00.000Z', ok: true, name: 'anyrouter' }),
    ]
    expect(failureStreak(runs, job).count).toBe(1)
    expect(
      failureStreak(runs, { name: 'anyrouter', task: job.task }).count,
    ).toBe(0)
  })

  test('reports nothing for a job with no records', () => {
    expect(failureStreak([], job)).toEqual({
      count: 0,
      since: null,
      detail: null,
    })
  })
})
