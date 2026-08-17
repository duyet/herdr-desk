import type { DeskConfig, LoadedDesk, TaskConfig } from './config'
import { cronsOf } from './schedule'
import { deskSlug } from './text'

const BUNDLED_PREFIX = 'desk:'
const LOCAL_PREFIX = 'local:'

function defaultId(playbook: string): string {
  if (playbook.includes('\n')) return `${LOCAL_PREFIX}inline`
  if (
    playbook.endsWith('.md') ||
    playbook.includes('/') ||
    playbook.startsWith('.')
  ) {
    const base = playbook.replace(/\\/g, '/').split('/').pop() ?? playbook
    return `${LOCAL_PREFIX}${base.replace(/\.md$/, '')}`
  }
  return `${BUNDLED_PREFIX}${playbook}`
}

function stateDirFor(id: string, playbook: string): string {
  if (id.startsWith(BUNDLED_PREFIX)) {
    return `.herdr-desk/runs/${playbook}`
  }
  const slug = id.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-|-$/g, '')
  return `.herdr-desk/runs/${slug || 'job'}`
}

export function applyDefaults(raw: DeskConfig, repo: string): LoadedDesk {
  const name = raw.name.trim()
  const rootPlaybook = raw.playbook || 'github-issues'
  const rootCrons = cronsOf(raw.schedule)
  const tasks = (raw.tasks?.length ? raw.tasks : [{}]).map((t) => {
    const playbook = t.playbook || rootPlaybook
    const id = t.id?.trim() || defaultId(playbook)
    const crons = t.schedule !== undefined ? cronsOf(t.schedule) : rootCrons
    const extra = t.extra ?? raw.extra
    return {
      label: t.label ?? 'GitHub issues and PRs',
      kind: t.kind ?? raw.kind ?? 'grok',
      maxChildren: t.maxChildren ?? raw.maxChildren ?? 5,
      agentName: t.agentName ?? raw.agentName ?? deskSlug(name),
      describe: t.describe,
      id,
      playbook,
      extra,
      crons,
      schedule: crons.length === 1 ? crons[0] : crons,
      stateDir: t.stateDir ?? stateDirFor(id, playbook),
    } satisfies TaskConfig
  })
  const loaded: LoadedDesk = {
    ...raw,
    name,
    repo: raw.repo ?? repo,
    tasks,
  }
  return loaded
}
