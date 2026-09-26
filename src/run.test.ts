import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TaskConfig } from './config'
import {
  baseRefFrom,
  deskWorktreeBranch,
  runDirFor,
  writeLatestPointer,
} from './run'

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

describe('writeLatestPointer', () => {
  function stateDir(): string {
    return mkdtempSync(join(tmpdir(), 'herdr-desk-latest-'))
  }

  test('writes taskId/day for a clean state dir', () => {
    const dir = stateDir()
    writeLatestPointer(dir, 'desk:github-issues', '2026-09-27')
    expect(readFileSync(join(dir, 'LATEST'), 'utf8')).toBe(
      'desk:github-issues/2026-09-27\n',
    )
    rmSync(dir, { recursive: true, force: true })
  })

  test('replaces a stale LATEST directory instead of throwing EISDIR', () => {
    // The exact shape that silenced 24 daily fires on chmonitor: a directory
    // left at the pointer path made every later writeFileSync throw, so each
    // run died before the manager was ever prompted.
    const dir = stateDir()
    mkdirSync(join(dir, 'LATEST'), { recursive: true })
    writeLatestPointer(dir, 'desk:github-issues', '2026-09-28')
    expect(statSync(join(dir, 'LATEST')).isFile()).toBe(true)
    expect(readFileSync(join(dir, 'LATEST'), 'utf8')).toBe(
      'desk:github-issues/2026-09-28\n',
    )
    rmSync(dir, { recursive: true, force: true })
  })

  test('is idempotent across repeated fires on the same day', () => {
    const dir = stateDir()
    writeLatestPointer(dir, 'desk:github-issues', '2026-09-27')
    writeLatestPointer(dir, 'desk:github-issues', '2026-09-27')
    expect(readFileSync(join(dir, 'LATEST'), 'utf8')).toBe(
      'desk:github-issues/2026-09-27\n',
    )
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('baseRefFrom', () => {
  test('uses the repo default branch when it is not main', () => {
    // The shape that broke docker-images: every fire died on
    // `fatal: invalid reference: origin/main` because that repo is master.
    expect(baseRefFrom('origin/master\n')).toBe('origin/master')
  })

  test('accepts main and trims the trailing newline git adds', () => {
    expect(baseRefFrom('origin/main\n')).toBe('origin/main')
  })

  test('falls back when origin/HEAD is missing or unusable', () => {
    // A repo with no origin/HEAD (fresh clone, no remote default) must still
    // get a ref rather than an empty --base argument.
    expect(baseRefFrom(null)).toBe('origin/main')
    expect(baseRefFrom(undefined)).toBe('origin/main')
    expect(baseRefFrom('')).toBe('origin/main')
    expect(baseRefFrom('refs/remotes/origin/master')).toBe('origin/main')
    expect(baseRefFrom('HEAD')).toBe('origin/main')
    expect(baseRefFrom('origin/')).toBe('origin/main')
  })

  test('honors an explicit fallback', () => {
    expect(baseRefFrom(null, 'origin/master')).toBe('origin/master')
  })
})

describe('deskWorktreeBranch', () => {
  test('slugs the task id into a stable git branch under desk/', () => {
    expect(deskWorktreeBranch(base)).toBe('desk/desk-github-issues')
  })

  test('is the same branch every day, so the manager worktree is reused', () => {
    // A per-day branch (desk/<task>-<day>) forced a new worktree + session on
    // every tick. The manager is long-lived, so its branch must not move.
    expect(deskWorktreeBranch(base)).toBe(deskWorktreeBranch(base))
    expect(deskWorktreeBranch(base)).not.toContain('2026')
  })
})
