import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { findConfigPath, type LoadedDesk, loadDeskConfig } from './config'
import { herdrCall, listedWorkspaces } from './herdr'
import { findGroupLayers, globalRepoRoots } from './layers'
import { pluginStateDir } from './paths'
import { watchRepo } from './watch'

export type Discovered = {
  repo: string
  configPath: string
  config: LoadedDesk
  source: 'workspace' | 'remembered' | 'plugin-config'
  /** Ancestor `group: true` configs that also apply, nearest first. */
  groups?: string[]
}

function knownPath(): string {
  return join(pluginStateDir(), 'known-repos.json')
}

export function loadKnownRepos(): string[] {
  const path = knownPath()
  if (!existsSync(path)) return []
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { repos?: string[] }
    return (raw.repos ?? []).map((p) => resolve(p))
  } catch {
    return []
  }
}

export function rememberRepos(repos: string[]): void {
  mkdirSync(pluginStateDir(), { recursive: true })
  const merged = [
    ...new Set([...loadKnownRepos(), ...repos.map((p) => resolve(p))]),
  ].sort()
  writeFileSync(knownPath(), `${JSON.stringify({ repos: merged }, null, 2)}\n`)
}

export async function workspaceRepoRoots(): Promise<string[]> {
  try {
    const listed = listedWorkspaces(await herdrCall(['workspace', 'list']))
    const roots: string[] = []
    for (const w of listed) {
      const root = w.repoRoot ?? w.cwd ?? w.checkoutPath
      if (root) roots.push(resolve(root))
    }
    return [...new Set(roots)]
  } catch {
    return []
  }
}

/**
 * One repo that could not be read, and why.
 *
 * This is the whole of issue #97 as data. `tryLoad` used to catch every config
 * error and return `null`, so a repo whose `.herdr-desk.json` the *running*
 * plugin cannot parse was not reported badly — it was not reported at all.
 * Absent from `scan`, `status`, `hub`, `board`, `timeline`, nothing in
 * `daemon.log`, no notice, and its cron jobs stopped firing. Reproduced live by
 * arming a config field ahead of the installed daemon, which is the normal state
 * of a rollout rather than an exotic one.
 *
 * A malformed config is normally loud: `validate` prints it, the job refuses to
 * start, `runs.jsonl` records a failure. This path was quiet in the worst way —
 * no run, no record, and no gap, because the scheduler did not know the job
 * existed. `desk analytics` reported a healthy machine doing nothing.
 */
export type LoadFailure = {
  /** The path the config was looked for in — the checkout, not `config.repo`. */
  repo: string
  /** The file that failed, or `null` when there was no config to begin with. */
  configPath: string | null
  /** Why it could not be loaded, verbatim from the throw. */
  error: string
  source: Discovered['source']
}

/** What one load attempt produced: a desk, a reported failure, or neither. */
type LoadResult =
  | { kind: 'desk'; desk: Discovered }
  | { kind: 'failed'; failure: LoadFailure }
  | { kind: 'absent' }

function tryLoad(repo: string, source: Discovered['source']): LoadResult {
  const configPath = findConfigPath(repo)
  if (!configPath) return { kind: 'absent' }
  try {
    const config = loadDeskConfig(repo)
    return {
      kind: 'desk',
      desk: {
        // `watchRepo`, not `config.repo ?? repo` written out again: the state key
        // has one definition, and the CLI resolves it through the same helper.
        repo: watchRepo(config, repo),
        configPath,
        config,
        source,
        groups: findGroupLayers(repo).map((g) => g.path),
      },
    }
  } catch (err) {
    return {
      kind: 'failed',
      failure: {
        repo,
        configPath,
        error: err instanceof Error ? err.message : String(err),
        source,
      },
    }
  }
}

/** Open workspaces + remembered + plugin config extras, and what failed. */
export type Discovery = {
  desks: Discovered[]
  /** Repos that have a config the running plugin cannot read. Never fatal. */
  failed: LoadFailure[]
}

/**
 * Discovery that reports the repos it could not read.
 *
 * {@link discoverDesks} is this, dropping the failures — kept because `cli.ts`,
 * `daemon.ts`, `board.ts` and friends all call it and a silent drop is what
 * #97 is about. The daemon and the two commands a person runs to find out what
 * a desk is doing use this one.
 */
export async function discoverAll(): Promise<Discovery> {
  const live = await workspaceRepoRoots()
  const extras = globalRepoRoots()
  const remembered = loadKnownRepos()

  const found: Discovered[] = []
  const failed: LoadFailure[] = []
  const seen = new Set<string>()

  const add = (repo: string, source: Discovered['source']) => {
    const key = resolve(repo)
    if (seen.has(key)) return
    // Marked before the load, not after: a repo that fails to load must be
    // attempted once per tick like any other, and the same bad config reached
    // from both a workspace and a remembered entry is one problem, not two.
    seen.add(key)
    const hit = tryLoad(key, source)
    if (hit.kind === 'desk') found.push(hit.desk)
    else if (hit.kind === 'failed') failed.push(hit.failure)
  }

  for (const repo of live) add(repo, 'workspace')
  for (const repo of extras) add(repo, 'plugin-config')
  for (const repo of remembered) add(repo, 'remembered')

  // A repo that cannot be read is still a repo this machine knows about, and
  // remembering it is what makes the round trip work: the config is fixed, and
  // the next tick finds it again with no restart. It also keeps the failure
  // from being *only* a problem while the workspace happens to be open.
  rememberRepos([...found.map((d) => d.repo), ...failed.map((f) => f.repo)])
  return { desks: found, failed }
}

/** Open workspaces + remembered + plugin config extras. */
export async function discoverDesks(): Promise<Discovered[]> {
  return (await discoverAll()).desks
}

/**
 * The desks, and the ones that could not be read, in one output.
 *
 * `scan` is the command a person runs to find out what the desk is looking at,
 * so a repo that failed to load has to be in its answer. It is listed with its
 * error rather than omitted, because the omission is the bug: a desk missing
 * from `scan` and `status` with nothing logged anywhere reads as a desk that no
 * longer exists, which is a different problem with a different fix.
 */
export function formatScan(
  desks: Discovered[],
  failed: LoadFailure[] = [],
): string {
  const lines: string[] = []
  for (const d of desks) {
    const group = d.groups?.length
      ? `  <- ${d.groups.length} group config(s)`
      : ''
    lines.push(`${d.config.name}  ${d.repo}  (${d.source})${group}`)
    for (const t of d.config.tasks) {
      lines.push(
        `  ${t.id}  ${t.agentName}  ${t.crons.join(' | ') || '-'}  ${t.agent.ladder[0]}`,
      )
    }
  }
  for (const f of failed) {
    // First line only: a validator error is a list, and the first one is the
    // reason the file was rejected. `validate` prints all of them.
    lines.push(`error  ${f.repo}  ${firstLine(f.error)}`)
  }
  if (lines.length === 0)
    return 'no desks (no open workspace has .herdr-desk.json)'
  return lines.join('\n')
}

/** First line of a multi-line error, for a one-line rendering. */
export function firstLine(error: string): string {
  return error.split('\n').find((l) => l.trim()) ?? error
}
