import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  compactUsage,
  countUsage,
  formatUsage,
  loadUsageSince,
  repoId,
  track,
  usagePath,
} from './usage'

let dir: string
const prev = process.env.HERDR_PLUGIN_STATE_DIR

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'usage-'))
  process.env.HERDR_PLUGIN_STATE_DIR = dir
})

afterEach(() => {
  if (prev === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR
  else process.env.HERDR_PLUGIN_STATE_DIR = prev
  rmSync(dir, { recursive: true, force: true })
})

const at = (iso: string) => new Date(iso)

test('track appends one stamped line per event and counts read them back', () => {
  track({ kind: 'command', command: 'status' }, at('2026-10-01T00:00:00Z'))
  track({ kind: 'command', command: 'status' }, at('2026-10-02T00:00:00Z'))
  track({ kind: 'command', command: 'run' }, at('2026-10-02T00:00:00Z'))
  track({ kind: 'run.started', repo: '/r', task: 't' })
  track({ kind: 'run.finished', repo: '/r', task: 't', outcome: 'ran', ms: 5 })
  track({ kind: 'child.spawned', repo: '/r', task: 't', agent: 'claude' })
  track({ kind: 'upgrade', target: 'duyet/herdr-desk' })

  const lines = readFileSync(usagePath(), 'utf8').trim().split('\n')
  expect(lines).toHaveLength(7)
  expect(JSON.parse(lines[0])).toEqual({
    kind: 'command',
    command: 'status',
    at: '2026-10-01T00:00:00.000Z',
  })

  const c = countUsage(loadUsageSince(at('2026-01-01T00:00:00Z')))
  expect(c).toEqual({
    commands: { status: 2, run: 1 },
    runsStarted: 1,
    runsFinished: 1,
    childrenSpawned: 1,
    upgrades: 1,
  })
  expect(formatUsage(c)).toBe(
    'local usage  3 commands · 1 runs started · 1 finished · 1 children spawned · 1 upgrades',
  )
})

test('since drops older events and a corrupt line does not lose the rest', () => {
  track({ kind: 'command', command: 'old' }, at('2026-01-01T00:00:00Z'))
  writeFileSync(usagePath(), '{not json\n', { flag: 'a' })
  track({ kind: 'command', command: 'new' }, at('2026-10-01T00:00:00Z'))
  const c = countUsage(loadUsageSince(at('2026-09-01T00:00:00Z')))
  expect(c.commands).toEqual({ new: 1 })
})

test('track never throws, even when the state dir cannot be written', () => {
  const file = join(dir, 'a-file')
  writeFileSync(file, '')
  process.env.HERDR_PLUGIN_STATE_DIR = join(file, 'nested')
  expect(() => track({ kind: 'command', command: 'x' })).not.toThrow()
})

test('nothing leaves the machine: track makes no network call', () => {
  const fetchSpy = spyOn(globalThis, 'fetch')
  try {
    track({ kind: 'command', command: 'status' })
    track({ kind: 'upgrade', target: 'x' })
    expect(fetchSpy).not.toHaveBeenCalled()
  } finally {
    fetchSpy.mockRestore()
  }
  const src = readFileSync(join(import.meta.dir, 'usage.ts'), 'utf8')
  expect(src).not.toMatch(
    /fetch\(|node:(http|https|net|dgram|tls)|WebSocket|Bun\.connect/,
  )
})

test('an empty log prints nothing rather than a row of zeros', () => {
  expect(formatUsage(countUsage([]))).toBe('')
})

test('a repo path never reaches disk, only a stable id', () => {
  const repo = '/home/alice/secret-project'
  track({ kind: 'run.started', repo, task: 't' })
  track({ kind: 'run.finished', repo, task: 't', outcome: 'ran', ms: 1 })
  track({ kind: 'child.spawned', repo, task: 't', agent: 'claude' })
  const raw = readFileSync(usagePath(), 'utf8')
  expect(raw).not.toContain('alice')
  expect(raw).not.toContain('secret-project')
  expect(raw).not.toContain('/home')
  const events = raw
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  for (const e of events) {
    expect(e.repo).toBeUndefined()
    expect(e.repoId).toBe(repoId(repo))
  }
  expect(repoId(repo)).toMatch(/^[0-9a-f]{12}$/)
  expect(repoId('/other')).not.toBe(repoId(repo))
})

test('events older than 90 days are dropped, newer ones kept', () => {
  writeFileSync(
    usagePath(),
    `${JSON.stringify({ kind: 'command', command: 'old', at: '2026-05-01T00:00:00.000Z' })}\n{bad\n`,
  )
  track({ kind: 'command', command: 'new' }, at('2026-10-01T00:00:00Z'))
  const c = countUsage(loadUsageSince(at('2000-01-01T00:00:00Z')))
  expect(c.commands).toEqual({ new: 1 })
})

test('compaction runs once per day and is idempotent', () => {
  track({ kind: 'command', command: 'a' }, at('2026-10-01T00:00:00Z'))
  const marker = join(dir, 'usage.compacted')
  expect(readFileSync(marker, 'utf8').trim()).toBe('2026-10-01')
  const before = readFileSync(usagePath(), 'utf8')
  compactUsage(at('2026-10-01T12:00:00Z'))
  expect(readFileSync(usagePath(), 'utf8')).toBe(before)

  writeFileSync(
    usagePath(),
    `${JSON.stringify({ kind: 'command', command: 'old', at: '2026-01-01T00:00:00.000Z' })}\n${before}`,
  )
  compactUsage(at('2026-10-01T13:00:00Z'))
  expect(readFileSync(usagePath(), 'utf8')).toContain('"old"')

  compactUsage(at('2026-10-02T00:00:00Z'))
  const once = readFileSync(usagePath(), 'utf8')
  expect(once).not.toContain('"old"')
  compactUsage(at('2026-10-02T00:00:00Z'))
  rmSync(marker)
  compactUsage(at('2026-10-02T00:00:00Z'))
  expect(readFileSync(usagePath(), 'utf8')).toBe(once)
  expect(existsSync(`${usagePath()}.${process.pid}.tmp`)).toBe(false)
})
