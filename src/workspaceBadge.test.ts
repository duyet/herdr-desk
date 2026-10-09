import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadDeskConfig } from './config'
import type { Discovered, LoadFailure } from './discover'
import { listedWorkspaces } from './herdr'
import {
  BADGE_SOURCE,
  BADGE_TOKEN,
  badgeReportArgs,
  badgeValueForTaskCount,
  physicalCheckoutOf,
  planWorkspaceBadges,
  syncWorkspaceBadges,
} from './workspaceBadge'

const roots: string[] = []
afterEach(() => {
  while (roots.length)
    rmSync(roots.pop() as string, { recursive: true, force: true })
})

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `badge-${prefix}-`))
  roots.push(dir)
  return dir
}

function write(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function deskFor(repo: string, name: string, taskCount: number): Discovered {
  return {
    repo,
    configPath: join(repo, '.herdr-desk.json'),
    config: {
      name,
      tasks: Array.from({ length: taskCount }, (_, i) => ({
        id: `job:${i}`,
        playbook: 'github-issues',
        agentName: `${name}-desk`,
        agent: { ladder: ['grok'], permission: 'default' },
        crons: ['0 7 * * *'],
      })),
    } as Discovered['config'],
    source: 'workspace',
  }
}

function failedFor(repo: string): LoadFailure {
  return {
    repo,
    configPath: join(repo, '.herdr-desk.json'),
    error: "unknown field 'retries'",
    source: 'workspace',
  }
}

function wsList(items: Array<Record<string, unknown>>) {
  return listedWorkspaces({ result: { workspaces: items } })
}

describe('badge value', () => {
  test('N is the resolved task count, zero clears', () => {
    expect(badgeValueForTaskCount(1)).toBe('1')
    expect(badgeValueForTaskCount(3)).toBe('3')
    expect(badgeValueForTaskCount(0)).toBeNull()
  })
})

describe('exact CLI syntax', () => {
  test('set uses workspace id first, scoped source and desk token only', () => {
    expect(badgeReportArgs('w80', '3')).toEqual([
      'workspace',
      'report-metadata',
      'w80',
      '--source',
      BADGE_SOURCE,
      '--token',
      'desk=3',
    ])
    expect(BADGE_SOURCE).toBe('user:herdr-desk')
    expect(BADGE_TOKEN).toBe('desk')
  })

  test('clear uses --clear-token desk, never a label flag', () => {
    const args = badgeReportArgs('w80', null)
    expect(args).toEqual([
      'workspace',
      'report-metadata',
      'w80',
      '--source',
      'user:herdr-desk',
      '--clear-token',
      'desk',
    ])
    expect(args.join(' ')).not.toContain('rename')
    expect(args.join(' ')).not.toContain('label')
  })
})

describe('herdr list parsing for badges', () => {
  test('reads tokens.desk and linked worktree flag', () => {
    const listed = wsList([
      {
        workspace_id: 'w-main',
        label: 'myrepo',
        worktree: {
          repo_root: '/src/myrepo',
          checkout_path: '/src/myrepo',
          is_linked_worktree: false,
        },
        tokens: { desk: '2', other: 'keep' },
      },
      {
        workspace_id: 'w-child',
        label: 'fix',
        worktree: {
          repo_root: '/src/myrepo',
          checkout_path: '/wt/myrepo/fix',
          is_linked_worktree: true,
        },
        tokens: { desk: '9' },
      },
    ])
    expect(listed[0]?.tokens).toEqual({ desk: '2', other: 'keep' })
    expect(listed[0]?.isLinkedWorktree).toBeUndefined()
    expect(listed[1]?.isLinkedWorktree).toBe(true)
  })
})

describe('planning', () => {
  test('multiple jobs set N, not 1', () => {
    const repo = '/src/myrepo'
    const plans = planWorkspaceBadges(
      [deskFor(repo, 'myrepo', 3)],
      [],
      wsList([
        {
          workspace_id: 'w1',
          label: 'myrepo',
          cwd: repo,
          worktree: { repo_root: repo, checkout_path: repo },
        },
      ]),
    )
    expect(plans).toHaveLength(1)
    expect(plans[0]?.workspaceId).toBe('w1')
    expect(plans[0]?.desired).toBe('3')
  })

  test('inherited group config counts resolved tasks', () => {
    // Group defines two tasks; repo declares only a name. The fold keeps the
    // group's tasks wholesale, so the badge is 2, not the default 1.
    const home = tmp('home')
    const group = join(home, 'project')
    const repo = join(group, 'myrepo')
    mkdirSync(repo, { recursive: true })
    write(join(group, '.herdr-desk.json'), {
      name: 'fleet',
      group: true,
      tasks: [
        { id: 'desk:github-issues', schedule: '0 7 * * *' },
        { id: 'local:second', playbook: 'other.md', schedule: '0 8 * * *' },
      ],
    })
    write(join(repo, '.herdr-desk.json'), { name: 'myrepo' })
    const loaded = loadDeskConfig(repo)
    expect(loaded.tasks).toHaveLength(2)
    const plans = planWorkspaceBadges(
      [
        {
          repo,
          configPath: join(repo, '.herdr-desk.json'),
          config: loaded,
          source: 'workspace',
        },
      ],
      [],
      wsList([
        {
          workspace_id: 'w1',
          label: 'myrepo',
          worktree: { repo_root: repo, checkout_path: repo },
        },
      ]),
    )
    expect(plans[0]?.desired).toBe('2')
  })

  test('invalid config clears a stale badge', () => {
    const repo = '/src/bad'
    const plans = planWorkspaceBadges(
      [],
      [failedFor(repo)],
      wsList([
        {
          workspace_id: 'w1',
          cwd: repo,
          worktree: { repo_root: repo, checkout_path: repo },
          tokens: { desk: '2' },
        },
      ]),
    )
    expect(plans).toHaveLength(1)
    expect(plans[0]?.desired).toBeNull()
  })

  test('invalid config with no badge writes nothing', () => {
    const repo = '/src/bad'
    const plans = planWorkspaceBadges(
      [],
      [failedFor(repo)],
      wsList([
        {
          workspace_id: 'w1',
          cwd: repo,
          worktree: { repo_root: repo, checkout_path: repo },
        },
      ]),
    )
    expect(plans).toEqual([])
  })

  test('removed config clears a stale badge on an open project', () => {
    // No desk and no failure: the file is gone, but the Space is still open
    // holding the old count.
    const repo = '/src/gone'
    const plans = planWorkspaceBadges(
      [],
      [],
      wsList([
        {
          workspace_id: 'w1',
          cwd: repo,
          worktree: { repo_root: repo, checkout_path: repo },
          tokens: { desk: '1' },
        },
      ]),
    )
    expect(plans).toHaveLength(1)
    expect(plans[0]?.desired).toBeNull()
  })

  test('zero tasks clears instead of writing 0', () => {
    const repo = '/src/empty'
    const plans = planWorkspaceBadges(
      [deskFor(repo, 'empty', 0)],
      [],
      wsList([
        {
          workspace_id: 'w1',
          cwd: repo,
          worktree: { repo_root: repo, checkout_path: repo },
          tokens: { desk: '2' },
        },
      ]),
    )
    expect(plans[0]?.desired).toBeNull()
  })

  test('linked worktree child is never decorated', () => {
    const repo = '/src/app'
    const workspaces = wsList([
      {
        workspace_id: 'w-main',
        label: 'app',
        cwd: repo,
        worktree: {
          repo_root: repo,
          checkout_path: repo,
          is_linked_worktree: false,
        },
      },
      {
        workspace_id: 'w-child',
        cwd: '/wt/app/fix',
        worktree: {
          repo_root: repo,
          checkout_path: '/wt/app/fix',
          is_linked_worktree: true,
        },
      },
    ])
    const plans = planWorkspaceBadges([deskFor(repo, 'app', 2)], [], workspaces)
    expect(plans.map((p) => p.workspaceId)).toEqual(['w-main'])
  })

  test('linked child holding a token is left alone', () => {
    const workspaces = wsList([
      {
        workspace_id: 'w-child',
        worktree: {
          repo_root: '/src/app',
          checkout_path: '/wt/app/fix',
          is_linked_worktree: true,
        },
        tokens: { desk: '9' },
      },
    ])
    expect(planWorkspaceBadges([], [], workspaces)).toEqual([])
  })

  test('unchanged badge writes nothing', () => {
    const repo = '/src/same'
    const at = (tokens?: Record<string, string>) =>
      wsList([
        {
          workspace_id: 'w1',
          cwd: repo,
          worktree: { repo_root: repo, checkout_path: repo },
          ...(tokens ? { tokens } : {}),
        },
      ])
    expect(
      planWorkspaceBadges([deskFor(repo, 'same', 2)], [], at({ desk: '2' })),
    ).toEqual([])
    // Other tokens do not matter: only desk is compared.
    expect(
      planWorkspaceBadges(
        [deskFor(repo, 'same', 2)],
        [],
        at({ desk: '2', other: 'keep' }),
      ),
    ).toEqual([])
    // A different count does write.
    expect(
      planWorkspaceBadges([deskFor(repo, 'same', 3)], [], at({ desk: '2' })),
    ).toHaveLength(1)
  })

  test('unchanged desk=2 survives the stale sweep through the full plan', () => {
    // Regression: want() skipped the write when current === desired, but the
    // final sweep only checked planned.has(wsId) — so every correctly-badged
    // Space was cleared again on the same tick. Matched IDs must be claimed
    // even when no write is needed.
    const repo = '/src/kept'
    const other = '/src/stale'
    const plans = planWorkspaceBadges(
      [deskFor(repo, 'kept', 2)],
      [],
      wsList([
        {
          workspace_id: 'w-kept',
          cwd: repo,
          worktree: { repo_root: repo, checkout_path: repo },
          tokens: { desk: '2' },
        },
        {
          workspace_id: 'w-stale',
          cwd: other,
          worktree: { repo_root: other, checkout_path: other },
          tokens: { desk: '1' },
        },
      ]),
    )
    // The stale Space still clears, but the unchanged one is left alone —
    // never re-set and never cleared.
    expect(plans.map((p) => p.workspaceId)).toEqual(['w-stale'])
    expect(plans[0]?.desired).toBeNull()
  })

  test('config.repo override still matches the physical checkout', () => {
    // d.repo is the watch/state key (config.repo), which may point elsewhere;
    // the open project Space is dirname(configPath). Both are tried, so the
    // physical checkout is claimed even when the logical key matches nothing.
    const physical = '/src/checkout'
    const logical = '/data/state-elsewhere'
    const desk: Discovered = {
      ...deskFor(logical, 'app', 2),
      configPath: join(physical, '.herdr-desk.json'),
    }
    const unchanged = wsList([
      {
        workspace_id: 'w-phys',
        cwd: physical,
        worktree: { repo_root: physical, checkout_path: physical },
        tokens: { desk: '2' },
      },
    ])
    expect(planWorkspaceBadges([desk], [], unchanged)).toEqual([])
    const missing = wsList([
      {
        workspace_id: 'w-phys',
        cwd: physical,
        worktree: { repo_root: physical, checkout_path: physical },
      },
    ])
    const set = planWorkspaceBadges([desk], [], missing)
    expect(set).toHaveLength(1)
    expect(set[0]?.workspaceId).toBe('w-phys')
    expect(set[0]?.desired).toBe('2')
  })

  test('physical checkout strips ops/desk.json, not just dirname', () => {
    expect(physicalCheckoutOf('/src/app/.herdr-desk.json')).toBe('/src/app')
    expect(physicalCheckoutOf('/src/app/herdr-desk.json')).toBe('/src/app')
    // Regression: dirname gives /src/app/ops, which matches no workspace and
    // lets the stale sweep clear the badge every tick.
    expect(physicalCheckoutOf('/src/app/ops/desk.json')).toBe('/src/app')
  })

  test('config.repo override in ops/desk.json still matches the physical checkout', () => {
    const physical = '/src/checkout'
    const logical = '/data/state-elsewhere'
    const desk: Discovered = {
      ...deskFor(logical, 'app', 2),
      configPath: join(physical, 'ops', 'desk.json'),
    }
    const unchanged = wsList([
      {
        workspace_id: 'w-phys',
        cwd: physical,
        worktree: { repo_root: physical, checkout_path: physical },
        tokens: { desk: '2' },
      },
    ])
    expect(planWorkspaceBadges([desk], [], unchanged)).toEqual([])
    const missing = wsList([
      {
        workspace_id: 'w-phys',
        cwd: physical,
        worktree: { repo_root: physical, checkout_path: physical },
      },
    ])
    const set = planWorkspaceBadges([desk], [], missing)
    expect(set).toHaveLength(1)
    expect(set[0]?.workspaceId).toBe('w-phys')
    expect(set[0]?.desired).toBe('2')
  })

  test('workspaces with no path are not project candidates', () => {
    const plans = planWorkspaceBadges(
      [deskFor('/src/x', 'x', 1)],
      [],
      wsList([{ workspace_id: 'w1', label: 'x' }]),
    )
    expect(plans).toEqual([])
  })
})

describe('sync fail-open', () => {
  test('a list failure resolves with errors, never throws', async () => {
    const r = await syncWorkspaceBadges([], [], {
      listWorkspaces: async () => {
        throw new Error('herdr socket missing')
      },
      report: async () => {
        throw new Error('must not be called')
      },
    })
    expect(r.errors).toHaveLength(1)
    expect(r.updated).toBe(0)
    expect(r.cleared).toBe(0)
  })

  test('one report failure does not stop the next workspace', async () => {
    const seen: Array<{ id: string; v: string | null }> = []
    const r = await syncWorkspaceBadges(
      [deskFor('/src/a', 'a', 1), deskFor('/src/b', 'b', 2)],
      [],
      {
        listWorkspaces: async () =>
          wsList([
            {
              workspace_id: 'wa',
              cwd: '/src/a',
              worktree: { repo_root: '/src/a', checkout_path: '/src/a' },
            },
            {
              workspace_id: 'wb',
              cwd: '/src/b',
              worktree: { repo_root: '/src/b', checkout_path: '/src/b' },
            },
          ]),
        report: async (id, v) => {
          seen.push({ id, v })
          if (id === 'wa') throw new Error('boom')
        },
      },
    )
    expect(seen.map((s) => s.id).sort()).toEqual(['wa', 'wb'])
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toContain('wa')
    expect(r.updated).toBe(1)
  })

  test('only changed workspaces are reported', async () => {
    const seen: string[] = []
    const r = await syncWorkspaceBadges([deskFor('/src/a', 'a', 2)], [], {
      listWorkspaces: async () =>
        wsList([
          {
            workspace_id: 'wa',
            cwd: '/src/a',
            worktree: { repo_root: '/src/a', checkout_path: '/src/a' },
            tokens: { desk: '2' },
          },
        ]),
      report: async (id) => {
        seen.push(id)
      },
    })
    expect(seen).toEqual([])
    expect(r.updated).toBe(0)
    expect(r.errors).toEqual([])
  })
})
