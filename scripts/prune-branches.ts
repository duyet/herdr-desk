#!/usr/bin/env bun
/**
 * Delete branches whose work has landed, and refuse to touch anything else.
 *
 * Why not `git cherry` / patch-id: this repo squash-merges (release-please, and
 * squash PR titles are the release commit). A squash changes every patch-id, so
 * patch-id reports already-merged branches as unmerged. That is the wrong answer
 * in both directions — it hid three dead branches and would have kept them
 * forever. GitHub already knows what merged, so ask GitHub.
 *
 * The guards, in order:
 *   1. a branch must have at least one **merged** PR to be a candidate. A branch
 *      with no PR history is never touched, which is what protects in-progress
 *      work that was pushed but not yet proposed.
 *   2. no **open** PR may reference it.
 *   3. never `main`, `master`, or a `release-please--*` branch.
 *   4. never a branch whose tip is newer than its last merged PR — the
 *      squash-aware backstop. A squash merge lands the tip's content under a
 *      rewritten commit, so no commit-level comparison (`git cherry`, ancestry)
 *      can tell a landed branch from an unmerged one. The only work a merged PR
 *      can leave behind is a commit pushed to the branch afterwards, and those
 *      carry a committer date later than the merge itself.
 *
 * Usage:
 *   bun scripts/prune-branches.ts            # report only
 *   bun scripts/prune-branches.ts --yes      # delete
 *   bun scripts/prune-branches.ts --remote origin
 */

export type Pr = { number: number; headRefName: string; state: string; mergedAt: string | null }

export type Decision = { action: 'keep' | 'delete'; why: string }

const PROTECTED = new Set(['main', 'master', 'develop'])
const isReleasePlease = (b: string) => b.startsWith('release-please--')
/** Local worktree branches the desk plugin creates for a manager. */
const isDeskWorktree = (b: string) => b.startsWith('desk/')

/**
 * One branch's fate, from the evidence GitHub and git give us. Every guard is
 * a way of losing work, so the first match wins and anything unknown keeps
 * the branch.
 *
 * `tipCommittedAtMs` is the branch tip's committer instant in epoch ms, or
 * null when git could not produce one.
 */
export function classifyBranch(
  branch: string,
  prs: Pr[],
  tipCommittedAtMs: number | null,
): Decision {
  if (PROTECTED.has(branch) || isReleasePlease(branch)) {
    return { action: 'keep', why: 'protected' }
  }
  if (isDeskWorktree(branch)) {
    return { action: 'keep', why: 'desk manager worktree' }
  }
  const merged = prs
    .filter((p): p is Pr & { mergedAt: string } => p.mergedAt !== null)
    .map((p) => ({ number: p.number, at: Date.parse(p.mergedAt) }))
  const open = prs.filter((p) => p.state === 'OPEN')

  // Guard 1: no merged PR means no evidence the work landed. An empty PR list
  // is NOT "all merged" — it is "unknown", and unknown must not be deleted.
  if (merged.length === 0) {
    return { action: 'keep', why: 'no merged PR (in-flight or unpushed work)' }
  }
  // Guard 2
  if (open.length > 0) {
    return { action: 'keep', why: `open PR #${open[0]?.number}` }
  }
  // Guard 4: squash-aware backstop. Work pushed to the branch after its last
  // merge is real, unlanded work that no PR describes, and it carries a
  // committer date later than the merge itself. Patch-id (`git cherry`) cannot
  // play this role in a squash-merge repo: the squash commit on main rewrites
  // every patch-id, so landed branches report as ahead forever and are never
  // deleted.
  const lastMergedAt = Math.max(...merged.map((m) => m.at).filter(Number.isFinite))
  if (!Number.isFinite(lastMergedAt)) {
    return { action: 'keep', why: 'merged PR date unreadable' }
  }
  if (tipCommittedAtMs === null || !Number.isFinite(tipCommittedAtMs)) {
    return { action: 'keep', why: 'tip commit date unreadable' }
  }
  if (tipCommittedAtMs > lastMergedAt) {
    return { action: 'keep', why: 'tip commit is newer than the last merged PR' }
  }
  return { action: 'delete', why: `#${merged.map((m) => m.number).join(', #')}` }
}

function argOf(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}

function gh<T>(args: string[]): T {
  const proc = Bun.spawnSync(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (proc.exitCode !== 0) {
    throw new Error(`gh ${args.join(' ')}: ${proc.stderr.toString().trim()}`)
  }
  return JSON.parse(proc.stdout.toString() || '[]') as T
}

function sh(cmd: string[]): string {
  return Bun.spawnSync(cmd, { stdout: 'pipe' }).stdout.toString().trim()
}

/** Committer instant of the branch tip, on the remote — or null if unreadable. */
const tipCommittedAtMs = (branch: string): number | null => {
  const iso = sh(['git', 'log', '-1', '--format=%cI', `origin/${branch}`])
  const at = iso ? Date.parse(iso) : Number.NaN
  return Number.isFinite(at) ? at : null
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const apply = args.includes('--yes') || args.includes('-y')
  const remote = argOf(args, '--remote') ?? 'origin'

  const branches = sh(['git', 'branch', '-r', '--format=%(refname:short)'])
    .split('\n')
    .map((b) => b.replace(/^origin\//, '').trim())
    .filter((b) => b && !b.includes('/HEAD'))

  const prs = gh<Pr[]>([
    'pr', 'list', '--state', 'all', '--limit', '200',
    '--json', 'number,headRefName,state,mergedAt',
  ])

  const byBranch = new Map<string, Pr[]>()
  for (const p of prs) {
    const list = byBranch.get(p.headRefName) ?? []
    list.push(p)
    byBranch.set(p.headRefName, list)
  }

  const deleted: string[] = []
  const kept: Array<{ branch: string; why: string }> = []

  for (const branch of branches.sort()) {
    const d = classifyBranch(branch, byBranch.get(branch) ?? [], tipCommittedAtMs(branch))
    if (d.action === 'keep') {
      kept.push({ branch, why: d.why })
      continue
    }
    if (!apply) {
      deleted.push(`${branch} (would delete)`)
      continue
    }
    const rmRemote = Bun.spawnSync(['git', 'push', remote, '--delete', branch], {
      stdout: 'pipe', stderr: 'pipe',
    })
    if (rmRemote.exitCode !== 0) {
      kept.push({ branch, why: `remote delete failed: ${rmRemote.stderr.toString().trim()}` })
      continue
    }
    // Local only if it exists; the shared tree may not have checked it out.
    Bun.spawnSync(['git', 'branch', '-D', branch], { stdout: 'pipe', stderr: 'pipe' })
    deleted.push(`${branch} (${d.why})`)
  }

  const label = apply ? 'deleted' : 'would delete'
  console.log(apply ? `pruned ${deleted.length} branch(es)` : `dry run — ${deleted.length} branch(es) would be deleted`)
  for (const d of deleted) console.log(`  ${label}: ${d}`)
  if (kept.length) {
    console.log(`\nkept ${kept.length}:`)
    for (const k of kept) console.log(`  ${k.branch}  — ${k.why}`)
  }
}
