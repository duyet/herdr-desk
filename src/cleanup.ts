import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import { isStaleClaim } from './claim'
import type { TaskConfig } from './config'
import { herdrCall, isAgentLive, type ListedAgent, namedAgents } from './herdr'
import { claimMaxAgeMs, runDirFor, spawnClaimPath } from './run'

/** A finished run dir or manager pane is kept this long before it is stale. */
export const RETAIN_DAYS = 14
const DAY_MS = 86_400_000
const DAY_DIR = /^\d{4}-\d{2}-\d{2}$/

/**
 * Branch prefix of every worktree the desk creates: a manager's `desk/<job>`
 * and the children `herdr-desk child` opens as `desk/<job>--<item>`.
 */
const DESK_BRANCH = 'desk/'

export type CleanupItem =
  | {
      kind: 'worktree'
      repo: string
      path: string
      branch: string
      why: string
    }
  | {
      kind: 'branch'
      repo: string
      branch: string
      /** Tip at plan time; the delete is refused if the branch moved since. */
      oid: string
      why: string
    }
  | { kind: 'rundir'; path: string; why: string }
  | { kind: 'lock'; path: string; maxAgeMs: number; why: string }
  | { kind: 'pane'; paneId: string; agent: string; why: string }

type Kept = { what: string; why: string }

export type CleanupPlan = {
  items: CleanupItem[]
  /** Candidates that were looked at and kept, with the reason. */
  kept: Kept[]
  /** Sources that could not be read; their candidates are neither listed nor removed. */
  unavailable: string[]
}

export type WorktreeEntry = {
  path: string
  branch?: string
  /** Checked-out commit, from the porcelain `HEAD` line. */
  head?: string
  locked: boolean
  /** Git reports the directory gone; `git worktree prune` drops the entry. */
  prunable?: boolean
  /** The repo's own checkout, always the first `git worktree list` entry. */
  main: boolean
}

export type PrInfo = { state: string; headOid?: string }

/** Everything cleanup learns from outside the process, so tests can fake it. */
export type Probe = {
  worktrees(repo: string): Promise<WorktreeEntry[]>
  /** `null` when the branch has no PR, or GitHub cannot be asked. */
  pr(repo: string, branch: string): Promise<PrInfo | null>
  isDirty(path: string): Promise<boolean>
  /** Local `desk/*` branches and their tips. */
  branches(repo: string): Promise<Array<{ name: string; oid: string }>>
  /** `rev` (HEAD by default) is reachable from some remote-tracking ref. */
  headOnRemote(path: string, rev?: string): Promise<boolean>
  /** `rev` (HEAD by default) is an ancestor of `oid`, the merged PR head. */
  headWithin(path: string, oid: string, rev?: string): Promise<boolean>
  /** `null` when Herdr cannot be asked. */
  agents(): Promise<ListedAgent[] | null>
}

async function run(
  cmd: string[],
  cwd: string,
): Promise<{ ok: boolean; out: string }> {
  try {
    const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
    const [out, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ])
    return { ok: code === 0, out: out.trim() }
  } catch {
    return { ok: false, out: '' }
  }
}

export function parseWorktrees(porcelain: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = []
  for (const block of porcelain.split(/\n\s*\n/)) {
    let path = ''
    let branch: string | undefined
    let head: string | undefined
    let locked = false
    let prunable = false
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice(9)
      else if (line.startsWith('HEAD ')) head = line.slice(5)
      else if (line.startsWith('branch refs/heads/'))
        branch = line.slice('branch refs/heads/'.length)
      else if (line === 'locked' || line.startsWith('locked ')) locked = true
      else if (line === 'prunable' || line.startsWith('prunable '))
        prunable = true
    }
    if (path)
      out.push({ path, branch, head, locked, prunable, main: out.length === 0 })
  }
  return out
}

export const realProbe: Probe = {
  async worktrees(repo) {
    const r = await run(['git', 'worktree', 'list', '--porcelain'], repo)
    return r.ok ? parseWorktrees(r.out) : []
  },
  async pr(repo, branch) {
    const r = await run(
      ['gh', 'pr', 'view', branch, '--json', 'state,headRefOid'],
      repo,
    )
    if (!r.ok) return null
    try {
      const j = JSON.parse(r.out) as { state?: string; headRefOid?: string }
      return j.state ? { state: j.state, headOid: j.headRefOid } : null
    } catch {
      return null
    }
  },
  async branches(repo) {
    const r = await run(
      [
        'git',
        'for-each-ref',
        '--format=%(refname:short) %(objectname)',
        `refs/heads/${DESK_BRANCH}`,
      ],
      repo,
    )
    if (!r.ok || !r.out) return []
    return r.out.split('\n').map((line) => {
      const [name, oid] = line.split(' ')
      return { name, oid }
    })
  },
  async isDirty(path) {
    const r = await run(['git', 'status', '--porcelain'], path)
    // If git cannot answer, assume there is work in there.
    return !r.ok || r.out !== ''
  },
  async headOnRemote(path, rev = 'HEAD') {
    const r = await run(['git', 'branch', '-r', '--contains', rev], path)
    return r.ok && r.out !== ''
  },
  async headWithin(path, oid, rev = 'HEAD') {
    const r = await run(['git', 'merge-base', '--is-ancestor', rev, oid], path)
    return r.ok
  },
  async agents() {
    try {
      return namedAgents(await herdrCall(['agent', 'list']))
    } catch {
      return null
    }
  },
}

/** `path` is `dir` or somewhere inside it. */
function isWithin(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep)
}

/** Liveness by Herdr's status alone: a working agent never loses its pane. */
const byStatus = () => true

/**
 * Finished agents still sitting in a worktree the plan removes. Their pane
 * would outlive the checkout it was opened on, so it closes first.
 */
function panesIn(path: string, agents: ListedAgent[]): CleanupItem[] {
  return agents
    .filter(
      (a) =>
        a.paneId && a.cwd && !isAgentLive(a, byStatus) && isWithin(a.cwd, path),
    )
    .map((a) => ({
      kind: 'pane',
      paneId: a.paneId as string,
      agent: a.name,
      why: `agent ${a.status ?? 'gone'}, worktree removed`,
    }))
}

/**
 * Decide whether one desk worktree may be removed, or say why not.
 *
 * Every rule here is a way of losing work, so each is a separate early exit and
 * anything unknown keeps the worktree: no PR, an open PR, a dirty tree, a HEAD
 * that exists nowhere else. Removal is only offered for a PR that is finished
 * (merged or closed) *and* whose commits are safe elsewhere.
 */
async function judgeWorktree(
  repo: string,
  wt: WorktreeEntry,
  probe: Probe,
  liveCwds: string[],
): Promise<{ remove: boolean; why: string }> {
  if (wt.main) return { remove: false, why: 'main checkout' }
  if (wt.locked) return { remove: false, why: 'locked' }
  if (liveCwds.some((cwd) => isWithin(cwd, wt.path)))
    return { remove: false, why: 'agent still live' }

  const pr = await probe.pr(repo, wt.branch ?? '')
  if (!pr) return { remove: false, why: 'no PR, or PR state unknown' }
  const state = pr.state.toUpperCase()
  if (state !== 'MERGED' && state !== 'CLOSED')
    return { remove: false, why: `PR ${state.toLowerCase()}` }

  if (await probe.isDirty(wt.path))
    return { remove: false, why: 'uncommitted changes' }

  // A squash merge leaves the local commits on no remote branch, so a merged
  // PR is also safe when HEAD is inside the head the PR was merged with.
  const safe =
    (await probe.headOnRemote(wt.path)) ||
    (state === 'MERGED' &&
      pr.headOid !== undefined &&
      (await probe.headWithin(wt.path, pr.headOid)))
  if (!safe) return { remove: false, why: 'commits not pushed or merged' }

  return { remove: true, why: `PR ${state.toLowerCase()}` }
}

/**
 * May a `desk/*` branch with no worktree be deleted? Only when its PR merged and
 * its tip is safe elsewhere. A closed-unmerged PR keeps its branch: that work
 * never landed, and a local branch is the cheapest place to find it again.
 */
async function judgeBranch(
  repo: string,
  name: string,
  oid: string,
  probe: Probe,
): Promise<{ remove: boolean; why: string }> {
  const pr = await probe.pr(repo, name)
  if (!pr) return { remove: false, why: 'no PR, or PR state unknown' }
  const state = pr.state.toUpperCase()
  if (state !== 'MERGED')
    return { remove: false, why: `PR ${state.toLowerCase()}` }
  const safe =
    (await probe.headOnRemote(repo, oid)) ||
    (pr.headOid !== undefined &&
      (await probe.headWithin(repo, pr.headOid, oid)))
  if (!safe) return { remove: false, why: 'commits not pushed or merged' }
  return { remove: true, why: 'PR merged' }
}

function latestDay(stateDir: string, taskId: string): string | undefined {
  try {
    const raw = readFileSync(join(stateDir, 'LATEST'), 'utf8').trim()
    return raw.startsWith(`${taskId}/`) ? raw.slice(taskId.length + 1) : raw
  } catch {
    return undefined
  }
}

/** Day dirs of one task older than `RETAIN_DAYS`, except the one LATEST names. */
export function staleRunDirs(
  repo: string,
  task: TaskConfig,
  now: Date,
): { stale: string[]; kept: Kept[] } {
  const stale: string[] = []
  const kept: Kept[] = []
  let root: string
  try {
    root = dirname(runDirFor(repo, task, 'x'))
  } catch {
    return { stale, kept }
  }
  if (!existsSync(root)) return { stale, kept }

  const latest = latestDay(root, task.id)
  const cutoff = now.getTime() - RETAIN_DAYS * DAY_MS
  for (const name of readdirSync(root).sort()) {
    if (!DAY_DIR.test(name)) continue
    // Local midnight, matching `dayKey`.
    const at = new Date(`${name}T00:00:00`).getTime()
    if (Number.isNaN(at) || at >= cutoff) continue
    const path = join(root, name)
    if (name === latest) kept.push({ what: path, why: 'LATEST points here' })
    else stale.push(path)
  }
  return { stale, kept }
}

type SpawnRecord = { agent?: string; paneId?: string; startedAt?: string }

/**
 * Panes the desk opened (recorded in `spawn.json`) whose agent has finished.
 * A pane is only stale once its run is past retention *and* Herdr reports the
 * agent under that name in that pane as no longer live.
 */
function stalePanes(
  runDirs: string[],
  agents: ListedAgent[],
  now: Date,
): CleanupItem[] {
  const cutoff = now.getTime() - RETAIN_DAYS * DAY_MS
  const out: CleanupItem[] = []
  const seen = new Set<string>()
  for (const dir of runDirs) {
    let rec: SpawnRecord
    try {
      rec = JSON.parse(readFileSync(join(dir, 'spawn.json'), 'utf8'))
    } catch {
      continue
    }
    const started = Date.parse(rec.startedAt ?? '')
    if (!rec.agent || !rec.paneId || Number.isNaN(started)) continue
    if (started >= cutoff || seen.has(rec.paneId)) continue
    const agent = agents.find(
      (a) => a.name === rec.agent && a.paneId === rec.paneId,
    )
    if (!agent || isAgentLive(agent)) continue
    seen.add(rec.paneId)
    out.push({
      kind: 'pane',
      paneId: rec.paneId,
      agent: rec.agent,
      why: `agent ${agent.status ?? 'gone'}, run ${basename(dir)}`,
    })
  }
  return out
}

export type CleanupDesk = { repo: string; tasks: TaskConfig[] }

/**
 * What a cleanup would remove. Pure read: this is what `--dry-run` prints and
 * exactly what `cleanup` executes, so the two cannot disagree.
 */
export async function planCleanup(
  desks: CleanupDesk[],
  probe: Probe = realProbe,
  now = new Date(),
): Promise<CleanupPlan> {
  const plan: CleanupPlan = { items: [], kept: [], unavailable: [] }
  const agents = await probe.agents()
  if (!agents) plan.unavailable.push('herdr agents (panes not checked)')
  const liveCwds = (agents ?? [])
    .filter((a) => isAgentLive(a) && a.cwd)
    .map((a) => a.cwd as string)

  const expired: string[] = []
  for (const desk of desks) {
    // A prunable entry's directory is already gone; apply prunes it first.
    const worktrees = (await probe.worktrees(desk.repo)).filter(
      (w) => !w.prunable,
    )
    const checkedOut = new Set(worktrees.map((w) => w.branch))
    const removable = new Set<string>()
    for (const wt of worktrees) {
      // Only worktrees the desk made; anything else is not ours to judge.
      const branch = wt.branch
      if (!branch?.startsWith(DESK_BRANCH)) continue
      const verdict = await judgeWorktree(desk.repo, wt, probe, liveCwds)
      if (verdict.remove) {
        plan.items.push({
          kind: 'worktree',
          repo: desk.repo,
          path: wt.path,
          branch,
          why: verdict.why,
        })
        if (agents) plan.items.push(...panesIn(wt.path, agents))
        removable.add(branch)
      } else {
        plan.kept.push({ what: wt.path, why: verdict.why })
      }
    }
    for (const { name, oid } of await probe.branches(desk.repo)) {
      // A branch whose worktree is kept stays with it.
      if (checkedOut.has(name) && !removable.has(name)) continue
      const verdict = await judgeBranch(desk.repo, name, oid, probe)
      if (verdict.remove) {
        plan.items.push({
          kind: 'branch',
          repo: desk.repo,
          branch: name,
          oid,
          why: verdict.why,
        })
      } else if (!checkedOut.has(name)) {
        plan.kept.push({ what: `branch ${name}`, why: verdict.why })
      }
    }
    const locks = new Set<string>()
    for (const task of desk.tasks) {
      let path: string
      try {
        path = spawnClaimPath(desk.repo, task)
      } catch {
        continue
      }
      const maxAgeMs = claimMaxAgeMs(task)
      if (locks.has(path) || !isStaleClaim(path, maxAgeMs, now.getTime()))
        continue
      locks.add(path)
      plan.items.push({
        kind: 'lock',
        path,
        maxAgeMs,
        why: 'holder gone or past its timeout',
      })
    }
    const dirs = new Set<string>()
    for (const task of desk.tasks) {
      const { stale, kept } = staleRunDirs(desk.repo, task, now)
      plan.kept.push(...kept)
      for (const path of stale) dirs.add(path)
    }
    for (const path of [...dirs].sort()) {
      expired.push(path)
      plan.items.push({
        kind: 'rundir',
        path,
        why: `older than ${RETAIN_DAYS} days`,
      })
    }
  }
  if (agents) {
    const planned = new Set(
      plan.items.flatMap((i) => (i.kind === 'pane' ? [i.paneId] : [])),
    )
    plan.items.push(
      ...stalePanes(expired, agents, now).filter(
        (i) => i.kind !== 'pane' || !planned.has(i.paneId),
      ),
    )
  }
  return plan
}

export type CleanupResult = {
  removed: CleanupItem[]
  failed: Array<{ item: CleanupItem; error: string }>
}

/** Panes close before their worktree goes, and a branch only once it is free. */
const APPLY_ORDER: Record<CleanupItem['kind'], number> = {
  pane: 0,
  worktree: 1,
  branch: 2,
  lock: 3,
  rundir: 4,
}

async function removeItem(item: CleanupItem): Promise<void> {
  switch (item.kind) {
    case 'pane':
      await herdrCall(['pane', 'close', item.paneId])
      return
    case 'rundir':
      rmSync(item.path, { recursive: true })
      return
    case 'lock':
      // A fire may have taken the lock since the plan; only a still-stale one goes.
      if (isStaleClaim(item.path, item.maxAgeMs))
        rmSync(item.path, { force: true })
      return
    case 'worktree': {
      // No --force: git itself refuses a dirty or locked worktree, a last
      // line of defence behind the plan's own checks.
      const r = await run(['git', 'worktree', 'remove', item.path], item.repo)
      if (!r.ok) throw new Error('git worktree remove refused')
      return
    }
    case 'branch': {
      // `update-ref` does not know about worktrees, so check none has it out.
      const held = (await realProbe.worktrees(item.repo)).some(
        (w) => w.branch === item.branch,
      )
      if (held) throw new Error('branch is still checked out')
      // The old-value argument makes this a compare-and-delete: a commit that
      // landed after the plan was made keeps the branch.
      const r = await run(
        ['git', 'update-ref', '-d', `refs/heads/${item.branch}`, item.oid],
        item.repo,
      )
      if (!r.ok) throw new Error('branch moved since the plan; kept')
      return
    }
    default: {
      const never: never = item
      throw new Error(`unknown item ${JSON.stringify(never)}`)
    }
  }
}

/**
 * Remove exactly the items in `plan`, nothing it did not list.
 *
 * Each of `repos` gets `git worktree prune` first. It only drops git's record
 * of a worktree whose directory is already gone, so it is safe to repeat, and
 * a stale record would otherwise hold its branch "checked out" forever.
 */
export async function applyCleanup(
  plan: CleanupPlan,
  repos: string[] = [],
): Promise<CleanupResult> {
  for (const repo of new Set(repos))
    await run(['git', 'worktree', 'prune'], repo)
  const result: CleanupResult = { removed: [], failed: [] }
  const ordered = [...plan.items].sort(
    (a, b) => APPLY_ORDER[a.kind] - APPLY_ORDER[b.kind],
  )
  for (const item of ordered) {
    try {
      await removeItem(item)
      result.removed.push(item)
    } catch (err) {
      result.failed.push({
        item,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return result
}

function describeItem(item: CleanupItem): string {
  switch (item.kind) {
    case 'worktree':
      return `worktree  ${item.path}  (${item.branch}, ${item.why})`
    case 'branch':
      return `branch    ${item.branch}  (${item.oid.slice(0, 8)}, ${item.why})`
    case 'rundir':
      return `run dir   ${item.path}  (${item.why})`
    case 'lock':
      return `lock      ${item.path}  (${item.why})`
    case 'pane':
      return `pane      ${item.paneId}  (${item.agent}, ${item.why})`
    default: {
      const never: never = item
      return String(never)
    }
  }
}

export function formatCleanup(plan: CleanupPlan, dryRun: boolean): string {
  const lines: string[] = []
  if (plan.items.length === 0) lines.push('nothing to clean up')
  else {
    lines.push(
      `${dryRun ? 'would remove' : 'removing'} ${plan.items.length}:`,
      ...plan.items.map((i) => `  ${describeItem(i)}`),
    )
  }
  if (plan.kept.length > 0) {
    lines.push('', `kept ${plan.kept.length}:`)
    lines.push(...plan.kept.map((k) => `  ${k.what}  — ${k.why}`))
  }
  for (const u of plan.unavailable) lines.push('', `unavailable: ${u}`)
  if (dryRun && plan.items.length > 0)
    lines.push('', 'dry run — `herdr-desk cleanup` removes exactly this')
  return lines.join('\n')
}

export function formatResult(result: CleanupResult): string {
  const lines = [`removed ${result.removed.length}`]
  for (const f of result.failed)
    lines.push(`  failed: ${describeItem(f.item)}  — ${f.error}`)
  return lines.join('\n')
}
