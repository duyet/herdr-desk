import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { loadDeskConfig } from './config'
import { explainTasks } from './configShow'
import { applyDefaults } from './defaults'
import { resolveConfig } from './layers'

/**
 * The drift guard.
 *
 * `resolveConfig` is documented as the single fold, and `config explain`, notify
 * and the run path are all supposed to agree. That agreement is not structural:
 * `explain` and notify call `resolveConfig` directly, while a run goes through
 * `loadDeskConfig`. When `loadDeskConfig` read the repo file on its own, `explain`
 * happily reported a global `agent.ladder` that no run would ever use, and no
 * test noticed — the display path and the execution path were two different
 * functions that happened to look similar.
 *
 * So every test here asserts the *same* repo resolves to the *same* agent through
 * both paths. If someone reintroduces a private fold, these fail.
 */

const roots: string[] = []
let savedConfigDir: string | undefined

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `herdr-desk-fold-${prefix}-`))
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
  if (savedConfigDir === undefined) delete process.env.HERDR_PLUGIN_CONFIG_DIR
  else process.env.HERDR_PLUGIN_CONFIG_DIR = savedConfigDir
  savedConfigDir = undefined
})

/** Point the global config at a temp dir and return its path. */
function useGlobalConfig(value: unknown): string {
  const dir = tmp('global')
  savedConfigDir = process.env.HERDR_PLUGIN_CONFIG_DIR
  process.env.HERDR_PLUGIN_CONFIG_DIR = dir
  const path = join(dir, 'config.json')
  write(path, value)
  return path
}

/** Agent ladder a run would actually use. */
function runLadder(repo: string): string[] {
  return loadDeskConfig(repo).tasks[0].agent.ladder
}

/** Agent ladder as `config explain --tasks` renders it in the LADDER column. */
function explainedLadder(repo: string): string[] {
  const row = explainTasks(repo)
    .split('\n')
    .find(
      (l) =>
        l.trim().startsWith('|') && !l.includes('JOB') && !l.includes('---'),
    )
  if (!row) return []
  const cells = row.split('|').map((c) => c.trim())
  const ladder = cells[2] ?? ''
  return ladder && ladder !== 'LADDER'
    ? ladder.split('>').map((s) => s.trim())
    : []
}

describe('one fold, two consumers', () => {
  test('a global agent ladder reaches the run, not just explain', () => {
    // Why: this is the exact bug. `explain` folded the global layer while the
    // run path read the repo file alone, so the ladder below was reported to the
    // user and then never used to launch anything.
    useGlobalConfig({ agent: { ladder: ['codex', 'claude'] } })
    const repo = tmp('repo')
    write(join(repo, '.herdr-desk.json'), { name: 'acme' })

    expect(runLadder(repo)).toEqual(['codex', 'claude'])
    expect(explainedLadder(repo)).toEqual(['codex', 'claude'])
  })

  test('resolveConfig and loadDeskConfig agree on the folded agent', () => {
    // Why: the two functions are the display path and the execution path. They
    // must be one fold, not two implementations that happen to look alike.
    useGlobalConfig({ agent: { ladder: ['codex', 'claude'] } })
    const group = tmp('group')
    const repo = join(group, 'acme')
    mkdirSync(repo, { recursive: true })
    write(join(group, '.herdr-desk.json'), {
      name: 'group',
      group: true,
      agent: { permission: 'yolo' },
    })
    write(join(repo, '.herdr-desk.json'), { name: 'acme' })

    const folded = resolveConfig(repo).config
    const applied = applyDefaults(folded, repo)
    expect(applied.tasks[0].agent.ladder).toEqual(runLadder(repo))
    expect(applied.tasks[0].agent.permission).toBe('yolo')
  })

  test('a repo overrides the global ladder', () => {
    useGlobalConfig({ agent: { ladder: ['codex', 'claude'] } })
    const repo = tmp('repo')
    write(join(repo, '.herdr-desk.json'), {
      name: 'acme',
      agent: { ladder: ['grok'] },
    })

    expect(runLadder(repo)).toEqual(['grok'])
  })

  test('a repo overriding one subfield still inherits the global ladder', () => {
    // Why: the deep merge is the whole reason the object form exists. A shallow
    // merge drops `ladder` and quietly falls back to the built-in default.
    useGlobalConfig({ agent: { ladder: ['codex', 'claude'] } })
    const repo = tmp('repo')
    write(join(repo, '.herdr-desk.json'), {
      name: 'acme',
      agent: { permission: 'yolo' },
    })

    const task = loadDeskConfig(repo).tasks[0]
    expect(task.agent.ladder).toEqual(['codex', 'claude'])
    expect(task.agent.permission).toBe('yolo')
  })

  test('a group layer sits between global and repo', () => {
    const home = tmp('home')
    const group = join(home, 'team')
    const repo = join(group, 'acme')
    mkdirSync(repo, { recursive: true })
    useGlobalConfig({ agent: { ladder: ['codex'] } })
    write(join(group, '.herdr-desk.json'), {
      name: 'team',
      group: true,
      agent: { ladder: ['claude', 'grok'] },
    })
    write(join(repo, '.herdr-desk.json'), { name: 'acme' })

    expect(runLadder(repo)).toEqual(['claude', 'grok'])
  })

  test('legacy `kind` in a repo still pins the ladder, beating global', () => {
    useGlobalConfig({ agent: { ladder: ['codex'] } })
    const repo = tmp('repo')
    write(join(repo, '.herdr-desk.json'), { name: 'acme', kind: 'grok' })

    expect(runLadder(repo)).toEqual(['grok'])
  })

  test('with no global config the built-in default is unchanged', () => {
    // Why: every repo that never set `kind` was running grok. If 0.2 changed
    // this default it would silently switch agents on upgrade.
    const dir = tmp('empty-global')
    savedConfigDir = process.env.HERDR_PLUGIN_CONFIG_DIR
    process.env.HERDR_PLUGIN_CONFIG_DIR = dir
    const repo = tmp('repo')
    write(join(repo, '.herdr-desk.json'), { name: 'acme' })

    expect(runLadder(repo)).toEqual(['grok'])
  })
})

describe('notify rides the same fold', () => {
  test('a per-desk channel override resolves through resolveConfig', () => {
    // Why: the override must be the standard layer mechanism, not a second
    // precedence path. If notify grew its own lookup, this would drift.
    const dir = tmp('global')
    savedConfigDir = process.env.HERDR_PLUGIN_CONFIG_DIR
    process.env.HERDR_PLUGIN_CONFIG_DIR = dir
    write(join(dir, 'notify.json'), { chatId: '111', enabled: true })
    const repo = tmp('repo')
    write(join(repo, '.herdr-desk.json'), { name: 'acme' })

    const { config } = resolveConfig(repo)
    expect(config.name).toBe('acme')
    expect(runLadder(repo)).toEqual(['grok'])
  })

  test('provenance blames the task that set the field, not the global layer', () => {
    // Why: `tasks` is replaced wholesale, not deep-merged, so a task's `agent`
    // block is the effective one. Tracking only the root-level block made
    // `explain` report the global ladder as the source even when the repo's
    // task had overridden it — the display would contradict the run.
    useGlobalConfig({ agent: { ladder: ['codex', 'claude', 'grok'] } })
    const repo = tmp('repo')
    write(join(repo, '.herdr-desk.json'), {
      name: 'acme',
      tasks: [
        { id: 'desk:github-issues', agent: { ladder: ['claude', 'grok'] } },
      ],
    })

    const { fieldProvenance } = resolveConfig(repo)
    expect(fieldProvenance['tasks.agent.ladder']).toBe('repo')
    expect(runLadder(repo)).toEqual(['claude', 'grok'])
  })

  test('global notify config and a repo override both fold without conflict', () => {
    useGlobalConfig({ agent: { ladder: ['codex', 'claude'] } })
    const repo = tmp('repo')
    write(join(repo, '.herdr-desk.json'), {
      name: 'acme',
      agent: { ladder: ['claude'] },
      notify: { chatId: '999' },
    })

    const { config, fieldProvenance } = resolveConfig(repo)
    expect(config.name).toBe('acme')
    // Provenance has to point at the layer that actually won, or `explain` is
    // decoration.
    expect(fieldProvenance['agent.ladder']).toBe('repo')
    expect(runLadder(repo)).toEqual(['claude'])
  })
})

describe('validation stays repo-scoped', () => {
  test('a malformed global layer does not break a repo load', () => {
    // Why: shared layers are machine-owned. One bad global file must not fail
    // every repo on the host at once — that is the whole blast radius argument
    // for scoping validation to the repo's own file.
    useGlobalConfig({ agent: { ladder: 'not-an-array-of-rungs' } })
    const repo = tmp('repo')
    write(join(repo, '.herdr-desk.json'), { name: 'acme' })

    expect(() => loadDeskConfig(repo)).not.toThrow()
  })

  test('an invalid repo config still throws', () => {
    useGlobalConfig({ agent: { ladder: ['codex'] } })
    const repo = tmp('repo')
    write(join(repo, '.herdr-desk.json'), { name: 'acme', maxChildren: 99 })

    expect(() => loadDeskConfig(repo)).toThrow(/maxChildren/)
  })
})
