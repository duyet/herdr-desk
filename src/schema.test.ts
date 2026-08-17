import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DESK_ROOT } from './config'
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

  test('accepts name-only (defaults fill the rest)', () => {
    expect(validateDeskJson({ name: 'demo' })).toEqual([])
  })

  test('examples/repo/.herdr-desk.json and repo root validate', () => {
    const examples = join(DESK_ROOT, 'examples')
    const files = readdirSync(examples)
      .map((name) => join(examples, name, '.herdr-desk.json'))
      .concat(join(DESK_ROOT, '.herdr-desk.json'))
    for (const file of files) {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      expect(validateDeskJson(raw, file), file).toEqual([])
    }
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
