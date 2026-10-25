import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CHECKS,
  type CheckDeps,
  type CheckRow,
  formatChecks,
  hasProblem,
  initConfig,
  runChecks,
} from './check'
import type { LoadedDesk, TaskConfig } from './config'
import { validateDeskJson } from './schema'

/** A machine where every probe passes, so each test breaks exactly one. */
function deps(over: Partial<CheckDeps> = {}): CheckDeps {
  return {
    herdr: () => ({ ok: true }),
    daemonPid: () => 42,
    which: (cmd) => `/usr/bin/${cmd}`,
    exec: (argv) => (argv.join(' ') === 'git remote' ? 'origin\n' : ''),
    stateDir: () => '/state',
    probeWritable: () => {},
    readFile: () => 'just a prompt',
    exists: () => true,
    ...over,
  }
}

function task(over: Partial<TaskConfig> = {}): TaskConfig {
  return {
    id: 'desk',
    playbook: './desk.md',
    agentName: 'desk',
    agent: { ladder: ['claude'], permission: 'default' },
    crons: [],
    ...over,
  }
}

function desk(tasks: TaskConfig[] = [task()]): () => LoadedDesk {
  return () => ({ name: 'r', tasks })
}

const broken = () => {
  throw new Error('bad schema')
}

function row(rows: CheckRow[], name: string): CheckRow {
  const r = rows.find((x) => x.name === name)
  if (!r) throw new Error(`no row ${name}`)
  return r
}

describe('check table', () => {
  test('a healthy repo reports every row ok and no problem', () => {
    const rows = runChecks('/repo', deps(), desk())
    expect(rows.map((r) => r.name)).toEqual(CHECKS.map((c) => c.name))
    expect(rows.every((r) => r.status === 'ok')).toBe(true)
    expect(hasProblem(rows)).toBe(false)
  })

  test('herdr missing names the reason and how to install', () => {
    const r = row(
      runChecks(
        '/repo',
        deps({ herdr: () => ({ ok: false, reason: 'herdr not found' }) }),
        desk(),
      ),
      'herdr',
    )
    expect(r.status).toBe('problem')
    expect(r.detail).toBe('herdr not found')
  })

  test('a stopped daemon is a problem fixed by start', () => {
    const r = row(
      runChecks('/repo', deps({ daemonPid: () => null }), desk()),
      'daemon',
    )
    expect(r).toMatchObject({ status: 'problem', fix: 'herdr-desk start' })
  })

  test('a missing config points at init; dependent rows skip, not pass', () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-'))
    const rows = runChecks(dir, deps(), broken)
    expect(row(rows, 'config')).toMatchObject({
      status: 'problem',
      fix: `herdr-desk init ${dir}`,
    })
    // Skipped rows must not read as ok: nothing was inspected.
    for (const name of ['prompts', 'agent', 'gh']) {
      expect(row(rows, name).status).toBe('skip')
    }
  })

  test('an invalid config reports the schema error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-'))
    writeFileSync(join(dir, '.herdr-desk.json'), '{}')
    const r = row(runChecks(dir, deps(), broken), 'config')
    expect(r.status).toBe('problem')
    expect(r.detail).toBe('bad schema')
  })

  test('a playbook file that does not exist is a problem', () => {
    const r = row(
      runChecks('/repo', deps({ exists: () => false }), desk()),
      'prompts',
    )
    expect(r.status).toBe('problem')
    expect(r.detail).toContain('desk: /repo/desk.md not found')
  })

  test('an unapproved gh: playbook does not resolve', () => {
    const r = row(
      runChecks(
        '/repo',
        deps(),
        desk([task({ playbook: 'gh:nobody/none/x.md' })]),
      ),
      'prompts',
    )
    expect(r.status).toBe('problem')
    expect(r.detail).toContain('not approved')
  })

  test('the launched agent kind must be on PATH', () => {
    const r = row(
      runChecks(
        '/repo',
        deps({ which: (c) => (c === 'claude' ? null : `/bin/${c}`) }),
        desk(),
      ),
      'agent',
    )
    expect(r.status).toBe('problem')
    expect(r.detail).toContain("'claude' not on PATH")
  })

  test('gh auth is only checked when a task needs GitHub', () => {
    const noAuth = deps({
      exec: (argv) => (argv[0] === 'gh' ? null : 'origin'),
    })
    expect(row(runChecks('/repo', noAuth, desk()), 'gh').status).toBe('ok')
    const ghPrompt = deps({
      exec: noAuth.exec,
      readFile: () => 'run `gh issue list`',
    })
    expect(row(runChecks('/repo', ghPrompt, desk()), 'gh')).toMatchObject({
      status: 'problem',
      fix: 'gh auth login',
    })
  })

  test('not a git repo, and a repo without a remote, are problems', () => {
    const noGit = deps({ exec: () => null })
    expect(row(runChecks('/repo', noGit, desk()), 'git').detail).toBe(
      'not a git repo',
    )
    const noRemote = deps({ exec: () => '' })
    expect(row(runChecks('/repo', noRemote, desk()), 'git').detail).toBe(
      'no git remote',
    )
  })

  test('an unwritable state dir is a problem', () => {
    const r = row(
      runChecks(
        '/repo',
        deps({
          probeWritable: () => {
            throw new Error('EACCES')
          },
        }),
        desk(),
      ),
      'state dir',
    )
    expect(r.status).toBe('problem')
    expect(r.detail).toContain('EACCES')
  })

  test('format prints the fix under each problem and a count', () => {
    const out = formatChecks(
      runChecks('/repo', deps({ daemonPid: () => null }), desk()),
    )
    expect(out).toContain('fix: herdr-desk start')
    expect(out).toContain('1 problem(s)')
  })
})

describe('init', () => {
  test('writes a schema-valid config named after the repo', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'init-')), 'my-app')
    mkdirSync(dir)
    const r = initConfig(dir)
    expect(r.written).toBe(true)
    const raw = JSON.parse(readFileSync(r.path, 'utf8'))
    expect(raw.name).toBe('my-app')
    expect(validateDeskJson(raw, r.path, dir)).toEqual([])
  })

  test('never overwrites an existing config, under any accepted name', () => {
    for (const name of ['.herdr-desk.json', 'herdr-desk.json']) {
      const dir = mkdtempSync(join(tmpdir(), 'init-'))
      const path = join(dir, name)
      writeFileSync(path, 'mine')
      expect(initConfig(dir)).toEqual({ written: false, path })
      expect(readFileSync(path, 'utf8')).toBe('mine')
    }
  })
})
