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

  test('too many live agents holds a fire', () => {
    // The desk's own children are the load it is causing.
    const v = check(host({ agents: 30 }), budget)
    expect(v.ok).toBe(false)
    expect(v.breaches[0]).toContain('30 agents')
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
  test('counts live and busy sessions', () => {
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
    expect(got).toEqual({ agents: 4, busy: 2 })
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
