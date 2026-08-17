import { describe, expect, test } from 'bun:test'
import { validateDeskJson } from './schema'

const good = {
  name: 'demo',
  tasks: [
    {
      id: 'issues',
      task: 'github-issues',
      agentName: 'my-desk',
      maxChildren: 5,
      schedule: { morning: '0 7 * * *' },
    },
  ],
}

describe('validateDeskJson', () => {
  test('accepts a minimal valid file', () => {
    expect(validateDeskJson(good)).toEqual([])
  })

  test('rejects a bad agent name and cron', () => {
    const bad = {
      name: 'demo',
      tasks: [
        {
          id: 'issues',
          task: 'github-issues',
          agentName: 'My Desk',
          schedule: { morning: '7am' },
        },
      ],
    }
    const errs = validateDeskJson(bad)
    expect(errs.some((e) => e.includes('agentName'))).toBe(true)
    expect(errs.some((e) => e.includes('cron'))).toBe(true)
  })
})
