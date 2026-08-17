import { describe, expect, test } from 'bun:test'
import { applyDefaults } from './defaults'

describe('applyDefaults', () => {
  test('name-only gets a morning issues task', () => {
    const cfg = applyDefaults({ name: 'Acme App' }, '/tmp/acme')
    expect(cfg.tasks).toHaveLength(1)
    const t = cfg.tasks[0]
    expect(t.id).toBe('issues')
    expect(t.task).toBe('github-issues')
    expect(t.agentName).toBe('acme-app-desk')
    expect(t.maxChildren).toBe(5)
    expect(t.schedule?.morning).toBe('0 7 * * *')
    expect(t.schedule?.nightly).toBeUndefined()
  })
})
