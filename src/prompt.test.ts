import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { DESK_ROOT, type LoadedDesk, type TaskConfig } from './config'
import { assembleManagerPrompt, taskVars } from './prompt'

const task: TaskConfig = {
  id: 'desk:github-issues',
  label: 'GitHub issues and PRs',
  playbook: 'github-issues',
  agentName: 'chm-desk',
  maxChildren: 3,
  crons: ['0 7 * * *'],
}

const config: LoadedDesk = { name: 'chmonitor', tasks: [task] }

describe('assembleManagerPrompt', () => {
  test('includes identity and playbook', () => {
    const vars = taskVars({
      config,
      task,
      repo: '/tmp/repo',
      day: '2026-08-18',
      runDir: '/tmp/repo/.herdr-desk/runs/issues/2026-08-18',
    })
    const text = assembleManagerPrompt(vars)
    expect(text).toContain('duyetbot')
    expect(text).toContain('GitHub issues and PRs')
    expect(text).toContain('chm-desk')
    expect(text).toContain('Against slop')
    expect(text).toContain(join(DESK_ROOT, 'prompts', 'child.md'))
    expect(text).not.toContain('{{agentName}}')
  })
})
