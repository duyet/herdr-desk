import { describe, expect, test } from 'bun:test'
import { type Dashboard, dashboardJson, render, renderWeb } from './dashboard'
import type { Insights } from './insights'

const PR = 'https://github.com/duyet/herdr-desk/pull/70'

const counts = {
  sessions: 3,
  agents: 2,
  prs: 1,
  runs: 4,
  ran: 3,
  skipped: 0,
  failed: 0,
}

function sample(
  insights?: Partial<Insights>,
  opts?: { plain?: boolean; repo?: string; desk?: string },
): Dashboard {
  const merged: Insights = {
    since: '2026-10-03T00:00:00.000Z',
    counts: { ...counts, ...insights?.counts },
    byAgent: insights?.byAgent ?? [
      { agent: 'grok', sessions: 2 },
      { agent: 'claude', sessions: 1 },
    ],
    prs: insights?.prs ?? [PR],
  }
  return {
    host: {
      at: '2026-10-04T00:00:00.000Z',
      loadPerCore: 0.4,
      cores: 8,
      memAvailable: 8e9,
      memTotal: 16e9,
      agents: 2,
      busy: 1,
      running: 1,
    },
    budget: { maxLoadPerCore: 1.5, minMemAvailable: 3e9, maxAgents: 6 },
    hub: {
      jobs: [
        {
          repo: '/r/a',
          task: 'triage',
          desk: opts?.desk ?? 'alpha',
          status: 'running',
          startedAt: '2026-10-04T00:00:00.000Z',
          updatedAt: '2026-10-04T00:00:00.000Z',
          day: '2026-10-04',
          state: 'running',
          ageMs: 0,
        },
      ],
      running: 1,
      stuck: 0,
      settled: 2,
      byLevel: { ok: 2, fail: 0, blocked: 0, skip: 0, info: 0 },
      attention: false,
      worst: 'ok',
      signature: 'sig',
    },
    queue: {
      jobs: [
        {
          repo: opts?.repo ?? 'org/<script>',
          task: 'triage',
          slot: '0 * * * *',
          since: '2026-10-04T00:00:00.000Z',
          tries: 2,
          reason: 'load',
        },
      ],
      expired: [],
      oldestMs: 1000,
    },
    today: { fired: 4, failed: 0, recent: [1] },
    insights: merged,
    plain: opts?.plain ?? true,
  }
}

function insightLine(out: string): string | undefined {
  return out.split('\n').find((line) => line.includes('insights'))
}

describe('render', () => {
  test('shows non-zero sessions, agents, and PRs, and skips a zero count', () => {
    const out = render(sample())
    expect(insightLine(out)).toBe(
      'insights  3 sessions · 2 agents · 1 PR · 4 runs',
    )
    // Zero failures stay off this line. The 24h row still reports its own.
    expect(insightLine(out)).not.toContain('failed')
    expect(out).toContain('          grok 2 · claude 1')

    const noPrs = render(
      sample({
        counts: { ...counts, prs: 0 },
        prs: [],
      }),
    )
    expect(insightLine(noPrs)).toBe('insights  3 sessions · 2 agents · 4 runs')
    expect(insightLine(noPrs)).not.toContain('PRs')
  })

  test('appends a failure in red, and drops the agent line when there is none', () => {
    const plain = render(
      sample(
        {
          counts: { ...counts, sessions: 0, agents: 0, prs: 0, failed: 2 },
          byAgent: [],
          prs: [],
        },
        { plain: true },
      ),
    )
    const lines = plain.split('\n')
    const at = lines.findIndex((line) => line.startsWith('insights'))
    expect(lines[at]).toBe('insights  4 runs · 2 failed')
    expect(lines[at + 1]).toBeUndefined()

    const colored = render(
      sample(
        {
          counts: { ...counts, failed: 2 },
        },
        { plain: false },
      ),
    )
    expect(insightLine(colored)).toContain('\u001B[31m2 failed\u001B[0m')
    expect(insightLine(colored)).toContain('\u001B[36minsights\u001B[0m')
  })

  test('omits the block when every count is zero', () => {
    const out = render(
      sample({
        counts: {
          sessions: 0,
          agents: 0,
          prs: 0,
          runs: 0,
          ran: 0,
          skipped: 0,
          failed: 0,
        },
        byAgent: [],
        prs: [],
      }),
    )
    expect(out.split('\n').some((line) => line.includes('insights'))).toBe(
      false,
    )
  })
})

describe('renderWeb', () => {
  test('escapes a repo name and links the pull url', () => {
    const html = renderWeb(sample(undefined, { desk: 'a<b' }))
    expect(html).toContain('org/&lt;script&gt;')
    expect(html).not.toContain('org/<script>')
    expect(html).toContain('a&lt;b')
    expect(html).not.toContain('a<b')
    expect(html).toContain(`href="${PR}"`)
    expect(html).toContain('http-equiv="refresh" content="15"')
    expect(html).not.toContain('<script')
  })
})

describe('dashboardJson', () => {
  test('includes insight counts with the rest of the dashboard', () => {
    const d = sample()
    const json = dashboardJson(d)
    expect(json.insights.counts).toEqual(counts)
    expect(json.insights.prs).toEqual([PR])
    expect(json.insights.since).toBe('2026-10-03T00:00:00.000Z')
    expect(json.insights.byAgent).toEqual([
      { agent: 'grok', sessions: 2 },
      { agent: 'claude', sessions: 1 },
    ])
    expect(json.host).toBe(d.host)
    expect(json.today).toEqual(d.today)
    expect(json.queue.jobs).toBe(d.queue.jobs)
  })
})
