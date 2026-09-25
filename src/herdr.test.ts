import { describe, expect, test } from 'bun:test'
import {
  isAgentLive,
  listedWorkspaces,
  namedAgents,
  pickPane,
  projectWorkspaceForRepo,
} from './herdr'

describe('listedWorkspaces', () => {
  test('reads workspace_id, cwd, and worktree provenance', () => {
    const listed = listedWorkspaces({
      result: {
        workspaces: [
          {
            workspace_id: 'w1',
            cwd: '/src/app',
            worktree: { repo_root: '/src/app', checkout_path: '/src/app' },
          },
          {
            workspace_id: 'w2',
            cwd: '/wt/app/fix-ci',
            worktree: {
              repo_root: '/src/app',
              checkout_path: '/wt/app/fix-ci',
              parent_workspace_id: 'w1',
            },
          },
        ],
      },
    })
    expect(listed).toHaveLength(2)
    expect(listed[0]?.workspaceId).toBe('w1')
    expect(listed[1]?.parentWorkspaceId).toBe('w1')
  })
})

describe('projectWorkspaceForRepo', () => {
  test('returns the main checkout, not a worktree child', () => {
    const listed = listedWorkspaces({
      result: {
        workspaces: [
          {
            workspace_id: 'w-child',
            cwd: '/wt/app/fix',
            worktree: {
              repo_root: '/src/app',
              checkout_path: '/wt/app/fix',
              parent_workspace_id: 'w-main',
            },
          },
          {
            workspace_id: 'w-main',
            cwd: '/src/app',
            label: 'anyrouter',
            worktree: { repo_root: '/src/app', checkout_path: '/src/app' },
          },
        ],
      },
    })
    expect(
      projectWorkspaceForRepo(listed, { repo: '/src/app', name: 'anyrouter' })
        ?.workspaceId,
    ).toBe('w-main')
  })

  test('matches cwd when worktree provenance is missing', () => {
    const listed = listedWorkspaces({
      result: {
        workspaces: [{ workspace_id: 'w9', cwd: '/src/app' }],
      },
    })
    expect(
      projectWorkspaceForRepo(listed, { repo: '/src/app' })?.workspaceId,
    ).toBe('w9')
  })

  test('matches the open Space by label (chmonitor, anyrouter)', () => {
    const listed = listedWorkspaces({
      result: {
        workspaces: [
          { workspace_id: 'w-other', label: 'blog', cwd: '/src/blog' },
          {
            workspace_id: 'w-chm',
            label: 'chmonitor',
            cwd: '/home/box/src/chmonitor',
          },
        ],
      },
    })
    expect(
      projectWorkspaceForRepo(listed, {
        repo: '/workspace/chmonitor',
        name: 'chmonitor',
      })?.workspaceId,
    ).toBe('w-chm')
  })

  test('walks up from a child hit to the project Space', () => {
    const listed = listedWorkspaces({
      result: {
        workspaces: [
          {
            workspace_id: 'w-child',
            label: 'fix-ci',
            cwd: '/wt/chmonitor/fix-ci',
            worktree: {
              repo_root: '/src/chmonitor',
              checkout_path: '/wt/chmonitor/fix-ci',
              parent_workspace_id: 'w-chm',
            },
          },
          {
            workspace_id: 'w-chm',
            label: 'chmonitor',
            cwd: '/src/chmonitor',
          },
        ],
      },
    })
    expect(
      projectWorkspaceForRepo(listed, {
        repo: '/src/chmonitor',
        name: 'chmonitor',
      })?.workspaceId,
    ).toBe('w-chm')
  })
})

describe('pickPane', () => {
  test('reads tab create root_pane', () => {
    expect(
      pickPane({
        result: {
          tab: { tab_id: 'w1:t2', workspace_id: 'w1' },
          root_pane: { pane_id: 'w1:p3', workspace_id: 'w1' },
        },
      }),
    ).toEqual({ workspaceId: 'w1', paneId: 'w1:p3' })
  })
})

describe('namedAgents', () => {
  test('keeps only agents that carry an explicit name', () => {
    const rows = namedAgents({
      result: {
        agents: [
          { agent: 'opencode', agent_status: 'idle' },
          { name: 'chm-desk', agent: 'opencode', agent_status: 'working' },
        ],
      },
    })
    expect(rows.map((a) => a.name)).toEqual(['chm-desk'])
  })
})

describe('isAgentLive', () => {
  const live = { name: 'chm-desk', status: 'idle', cwd: '/wt' }

  test('idle and working sessions are live', () => {
    const exists = () => true
    expect(isAgentLive({ ...live, status: 'idle' }, exists)).toBe(true)
    expect(isAgentLive({ ...live, status: 'working' }, exists)).toBe(true)
  })

  test('a done session is not live — prompting it is a no-op', () => {
    // The regression: `done` counted as live, so the desk never re-prompted the
    // manager and forked a new worktree + session on every tick.
    expect(isAgentLive({ ...live, status: 'done' }, () => true)).toBe(false)
  })

  test('a session whose cwd is gone is not live', () => {
    // Worktree deleted underneath a still-listed session.
    expect(isAgentLive({ ...live, status: 'idle' }, () => false)).toBe(false)
  })

  test('an unknown status is not assumed live (fail closed)', () => {
    expect(isAgentLive({ ...live, status: 'weird' }, () => true)).toBe(false)
  })

  test('a session with no reported status and an existing cwd is live', () => {
    expect(isAgentLive({ name: 'chm-desk', cwd: '/wt' }, () => true)).toBe(true)
  })
})
