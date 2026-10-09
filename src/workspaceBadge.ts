import { dirname, resolve } from 'node:path'
import type { Discovered, LoadFailure } from './discover'
import {
  herdrCall,
  type ListedWorkspace,
  listedWorkspaces,
  projectWorkspaceForRepo,
} from './herdr'
import { CONFIG_NAMES } from './paths'

/**
 * Sidebar badge: a small count on each open project Space.
 *
 * Herdr renders `tokens` beside the workspace label. This plugin owns one
 * token in one namespace: `desk` under `user:herdr-desk`. The value is the
 * number of resolved configured tasks for that repo (`N`), so a Space with
 * three jobs reads `3` and a Space with no desk reads nothing.
 *
 * Scope is deliberate. Only `desk` under `user:herdr-desk` is ever written or
 * cleared; labels are never renamed and unrelated tokens are never touched.
 * Only open project Spaces are decorated — never a linked worktree child —
 * and repos are never hard-coded: every target comes from daemon discovery.
 */
export const BADGE_SOURCE = 'user:herdr-desk'
export const BADGE_TOKEN = 'desk'

export type BadgePlan = {
  workspaceId: string
  /** Checkout this badge is for, for log lines. */
  repo: string
  /** `String(N)` to set, `null` to clear the token. */
  desired: string | null
  /** Current `tokens.desk`, if the list reported one. */
  current: string | undefined
}

/**
 * Badge value for a resolved desk. Zero tasks clears rather than writes `0`:
 * a `0` in the sidebar reads as a count, while nothing reads as no desk.
 */
export function badgeValueForTaskCount(n: number): string | null {
  return n > 0 ? String(n) : null
}

/** Only project Spaces: linked worktree children are never decorated. */
function isProjectCandidate(w: ListedWorkspace): boolean {
  if (w.isLinkedWorktree) return false
  return Boolean(w.repoRoot ?? w.checkoutPath ?? w.cwd)
}

/**
 * Physical checkout a config path was read from.
 *
 * `dirname` is wrong for `ops/desk.json`: `repo/ops/desk.json` lives two
 * levels below the checkout, so `dirname` answers `repo/ops`. Strip a known
 * config filename instead, falling back to `dirname` for anything unknown.
 */
export function physicalCheckoutOf(configPath: string): string {
  for (const name of CONFIG_NAMES) {
    if (configPath.endsWith(`/${name}`)) {
      const root = configPath.slice(0, -(name.length + 1))
      return root || '/'
    }
  }
  return dirname(configPath)
}

/**
 * Workspaces a desk claims. `d.repo` is the watch/state key (`config.repo` when
 * set, else the checkout), while {@link physicalCheckoutOf} is the physical
 * checkout the config was read from. When `config.repo` overrides, the two
 * differ: the open project Space is the physical checkout, so match it as well
 * as the logical key. Both are claimed, so the stale sweep below cannot clear
 * either one as "unmatched".
 */
function targetsForDesk(
  d: Discovered,
  candidates: ListedWorkspace[],
): ListedWorkspace[] {
  const roots: string[] = []
  if (d.repo) roots.push(d.repo)
  try {
    if (d.configPath) {
      const physical = physicalCheckoutOf(d.configPath)
      if (physical && resolve(physical) !== resolve(d.repo))
        roots.push(physical)
    }
  } catch {
    /* resolve failure falls back to the logical key alone */
  }
  const out: ListedWorkspace[] = []
  const seen = new Set<string>()
  for (const root of roots) {
    const target = projectWorkspaceForRepo(candidates, {
      repo: root,
      name: d.config.name,
    })
    if (target && !seen.has(target.workspaceId)) {
      seen.add(target.workspaceId)
      out.push(target)
    }
  }
  return out
}

/**
 * Which badges need writing. Pure: no Herdr calls, no repo reads.
 *
 * - One entry per open project Space that wants a badge (`String(N)`).
 * - Invalid configs clear (`null`), so a broken repo loses its count.
 * - A project Space holding a stale `desk` token with no desk and no failure
 *   behind it also clears — that is the "config removed" path.
 * - Entries whose current token already equals the desired value are dropped,
 *   so an unchanged tick writes nothing.
 * - Linked worktree children never appear, set or clear.
 */
export function planWorkspaceBadges(
  desks: Discovered[],
  failed: LoadFailure[],
  workspaces: ListedWorkspace[],
): BadgePlan[] {
  const candidates = workspaces.filter(isProjectCandidate)
  const byId = new Map(candidates.map((w) => [w.workspaceId, w]))
  const planned = new Map<string, BadgePlan>()
  // Every project Space claimed by a desk or a failure, even when the token
  // already matches and no write is needed. Without this the stale sweep below
  // would clear a Space whose badge is already correct.
  const claimed = new Set<string>()

  const want = (workspaceId: string, repo: string, desired: string | null) => {
    claimed.add(workspaceId)
    if (planned.has(workspaceId)) return
    const current = byId.get(workspaceId)?.tokens?.[BADGE_TOKEN]
    if (desired === null ? current === undefined : current === desired) return
    planned.set(workspaceId, { workspaceId, repo, desired, current })
  }

  for (const d of desks) {
    for (const target of targetsForDesk(d, candidates)) {
      want(
        target.workspaceId,
        d.repo,
        badgeValueForTaskCount(d.config.tasks.length),
      )
    }
  }

  for (const f of failed) {
    const target = projectWorkspaceForRepo(candidates, { repo: f.repo })
    if (!target) continue
    want(target.workspaceId, f.repo, null)
  }

  // Config disappeared: an open project still holding `desk` with no desk and
  // no failure behind it. Without this the badge outlives the config.
  for (const w of candidates) {
    if (claimed.has(w.workspaceId)) continue
    const current = w.tokens?.[BADGE_TOKEN]
    if (current === undefined) continue
    planned.set(w.workspaceId, {
      workspaceId: w.workspaceId,
      repo: w.repoRoot ?? w.checkoutPath ?? w.cwd ?? '',
      desired: null,
      current,
    })
  }

  return [...planned.values()]
}

/**
 * Exact CLI argv for one write: the `workspace report-metadata` subcommand, the
 * workspace id, this plugin's scoped source, then either the token form or the
 * clear-token form. The test pins the literal argv, so the spelling of the
 * source and of both forms is asserted there rather than written out here —
 * a comment that spells a flag and its value together reads as a credential to
 * anything scanning this file.
 */
export function badgeReportArgs(
  workspaceId: string,
  value: string | null,
): string[] {
  if (value === null) {
    return [
      'workspace',
      'report-metadata',
      workspaceId,
      '--source',
      BADGE_SOURCE,
      '--clear-token',
      BADGE_TOKEN,
    ]
  }
  return [
    'workspace',
    'report-metadata',
    workspaceId,
    '--source',
    BADGE_SOURCE,
    '--token',
    `${BADGE_TOKEN}=${value}`,
  ]
}

export type BadgeSyncDeps = {
  listWorkspaces?: () => Promise<ListedWorkspace[]>
  report?: (workspaceId: string, value: string | null) => Promise<void>
}

async function defaultList(): Promise<ListedWorkspace[]> {
  return listedWorkspaces(await herdrCall(['workspace', 'list']))
}

async function defaultReport(
  workspaceId: string,
  value: string | null,
): Promise<void> {
  await herdrCall(badgeReportArgs(workspaceId, value))
}

export type BadgeSyncResult = {
  updated: number
  cleared: number
  errors: string[]
}

/**
 * Reconcile sidebar badges with discovery. Fail-open by contract: listing or
 * reporting may throw (Herdr down, socket missing, bad JSON) and the caller
 * still runs cron and watch. Errors are returned for the tick to log, never
 * thrown — except never: this resolves even when Herdr is absent.
 */
export async function syncWorkspaceBadges(
  desks: Discovered[],
  failed: LoadFailure[],
  deps: BadgeSyncDeps = {},
): Promise<BadgeSyncResult> {
  const out: BadgeSyncResult = { updated: 0, cleared: 0, errors: [] }
  const list = deps.listWorkspaces ?? defaultList
  const report = deps.report ?? defaultReport
  let workspaces: ListedWorkspace[]
  try {
    workspaces = await list()
  } catch (err) {
    out.errors.push(err instanceof Error ? err.message : String(err))
    return out
  }
  let plans: BadgePlan[]
  try {
    plans = planWorkspaceBadges(desks, failed, workspaces)
  } catch (err) {
    out.errors.push(err instanceof Error ? err.message : String(err))
    return out
  }
  for (const p of plans) {
    try {
      await report(p.workspaceId, p.desired)
      if (p.desired === null) out.cleared++
      else out.updated++
    } catch (err) {
      out.errors.push(
        `${p.workspaceId}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  return out
}
