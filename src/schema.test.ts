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

describe('agent field', () => {
  test('accepts a bare rung, a command, and a ladder', () => {
    for (const agent of [
      'claude',
      'opencode2',
      'anyr claude --yolo',
      './scripts/desk-agent.sh --fast',
      { ladder: ['opencode2', 'opencode', 'claude'] },
      { default: 'pi' },
      { permission: 'yolo' },
      { ladder: 'codex', permission: 'yolo', timeoutMs: 60_000 },
    ]) {
      expect(
        validateDeskJson({ name: 'demo', agent }),
        JSON.stringify(agent),
      ).toEqual([])
      expect(
        validateDeskJson({ name: 'demo', tasks: [{ id: 't', agent }] }),
        JSON.stringify(agent),
      ).toEqual([])
    }
  })

  test('a 0.1.x kind config still validates cleanly', () => {
    // Back-compat: kind must not become an error, or every existing repo fails
    // `validate` on upgrade.
    expect(validateDeskJson({ name: 'demo', kind: 'grok' })).toEqual([])
    expect(
      validateDeskJson({ name: 'demo', tasks: [{ id: 't', kind: 'claude' }] }),
    ).toEqual([])
  })

  test('setting both agent and kind is reported as a conflict', () => {
    const errs = validateDeskJson({
      name: 'demo',
      agent: 'claude',
      kind: 'grok',
    })
    expect(errs.some((e) => e.includes("kind: ignored because 'agent'"))).toBe(
      true,
    )
  })

  test('rejects a malformed agent block', () => {
    expect(
      validateDeskJson({ name: 'demo', agent: { ladder: [] } }).some((e) =>
        e.includes('ladder'),
      ),
    ).toBe(true)
    expect(
      validateDeskJson({ name: 'demo', agent: { ladder: 7 } }).some((e) =>
        e.includes('ladder'),
      ),
    ).toBe(true)
    expect(
      validateDeskJson({ name: 'demo', agent: { nope: 1 } }).some((e) =>
        e.includes('nope'),
      ),
    ).toBe(true)
    expect(
      validateDeskJson({ name: 'demo', agent: { permission: '' } }).some((e) =>
        e.includes('permission'),
      ),
    ).toBe(true)
    expect(
      validateDeskJson({ name: 'demo', agent: 7 }).some((e) =>
        e.includes('agent'),
      ),
    ).toBe(true)
  })

  test('bounds timeoutMs to the range agent start accepts', () => {
    // 0 is the value that would mean "no readiness wait at all", which reads as
    // a fast agent rather than a broken one.
    expect(
      validateDeskJson({ name: 'demo', agent: { timeoutMs: 0 } }).some((e) =>
        e.includes('timeoutMs'),
      ),
    ).toBe(true)
    expect(
      validateDeskJson({ name: 'demo', agent: { timeoutMs: 999_999 } }).some(
        (e) => e.includes('timeoutMs'),
      ),
    ).toBe(true)
  })
})

describe('notify block', () => {
  test('accepts a destination override at root and task level', () => {
    for (const notify of [
      { chatId: '-100123' },
      { topicId: '42' },
      { enabled: false },
      { chatId: '-100123', topicId: '42' },
    ]) {
      expect(
        validateDeskJson({ name: 'demo', notify }),
        JSON.stringify(notify),
      ).toEqual([])
      expect(
        validateDeskJson({ name: 'demo', tasks: [{ id: 't', notify }] }),
        JSON.stringify(notify),
      ).toEqual([])
    }
  })

  test('rejects a token in a repo config, and says where it belongs', () => {
    // A repo config is committed. Failing loudly is the point: silently
    // stripping would leave a credential in git history and the user none the
    // wiser.
    const errs = validateDeskJson({
      name: 'demo',
      notify: { chatId: '-100', token: '123:ABC' },
    })
    const hit = errs.find((e) => e.includes('token'))
    expect(hit).toBeDefined()
    expect(hit).toContain('notify.json')
    expect(hit).toContain('HERDR_DESK_TELEGRAM_TOKEN')
  })

  test('rejects a token on a task too', () => {
    const errs = validateDeskJson({
      name: 'demo',
      tasks: [{ id: 't', notify: { token: '123:ABC' } }],
    })
    expect(errs.some((e) => e.includes('notify.token'))).toBe(true)
  })

  test('rejects a malformed notify block', () => {
    expect(
      validateDeskJson({ name: 'demo', notify: 'chat' }).some((e) =>
        e.includes('notify'),
      ),
    ).toBe(true)
    expect(
      validateDeskJson({ name: 'demo', notify: { enabled: 'yes' } }).some((e) =>
        e.includes('enabled'),
      ),
    ).toBe(true)
    expect(
      validateDeskJson({ name: 'demo', notify: { chatId: '' } }).some((e) =>
        e.includes('chatId'),
      ),
    ).toBe(true)
    expect(
      validateDeskJson({ name: 'demo', notify: { nope: 1 } }).some((e) =>
        e.includes('nope'),
      ),
    ).toBe(true)
  })
})
