import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyCleanup,
  type CleanupDesk,
  formatCleanup,
  type PrInfo,
  type Probe,
  parseWorktrees,
  planCleanup,
  realProbe,
} from './cleanup'
import type { TaskConfig } from './config'
import type { ListedAgent } from './herdr'
import { childBranch } from './run'

const NOW = new Date('2026-09-30T12:00:00')
const dirs: string[] = []

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'desk-cleanup-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function task(id = 'local:babysit'): TaskConfig {
  return {
    id,
    playbook: 'github-issues',
    agentName: 'x-desk',
    agent: { ladder: ['grok'], permission: 'default' },
    crons: ['0 7 * * *'],
    stateDir: `.herdr-desk/runs/${id.replace(':', '-')}`,
  } as TaskConfig
}

function runDir(repo: string, day: string, spawn?: object): string {
  const dir = join(repo, '.herdr-desk/runs/local-babysit', day)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'report.md'), 'x')
  if (spawn) writeFileSync(join(dir, 'spawn.json'), JSON.stringify(spawn))
  return dir
}

const noProbe: Probe = {
  worktrees: async () => [],
  branches: async () => [],
  pr: async () => null,
  isDirty: async () => false,
  headOnRemote: async () => true,
  headWithin: async () => true,
  agents: async () => [],
}

function desk(repo: string): CleanupDesk[] {
  return [{ repo, tasks: [task()] }]
}

describe('run dirs', () => {
  test('lists the dir older than 14 days and keeps the new one', async () => {
    const repo = tmp()
    const old = runDir(repo, '2026-09-10')
    const fresh = runDir(repo, '2026-09-25')
    const plan = await planCleanup(desk(repo), noProbe, NOW)
    const listed = plan.items.map((i) => (i.kind === 'rundir' ? i.path : ''))
    expect(listed).toContain(old)
    expect(listed).not.toContain(fresh)
  })

  test('the day LATEST points at is never listed, however old', async () => {
    const repo = tmp()
    const old = runDir(repo, '2026-08-01')
    writeFileSync(
      join(repo, '.herdr-desk/runs/local-babysit/LATEST'),
      'local:babysit/2026-08-01\n',
    )
    const plan = await planCleanup(desk(repo), noProbe, NOW)
    expect(plan.items).toEqual([])
    expect(plan.kept.map((k) => k.what)).toContain(old)
  })

  test('non-day entries in the state dir are left alone', async () => {
    const repo = tmp()
    runDir(repo, '2026-09-01')
    mkdirSync(join(repo, '.herdr-desk/runs/local-babysit/notes'))
    const plan = await planCleanup(desk(repo), noProbe, NOW)
    expect(plan.items).toHaveLength(1)
  })

  test('dry run removes nothing; apply removes only the listed dir', async () => {
    const repo = tmp()
    const old = runDir(repo, '2026-09-10')
    const fresh = runDir(repo, '2026-09-25')
    const plan = await planCleanup(desk(repo), noProbe, NOW)
    expect(existsSync(old)).toBe(true)
    // A dir that appears after the plan was made is not in it.
    const late = runDir(repo, '2026-09-11')
    await applyCleanup(plan)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(late)).toBe(true)
  })
})

describe('worktrees', () => {
  const wt = (path: string, branch: string, locked = false) => ({
    path,
    branch,
    locked,
    main: false,
  })

  function probe(over: Partial<Probe> & { pr?: Probe['pr'] }): Probe {
    return {
      ...noProbe,
      worktrees: async () => [
        { path: '/r', branch: 'main', locked: false, main: true },
        wt('/r/w', 'desk/local-babysit'),
      ],
      ...over,
    }
  }

  const pr =
    (info: PrInfo | null): Probe['pr'] =>
    async () =>
      info

  async function listed(p: Probe): Promise<string[]> {
    const plan = await planCleanup([{ repo: '/r', tasks: [] }], p, NOW)
    return plan.items.map((i) => (i.kind === 'worktree' ? i.path : ''))
  }

  test('a merged PR with clean, pushed work is listed', async () => {
    expect(await listed(probe({ pr: pr({ state: 'MERGED' }) }))).toEqual([
      '/r/w',
    ])
  })

  test('a closed PR with pushed work is listed', async () => {
    expect(await listed(probe({ pr: pr({ state: 'CLOSED' }) }))).toEqual([
      '/r/w',
    ])
  })

  test('an open PR is never listed', async () => {
    expect(await listed(probe({ pr: pr({ state: 'OPEN' }) }))).toEqual([])
  })

  test('no PR, or a PR that cannot be read, is never listed', async () => {
    expect(await listed(probe({ pr: pr(null) }))).toEqual([])
  })

  test('uncommitted changes are never listed', async () => {
    const p = probe({ pr: pr({ state: 'MERGED' }), isDirty: async () => true })
    expect(await listed(p)).toEqual([])
  })

  test('commits on no remote and outside the merged head are never listed', async () => {
    const p = probe({
      pr: pr({ state: 'MERGED', headOid: 'abc' }),
      headOnRemote: async () => false,
      headWithin: async () => false,
    })
    expect(await listed(p)).toEqual([])
  })

  test('a squash-merged branch is listed when HEAD is inside the PR head', async () => {
    const p = probe({
      pr: pr({ state: 'MERGED', headOid: 'abc' }),
      headOnRemote: async () => false,
      headWithin: async () => true,
    })
    expect(await listed(p)).toEqual(['/r/w'])
  })

  test('a closed PR never trusts the PR head, only a remote', async () => {
    const p = probe({
      pr: pr({ state: 'CLOSED', headOid: 'abc' }),
      headOnRemote: async () => false,
      headWithin: async () => true,
    })
    expect(await listed(p)).toEqual([])
  })

  test('locked, live-agent and non-desk worktrees are never listed', async () => {
    const merged = pr({ state: 'MERGED' })
    const locked = probe({
      pr: merged,
      worktrees: async () => [
        { path: '/r', branch: 'main', locked: false, main: true },
        wt('/r/w', 'desk/a', true),
      ],
    })
    expect(await listed(locked)).toEqual([])

    const live = probe({
      pr: merged,
      agents: async () => [{ name: 'a', cwd: '/r/w', status: 'idle' }],
    })
    // The cwd must exist for an agent to count as live.
    const here = tmp()
    const liveHere = probe({
      pr: merged,
      worktrees: async () => [
        { path: '/r', branch: 'main', locked: false, main: true },
        wt(here, 'desk/a'),
      ],
      agents: async () => [{ name: 'a', cwd: here, status: 'working' }],
    })
    expect(await listed(liveHere)).toEqual([])
    expect(await listed(live)).toEqual(['/r/w'])

    const feature = probe({
      pr: merged,
      worktrees: async () => [
        { path: '/r', branch: 'main', locked: false, main: true },
        wt('/r/f', 'feat/mine'),
      ],
    })
    expect(await listed(feature)).toEqual([])
  })

  test('parses git worktree --porcelain', () => {
    const out = parseWorktrees(
      [
        'worktree /r',
        'HEAD aaa',
        'branch refs/heads/main',
        '',
        'worktree /r/w',
        'HEAD bbb',
        'branch refs/heads/desk/x',
        'locked why',
        '',
        'worktree /r/d',
        'HEAD ccc',
        'detached',
        'prunable gitdir file points to non-existent location',
        '',
      ].join('\n'),
    )
    expect(out).toEqual([
      {
        path: '/r',
        branch: 'main',
        head: 'aaa',
        locked: false,
        prunable: false,
        main: true,
      },
      {
        path: '/r/w',
        branch: 'desk/x',
        head: 'bbb',
        locked: true,
        prunable: false,
        main: false,
      },
      {
        path: '/r/d',
        branch: undefined,
        head: 'ccc',
        locked: false,
        prunable: true,
        main: false,
      },
    ])
  })
})

/** Real git: an unpushed worktree must survive a real cleanup. */
describe('worktrees on disk', () => {
  const git = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], { cwd, stderr: 'pipe' })
    if (r.exitCode !== 0) throw new Error(r.stderr.toString())
    return r.stdout.toString().trim()
  }

  function setup(branch = 'desk/x'): { repo: string; wt: string } {
    const root = tmp()
    const origin = join(root, 'origin.git')
    const repo = join(root, 'repo')
    git(root, 'init', '--bare', '-b', 'main', origin)
    git(root, 'clone', origin, repo)
    git(repo, 'config', 'user.email', 't@t')
    git(repo, 'config', 'user.name', 't')
    writeFileSync(join(repo, 'a'), '1')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'init')
    git(repo, 'push', 'origin', 'main')
    const wt = join(root, 'desk-x')
    git(repo, 'worktree', 'add', '-b', branch, wt)
    git(wt, 'config', 'user.email', 't@t')
    git(wt, 'config', 'user.name', 't')
    return { repo, wt }
  }

  // GitHub is faked: the PR is merged, but with a head this worktree is not in.
  const merged: Probe = {
    ...realProbe,
    pr: async () => ({ state: 'MERGED', headOid: 'deadbeef' }),
    agents: async () => [],
  }

  test('an unpushed commit keeps the worktree, even under a merged PR', async () => {
    const { repo, wt } = setup()
    writeFileSync(join(wt, 'b'), '2')
    git(wt, 'add', '.')
    git(wt, 'commit', '-m', 'unpushed work')
    const plan = await planCleanup([{ repo, tasks: [] }], merged, NOW)
    expect(plan.items).toEqual([])
    await applyCleanup(plan)
    expect(existsSync(wt)).toBe(true)
  })

  test('an uncommitted change keeps the worktree', async () => {
    const { repo, wt } = setup()
    writeFileSync(join(wt, 'b'), 'wip')
    const plan = await planCleanup([{ repo, tasks: [] }], merged, NOW)
    expect(plan.items).toEqual([])
    expect(existsSync(wt)).toBe(true)
  })

  test('a clean worktree at a pushed commit is listed, then removed', async () => {
    const { repo, wt } = setup()
    const plan = await planCleanup([{ repo, tasks: [] }], merged, NOW)
    expect(plan.items.map((i) => i.kind)).toEqual(['worktree', 'branch'])
    expect(formatCleanup(plan, true)).toContain('would remove 2')
    expect(existsSync(wt)).toBe(true)
    const result = await applyCleanup(plan)
    expect(result.failed).toEqual([])
    expect(existsSync(wt)).toBe(false)
  })

  test('a merged PR removes the worktree and then its branch, and a second run finds nothing', async () => {
    const { repo, wt } = setup()
    const plan = await planCleanup([{ repo, tasks: [] }], merged, NOW)
    expect(plan.items.map((i) => i.kind)).toEqual(['worktree', 'branch'])
    expect((await applyCleanup(plan)).failed).toEqual([])
    expect(existsSync(wt)).toBe(false)
    expect(git(repo, 'branch', '--list', 'desk/x')).toBe('')
    const again = await planCleanup([{ repo, tasks: [] }], merged, NOW)
    expect(again.items).toEqual([])
    expect((await applyCleanup(again)).failed).toEqual([])
  })

  test('a closed, unmerged PR removes the pushed worktree but keeps the branch', async () => {
    const { repo, wt } = setup()
    const closed = { ...merged, pr: async () => ({ state: 'CLOSED' }) }
    const plan = await planCleanup([{ repo, tasks: [] }], closed, NOW)
    expect(plan.items.map((i) => i.kind)).toEqual(['worktree'])
    await applyCleanup(plan)
    expect(existsSync(wt)).toBe(false)
    expect(git(repo, 'branch', '--list', 'desk/x')).toContain('desk/x')
  })

  test('an orphan branch with unmerged commits is kept', async () => {
    const { repo, wt } = setup()
    writeFileSync(join(wt, 'b'), '2')
    git(wt, 'add', '.')
    git(wt, 'commit', '-m', 'unpushed work')
    git(repo, 'worktree', 'remove', wt)
    const plan = await planCleanup([{ repo, tasks: [] }], merged, NOW)
    expect(plan.items).toEqual([])
    expect(plan.kept.map((k) => k.what)).toContain('branch desk/x')
    await applyCleanup(plan)
    expect(git(repo, 'branch', '--list', 'desk/x')).toContain('desk/x')
  })

  test('an orphan branch with no PR is kept', async () => {
    const { repo, wt } = setup()
    git(repo, 'worktree', 'remove', wt)
    const none = { ...merged, pr: async () => null }
    const plan = await planCleanup([{ repo, tasks: [] }], none, NOW)
    expect(plan.items).toEqual([])
    expect(git(repo, 'branch', '--list', 'desk/x')).toContain('desk/x')
  })

  test('a branch that moved after the plan is kept', async () => {
    const { repo, wt } = setup()
    git(repo, 'worktree', 'remove', wt)
    const plan = await planCleanup([{ repo, tasks: [] }], merged, NOW)
    expect(plan.items.map((i) => i.kind)).toEqual(['branch'])
    // New work lands on the branch between dry run and apply.
    const tip = git(
      repo,
      'commit-tree',
      '-p',
      'desk/x',
      '-m',
      'late',
      'desk/x^{tree}',
    )
    git(repo, 'update-ref', 'refs/heads/desk/x', tip)
    const result = await applyCleanup(plan)
    expect(result.failed).toHaveLength(1)
    expect(git(repo, 'rev-parse', 'desk/x')).toBe(tip)
  })

  test('a branch checked out in a worktree that is kept is never deleted', async () => {
    const { repo, wt } = setup()
    writeFileSync(join(wt, 'b'), 'wip')
    const plan = await planCleanup([{ repo, tasks: [] }], merged, NOW)
    expect(plan.items).toEqual([])
    expect(git(repo, 'branch', '--list', 'desk/x')).toContain('desk/x')
  })
})

describe('child worktrees on disk', () => {
  const git = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], { cwd, stderr: 'pipe' })
    if (r.exitCode !== 0) throw new Error(r.stderr.toString())
    return r.stdout.toString().trim()
  }
  const child = childBranch(task(), 'issue-42')

  function setup(branch = child): { repo: string; wt: string } {
    const root = tmp()
    const origin = join(root, 'origin.git')
    const repo = join(root, 'repo')
    git(root, 'init', '--bare', '-b', 'main', origin)
    git(root, 'clone', origin, repo)
    git(repo, 'config', 'user.email', 't@t')
    git(repo, 'config', 'user.name', 't')
    writeFileSync(join(repo, 'a'), '1')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'init')
    git(repo, 'push', 'origin', 'main')
    // The manager's own branch exists beside its children, as on a real desk.
    git(repo, 'branch', 'desk/local-babysit')
    const wt = join(root, 'child')
    git(repo, 'worktree', 'add', '-b', branch, wt)
    return { repo, wt }
  }

  const prs =
    (states: Record<string, string>): Probe['pr'] =>
    async (_repo, branch) =>
      states[branch] ? { state: states[branch], headOid: 'deadbeef' } : null
  const probe = (states: Record<string, string>): Probe => ({
    ...realProbe,
    pr: prs(states),
    agents: async () => [],
  })
  const desks = (repo: string) => [{ repo, tasks: [task()] }]
  const has = (repo: string, b: string) =>
    git(repo, 'branch', '--list', b) !== ''

  test('a merged child goes, worktree and branch, and a second run finds nothing', async () => {
    const { repo, wt } = setup()
    const p = probe({ [child]: 'MERGED' })
    const plan = await planCleanup(desks(repo), p, NOW)
    expect(plan.items.map((i) => i.kind)).toEqual(['worktree', 'branch'])
    expect((await applyCleanup(plan, [repo])).failed).toEqual([])
    expect(existsSync(wt)).toBe(false)
    expect(has(repo, child)).toBe(false)
    expect(has(repo, 'desk/local-babysit')).toBe(true)
    expect((await planCleanup(desks(repo), p, NOW)).items).toEqual([])
  })

  test('a child with unmerged commits keeps its worktree and branch', async () => {
    const { repo, wt } = setup()
    writeFileSync(join(wt, 'b'), '2')
    git(wt, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.')
    git(wt, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'wip')
    const plan = await planCleanup(
      desks(repo),
      probe({ [child]: 'MERGED' }),
      NOW,
    )
    expect(plan.items).toEqual([])
    await applyCleanup(plan, [repo])
    expect(existsSync(wt)).toBe(true)
    expect(has(repo, child)).toBe(true)
  })

  test('an unmerged child branch with no worktree is kept', async () => {
    const { repo, wt } = setup()
    git(repo, 'worktree', 'remove', wt)
    const plan = await planCleanup(desks(repo), probe({ [child]: 'OPEN' }), NOW)
    expect(plan.items).toEqual([])
    expect(plan.kept.map((k) => k.what)).toContain(`branch ${child}`)
  })

  test('a child branch that moved after the plan is kept', async () => {
    const { repo, wt } = setup()
    git(repo, 'worktree', 'remove', wt)
    const plan = await planCleanup(
      desks(repo),
      probe({ [child]: 'MERGED' }),
      NOW,
    )
    expect(plan.items.map((i) => i.kind)).toEqual(['branch'])
    const tip = git(
      repo,
      'commit-tree',
      '-p',
      child,
      '-m',
      'late',
      `${child}^{tree}`,
    )
    git(repo, 'update-ref', `refs/heads/${child}`, tip)
    expect((await applyCleanup(plan, [repo])).failed).toHaveLength(1)
    expect(git(repo, 'rev-parse', child)).toBe(tip)
  })

  test('a child branch checked out where work remains is never deleted', async () => {
    const { repo, wt } = setup()
    writeFileSync(join(wt, 'b'), 'wip')
    const plan = await planCleanup(
      desks(repo),
      probe({ [child]: 'MERGED' }),
      NOW,
    )
    expect(plan.items).toEqual([])
    expect(has(repo, child)).toBe(true)
  })

  test('a merged branch the desk did not name is never touched', async () => {
    const { repo, wt } = setup('fix/by-hand')
    const plan = await planCleanup(
      desks(repo),
      probe({ 'fix/by-hand': 'MERGED' }),
      NOW,
    )
    expect(plan.items).toEqual([])
    expect(existsSync(wt)).toBe(true)
  })

  test('a live agent working in a subdirectory keeps the child', async () => {
    const { repo, wt } = setup()
    mkdirSync(join(wt, 'src'))
    const p: Probe = {
      ...probe({ [child]: 'MERGED' }),
      agents: async () => [
        { name: 'kid', status: 'working', paneId: 'p1', cwd: join(wt, 'src') },
      ],
    }
    const plan = await planCleanup(desks(repo), p, NOW)
    expect(plan.items).toEqual([])
  })

  test('a done pane in a removed child closes before the worktree goes', async () => {
    const { repo, wt } = setup()
    const p: Probe = {
      ...probe({ [child]: 'MERGED' }),
      agents: async () => [
        { name: 'kid', status: 'done', paneId: 'p1', cwd: wt },
        { name: 'other', status: 'done', paneId: 'p2', cwd: `${wt}-sibling` },
      ],
    }
    const plan = await planCleanup(desks(repo), p, NOW)
    const panes = plan.items.filter((i) => i.kind === 'pane')
    expect(panes).toEqual([
      expect.objectContaining({ kind: 'pane', paneId: 'p1', agent: 'kid' }),
    ])
  })

  test('a done pane whose child directory was deleted closes; a working one stays', async () => {
    const { repo, wt } = setup()
    rmSync(wt, { recursive: true, force: true })
    const p: Probe = {
      ...probe({ [child]: 'OPEN' }),
      agents: async () => [
        { name: 'kid', status: 'done', paneId: 'p1', cwd: wt },
        { name: 'busy', status: 'working', paneId: 'p2', cwd: wt },
      ],
    }
    const plan = await planCleanup(desks(repo), p, NOW)
    expect(plan.items).toEqual([
      expect.objectContaining({ kind: 'pane', paneId: 'p1' }),
    ])
  })

  test('a deleted child directory is pruned, then its merged branch goes', async () => {
    const { repo, wt } = setup()
    rmSync(wt, { recursive: true, force: true })
    const p = probe({ [child]: 'MERGED' })
    const plan = await planCleanup(desks(repo), p, NOW)
    expect(plan.items.map((i) => i.kind)).toEqual(['branch'])
    expect((await applyCleanup(plan, [repo])).failed).toEqual([])
    expect(git(repo, 'worktree', 'list')).not.toContain(wt)
    expect(has(repo, child)).toBe(false)
    // Prune again with nothing left to prune.
    expect(
      (await applyCleanup({ items: [], kept: [], unavailable: [] }, [repo]))
        .failed,
    ).toEqual([])
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1)
  })
})

describe('claim locks', () => {
  const lockPath = (repo: string) =>
    join(repo, '.herdr-desk/runs/local-babysit/spawn.lock')

  test('a lock whose holder is gone is listed and removed', async () => {
    const repo = tmp()
    mkdirSync(join(repo, '.herdr-desk/runs/local-babysit'), { recursive: true })
    writeFileSync(lockPath(repo), JSON.stringify({ pid: 2 ** 22 + 7, at: 0 }))
    const plan = await planCleanup(desk(repo), noProbe, NOW)
    expect(plan.items.map((i) => i.kind)).toEqual(['lock'])
    await applyCleanup(plan)
    expect(existsSync(lockPath(repo))).toBe(false)
  })

  test('a lock held by a live, recent fire is kept', async () => {
    const repo = tmp()
    mkdirSync(join(repo, '.herdr-desk/runs/local-babysit'), { recursive: true })
    writeFileSync(
      lockPath(repo),
      JSON.stringify({ pid: process.pid, at: Date.now() }),
    )
    const plan = await planCleanup(desk(repo), noProbe, new Date())
    expect(plan.items).toEqual([])
  })
})

describe('panes', () => {
  const spawn = {
    agent: 'x-desk',
    paneId: 'p1',
    startedAt: '2026-09-01T07:00:00Z',
  }

  test('a done agent from an old run is listed', async () => {
    const repo = tmp()
    runDir(repo, '2026-09-01', spawn)
    const p = {
      ...noProbe,
      agents: async () => [
        { name: 'x-desk', paneId: 'p1', status: 'done', cwd: undefined },
      ],
    }
    const plan = await planCleanup(desk(repo), p, NOW)
    expect(plan.items.filter((i) => i.kind === 'pane')).toHaveLength(1)
  })

  test('a live agent, a recent run, or another pane is never listed', async () => {
    const repo = tmp()
    runDir(repo, '2026-09-01', spawn)
    const agentsOf = (a: ListedAgent[]): Probe => ({
      ...noProbe,
      agents: async () => a,
    })
    for (const agents of [
      [{ name: 'x-desk', paneId: 'p1', status: 'idle' }],
      [{ name: 'x-desk', paneId: 'p2', status: 'done' }],
      [],
    ]) {
      const plan = await planCleanup(desk(repo), agentsOf(agents), NOW)
      expect(plan.items.filter((i) => i.kind === 'pane')).toEqual([])
    }
    const recent = tmp()
    runDir(recent, '2026-09-29', {
      ...spawn,
      startedAt: '2026-09-29T07:00:00Z',
    })
    const plan = await planCleanup(
      desk(recent),
      agentsOf([{ name: 'x-desk', paneId: 'p1', status: 'done' }]),
      NOW,
    )
    expect(plan.items).toEqual([])
  })

  test('when Herdr cannot be asked, no pane is listed and it says so', async () => {
    const repo = tmp()
    runDir(repo, '2026-09-01', spawn)
    const plan = await planCleanup(
      desk(repo),
      { ...noProbe, agents: async () => null },
      NOW,
    )
    expect(plan.items.filter((i) => i.kind === 'pane')).toEqual([])
    expect(plan.unavailable).toHaveLength(1)
  })
})
