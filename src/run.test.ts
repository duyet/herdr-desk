import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TaskConfig } from './config'
import { recordAnnounced, shouldAnnounce } from './failures'
import type { ListedAgent } from './herdr'
import {
  announceable,
  announceBody,
  assertOwnWorktree,
  baseRefArgv,
  baseRefFrom,
  childBranch,
  deskWorktreeBranch,
  isManagerCheckout,
  managerToPrompt,
  preconditionSkip,
  runDirFor,
  runTask,
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

describe('baseRefArgv', () => {
  const git = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], { cwd, stderr: 'pipe' })
    if (r.exitCode !== 0) throw new Error(r.stderr.toString())
    return r.stdout.toString().trim()
  }

  /** A clone whose remote default is `master` — the repo shape #18 died on. */
  function masterRepo(): string {
    const root = mkdtempSync(join(tmpdir(), 'herdr-desk-baseref-'))
    const repo = join(root, 'repo')
    git(root, 'init', '--bare', '-b', 'master', join(root, 'origin.git'))
    git(root, 'clone', join(root, 'origin.git'), repo)
    git(repo, 'config', 'user.email', 't@t')
    git(repo, 'config', 'user.name', 't')
    writeFileSync(join(repo, 'a'), '1')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'init')
    git(repo, 'push', 'origin', 'master')
    git(repo, 'remote', 'set-head', 'origin', 'master')
    return root
  }

  test('a master repo comes back as origin/master, so --short never goes', () => {
    // Not the parser — the command that feeds it. The tests above pass whatever
    // git printed, so they stay green if `--short` is dropped from the spawn:
    // git would answer `refs/remotes/origin/master`, the same regex would
    // reject it, and a `master` repo would fall back to an origin/main it does
    // not have. `fatal: invalid reference` again, with nothing in the log.
    const root = masterRepo()
    const proc = Bun.spawnSync(baseRefArgv(join(root, 'repo')), {
      stderr: 'pipe',
    })
    const printed = proc.stdout.toString().trim()
    rmSync(root, { recursive: true, force: true })

    expect(proc.exitCode).toBe(0)
    expect(printed).not.toContain('refs/remotes/')
    expect(baseRefFrom(printed)).toBe('origin/master')
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

describe('childBranch', () => {
  test('lives under desk/ beside the manager branch, never inside it', () => {
    expect(childBranch(base, 'Issue #42')).toBe(
      'desk/desk-github-issues--issue-42',
    )
  })

  test('git accepts a child ref while the manager ref exists', () => {
    // `desk/<task>/<item>` is refused once `desk/<task>` is a ref.
    const repo = mkdtempSync(join(tmpdir(), 'desk-child-'))
    try {
      const git = (...args: string[]) =>
        Bun.spawnSync(
          ['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
          { cwd: repo },
        ).exitCode
      git('init', '-q')
      git('commit', '-q', '--allow-empty', '-m', 'root')
      expect(git('branch', deskWorktreeBranch(base))).toBe(0)
      expect(git('branch', childBranch(base, 'pr-17'))).toBe(0)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('the child checkout is never mistaken for the manager', () => {
    const dir = `/w/${childBranch(base, 'pr-17').replace('/', '-')}`
    expect(isManagerCheckout(dir, base)).toBe(false)
  })

  test('refuses an item with nothing to name a branch after', () => {
    expect(() => childBranch(base, '///')).toThrow()
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

describe('managerToPrompt', () => {
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
    expect(managerToPrompt([registered], [], prod)).toBe('chm-prod')
  })

  test('prompts a manager that is still working', () => {
    // `cwd` is left off: `isAgentLive` calls a session whose cwd is gone dead,
    // and no checkout at that path exists on a CI runner.
    expect(
      managerToPrompt([{ name: 'chm-prod', status: 'working' }], [], prod),
    ).toBe('chm-prod')
  })

  test('starts a session only for a name nobody holds', () => {
    // The other half of the rule. Without it the test above could pass for the
    // wrong reason — by answering true no matter what Herdr reported.
    expect(managerToPrompt([], [], prod)).toBeNull()
  })

  test('starts when the registered manager’s worktree is gone', () => {
    // Its pane went with the checkout, so there is nothing left to prompt.
    expect(managerToPrompt([{ ...registered, cwd: '' }], [], prod)).toBeNull()
  })

  // Before task ids named the session, every job of a desk defaulted to the
  // one `<desk>-desk` name. A desk upgraded mid-life still has that session.
  describe('legacy shared name', () => {
    const migrated: TaskConfig = {
      ...prod,
      agentName: 'chmonitor-desk-local-prod',
      legacyAgentName: 'chm-desk',
    }
    const legacy = (cwd: string, status = 'done'): ListedAgent => ({
      ...registered,
      name: 'chm-desk',
      status,
      cwd,
    })

    test('re-prompts the old session in this task’s checkout', () => {
      const own = '/home/duyet/.herdr/worktrees/chmonitor/desk-local-prod'
      expect(managerToPrompt([legacy(own)], [], migrated)).toBe('chm-desk')
    })

    test('never prompts the old session sitting in another job’s checkout', () => {
      const other = '/home/duyet/.herdr/worktrees/chmonitor/desk-local-babysit'
      expect(managerToPrompt([legacy(other)], [], migrated)).toBeNull()
      expect(
        managerToPrompt([legacy(other, 'working')], [], migrated),
      ).toBeNull()
    })

    test('prefers the new name when both are registered', () => {
      const own = '/home/duyet/.herdr/worktrees/chmonitor/desk-local-prod'
      expect(
        managerToPrompt(
          [legacy(own), { ...registered, name: migrated.agentName }],
          [],
          migrated,
        ),
      ).toBe(migrated.agentName)
    })
  })
})

describe('runTask', () => {
  // Everything a run reads off the host, so a test tick cannot pick up the
  // developer's own Herdr, desk configs or Telegram token.
  const HOST_ENV = [
    'HERDR_PLUGIN_STATE_DIR',
    'HERDR_PLUGIN_CONFIG_DIR',
    'HERDR_BIN_PATH',
    'HERDR_SOCKET_PATH',
    'HERDR_DESK_TELEGRAM_TOKEN',
    'HERDR_DESK_TELEGRAM_CHAT_ID',
  ] as const
  const prevEnv = HOST_ENV.map((k) => [k, process.env[k]] as const)
  const temps: string[] = []

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    temps.push(dir)
    return dir
  }

  const TASK_ID = 'local:babysit'
  const FAULT = 'agent_name_taken: agent name chm-babysit is already used'

  /**
   * A one-task desk on a temp repo, and a Herdr that answers.
   *
   * The fake binary is a shell script rather than a stub of `herdrCall`, so this
   * drives the real path: the project Space is found in `workspace list`, the
   * manager is promptable in `agent list`, and `agent prompt` is accepted. No
   * Telegram token exists anywhere, so `announce` gets as far as its decision
   * and never reaches the network.
   *
   * `herdrDown` leaves the socket missing, which is the precondition-skip path.
   */
  function desk(herdrDown = false, legacy = false): string {
    const state = tempDir('herdr-desk-run-')
    const repo = tempDir('herdr-desk-repo-')
    process.env.HERDR_PLUGIN_STATE_DIR = state
    process.env.HERDR_PLUGIN_CONFIG_DIR = tempDir('herdr-desk-config-')
    delete process.env.HERDR_DESK_TELEGRAM_TOKEN
    delete process.env.HERDR_DESK_TELEGRAM_CHAT_ID

    writeFileSync(
      join(repo, '.herdr-desk.json'),
      `${JSON.stringify({
        name: 'chmonitor',
        tasks: [
          {
            id: TASK_ID,
            schedule: '0 7 * * *',
            ...(legacy ? {} : { agentName: 'chm-babysit' }),
          },
        ],
      })}\n`,
    )

    const bin = join(state, 'herdr')
    // An upgraded desk: the finished manager is still registered under the
    // name every task used to share, in this task's own checkout.
    const agents = legacy
      ? '{"name":"chmonitor-desk","status":"done","pane_id":"p1","workspace_id":"wMgr","cwd":"/w/desk-local-babysit"}'
      : '{"name":"chm-babysit","status":"working"}'
    writeFileSync(
      bin,
      `#!/bin/sh
case "$1 $2" in
  "workspace list") echo '{"result":{"workspaces":[{"workspace_id":"wProj","cwd":"${repo}"}]}}' ;;
  "agent list") echo '{"result":{"agents":[${agents}]}}' ;;
  "agent prompt") printf '%s\n%s' "$3" "$4" > "${state}/prompted" ;;
  *) echo '{}' ;;
esac
`,
    )
    chmodSync(bin, 0o755)
    process.env.HERDR_BIN_PATH = bin
    const socket = join(state, 'herdr.sock')
    if (herdrDown) process.env.HERDR_SOCKET_PATH = join(state, 'gone.sock')
    else {
      writeFileSync(socket, '')
      process.env.HERDR_SOCKET_PATH = socket
    }
    return repo
  }

  afterEach(() => {
    for (const [k, v] of prevEnv) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    for (const dir of temps.splice(0))
      rmSync(dir, { recursive: true, force: true })
  })

  test('a run that reached its manager forgets the faults it had', async () => {
    // The dedupe must not outlive the fault it was written for. Without this
    // clear, a job that failed, recovered, and failed again the same way is
    // treated as repeating a fault that is already fixed — and the second
    // outage is silent.
    const repo = desk()
    recordAnnounced(repo, TASK_ID, FAULT)
    expect(shouldAnnounce(repo, TASK_ID, FAULT)).toBe(false)

    expect((await runTask({ repo })).prompted).toBe(true)
    expect(shouldAnnounce(repo, TASK_ID, FAULT)).toBe(true)
  })

  test('a job that never started keeps its faults held back', async () => {
    // Herdr being down is not recovery. Clearing on anything short of reaching
    // the manager would hand every standing fault on the machine back its first
    // notice on every tick — the exact repetition this dedupe exists to stop.
    const repo = desk(true)
    recordAnnounced(repo, TASK_ID, FAULT)

    expect((await runTask({ repo })).skipped).toContain('socket')
    expect(shouldAnnounce(repo, TASK_ID, FAULT)).toBe(false)
  })

  const lockOf = (repo: string) =>
    join(repo, '.herdr-desk', 'runs', 'local-babysit', 'spawn.lock')

  test('a second fire while one holds the claim does not prompt again', async () => {
    const repo = desk()
    mkdirSync(join(repo, '.herdr-desk', 'runs', 'local-babysit'), {
      recursive: true,
    })
    writeFileSync(
      lockOf(repo),
      JSON.stringify({ pid: process.pid, at: Date.now() }),
    )
    const result = await runTask({ repo })
    expect(result.prompted).toBeUndefined()
    expect(result.skipped).toContain('already prompting or spawning')
    // The holder's lock is not ours to remove.
    expect(readFileSync(lockOf(repo), 'utf8')).toContain(`${process.pid}`)
  })

  test('an upgraded desk re-prompts its old session, and tells it its real name', async () => {
    const repo = desk(false, true)
    expect((await runTask({ repo })).prompted).toBe(true)
    const state = process.env.HERDR_PLUGIN_STATE_DIR as string
    const [name, ...prompt] = readFileSync(
      join(state, 'prompted'),
      'utf8',
    ).split('\n')
    expect(name).toBe('chmonitor-desk')
    // Children report to this name; the new default would reach nobody.
    expect(prompt.join('\n')).toContain('Your Herdr name: chmonitor-desk\n')
  })

  test('a finished fire releases its claim so the next one can run', async () => {
    const repo = desk()
    expect((await runTask({ repo })).prompted).toBe(true)
    expect(() => statSync(lockOf(repo))).toThrow()
    expect((await runTask({ repo })).prompted).toBe(true)
  })
})

describe('assertOwnWorktree', () => {
  const t = (id: string) => ({ id }) as TaskConfig
  test('two tasks whose ids slug alike cannot share a manager checkout', () => {
    const a = t('local:babysit')
    expect(() => assertOwnWorktree([a, t('local-babysit')], a)).toThrow(
      /local-babysit/,
    )
  })
  test('distinct slugs pass', () => {
    const a = t('local:babysit')
    expect(() => assertOwnWorktree([a, t('local:prod')], a)).not.toThrow()
  })
})
