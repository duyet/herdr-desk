import {
  type AgentInput,
  type AgentSpec,
  DEFAULT_AGENT,
  DEFAULT_AGENT_TIMEOUT_MS,
  type DeskConfig,
  type LoadedDesk,
  type TaskConfig,
} from './config'
import { cronsOf } from './schedule'
import { deskSlug } from './text'

const BUNDLED_PREFIX = 'desk:'
const LOCAL_PREFIX = 'local:'

/**
 * Merge an `agent` block over a lower-priority spec.
 *
 * A string pins a single rung, which is why `"agent": "claude"` and
 * `"agent": { "ladder": ["claude"] }` mean the same thing. `default` is a
 * convenience alias for a one-rung ladder. An empty or absent `ladder`
 * inherits, so a repo can override only `permission` without restating the
 * machine-wide ladder.
 */
function mergeAgent(base: AgentSpec, input: AgentInput | undefined): AgentSpec {
  if (input === undefined) return base
  if (typeof input === 'string') {
    return { ...base, ladder: input.trim() ? [input.trim()] : base.ladder }
  }
  const ladderRaw = input.ladder ?? input.default
  const ladder =
    typeof ladderRaw === 'string'
      ? [ladderRaw]
      : Array.isArray(ladderRaw)
        ? ladderRaw.map((r) => String(r).trim()).filter(Boolean)
        : undefined
  const out: AgentSpec = { ...base }
  if (ladder?.length) out.ladder = ladder
  if (input.permission !== undefined) out.permission = input.permission
  if (input.timeoutMs !== undefined) out.timeoutMs = input.timeoutMs
  return out
}

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

  // Root agent, lowest priority. `kind` is only consulted when `agent` is
  // absent, so a config that sets both resolves to `agent`.
  const rootAgent = mergeAgent(
    { ...DEFAULT_AGENT, timeoutMs: DEFAULT_AGENT_TIMEOUT_MS },
    raw.agent ?? raw.kind,
  )

  const tasks = (raw.tasks?.length ? raw.tasks : [{}]).map((t) => {
    const playbook = t.playbook || rootPlaybook
    const id = t.id?.trim() || defaultId(playbook)
    const crons = t.schedule !== undefined ? cronsOf(t.schedule) : rootCrons
    const extra = t.extra ?? raw.extra
    return {
      label: t.label ?? 'GitHub issues and PRs',
      agent: mergeAgent(rootAgent, t.agent ?? t.kind),
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
