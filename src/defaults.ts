import type { DeskConfig, LoadedDesk, TaskConfig } from './config'
import { deskSlug } from './text'

const DEFAULT_TASK_ID = 'issues'

export function applyDefaults(raw: DeskConfig, repo: string): LoadedDesk {
  const name = raw.name.trim()
  const base: TaskConfig = {
    id: DEFAULT_TASK_ID,
    label: 'GitHub issues and PRs',
    task: 'github-issues',
    agentName: raw.agentName ?? deskSlug(name),
    kind: raw.kind ?? 'grok',
    maxChildren: raw.maxChildren ?? 5,
    stateDir: '.herdr-desk/runs/issues',
    extraPrompt: raw.extraPrompt,
    schedule: raw.schedule ?? { morning: '0 7 * * *' },
  }
  const tasks = (raw.tasks?.length ? raw.tasks : [{} as TaskConfig]).map(
    (t) => ({
      ...base,
      ...t,
      extraPrompt: t.extraPrompt ?? raw.extraPrompt,
      schedule: t.schedule ?? raw.schedule ?? base.schedule,
      maxChildren: t.maxChildren ?? raw.maxChildren ?? base.maxChildren,
      kind: t.kind ?? raw.kind ?? base.kind,
      agentName: t.agentName ?? raw.agentName ?? base.agentName,
    }),
  )
  return { ...raw, name, repo: raw.repo ?? repo, tasks }
}
