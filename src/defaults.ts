import {
  type AgentInput,
  type AgentSpec,
  DEFAULT_AGENT,
  DEFAULT_AGENT_TIMEOUT_MS,
  type DeskConfig,
  type LoadedDesk,
  type TaskConfig,
  type WatchConfig,
  type WatchSpec,
} from './config'
import { cronsOf } from './schedule'
import { WATCH_RANGES } from './schema'
import { deskSlug } from './text'

const BUNDLED_PREFIX = 'desk:'
const LOCAL_PREFIX = 'local:'

/**
 * Watch defaults.
 *
 * `intervalSec: 60` is a minute because that is the cadence a repo-side poll
 * loop is normally written at, so a watcher added today behaves like the loop it
 * replaces. `timeoutSec: 30` is half an interval on purpose: a poll that hangs
 * must be killed before its own successor is due, or one broken script costs two
 * ticks instead of one.
 */
export const DEFAULT_WATCH: Omit<WatchConfig, 'command'> = {
  intervalSec: 60,
  timeoutSec: 30,
  maxPending: 8,
}

/**
 * Fill in a task's watch defaults, and hold the numbers to the documented range.
 *
 * Task-level only. There is no root-level `watch` to inherit: the command is
 * repo-specific, and a group config that could name one would silently point
 * every repo in a tree at a script that only exists in one of them.
 *
 * The clamp is not belt-and-braces. `resolveConfig` folds an ancestor group
 * config **without** calling `validateDeskJson` — deliberately, so one bad
 * shared layer cannot break every repo on the host at once — and a group config
 * *can* carry task-level `watch`. So `intervalSec: 1` and `maxPending: 9999`
 * from a shared layer reached this function unvalidated and were used as
 * written, while the docs and the schema both promise 15–3600 and 1–64. A
 * documented range the code does not honour is not a documentation bug; it is
 * the same defect as a state key nobody writes, wearing a different hat. So the
 * range is enforced here too, where the numbers are actually used.
 */
export function applyWatch(spec: WatchSpec): WatchConfig {
  return {
    command: spec.command,
    intervalSec: clampWatch('intervalSec', spec.intervalSec),
    timeoutSec: clampWatch('timeoutSec', spec.timeoutSec),
    maxPending: clampWatch('maxPending', spec.maxPending),
  }
}

/**
 * One watch number, defaulted then clamped into {@link WATCH_RANGES}.
 *
 * A non-integer or non-numeric value from an unvalidated layer falls back to the
 * default rather than propagating: `Math.min(3600, NaN)` is `NaN`, and a `NaN`
 * interval is a task that is due on every tick forever.
 */
function clampWatch(
  key: keyof typeof WATCH_RANGES,
  raw: number | undefined,
): number {
  const fallback = DEFAULT_WATCH[key]
  const n = raw ?? fallback
  if (!Number.isInteger(n)) return fallback
  const { min, max } = WATCH_RANGES[key]
  return Math.min(max, Math.max(min, n))
}

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
      // A task's own `notify` block. It is not an override of the repo's — the
      // layers fold that separately — so it is carried verbatim and merged at
      // send time. Dropping it here silently sent every job in a repo to the
      // same topic, so a desk that routed one job to its own forum topic put
      // all of them back in the general one.
      notify: t.notify,
      id,
      playbook,
      extra,
      crons,
      schedule: crons.length === 1 ? crons[0] : crons,
      watch: t.watch ? applyWatch(t.watch) : undefined,
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
