import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { DeskConfig } from './config'
import { applyDefaults } from './defaults'
import {
  expandPath,
  findGroupLayers,
  globalRepoRoots,
  mergeConfigs,
} from './layers'

const roots: string[] = []

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `herdr-desk-${prefix}-`))
  roots.push(dir)
  return dir
}

function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

afterEach(() => {
  while (roots.length)
    rmSync(roots.pop() as string, { recursive: true, force: true })
})

describe('expandPath', () => {
  test('expands ~ and relative paths against a base', () => {
    expect(expandPath('/abs/path')).toBe('/abs/path')
    expect(expandPath('~/src/x')).toBe(
      join(process.env.HOME as string, 'src/x'),
    )
    expect(expandPath('rel', '/base')).toBe('/base/rel')
  })
})

describe('findGroupLayers', () => {
  test('finds an ancestor group config, nearest first', () => {
    const home = tmp('home')
    const group = join(home, 'project')
    const repo = join(group, 'myrepo')
    mkdirSync(repo, { recursive: true })
    write(join(group, '.herdr-desk.json'), { name: 'fleet', group: true })

    const layers = findGroupLayers(repo, home)
    expect(layers).toHaveLength(1)
    expect(layers[0].config.group).toBe(true)
    expect(layers[0].dir).toBe(group)
  })

  test('orders nearer ancestors before further ones', () => {
    const home = tmp('home')
    const far = join(home, 'all')
    const near = join(far, 'team')
    const repo = join(near, 'myrepo')
    mkdirSync(repo, { recursive: true })
    write(join(far, '.herdr-desk.json'), {
      name: 'all',
      group: true,
      schedule: '0 5 * * *',
    })
    write(join(near, '.herdr-desk.json'), {
      name: 'team',
      group: true,
      schedule: '0 6 * * *',
    })

    const layers = findGroupLayers(repo, home)
    expect(layers.map((l) => l.dir)).toEqual([near, far])
  })

  test('ignores an ancestor config that did not opt in with group:true', () => {
    // The marker is what stops a stray config in an unrelated parent from
    // silently steering this repo.
    const home = tmp('home')
    const repo = join(home, 'project', 'myrepo')
    mkdirSync(repo, { recursive: true })
    write(join(home, 'project', '.herdr-desk.json'), { name: 'nope' })
    expect(findGroupLayers(repo, home)).toEqual([])
  })

  test('a repo config is not its own group layer', () => {
    const home = tmp('home')
    const repo = join(home, 'myrepo')
    mkdirSync(repo, { recursive: true })
    write(join(repo, '.herdr-desk.json'), { name: 'self', group: true })
    expect(findGroupLayers(repo, home)).toEqual([])
  })

  test('stops climbing at the stop directory', () => {
    const home = tmp('home')
    const repo = join(home, 'a', 'b', 'c')
    mkdirSync(repo, { recursive: true })
    write(join(home, 'a', '.herdr-desk.json'), { name: 'a', group: true })
    // `home` is the stop, and it has no config, so only `a` is found.
    expect(findGroupLayers(repo, home).map((l) => l.dir)).toEqual([
      join(home, 'a'),
    ])
  })

  test('skips a malformed group config instead of throwing', () => {
    const home = tmp('home')
    const repo = join(home, 'p', 'r')
    mkdirSync(repo, { recursive: true })
    writeFileSync(join(home, 'p', '.herdr-desk.json'), '{ not json')
    expect(findGroupLayers(repo, home)).toEqual([])
  })
})

describe('globalRepoRoots', () => {
  test('expands ~ and a single-level glob, keeping only desk repos', () => {
    const home = tmp('home')
    const withDesk = join(home, 'a')
    const without = join(home, 'b')
    mkdirSync(withDesk, { recursive: true })
    mkdirSync(without, { recursive: true })
    write(join(withDesk, '.herdr-desk.json'), { name: 'a' })

    const roots = globalRepoRoots({ repos: [`${home}/*`] })
    expect(roots).toEqual([withDesk])
  })

  test('accepts explicit paths alongside globs', () => {
    const home = tmp('home')
    const explicit = join(home, 'solo')
    mkdirSync(explicit, { recursive: true })
    write(join(explicit, '.herdr-desk.json'), { name: 'solo' })
    expect(globalRepoRoots({ repos: [explicit] })).toEqual([explicit])
  })
})

describe('mergeConfigs', () => {
  test('later layers win', () => {
    const merged = mergeConfigs(
      { name: 'a', schedule: '0 5 * * *', maxChildren: 5 },
      { name: 'b', schedule: '0 6 * * *' },
    )
    expect(merged.schedule).toBe('0 6 * * *')
    expect(merged.maxChildren).toBe(5)
  })

  test('an absent field is inherited rather than reset', () => {
    const merged = mergeConfigs(
      { name: 'a', agent: { ladder: ['claude'] } },
      { name: 'b' },
    )
    expect(merged.agent).toEqual({ ladder: ['claude'] })
  })

  test('tasks are replaced wholesale, not concatenated', () => {
    const merged = mergeConfigs(
      { name: 'a', tasks: [{ id: 'desk:github-issues' }] },
      { name: 'b', tasks: [{ id: 'local:other' }] },
    )
    expect(merged.tasks).toEqual([{ id: 'local:other' }])
  })

  test('does not mutate its inputs', () => {
    const base = { name: 'a', schedule: '0 5 * * *' }
    mergeConfigs(base, { name: 'b' })
    expect(base).toEqual({ name: 'a', schedule: '0 5 * * *' })
  })

  test('a repo overriding only permission keeps the group ladder', () => {
    // Regression: a shallow merge dropped the inherited ladder here, so the repo
    // silently fell back to the built-in default agent. The object form exists
    // precisely so a repo can override one field without restating the ladder.
    const merged = mergeConfigs(
      {
        name: 'group',
        agent: { ladder: ['opencode2', 'claude'], permission: 'yolo' },
      },
      { name: 'repo', agent: { permission: 'default' } },
    )
    expect(merged.agent).toEqual({
      ladder: ['opencode2', 'claude'],
      permission: 'default',
    })
  })

  test('the merged agent survives applyDefaults end to end', () => {
    // The unit above checks the merge; this checks the value a run would use.
    const merged = mergeConfigs(
      { name: 'group', agent: { ladder: ['opencode2', 'claude'] } },
      { name: 'repo', agent: { permission: 'yolo' } },
    )
    const task = applyDefaults(merged as DeskConfig, '/tmp/repo').tasks[0]
    expect(task.agent.ladder).toEqual(['opencode2', 'claude'])
    expect(task.agent.permission).toBe('yolo')
  })

  test('a string on either side is treated as a deliberate pin', () => {
    expect(
      mergeConfigs({ name: 'a', agent: 'claude' }, { name: 'b' }).agent,
    ).toBe('claude')
    // A repo string replaces a group object outright.
    expect(
      mergeConfigs(
        { name: 'a', agent: { ladder: ['claude', 'codex'] } },
        { name: 'b', agent: 'codex' },
      ).agent,
    ).toBe('codex')
  })

  test('a group string ladder survives a repo object override', () => {
    const merged = mergeConfigs(
      { name: 'a', agent: 'codex' },
      { name: 'b', agent: { permission: 'yolo' } },
    )
    expect(merged.agent).toEqual({ ladder: ['codex'], permission: 'yolo' })
  })
})
