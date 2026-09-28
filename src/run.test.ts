import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TaskConfig } from './config'
import type { ListedAgent } from './herdr'
import {
  announceable,
  announceBody,
  baseRefFrom,
  canPromptManager,
  deskWorktreeBranch,
  isManagerCheckout,
  preconditionSkip,
  runDirFor,
  writeLatestPointer,
} from './run'

const base: TaskConfig = {
  id: 'desk:github-issues',
  playbook: 'github-issues',
  agentName: 'chm-desk',
  agent: { ladder: ['grok'], permission: 'default' },
  crons: ['0 7 * * *'],
}

describe('announceable', () => {
  test('a precondition skip is never announced', () => {
    // The exact shape that filled the channel: four anyrouter tasks reporting
    // "no open Herdr session" every 30 minutes, forever, because a condition
    // the operator reaches just by closing a Space was treated as news.
    expect(
      announceable(preconditionSkip('no open Herdr session for anyrouter')),
    ).toBe(false)
  })

  test('a failure is always announced', () => {
    expect(announceable({ error: 'boom' })).toBe(true)
  })

  test('a successful run is not announced', () => {
    // The manager's merged report says what happened; `spawned manager` said
    // only that something had.
    expect(announceable({ spawned: true })).toBe(false)
    expect(announceable({ prompted: true })).toBe(false)
  })

  test('a skip can opt back in when it is worth a message', () => {
    expect(announceable(preconditionSkip('manual lock held', false))).toBe(true)
    expect(announceable({ skipped: 'manual lock held' })).toBe(true)
  })

  test('a skip is reported as a skip, not as a failure', () => {
    // `announce` hardcoded level `fail` and the headline `run failed`, so a
    // non-quiet skip would have gone out reading "run failed" — sending a
    // reader hunting for a crash that never happened. The compiler caught the
    // `undefined`; this pins the verdict.
    expect(announceBody(preconditionSkip('manual lock held', false))).toBe(
      '⚪ *skip* manual lock held\n#skip #desk',
    )
    expect(announceBody({ error: 'boom' })).toContain('*fail*')
  })
})

describe('preconditionSkip', () => {
  test('keeps the reason so history stays diagnosable', () => {
    // The notice is withheld, not the record: `history` is the only way to tell
    // "the desk never ran" from "the desk ran and said nothing".
    expect(preconditionSkip('herdr is not running')).toEqual({
      skipped: 'herdr is not running',
      quiet: true,
    })
  })

  test('defaults to quiet but stays overridable', () => {
    expect(preconditionSkip('a').quiet).toBe(true)
    expect(preconditionSkip('a', false).quiet).toBe(false)
  })
})

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

describe('isManagerCheckout', () => {
  const babysit: TaskConfig = { ...base, id: 'local:babysit' }

  test('matches the dashed directory Herdr actually creates', () => {
    // The live shape: branch `desk/local-babysit`, directory
    // `desk-local-babysit`. The old check compared the branch against the path,
    // never matched, and every finished manager then hit `agent_name_taken` on
    // every fire.
    expect(
      isManagerCheckout(
        '/home/duyet/.herdr/worktrees/chmonitor/desk-local-babysit',
        babysit,
      ),
    ).toBe(true)
  })

  test('matches a checkout that keeps the branch spelling', () => {
    expect(
      isManagerCheckout(
        '/home/duyet/.herdr/worktrees/chmonitor/desk/local-babysit',
        babysit,
      ),
    ).toBe(true)
  })

  test('rejects another task’s worktree and an empty path', () => {
    expect(
      isManagerCheckout(
        '/home/duyet/.herdr/worktrees/chmonitor/desk-local-prod',
        babysit,
      ),
    ).toBe(false)
    expect(isManagerCheckout('', babysit)).toBe(false)
  })
})

describe('canPromptManager', () => {
  const prod: TaskConfig = { ...base, id: 'local:prod', agentName: 'chm-prod' }

  // The shape that lost 20 `chmonitor local:prod` fires in 95 seconds on
  // 2026-09-28: `chm-prod` is registered and finished, its worktree is
  // `desk-local-prod` because Herdr dashes the branch's slash, and the
  // workspace list no longer carries it. Nothing matched, so every run reached
  // `agent start` on a name Herdr was already holding.
  const registered: ListedAgent = {
    name: 'chm-prod',
    status: 'done',
    paneId: 'wAY:p1',
    workspaceId: 'wAY',
    cwd: '/home/duyet/.herdr/worktrees/chmonitor/desk-local-prod',
  }

  test('prompts a registered-but-unlisted manager, never starts one', () => {
    expect(canPromptManager([registered], [], prod)).toBe(true)
  })

  test('prompts a manager that is still working', () => {
    // `cwd` is left off: `isAgentLive` calls a session whose cwd is gone dead,
    // and no checkout at that path exists on a CI runner.
    expect(
      canPromptManager([{ name: 'chm-prod', status: 'working' }], [], prod),
    ).toBe(true)
  })

  test('starts a session only for a name nobody holds', () => {
    // The other half of the rule. Without it the test above could pass for the
    // wrong reason — by answering true no matter what Herdr reported.
    expect(canPromptManager([], [], prod)).toBe(false)
  })

  test('starts when the registered manager’s worktree is gone', () => {
    // Its pane went with the checkout, so there is nothing left to prompt.
    expect(canPromptManager([{ ...registered, cwd: '' }], [], prod)).toBe(false)
  })
})
