import type { TaskConfig } from './config'
import { resolveText } from './text'

function extraText(repo: string, task: TaskConfig): string {
  return resolveText(repo, task.extra).text
}

function extras(text: string): string[] {
  const bits: string[] = []
  const t = text.toLowerCase()
  if (t.includes('never deploy') || t.includes('children never deploy')) {
    bits.push('children never deploy')
  }
  if (t.includes('deploys from') || t.includes('deploy from this `main`')) {
    bits.push('manager deploys from main')
  }
  if (t.includes('unit-tests') && t.includes('dashboard')) {
    bits.push('babysit unit-tests+dashboard')
  }
  if (t.includes('do not wait on github actions')) {
    bits.push('do not wait on GHA')
  }
  if (t.includes('never auto-merge release-please')) {
    bits.push('no release-please merge')
  }
  return bits
}

export function describeJob(repo: string, task: TaskConfig): string {
  if (task.describe) return task.describe

  const n = task.maxChildren ?? 5
  const raw = task.playbook
  const playbook =
    !raw || raw.includes('\n') || raw.endsWith('.md')
      ? (task.label ?? task.id)
      : raw
  const core =
    playbook === 'github-issues'
      ? `Triage issues/PRs; spawn ≤${n} worktrees; write changes.md when done`
      : `${task.label ?? task.id}: run (≤${n}); write changes.md when done`

  const extra = extras(extraText(repo, task))
  return extra.length ? `${core}. ${extra.join('; ')}` : core
}
