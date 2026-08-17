import { describe, expect, test } from 'bun:test'
import type { TaskConfig } from './config'
import { describeJob } from './describe'

const base: TaskConfig = {
  id: 'desk:github-issues',
  playbook: 'github-issues',
  agentName: 'chm-desk',
  maxChildren: 3,
  crons: ['0 7 * * *'],
}

describe('describeJob', () => {
  test('default', () => {
    expect(describeJob('/tmp', base)).toContain('Triage issues/PRs')
    expect(describeJob('/tmp', base)).toContain('≤3')
    expect(describeJob('/tmp', base)).toContain('changes.md')
  })

  test('override', () => {
    const t = { ...base, describe: 'custom line' }
    expect(describeJob('/tmp', t)).toBe('custom line')
  })
})
