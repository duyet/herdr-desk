import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { TaskConfig } from './config'
import { deskWorktreeBranch, runDirFor } from './run'

const base: TaskConfig = {
  id: 'desk:github-issues',
  playbook: 'github-issues',
  agentName: 'chm-desk',
  crons: ['0 7 * * *'],
}

describe('runDirFor', () => {
  test('joins a relative stateDir inside the repo', () => {
    const repo = '/tmp/herdr-desk-repo'
    expect(
      runDirFor(
        repo,
        { ...base, stateDir: '.herdr-desk/runs/ok' },
        '2026-08-24',
      ),
    ).toBe(join(repo, '.herdr-desk/runs/ok', '2026-08-24'))
  })

  test('throws when stateDir traverses out of the repo', () => {
    expect(() =>
      runDirFor(
        '/tmp/herdr-desk-repo',
        { ...base, stateDir: '../outside' },
        '2026-08-24',
      ),
    ).toThrow(/escapes repo/)
  })
})

describe('deskWorktreeBranch', () => {
  test('slugs the task id into a git branch under desk/', () => {
    expect(deskWorktreeBranch(base, '2026-09-13')).toBe(
      'desk/desk-github-issues-2026-09-13',
    )
  })
})
