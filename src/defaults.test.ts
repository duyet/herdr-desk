import { describe, expect, test } from 'bun:test'
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
