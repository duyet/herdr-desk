import { execFileSync } from 'node:child_process'
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import {
  DESK_ROOT,
  findConfigPath,
  type LoadedDesk,
  loadDeskConfig,
  resolveTaskPromptPath,
} from './config'
import { daemonPid } from './daemon'
import { herdrReady } from './herdr'
import { pluginStateDir } from './paths'
import { GH_PREFIX } from './registry'
import { launchKind } from './run'

/**
 * First-run check for a repo adopting herdr-desk.
 *
 * Each item is a row in {@link CHECKS}: a name and a function from the shared
 * context to a result. Adding a check is adding a row, never another branch.
 * Every probe of the machine goes through {@link CheckDeps}, so a test swaps
 * the machine for a fake and each row is tested on its own.
 */

/** `skip` means an earlier row failed and this one had nothing to inspect. */
export type CheckStatus = 'ok' | 'problem' | 'skip'

export type CheckResult = {
  status: CheckStatus
  detail: string
  /** The exact command or edit that fixes a problem. */
  fix?: string
}

export type CheckDeps = {
  herdr: () => { ok: true } | { ok: false; reason: string }
  daemonPid: () => number | null
  /** Absolute path of a command on PATH, or null. */
  which: (cmd: string) => string | null
  /** stdout, or null when the command failed. */
  exec: (argv: string[], cwd: string) => string | null
  stateDir: () => string
  /** Throws when `dir` cannot be created or written. */
  probeWritable: (dir: string) => void
  readFile: (path: string) => string
  exists: (path: string) => boolean
}

export type CheckContext = {
  repo: string
  deps: CheckDeps
  /** The loaded desk, or the reason it did not load. */
  desk: { ok: true; value: LoadedDesk } | { ok: false; error: string }
}

export type Check = {
  name: string
  run: (ctx: CheckContext) => CheckResult
}

const ok = (detail: string): CheckResult => ({ status: 'ok', detail })
const problem = (detail: string, fix: string): CheckResult => ({
  status: 'problem',
  detail,
  fix,
})
const skip = (detail = 'config did not load'): CheckResult => ({
  status: 'skip',
  detail,
})

/** The bundled tasks whose prompts drive `gh`; a `gh:` playbook needs it too. */
const GH_COMMAND = /`gh (pr|issue|api|repo|run|release)\b/

function needsGitHub(ctx: CheckContext, desk: LoadedDesk): string[] {
  return desk.tasks
    .filter((t) => {
      if (t.playbook.startsWith(GH_PREFIX)) return true
      try {
        const path = resolveTaskPromptPath(t, ctx.repo)
        return GH_COMMAND.test(ctx.deps.readFile(path))
      } catch {
        return false
      }
    })
    .map((t) => t.id)
}

export const CHECKS: readonly Check[] = [
  {
    name: 'herdr',
    run: ({ deps }) => {
      const r = deps.herdr()
      return r.ok
        ? ok('installed and socket present')
        : problem(r.reason, 'install Herdr and open it once: herdr')
    },
  },
  {
    name: 'daemon',
    run: ({ deps }) => {
      const pid = deps.daemonPid()
      return pid
        ? ok(`running (pid ${pid})`)
        : problem('not running', 'herdr-desk start')
    },
  },
  {
    name: 'config',
    run: ({ repo, desk }) => {
      if (desk.ok) {
        return ok(`${desk.value.name}: ${desk.value.tasks.length} task(s)`)
      }
      const present = findConfigPath(repo)
      return present === null
        ? problem('no .herdr-desk.json', `herdr-desk init ${repo}`)
        : problem(desk.error, `edit ${present} until: herdr-desk check ${repo}`)
    },
  },
  {
    name: 'prompts',
    run: ({ repo, desk, deps }) => {
      if (!desk.ok) return skip()
      const missing: string[] = []
      for (const t of desk.value.tasks) {
        try {
          const path = resolveTaskPromptPath(t, repo)
          if (!deps.exists(path)) missing.push(`${t.id}: ${path} not found`)
        } catch (e) {
          missing.push(`${t.id}: ${(e as Error).message}`)
        }
      }
      return missing.length
        ? problem(
            missing.join('; '),
            'fix `playbook`, or run: herdr-desk tasks (bundled) / herdr-desk prompts apply --accept (gh:)',
          )
        : ok(`${desk.value.tasks.length} playbook(s) resolve`)
    },
  },
  {
    name: 'agent',
    run: ({ desk, deps }) => {
      if (!desk.ok) return skip()
      const bad: string[] = []
      const kinds = new Set<string>()
      for (const t of desk.value.tasks) {
        let kind: string
        try {
          kind = launchKind(t.agent.ladder)
        } catch (e) {
          bad.push(`${t.id}: ${(e as Error).message}`)
          continue
        }
        if (deps.which(kind)) kinds.add(kind)
        else bad.push(`${t.id}: '${kind}' not on PATH`)
      }
      return bad.length
        ? problem(
            bad.join('; '),
            'install that agent CLI, or set `agent` to one that is installed',
          )
        : ok(`${[...kinds].join(', ')} on PATH`)
    },
  },
  {
    name: 'gh',
    run: (ctx) => {
      if (!ctx.desk.ok) return skip()
      const tasks = needsGitHub(ctx, ctx.desk.value)
      if (!tasks.length) return ok('no task needs GitHub')
      if (!ctx.deps.which('gh')) {
        return problem(
          `gh not on PATH (needed by ${tasks.join(', ')})`,
          'install GitHub CLI, then: gh auth login',
        )
      }
      return ctx.deps.exec(['gh', 'auth', 'status'], ctx.repo) === null
        ? problem(
            `gh not authenticated (needed by ${tasks.join(', ')})`,
            'gh auth login',
          )
        : ok(`authenticated (needed by ${tasks.join(', ')})`)
    },
  },
  {
    name: 'git',
    run: ({ repo, deps }) => {
      if (deps.exec(['git', 'rev-parse', '--git-dir'], repo) === null) {
        return problem('not a git repo', `git -C ${repo} init`)
      }
      const remotes = (deps.exec(['git', 'remote'], repo) ?? '').trim()
      return remotes
        ? ok(`remote: ${remotes.split('\n').join(', ')}`)
        : problem('no git remote', `git -C ${repo} remote add origin <url>`)
    },
  },
  {
    name: 'state dir',
    run: ({ deps }) => {
      const dir = deps.stateDir()
      try {
        deps.probeWritable(dir)
        return ok(dir)
      } catch (e) {
        return problem(
          `${dir} not writable: ${(e as Error).message}`,
          `mkdir -p ${dir} && chmod u+w ${dir} (or set HERDR_PLUGIN_STATE_DIR)`,
        )
      }
    },
  },
]

export const realDeps: CheckDeps = {
  herdr: () => herdrReady(),
  daemonPid,
  which: (cmd) => Bun.which(cmd),
  exec: (argv, cwd) => {
    try {
      return execFileSync(argv[0], argv.slice(1), {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      return null
    }
  },
  stateDir: pluginStateDir,
  probeWritable: (dir) => {
    mkdirSync(dir, { recursive: true })
    accessSync(dir, constants.W_OK)
  },
  readFile: (path) => readFileSync(path, 'utf8'),
  exists: existsSync,
}

export type CheckRow = CheckResult & { name: string }

export function runChecks(
  repoArg: string,
  deps: CheckDeps = realDeps,
  load: (repo: string) => LoadedDesk = loadDeskConfig,
  checks: readonly Check[] = CHECKS,
): CheckRow[] {
  const repo = resolve(repoArg)
  let desk: CheckContext['desk']
  try {
    desk = { ok: true, value: load(repo) }
  } catch (e) {
    desk = { ok: false, error: (e as Error).message }
  }
  const ctx: CheckContext = { repo, deps, desk }
  return checks.map((c) => ({ name: c.name, ...c.run(ctx) }))
}

export function hasProblem(rows: CheckRow[]): boolean {
  return rows.some((r) => r.status === 'problem')
}

export function formatChecks(rows: CheckRow[]): string {
  const width = Math.max(...rows.map((r) => r.name.length))
  const lines = rows.flatMap((r) => {
    const head = `${r.status.padEnd(7)} ${r.name.padEnd(width)}  ${r.detail}`
    return r.fix ? [head, `${' '.repeat(10 + width)}fix: ${r.fix}`] : [head]
  })
  const problems = rows.filter((r) => r.status === 'problem').length
  lines.push('', problems ? `${problems} problem(s)` : 'all checks ok')
  return lines.join('\n')
}

/** The example `init` copies: the smallest valid config. */
export const INIT_EXAMPLE = join(
  DESK_ROOT,
  'examples',
  'minimal',
  '.herdr-desk.json',
)

/**
 * Write `.herdr-desk.json` from the minimal example, named after the repo.
 *
 * Never overwrites: any config `findConfigPath` would pick up counts as
 * present, so `init` cannot shadow an `ops/desk.json` either.
 */
export function initConfig(
  repoArg: string,
): { written: true; path: string } | { written: false; path: string } {
  const repo = resolve(repoArg)
  const existing = findConfigPath(repo)
  if (existing) return { written: false, path: existing }
  const example = JSON.parse(readFileSync(INIT_EXAMPLE, 'utf8'))
  const path = join(repo, '.herdr-desk.json')
  writeFileSync(
    path,
    `${JSON.stringify({ ...example, name: basename(repo) }, null, 2)}\n`,
    { flag: 'wx' },
  )
  return { written: true, path }
}
