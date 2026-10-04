import { describe, expect, test } from 'bun:test'
import { type Dashboard, dashboardJson } from './dashboard'
import { handle, serve } from './http'
import type { Insights } from './insights'
import { parseSince } from './since'

const insights: Insights = {
  since: '2026-10-03T00:00:00.000Z',
  counts: {
    sessions: 1,
    agents: 1,
    prs: 0,
    runs: 0,
    ran: 0,
    skipped: 0,
    failed: 0,
  },
  byAgent: [{ agent: 'grok', sessions: 1 }],
  prs: [],
}

const dash: Dashboard = {
  host: {
    at: '2026-10-04T00:00:00.000Z',
    loadPerCore: 0.2,
    cores: 4,
    memAvailable: 4e9,
    memTotal: 8e9,
    agents: 1,
    busy: 0,
    running: 0,
  },
  budget: { maxLoadPerCore: 1.5, minMemAvailable: 3e9, maxAgents: 6 },
  hub: {
    jobs: [],
    running: 0,
    stuck: 0,
    settled: 0,
    byLevel: { ok: 0, fail: 0, blocked: 0, skip: 0, info: 0 },
    attention: false,
    worst: 'ok',
    signature: 'sig',
  },
  queue: { jobs: [], expired: [], oldestMs: 0 },
  today: { fired: 0, failed: 0, recent: [] },
  insights,
  plain: true,
}

const deps = {
  dashboard: () => dash,
  analytics: (since: string) => {
    // Bad windows throw here, the same way the CLI does, and handle maps that
    // to 400. A good window is echoed so the test can see what was passed.
    parseSince(since)
    return { since }
  },
}

describe('handle', () => {
  test('GET / is the html page', async () => {
    const res = handle(new Request('http://127.0.0.1/'), deps)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    const html = await res.text()
    expect(html).toContain('<h1>desk</h1>')
    expect(html).toContain('1 sessions')
  })

  test('GET /api/dashboard is the dash --json object', async () => {
    const res = handle(new Request('http://127.0.0.1/api/dashboard'), deps)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe(
      'application/json; charset=utf-8',
    )
    expect(await res.json()).toEqual(dashboardJson(dash))
  })

  test('analytics passes since, and defaults a missing one to 30d', async () => {
    const given = handle(
      new Request('http://127.0.0.1/api/analytics?since=7d'),
      deps,
    )
    expect(await given.json()).toEqual({ since: '7d' })
    const missing = handle(new Request('http://127.0.0.1/api/analytics'), deps)
    expect(await missing.json()).toEqual({ since: '30d' })
  })

  test('a bad since is 400 with the error text', async () => {
    const res = handle(
      new Request('http://127.0.0.1/api/analytics?since=nope'),
      deps,
    )
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toContain('text/plain')
    expect(await res.text()).toBe('bad --since nope: use e.g. 30m, 12h, 7d, 2w')
  })

  test('POST is 405 and an unknown path is 404', () => {
    const post = handle(
      new Request('http://127.0.0.1/', { method: 'POST' }),
      deps,
    )
    expect(post.status).toBe(405)
    const missing = handle(new Request('http://127.0.0.1/nope'), deps)
    expect(missing.status).toBe(404)
  })
})

describe('serve', () => {
  test('answers /api/dashboard on an ephemeral port', async () => {
    const server = serve({ port: 0, hostname: '127.0.0.1', deps })
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/dashboard`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(dashboardJson(dash))
    } finally {
      server.stop(true)
    }
  })
})
