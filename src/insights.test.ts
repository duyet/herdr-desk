import { describe, expect, test } from 'bun:test'
import type { RunRecord } from './history'
import { insightsOf, MAX_PRS_LISTED, pullUrls } from './insights'
import type { SessionRow } from './sessions/types'

const SINCE = new Date('2026-09-01T00:00:00Z')

function run(
  partial: Partial<RunRecord> & Pick<RunRecord, 'detail'>,
): RunRecord {
  return {
    at: '2026-09-15T00:00:00Z',
    name: 'a',
    repo: '/r/a',
    task: 'triage',
    mode: 'agent',
    ok: true,
    ...partial,
  }
}

function sess(
  agent: SessionRow['agent'],
  title: string,
  started = '2026-09-15T00:00:00Z',
): SessionRow {
  return {
    agent,
    id: `${agent}-${title}`,
    repo: null,
    started,
    ended: started,
    title,
    path: '',
  }
}

describe('pullUrls', () => {
  test('counts a pull URL and ignores a bare issue number', () => {
    // `#418` is an issue as often as a pull. Guessing would inflate the
    // dashboard, so only a github pull URL counts.
    expect(
      pullUrls('see #418 and https://github.com/duyet/herdr-desk/pull/70'),
    ).toEqual(['https://github.com/duyet/herdr-desk/pull/70'])
    expect(pullUrls(undefined)).toEqual([])
  })
})

describe('insightsOf', () => {
  test('sessions, agents, and PRs are unique counts in one window', () => {
    const pr = 'https://github.com/duyet/herdr-desk/pull/70'
    const got = insightsOf({
      since: SINCE,
      runs: [
        run({
          ok: true,
          detail: JSON.stringify({ spawned: 1 }),
        }),
        run({
          ok: false,
          detail: `socket gone ${pr}`,
        }),
        run({
          ok: true,
          detail: JSON.stringify({ skipped: 'not open' }),
        }),
        // Before the window: must not move any count.
        run({ at: '2026-08-01T00:00:00Z', detail: pr }),
      ],
      sessions: [
        sess('grok', `opened ${pr}`),
        sess('grok', 'no pull here'),
        sess('claude', `also ${pr}`),
        sess('codex', 'old', '2026-08-01T00:00:00Z'),
      ],
    })
    expect(got.counts).toEqual({
      sessions: 3,
      agents: 2,
      prs: 1,
      runs: 3,
      ran: 1,
      skipped: 1,
      failed: 1,
    })
    // Same URL in a run and two sessions is one PR.
    expect(got.prs).toEqual([pr])
    expect(got.byAgent).toEqual([
      { agent: 'grok', sessions: 2 },
      { agent: 'claude', sessions: 1 },
    ])
  })

  test('the listed PR urls are capped; the count is not', () => {
    const runs = Array.from({ length: MAX_PRS_LISTED + 3 }, (_, i) =>
      run({
        detail: `https://github.com/duyet/herdr-desk/pull/${i + 1}`,
      }),
    )
    const got = insightsOf({ since: SINCE, runs, sessions: [] })
    expect(got.counts.prs).toBe(MAX_PRS_LISTED + 3)
    expect(got.prs).toHaveLength(MAX_PRS_LISTED)
  })

  test('an empty window is zeros, not omitted fields', () => {
    const got = insightsOf({ since: SINCE, runs: [], sessions: [] })
    expect(got.counts.sessions).toBe(0)
    expect(got.counts.prs).toBe(0)
    expect(got.byAgent).toEqual([])
    expect(got.since).toBe(SINCE.toISOString())
  })
})
