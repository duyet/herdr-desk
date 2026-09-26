import { describe, expect, test } from 'bun:test'
import { DEFAULT_AGENT } from './config'
import { applyDefaults } from './defaults'

describe('applyDefaults', () => {
  test('name-only gets desk:github-issues at 07:00', () => {
    const cfg = applyDefaults({ name: 'Acme App' }, '/tmp/acme')
    expect(cfg.tasks).toHaveLength(1)
    const t = cfg.tasks[0]
    expect(t.id).toBe('desk:github-issues')
    expect(t.playbook).toBe('github-issues')
    expect(t.agentName).toBe('acme-app-desk')
    expect(t.maxChildren).toBe(5)
    expect(t.crons).toEqual(['0 7 * * *'])
    expect(t.schedule).toBe('0 7 * * *')
    expect(t.stateDir).toBe('.herdr-desk/runs/github-issues')
  })

  test('local playbook gets local: id; schedule may be a list', () => {
    const cfg = applyDefaults(
      {
        name: 'demo',
        tasks: [
          {
            playbook: 'notes/triage.md',
            agentName: 'demo-desk',
            schedule: ['0 8 * * *', '0 21 * * *'],
          },
        ],
      },
      '/tmp/demo',
    )
    const t = cfg.tasks[0]
    expect(t.id).toBe('local:triage')
    expect(t.crons).toEqual(['0 8 * * *', '0 21 * * *'])
  })
})

describe('agent selection', () => {
  test('a config that never mentioned the agent keeps running grok', () => {
    // Why: 0.1.x defaulted to grok. Changing the default rung would silently
    // switch every existing repo's agent on upgrade, which is not back-compat.
    const t = applyDefaults({ name: 'acme' }, '/tmp/acme').tasks[0]
    expect(t.agent.ladder).toEqual(['grok'])
    expect(t.agent.permission).toBe('default')
  })

  test('deprecated kind still resolves to a one-rung ladder', () => {
    const t = applyDefaults({ name: 'acme', kind: 'codex' }, '/tmp/acme')
      .tasks[0]
    expect(t.agent.ladder).toEqual(['codex'])
  })

  test('deprecated kind on a task still works', () => {
    const t = applyDefaults(
      { name: 'acme', tasks: [{ id: 'desk:github-issues', kind: 'claude' }] },
      '/tmp/acme',
    ).tasks[0]
    expect(t.agent.ladder).toEqual(['claude'])
  })

  test('agent wins over kind when both are set', () => {
    const t = applyDefaults(
      { name: 'acme', agent: 'claude', kind: 'grok' },
      '/tmp/acme',
    ).tasks[0]
    expect(t.agent.ladder).toEqual(['claude'])
  })

  test('an ordered ladder is preserved in preference order', () => {
    const t = applyDefaults(
      { name: 'acme', agent: { ladder: ['opencode2', 'opencode', 'claude'] } },
      '/tmp/acme',
    ).tasks[0]
    expect(t.agent.ladder).toEqual(['opencode2', 'opencode', 'claude'])
  })

  test('a command rung with arguments survives intact', () => {
    const t = applyDefaults(
      { name: 'acme', agent: 'anyr claude --yolo' },
      '/tmp/acme',
    ).tasks[0]
    expect(t.agent.ladder).toEqual(['anyr claude --yolo'])
  })

  test('a task agent block inherits the rest of the root ladder', () => {
    // The point of the object form: a repo overrides one field without having
    // to restate a machine-wide ladder it does not own.
    const t = applyDefaults(
      {
        name: 'acme',
        agent: { ladder: ['opencode2', 'claude'], permission: 'yolo' },
        tasks: [{ id: 'desk:github-issues', agent: { permission: 'default' } }],
      },
      '/tmp/acme',
    ).tasks[0]
    expect(t.agent.ladder).toEqual(['opencode2', 'claude'])
    expect(t.agent.permission).toBe('default')
  })

  test('a task pin replaces the ladder but keeps shared fields', () => {
    const t = applyDefaults(
      {
        name: 'acme',
        agent: { ladder: ['opencode2', 'claude'], permission: 'yolo' },
        tasks: [{ id: 'desk:github-issues', agent: 'codex' }],
      },
      '/tmp/acme',
    ).tasks[0]
    expect(t.agent.ladder).toEqual(['codex'])
    expect(t.agent.permission).toBe('yolo')
  })

  test('default is an alias for a one-rung ladder', () => {
    const t = applyDefaults(
      { name: 'acme', agent: { default: 'pi' } },
      '/tmp/acme',
    ).tasks[0]
    expect(t.agent.ladder).toEqual(['pi'])
  })

  test('an empty ladder is ignored rather than producing an unusable task', () => {
    const t = applyDefaults(
      { name: 'acme', agent: { ladder: [] } },
      '/tmp/acme',
    ).tasks[0]
    expect(t.agent.ladder).toEqual(DEFAULT_AGENT.ladder)
  })

  test('timeoutMs is inherited and overridable', () => {
    const cfg = applyDefaults(
      {
        name: 'acme',
        agent: { timeoutMs: 60_000 },
        tasks: [{ id: 'desk:github-issues', agent: { timeoutMs: 300_000 } }],
      },
      '/tmp/acme',
    )
    expect(cfg.tasks[0].agent.timeoutMs).toBe(300_000)
  })
})
