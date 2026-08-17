import type { TaskConfig } from './config'
import { resolveText } from './text'

export type Slot = 'morning' | 'nightly'

function extraText(repo: string, task: TaskConfig): string {
  return resolveText(repo, task.extraPrompt).text
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

export function describeJob(
  repo: string,
  task: TaskConfig,
  mode: Slot,
): string {
  const override = task.describe?.[mode]
  if (override) return override

  const n = task.maxChildren ?? 5
  const playbook =
    !task.task || task.task.includes('\n') || task.task.endsWith('.md')
      ? (task.label ?? task.id)
      : task.task
  const core =
    mode === 'morning'
      ? playbook === 'github-issues'
        ? `Triage issues/PRs; spawn ≤${n} worktrees; write changes.md when done`
        : `${task.label ?? task.id}: morning dispatch (≤${n}); write changes.md when done`
      : playbook === 'github-issues'
        ? 'Wrap summary; no new work unless one CI-fix left'
        : `${task.label ?? task.id}: nightly wrap`

  const extra = extras(extraText(repo, task))
  return extra.length ? `${core}. ${extra.join('; ')}` : core
}
