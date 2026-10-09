import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collectCard,
  DEFAULT_DASHBOARD_PORT,
  dashboardUrl,
  deskCard,
  parseInvocation,
  pickRepo,
  renderCard,
} from './deskCard'

/** A throwaway repo dir, removed by the caller's after(). */
function repo(config?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'desk-card-'))
  dirs.push(dir)
  if (config !== undefined) {
    writeFileSync(join(dir, '.herdr-desk.json'), JSON.stringify(config))
  }
  return dir
}

const dirs: string[] = []

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

// Shaped against herdr-desk.schema.json: `schedule`, not `crons` — the task
// object is `additionalProperties: false`, so a plausible-looking wrong key is
// a hard validation failure and the card renders the config as unreadable.
const okConfig = {
  name: 'myrepo',
  tasks: [
    {
      id: 'desk:github-issues',
      agent: { ladder: ['grok'], permission: 'default' },
      schedule: ['0 7 * * *'],
      maxChildren: 3,
    },
  ],
}

describe('parseInvocation', () => {
  test('reads the workspace and its worktree from the context JSON', () => {
    const inv = parseInvocation({
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        workspace_id: 'ws-7',
        workspace_label: 'myrepo',
        workspace_cwd: '/src/myrepo',
        worktree: {
          repo_root: '/src/myrepo',
          checkout_path: '/src/wt/feat-x',
          is_linked_worktree: true,
        },
        invocation_source: 'keybind',
      }),
    })
    expect(inv).toEqual({
      workspaceId: 'ws-7',
      workspaceLabel: 'myrepo',
      workspaceCwd: '/src/myrepo',
      repoRoot: '/src/myrepo',
      checkoutPath: '/src/wt/feat-x',
      linkedWorktree: true,
      branch: undefined,
      tabId: undefined,
      paneId: undefined,
      paneAgent: undefined,
      paneStatus: undefined,
      source: 'keybind',
    })
  })

  test('falls back to HERDR_WORKSPACE_ID when the JSON is unusable', () => {
    for (const bad of ['', 'not json', '[]', 'null']) {
      expect(
        parseInvocation({
          HERDR_PLUGIN_CONTEXT_JSON: bad,
          HERDR_WORKSPACE_ID: 'ws-9',
        }).workspaceId,
      ).toBe('ws-9')
    }
  })

  test('no env at all is empty, not a throw', () => {
    expect(parseInvocation({}).workspaceId).toBeUndefined()
  })

  test('never copies selected text or the clicked URL', () => {
    // Both are in Herdr's context JSON. `selected_text` is whatever the user had
    // selected in the pane; a card that echoed it would put terminal content
    // into a plugin log or a screenshot.
    const inv = parseInvocation({
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        workspace_id: 'ws-1',
        selected_text: 'AWS_SECRET_ACCESS_KEY=hunter2',
        clicked_url: 'https://example.com/?token=abc123',
      }),
    })
    const printed = JSON.stringify(inv)
    expect(printed).not.toContain('hunter2')
    expect(printed).not.toContain('abc123')
    expect(inv.workspaceId).toBe('ws-1')
  })

  test('ignores unknown fields instead of carrying them', () => {
    const inv = parseInvocation({
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        workspace_id: 'ws-1',
        some_future_herdr_field: 'should not be here',
      }),
    })
    expect(Object.keys(inv)).not.toContain('some_future_herdr_field')
  })
})

describe('pickRepo', () => {
  test('prefers a linked worktree checkout over the main repo root', () => {
    const wt = repo(okConfig)
    const main = repo(okConfig)
    expect(
      pickRepo({
        checkoutPath: wt,
        repoRoot: main,
        linkedWorktree: true,
      }),
    ).toEqual({ repo: wt, via: 'checkout', linkedWorktree: true })
  })

  test('falls back to repo root when the worktree checkout is gone', () => {
    const main = repo(okConfig)
    const pick = pickRepo({
      checkoutPath: join(main, 'deleted-worktree'),
      repoRoot: main,
      linkedWorktree: true,
    })
    expect(pick.repo).toBe(main)
    // Still reported as a worktree even though it resolved to the main checkout:
    // the card says which workspace it was invoked for, separately from where
    // the config was found.
    expect(pick.linkedWorktree).toBe(true)
  })

  test('falls back to cwd when the context names nothing on disk', () => {
    const here = repo(okConfig)
    expect(pickRepo({}, here)).toEqual({
      repo: here,
      via: 'cwd-fallback',
      linkedWorktree: false,
    })
  })

  test('an unconfigured workspace still names the directory it checked', () => {
    const bare = repo()
    // An explicit cwd, so the assertion is about the checkout candidate winning
    // over the process directory the test happens to run in.
    expect(pickRepo({ checkoutPath: bare }, '/nowhere-at-all')).toEqual({
      repo: bare,
      via: 'checkout',
      linkedWorktree: false,
    })
  })
})

describe('renderCard', () => {
  const now = new Date('2026-03-04T09:00:00Z')

  function card(over: Partial<Parameters<typeof collectCard>[1]> = {}) {
    const dir = repo(okConfig)
    return renderCard(
      collectCard(
        { workspaceLabel: 'myrepo', checkoutPath: dir },
        {
          cwd: dir,
          probe: null,
          pid: 4242,
          now,
          ...over,
        },
      ),
    )
  }

  test('shows the config path and every job', () => {
    const dir = repo(okConfig)
    const text = card({ override: dir })
    expect(text).toContain(join(dir, '.herdr-desk.json'))
    expect(text).toContain('desk:github-issues')
    expect(text).toContain('0 7 * * *')
    expect(text).toContain('grok')
  })

  test('shows the next fire and the daemon pid', () => {
    const text = card()
    expect(text).toContain('2026-03-05 07:00')
    expect(text).toContain('running (pid 4242)')
  })

  test('says stopped, not running, when there is no pid', () => {
    const dir = repo(okConfig)
    expect(card({ override: dir, pid: null })).toContain('daemon     stopped')
  })

  test('reports a dashboard URL with no promise when nothing is listening', () => {
    const dir = repo(okConfig)
    const data = collectCard({ checkoutPath: dir }, { cwd: dir, pid: 1, now })
    const text = renderCard({ ...data, dashboardUp: false })
    expect(text).toContain(dashboardUrl())
    expect(text).toContain('nothing listening')
    expect(text).toContain('desk serve')
  })

  test('says listening when the probe succeeded', () => {
    const dir = repo(okConfig)
    const data = collectCard({ checkoutPath: dir }, { cwd: dir, pid: 1, now })
    expect(renderCard({ ...data, dashboardUp: true })).toContain('(listening)')
  })

  test('an unchecked dashboard is labelled unchecked, not dead', () => {
    const dir = repo(okConfig)
    const data = collectCard({ checkoutPath: dir }, { cwd: dir, pid: 1, now })
    expect(renderCard(data)).toContain('not checked')
  })

  test('an unconfigured repo says so and names the directory checked', () => {
    const bare = repo()
    const text = renderCard(
      collectCard({ checkoutPath: bare }, { cwd: bare, pid: 1, now }),
    )
    expect(text).toContain(`config  none in ${bare}`)
    expect(text).toContain('not scheduled')
    // No invented config path.
    expect(text).not.toContain('.herdr-desk.json —')
  })

  test('a malformed config is reported as unreadable, not as absent', () => {
    const dir = repo()
    writeFileSync(join(dir, '.herdr-desk.json'), '{ "name": 42 }')
    const text = renderCard(
      collectCard({ checkoutPath: dir }, { cwd: dir, pid: 1, now }),
    )
    expect(text).toContain('unreadable')
    // "none in <dir>" is the unscheduled case; saying it here would report a
    // broken repo as an unscheduled one, which is a different fix.
    expect(text).not.toContain('not scheduled')
  })

  test('names the worktree and the invocation source it was given', () => {
    const dir = repo(okConfig)
    const text = renderCard(
      collectCard(
        {
          workspaceLabel: 'myrepo',
          checkoutPath: dir,
          linkedWorktree: true,
          source: 'keybind',
        },
        { cwd: dir, pid: 1, now },
      ),
    )
    expect(text).toContain('linked worktree')
    expect(text).toContain('via keybind')
    expect(text).toContain('repo from  checkout')
  })

  test('says so when there is no workspace context at all', () => {
    const dir = repo(okConfig)
    const text = renderCard(collectCard({}, { cwd: dir, pid: 1, now }))
    expect(text).toContain('(no workspace context)')
  })
})

describe('deskCard', () => {
  test('--repo overrides the invocation context', async () => {
    const here = repo(okConfig)
    const elsewhere = repo(okConfig)
    const text = await deskCard(
      { checkoutPath: here, workspaceLabel: 'here' },
      { override: elsewhere, probe: null, pid: 1 },
    )
    expect(text).toContain(elsewhere)
    expect(text).not.toContain(here)
  })

  test('prints commands, never runs them', async () => {
    const dir = repo(okConfig)
    const text = await deskCard(
      { checkoutPath: dir },
      {
        override: dir,
        probe: null,
        pid: 1,
      },
    )
    // The card is safe to bind to a key precisely because it starts nothing.
    expect(text).toContain('desk status')
    expect(text).toContain('desk scan')
  })
})

describe('dashboardUrl', () => {
  test('defaults to the port serve binds', () => {
    expect(dashboardUrl()).toBe(`http://127.0.0.1:${DEFAULT_DASHBOARD_PORT}/`)
  })
})
