import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDaemon } from './daemon'
import { validateDeskJson } from './schema'
import {
  applyUpdate,
  autoUpdateEnabled,
  changelogLines,
  checkDue,
  checkForUpdate,
  compareVersions,
  installedVersion,
  loadCheckState,
  loadLastCheck,
  maybeAutoUpdate,
  parseSelfSource,
  releaseUpdateLock,
  saveLastCheck,
  takeUpdateLock,
  type UpdateCheck,
  updateLockHeld,
} from './update'

const prevState = process.env.HERDR_PLUGIN_STATE_DIR

beforeEach(() => {
  const dir = join(tmpdir(), `desk-update-${Date.now()}-${Math.random()}`)
  mkdirSync(dir, { recursive: true })
  process.env.HERDR_PLUGIN_STATE_DIR = dir
})

afterEach(() => {
  if (prevState === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR
  else process.env.HERDR_PLUGIN_STATE_DIR = prevState
})

const github = { kind: 'github', owner: 'duyet', repo: 'herdr-desk' }

function newer(over: Partial<UpdateCheck> = {}): UpdateCheck {
  return {
    installed: '0.1.6',
    latest: 'v0.1.7',
    newer: true,
    source: github,
    ...over,
  }
}

describe('compareVersions', () => {
  // String comparison would call 0.1.9 newer than 0.1.10 and never upgrade.
  test('compares numerically, not lexically', () => {
    expect(compareVersions('0.1.10', '0.1.9')).toBeGreaterThan(0)
    expect(compareVersions('0.2.0', '0.1.99')).toBeGreaterThan(0)
  })

  test('the v prefix of a release tag does not matter', () => {
    expect(compareVersions('v0.1.6', '0.1.6')).toBe(0)
    expect(compareVersions('v0.1.5', '0.1.6')).toBeLessThan(0)
  })

  // A bad tag must fail loud, not look "older" and silently skip.
  test('garbage throws', () => {
    expect(() => compareVersions('latest', '0.1.6')).toThrow()
  })

  test('the installed manifest has a parseable version', () => {
    expect(() => compareVersions(installedVersion(), '0.0.0')).not.toThrow()
  })
})

describe('checkForUpdate', () => {
  const deps = (source = github as Parameters<typeof parseSelfSource>[0]) => ({
    source: async () => source as typeof github,
    latest: async () => 'v0.2.0',
    installed: () => '0.1.6',
    notes: async () => [{ tag: 'v0.2.0', body: '* **notify:** shorter texts' }],
  })

  test('a local link is never applicable', async () => {
    const r = await checkForUpdate(deps({ kind: 'local' }))
    expect(r.newer).toBe(true)
    expect(r.blocked).toContain('local')
  })

  test('a pinned ref is never moved', async () => {
    const r = await checkForUpdate(deps({ ...github, requestedRef: 'v0.1.6' }))
    expect(r.blocked).toContain('pinned')
  })

  test('attaches a compact changelog when a release is newer', async () => {
    const r = await checkForUpdate(deps())
    expect(r.changes).toEqual(['0.2.0 notify: shorter texts'])
  })

  test('parses its own entry from herdr plugin list', () => {
    const src = parseSelfSource({
      result: {
        plugins: [
          { plugin_id: 'other', source: { kind: 'github' } },
          {
            plugin_id: 'herdr-desk',
            plugin_root: '/x',
            source: { kind: 'github', owner: 'duyet', repo: 'herdr-desk' },
          },
        ],
      },
    })
    expect(src).toEqual({
      ...github,
      requestedRef: undefined,
      pluginRoot: '/x',
    })
  })
})

describe('changelogLines', () => {
  const body = [
    '### Features',
    '',
    '* **notify:** write telegram notices like a short text ([20c6bff](https://github.com/duyet/herdr-desk/commit/20c6bff))',
    '* **cli:** add next, trigger, pause and resume ([#52](https://github.com/duyet/herdr-desk/issues/52)) ([750ccb7](https://github.com/duyet/herdr-desk/commit/750ccb7))',
    '',
    '### Bug Fixes',
    '',
    '* **daemon:** a signal-driven stop leaves a line ([#62](https://github.com/duyet/herdr-desk/issues/62)) ([d7a79af](https://github.com/duyet/herdr-desk/commit/d7a79af))',
  ].join('\n')

  test('keeps scope and subject, drops links, issues, and SHAs', () => {
    expect(changelogLines('0.1.6', [{ tag: 'v0.1.7', body }])).toEqual([
      '0.1.7 notify: write telegram notices like a short text',
      '0.1.7 cli: add next, trigger, pause and resume',
      '0.1.7 daemon: a signal-driven stop leaves a line',
    ])
  })

  test('skips the installed release and older ones', () => {
    expect(
      changelogLines('0.1.7', [
        { tag: 'v0.1.7', body },
        { tag: 'v0.1.6', body: '* **old:** stays out' },
      ]),
    ).toEqual([])
  })

  test('caps the list and counts the rest', () => {
    const many = Array.from({ length: 10 }, (_, i) => `* item ${i}`).join('\n')
    const lines = changelogLines('0.1.0', [{ tag: 'v0.1.1', body: many }], 3)
    expect(lines).toEqual([
      '0.1.1 item 0',
      '0.1.1 item 1',
      '0.1.1 item 2',
      '+7 more',
    ])
  })
})

describe('checkDue', () => {
  const now = new Date('2026-09-30T12:00:00Z')
  test('never checked, or unreadable stamp, is due', () => {
    expect(checkDue(null, now)).toBe(true)
    expect(checkDue('nonsense', now)).toBe(true)
  })
  test('at most once a day', () => {
    expect(checkDue('2026-09-30T00:00:01Z', now)).toBe(false)
    expect(checkDue('2026-09-29T12:00:00Z', now)).toBe(true)
  })
})

describe('maybeAutoUpdate', () => {
  const now = new Date('2026-09-30T12:00:00Z')

  test('a second call the same day does not hit GitHub', async () => {
    let checks = 0
    const check = async () => {
      checks++
      return newer({ newer: false })
    }
    expect(await maybeAutoUpdate({ now, check })).toBe('current')
    const later = new Date(now.getTime() + 60 * 60 * 1000)
    expect(await maybeAutoUpdate({ now: later, check })).toBe('not-due')
    expect(checks).toBe(1)
  })

  test('autoUpdate off: reports, never applies', async () => {
    let applied = false
    const r = await maybeAutoUpdate({
      now,
      enabled: false,
      check: async () => newer(),
      apply: async () => {
        applied = true
        return { ok: true }
      },
    })
    expect(r).toBe('available')
    expect(applied).toBe(false)
  })

  test('blocked source is never applied even when enabled', async () => {
    let applied = false
    const r = await maybeAutoUpdate({
      now,
      enabled: true,
      check: async () => newer({ blocked: 'installed as local' }),
      apply: async () => {
        applied = true
        return { ok: true }
      },
    })
    expect(r).toBe('blocked')
    expect(applied).toBe(false)
  })

  test('applies and notifies on upgrade', async () => {
    const sent: string[] = []
    const r = await maybeAutoUpdate({
      now,
      enabled: true,
      check: async () => newer(),
      apply: async () => ({ ok: true }),
      notify: async (m) => {
        sent.push(m)
      },
    })
    expect(r).toBe('updated')
    expect(sent).toEqual(['herdr-desk updated 0.1.6 -> v0.1.7'])
  })

  // Without the stamp, a failing install would retry and notify every tick.
  test('a failed apply notifies once and still records the check', async () => {
    const sent: string[] = []
    const r = await maybeAutoUpdate({
      now,
      enabled: true,
      check: async () => newer(),
      apply: async () => ({ ok: false, error: 'boom', rolledBack: true }),
      notify: async (m) => {
        sent.push(m)
      },
    })
    expect(r).toBe('failed')
    expect(sent[0]).toContain('rolled back to 0.1.6: boom')
    expect(loadLastCheck()).toBe(now.toISOString())
    expect(await maybeAutoUpdate({ now, check: async () => newer() })).toBe(
      'not-due',
    )
  })

  test('a failed check is non-fatal and still gated', async () => {
    const r = await maybeAutoUpdate({
      now,
      check: async () => {
        throw new Error('offline')
      },
    })
    expect(r).toBe('failed')
    expect(loadLastCheck()).toBe(now.toISOString())
  })

  test('stamp round-trips', () => {
    saveLastCheck(now, 'x')
    expect(loadLastCheck()).toBe(now.toISOString())
  })
})

describe('maybeAutoUpdate safety', () => {
  const now = new Date('2026-09-30T12:00:00Z')
  const nextDay = new Date(now.getTime() + 25 * 60 * 60 * 1000)

  // Ticks are 20s apart; a busy defer that hit GitHub would blow the
  // unauthenticated rate limit, and one that stamped would wait a day.
  test('waits for in-flight runs without checking or stamping', async () => {
    let checks = 0
    const r = await maybeAutoUpdate({
      now,
      enabled: true,
      busy: () => true,
      check: async () => {
        checks++
        return newer()
      },
    })
    expect(r).toBe('deferred')
    expect(checks).toBe(0)
    expect(loadLastCheck()).toBeNull()
    expect(
      await maybeAutoUpdate({
        now,
        enabled: true,
        busy: () => false,
        check: async () => newer(),
        apply: async () => ({ ok: true }),
      }),
    ).toBe('updated')
  })

  test('notify-only announces a version once, not every day', async () => {
    const sent: string[] = []
    const notify = async (m: string) => {
      sent.push(m)
    }
    const check = async () => newer()
    expect(await maybeAutoUpdate({ now, enabled: false, check, notify })).toBe(
      'available',
    )
    expect(
      await maybeAutoUpdate({ now: nextDay, enabled: false, check, notify }),
    ).toBe('available')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('herdr-desk upgrade')
  })

  test('a failed version is skipped later; a newer one still applies', async () => {
    let applies = 0
    const apply = async () => {
      applies++
      return { ok: false as const, error: 'boom', rolledBack: true }
    }
    expect(
      await maybeAutoUpdate({
        now,
        enabled: true,
        check: async () => newer(),
        apply,
      }),
    ).toBe('failed')
    expect(loadCheckState()?.rolledBackTo).toBe('v0.1.6')
    // The rollback pinned the install; that pin is ours, not the user's.
    const pinned = { ...github, requestedRef: 'v0.1.6' }
    const blocked = 'pinned to v0.1.6'
    expect(
      await maybeAutoUpdate({
        now: nextDay,
        enabled: true,
        check: async () => newer({ source: pinned, blocked }),
        apply,
      }),
    ).toBe('skipped')
    expect(applies).toBe(1)
    const later = new Date(nextDay.getTime() + 25 * 60 * 60 * 1000)
    expect(
      await maybeAutoUpdate({
        now: later,
        enabled: true,
        check: async () => newer({ latest: 'v0.1.8', source: pinned, blocked }),
        apply: async () => ({ ok: true }),
      }),
    ).toBe('updated')
    expect(loadCheckState()?.rolledBackTo).toBeUndefined()
  })

  test('a user pin still blocks', async () => {
    const r = await maybeAutoUpdate({
      now,
      enabled: true,
      check: async () =>
        newer({
          source: { ...github, requestedRef: 'v0.1.5' },
          blocked: 'pinned to v0.1.5',
        }),
      apply: async () => ({ ok: true }),
    })
    expect(r).toBe('blocked')
  })
})

describe('applyUpdate', () => {
  const src = { ...github, pluginRoot: '/p' }

  function fake(smoke: () => Promise<string>) {
    const installs: (string | undefined)[] = []
    return {
      installs,
      deps: {
        install: async (_s: unknown, ref?: string) => {
          installs.push(ref)
        },
        source: async () => src,
        smoke,
      },
    }
  }

  test('keeps the new version when it boots and reports it', async () => {
    const f = fake(async () => '0.1.7')
    expect(await applyUpdate(src, '0.1.6', 'v0.1.7', f.deps)).toEqual({
      ok: true,
    })
    expect(f.installs).toEqual([undefined])
  })

  // A tag whose manifest lags (or a tree that will not load) must not become
  // the code the daemon restarts onto.
  test('reinstalls the old tag when the new tree reports the wrong version', async () => {
    const f = fake(async () => '0.1.6')
    const r = await applyUpdate(src, '0.1.6', 'v0.1.7', f.deps)
    expect(r).toMatchObject({ ok: false, rolledBack: true })
    expect(f.installs).toEqual([undefined, 'v0.1.6'])
  })

  test('reinstalls the old tag when the new tree does not boot', async () => {
    const f = fake(async () => {
      throw new Error('SyntaxError')
    })
    const r = await applyUpdate(src, '0.1.6', 'v0.1.7', f.deps)
    expect(r).toMatchObject({ ok: false, rolledBack: true })
    expect(!r.ok && r.error).toContain('SyntaxError')
    expect(f.installs).toEqual([undefined, 'v0.1.6'])
  })
})

describe('autoUpdate config', () => {
  // Upgrades are safe (between runs, verified, rolled back), so on by default.
  test('defaults to on, off only when explicitly false', () => {
    expect(autoUpdateEnabled({})).toBe(true)
    expect(autoUpdateEnabled({ autoUpdate: true })).toBe(true)
    expect(autoUpdateEnabled({ autoUpdate: false })).toBe(false)
  })

  test('schema accepts a boolean and rejects anything else', () => {
    expect(validateDeskJson({ name: 'd', autoUpdate: false })).toEqual([])
    expect(validateDeskJson({ name: 'd', autoUpdate: 'no' })).toHaveLength(1)
  })
})

describe('update lock', () => {
  const now = new Date('2026-09-30T12:00:00Z')

  // A focus event mid-install must not start the old daemon.
  test('startDaemon refuses while an update holds the lock', () => {
    takeUpdateLock(new Date())
    expect(startDaemon()).toEqual({ updating: true, pid: 0 })
    releaseUpdateLock()
    expect(updateLockHeld()).toBe(false)
  })

  test('a lock older than 10 minutes is stale and no longer blocks', () => {
    takeUpdateLock(now)
    expect(updateLockHeld(new Date(now.getTime() + 9 * 60_000))).toBe(true)
    expect(updateLockHeld(new Date(now.getTime() + 10 * 60_000))).toBe(false)
  })
})
