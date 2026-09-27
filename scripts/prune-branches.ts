#!/usr/bin/env bun
/**
 * Delete branches whose work has landed, and refuse to touch anything else.
 *
 * Why not `git cherry` / patch-id: this repo squash-merges (release-please, and
 * squash PR titles are the release commit). A squash changes every patch-id, so
 * patch-id reports already-landed branches as unmerged. That is the wrong answer
 * in both directions — it hid three dead branches and would have kept them
 * forever. GitHub already knows what merged, so ask GitHub.
 *
 * The guards, in order:
 *   1. a branch must have at least one **merged** PR to be a candidate. A branch
 *      with no PR history is never touched, which is what protects in-progress
 *      work that was pushed but not yet proposed.
 *   2. no **open** PR may reference it.
 *   3. never `main`, `master`, or a `release-please--*` branch.
 *   4. never a branch that is ahead of `main` by patch-id, as a backstop for
 *      any PR state GitHub has not caught up on.
 *
 * Usage:
 *   bun scripts/prune-branches.ts            # report only
 *   bun scripts/prune-branches.ts --yes      # delete
 *   bun scripts/prune-branches.ts --remote origin
 */

const args = process.argv.slice(2)
const apply = args.includes('--yes') || args.includes('-y')
const remote = argOf('--remote') ?? 'origin'
const base = argOf('--base') ?? 'main'

function argOf(flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}

const PROTECTED = new Set(['main', 'master', 'develop'])
const isReleasePlease = (b: string) => b.startsWith('release-please--')
/** Local worktree branches the desk plugin creates for a manager. */
const isDeskWorktree = (b: string) => b.startsWith('desk/')

type Pr = { number: number; headRefName: string; state: string; mergedAt: string | null }

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

const branches = sh(['git', 'branch', '-r', '--format=%(refname:short)'])
  .split('\n')
  .map((b) => b.replace(/^origin\//, '').trim())
  .filter((b) => b && !b.includes('/HEAD'))

const prs = gh<Pr[]>([
  'pr', 'list', '--state', 'all', '--limit', '200',
  '--json', 'number,headRefName,state,mergedAt',
])

const byBranch = new Map<string, Pr[]>()
for (const pr of prs) {
  const list = byBranch.get(pr.headRefName) ?? []
  list.push(pr)
  byBranch.set(pr.headRefName, list)
}

const unmergedAhead = (branch: string): number => {
  const out = sh(['git', 'cherry', base, branch])
  return out.split('\n').filter((l) => l.startsWith('+')).length
}

const deleted: string[] = []
const kept: Array<{ branch: string; why: string }> = []

for (const branch of branches.sort()) {
  if (PROTECTED.has(branch) || isReleasePlease(branch)) {
    kept.push({ branch, why: 'protected' })
    continue
  }
  if (isDeskWorktree(branch)) {
    kept.push({ branch, why: 'desk manager worktree' })
    continue
  }
  const branchPrs = byBranch.get(branch) ?? []
  const merged = branchPrs.filter((p) => p.mergedAt !== null)
  const open = branchPrs.filter((p) => p.state === 'OPEN')

  // Guard 1: no merged PR means no evidence the work landed. An empty PR list is
  // NOT "all merged" — it is "unknown", and unknown must not be deleted.
  if (merged.length === 0) {
    kept.push({ branch, why: 'no merged PR (in-flight or unpushed work)' })
    continue
  }
  // Guard 2
  if (open.length > 0) {
    kept.push({ branch, why: `open PR #${open[0]?.number}` })
    continue
  }
  // Guard 4
  const ahead = unmergedAhead(branch)
  if (ahead > 0) {
    kept.push({ branch, why: `${ahead} commit(s) not in ${base}` })
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
  deleted.push(`${branch} (#${merged.map((p) => p.number).join(', #')})`)
}

const label = apply ? 'deleted' : 'would delete'
console.log(apply ? `pruned ${deleted.length} branch(es)` : `dry run — ${deleted.length} branch(es) would be deleted`)
for (const d of deleted) console.log(`  ${label}: ${d}`)
if (kept.length) {
  console.log(`\nkept ${kept.length}:`)
  for (const k of kept) console.log(`  ${k.branch}  — ${k.why}`)
}
