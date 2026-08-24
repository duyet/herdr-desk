import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DESK_ROOT } from './config'
import { validateDeskJson } from './schema'

const good = {
  name: 'demo',
  tasks: [
    {
      id: 'desk:github-issues',
      playbook: 'github-issues',
      agentName: 'my-desk',
      maxChildren: 5,
      schedule: '0 7 * * *',
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

  test('accepts a cron list', () => {
    expect(
      validateDeskJson({
        name: 'demo',
        schedule: ['0 8 * * *', '30 20 * * *'],
      }),
    ).toEqual([])
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

  test('rejects cron fields that Number() would silently mishandle', () => {
    // Why: token count used to pass; expand() then treated */q as NaN step
    // (one fire at the field min) and 10-2 / 61 as empty (never fire).
    const cases = ['*/q * * * *', '61 * * * *', '10-2 * * * *']
    for (const schedule of cases) {
      const errs = validateDeskJson({ name: 'demo', schedule })
      expect(
        errs.some((e) => e.includes('cron')),
        schedule,
      ).toBe(true)
    }
  })

  test('still accepts stepped, ranged, and named-dow crons', () => {
    for (const schedule of [
      '*/15 * * * *',
      '0-10 * * * *',
      '0 8 * * 1-5',
      '0 9 * * mon-fri',
    ]) {
      expect(validateDeskJson({ name: 'demo', schedule }), schedule).toEqual([])
    }
  })

  test('rejects a bad agent name and cron', () => {
    const bad = {
      name: 'demo',
      tasks: [
        {
          id: 'desk:github-issues',
          playbook: 'github-issues',
          agentName: 'My Desk',
          schedule: '7am',
        },
      ],
    }
    const errs = validateDeskJson(bad)
    expect(errs.some((e) => e.includes('agentName'))).toBe(true)
    expect(errs.some((e) => e.includes('cron'))).toBe(true)
  })

  test('rejects legacy schedule objects', () => {
    const errs = validateDeskJson({
      name: 'demo',
      schedule: { start: '0 8 * * *' },
    })
    expect(errs.some((e) => e.includes('schedule'))).toBe(true)
  })

  test('rejects a traversal task id', () => {
    const errs = validateDeskJson({
      name: 'demo',
      tasks: [{ id: '../../.ssh' }],
    })
    expect(errs.some((e) => e.includes('.id'))).toBe(true)
  })

  test('rejects a stateDir that escapes the repo', () => {
    const errs = validateDeskJson(
      {
        name: 'demo',
        tasks: [{ id: 'desk:github-issues', stateDir: '../outside' }],
      },
      '.herdr-desk.json',
      '/tmp/herdr-desk-repo',
    )
    expect(errs.some((e) => e.includes('stateDir'))).toBe(true)
  })

  test('accepts a stateDir inside the repo', () => {
    expect(
      validateDeskJson(
        {
          name: 'demo',
          tasks: [
            { id: 'desk:github-issues', stateDir: '.herdr-desk/runs/ok' },
          ],
        },
        '.herdr-desk.json',
        '/tmp/herdr-desk-repo',
      ),
    ).toEqual([])
  })
})
