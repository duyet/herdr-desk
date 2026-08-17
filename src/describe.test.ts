import { describe, expect, test } from 'bun:test'
import { describeJob } from './describe'
import type { TaskConfig } from './config'

const base: TaskConfig = {
  id: 'issues',
  task: 'github-issues',
  agentName: 'chm-desk',
  maxChildren: 3,
}

describe('describeJob', () => {
  test('morning default', () => {
    expect(describeJob('/tmp', base, 'morning')).toContain('Triage issues/PRs')
    expect(describeJob('/tmp', base, 'morning')).toContain('≤3')
    expect(describeJob('/tmp', base, 'morning')).toContain('changes.md')
  })

  test('override', () => {
    const t = { ...base, describe: { morning: 'custom line' } }
    expect(describeJob('/tmp', t, 'morning')).toBe('custom line')
  })
})
