import { describe, expect, test } from 'bun:test'
import { listedWorkspaces, pickPane, projectWorkspaceForRepo } from './herdr'

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
