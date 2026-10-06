import { describe, expect, test } from 'bun:test'
import {
  agentCounts,
  type Budget,
  check,
  defaultBudget,
  fmtLoad,
  fmtMem,
  type HostHealth,
} from './health'

/**
 * A host with everything comfortable, so each test changes exactly one reading
 * and the reason a fire was held is unambiguous.
 */
function host(over: Partial<HostHealth> = {}): HostHealth {
  return {
    at: '2026-09-28T12:00:00.000Z',
    loadPerCore: 0.4,
    cores: 16,
    memAvailable: 8 * 1024 ** 3,
    memTotal: 16 * 1024 ** 3,
    agents: 6,
    busy: 2,
    running: 1,
    ...over,
  }
}

/** A `herdr agent list` listing holding that many sessions in each state. */
function listing(states: Record<string, number>): unknown {
  return {
    result: {
      agents: Object.entries(states).flatMap(([agent_status, n]) =>
        Array.from({ length: n }, (_, i) => ({
          name: `${agent_status}-${i}`,
          agent_status,
        })),
      ),
    },
  }
}

const budget: Budget = {
  maxLoadPerCore: 1.5,
  minMemAvailable: 3 * 1024 ** 3,
  maxAgents: 24,
}

describe('check', () => {
  test('an idle host may take another job', () => {
    const v = check(host(), budget)
    expect(v.ok).toBe(true)
    expect(v.breaches).toEqual([])
  })

  test('load is held per core, not as a raw number', () => {
    // Load 21 meant something very different on 4 cores than on 16, so the same
    // raw figure cannot be one threshold.
    const busy = check(host({ loadPerCore: 1.6 }), budget)
    expect(busy.ok).toBe(false)
    expect(busy.breaches[0]).toContain('load 1.6/core')
  })

  test('low memory holds a fire', () => {
    // The documented failure: 2 GB free of 15 GB, where the OOM killer evicts
    // node first and a half-finished test looks like the bug.
    const v = check(host({ memAvailable: 2 * 1024 ** 3 }), budget)
    expect(v.ok).toBe(false)
    expect(v.breaches[0]).toContain('2.0GB free')
  })

  test('too many open sessions holds a fire', () => {
    // The desk's own children are the load it is causing.
    const v = check(host({ agents: 30, busy: 12 }), budget)
    expect(v.ok).toBe(false)
    expect(v.breaches[0]).toBe('30 sessions (12 working) over 24')
  })

  test('a desk full of finished managers does not stop the machine', () => {
    // 2026-10-05: 32 registered sessions, 2 of them working, 150 give-ups in a
    // day. Counting every registration made the number monotonic, so a
    // long-lived desk crossed 24 for good and nothing on it ever fired again.
    const { agents, busy } = agentCounts(
      listing({ working: 2, idle: 2, done: 28 }),
    )
    expect(check(host({ agents, busy }), budget).ok).toBe(true)
  })

  test('but sessions that are still open do hold a fire', () => {
    // The same gate, and the reason it exists: idle panes hold a PTY, so a
    // count that ignored them would re-enter the outage under another name.
    const { agents, busy } = agentCounts(listing({ working: 30 }))
    const v = check(host({ agents, busy }), budget)
    expect(v.ok).toBe(false)
    expect(v.breaches[0]).toBe('30 sessions (30 working) over 24')
  })

  test('the reason names every breach, not just the first', () => {
    // A reader who is told only "busy" opens the wrong thing.
    const v = check(
      host({ loadPerCore: 3, memAvailable: 1024 ** 3, agents: 40 }),
      budget,
    )
    expect(v.breaches).toHaveLength(3)
  })

  test('an unreadable signal never blocks a fire', () => {
    // A health check that blocks on a missing reading stops the desk entirely,
    // which is the opposite of what a health check is for.
    const v = check(host({ loadPerCore: null, memAvailable: null }), budget)
    expect(v.ok).toBe(true)
  })

  test('pressure rises as the host fills up', () => {
    const calm = check(host(), budget).pressure
    const tight = check(host({ loadPerCore: 1.45 }), budget).pressure
    expect(tight).toBeGreaterThan(calm)
  })
})

describe('defaultBudget', () => {
  test('never asks a small host for more memory than it has', () => {
    // 15% of a 1 GB machine is 160 MB, which would hold every fire forever.
    const b = defaultBudget(1024 ** 3)
    expect(b.minMemAvailable).toBe(3 * 1024 ** 3)
    expect(b.minMemAvailable).toBeGreaterThan(1024 ** 3)
  })

  test('scales with a large host', () => {
    expect(defaultBudget(64 * 1024 ** 3).minMemAvailable).toBe(
      Math.round(64 * 1024 ** 3 * 0.15),
    )
  })
})

describe('agentCounts', () => {
  test('counts open sessions and the working ones among them', () => {
    // `idle` counts — a parked pane still holds a PTY — and `done` does not,
    // because a finished manager stays registered for the next prompt.
    const got = agentCounts({
      result: {
        agents: [
          { name: 'a', agent_status: 'working' },
          { name: 'b', agent_status: 'working' },
          { name: 'c', agent_status: 'idle' },
          { name: 'd', agent_status: 'done' },
        ],
      },
    })
    expect(got).toEqual({ agents: 3, busy: 2 })
  })

  test('a status we do not know counts as open', () => {
    // A new Herdr state must not silently delete the ceiling the gate enforces.
    expect(agentCounts(listing({ parked: 5 }))).toEqual({ agents: 5, busy: 0 })
  })

  test('an unreadable listing is zero, never a throw', () => {
    expect(agentCounts(null)).toEqual({ agents: 0, busy: 0 })
    expect(agentCounts({})).toEqual({ agents: 0, busy: 0 })
  })
})

describe('formatters', () => {
  test('an unknown reading is marked, not shown as zero', () => {
    // `0.0/core` reads as a healthy machine; `?` reads as "not measured".
    expect(fmtLoad(host({ loadPerCore: null }))).toBe('?')
    expect(fmtMem(null)).toBe('?')
  })

  test('gigabytes and megabytes both read naturally', () => {
    expect(fmtMem(8 * 1024 ** 3)).toBe('8.0GB')
    expect(fmtMem(400 * 1024 ** 2)).toBe('400MB')
  })
})
