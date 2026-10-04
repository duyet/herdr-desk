import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDaemon } from './daemon'
import { validateDeskJson } from './schema'
import {
  autoUpdateEnabled,
  changelogLines,
  checkDue,
  checkForUpdate,
  compareVersions,
  installedVersion,
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
      apply: async () => {},
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
      apply: async () => {
        throw new Error('boom')
      },
      notify: async (m) => {
        sent.push(m)
      },
    })
    expect(r).toBe('failed')
    expect(sent[0]).toContain('failed: boom')
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

describe('autoUpdate config', () => {
  test('defaults to on, off only when explicitly false', () => {
    expect(autoUpdateEnabled({})).toBe(true)
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
