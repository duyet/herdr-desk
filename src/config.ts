import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyDefaults } from './defaults'
import { resolveConfig } from './layers'
import {
  CONFIG_NAMES as CONFIG_NAMES_,
  findConfigPath as findConfigPath_,
} from './paths'
import { validateDeskJson } from './schema'

export const DESK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Cron string, or several crons that all run the same playbook. */
export type Schedule = string | string[]

/**
 * Resolved agent selection.
 *
 * `ladder` is ordered by preference: the first rung is tried first, and a
 * failure escalates down the list. A rung is either a bare Herdr agent kind
 * (`claude`) or a command (`anyr claude --yolo`, `opencode2`,
 * `./scripts/desk-agent.sh`) — see `agents.ts` for how the transport is chosen.
 */
export type AgentSpec = {
  ladder: string[]
  /** Permission posture, e.g. `default` or `yolo`. */
  permission: string
  /** Readiness budget for one launch attempt, in ms. */
  timeoutMs?: number
}

/**
 * Defaults preserve 0.1.x behaviour exactly. The default rung stays `grok`
 * because every repo that never set `kind` was running grok; changing it would
 * silently switch agents on upgrade.
 */
export const DEFAULT_AGENT: AgentSpec = {
  ladder: ['grok'],
  permission: 'default',
}

export const DEFAULT_AGENT_TIMEOUT_MS = 180_000

/** Authoring form: a bare rung, or a block overriding parts of the ladder. */
export type AgentInput =
  | string
  | {
      ladder?: string | string[]
      default?: string
      permission?: string
      timeoutMs?: number
    }

/**
 * Per-desk notification *destination*.
 *
 * Deliberately has no `token` field. The bot token is a host secret read only
 * from `notify.json` or the environment, and a repo config is committed — so the
 * type itself makes "put the token in a repo" impossible rather than merely
 * discouraged. A repo may retarget where a notice goes; only the host decides
 * who it goes as.
 */
export type NotifyOverride = {
  enabled?: boolean
  chatId?: string
  topicId?: string
}

export type TaskConfig = {
  id: string
  label?: string
  playbook: string
  agentName: string
  /** Resolved agent selection. Replaces the 0.1.x `kind` field. */
  agent: AgentSpec
  /** Notification destination for this job, after layering. */
  notify?: NotifyOverride
  maxChildren?: number
  /** Authoring form (string or list). */
  schedule?: Schedule
  /** Normalized cron list after defaults. */
  crons: string[]
  stateDir?: string
  extra?: string
  describe?: string
}

export type DeskConfig = {
  $schema?: string
  name: string
  /**
   * Marks this file as an umbrella config for every repo beneath its directory.
   * Required rather than inferred, so a stray config in a parent directory
   * cannot silently start steering a repo.
   */
  group?: boolean
  repo?: string
  extra?: string
  playbook?: string
  schedule?: Schedule
  maxChildren?: number
  agentName?: string
  agent?: AgentInput
  /** Retarget this desk's notices. Cannot set the token. */
  notify?: NotifyOverride
  /** @deprecated 0.1.x single-rung field. Read as `agent`; still accepted. */
  kind?: string
  tasks?: Array<
    Partial<
      Omit<
        TaskConfig,
        'crons' | 'playbook' | 'agentName' | 'id' | 'agent' | 'notify'
      >
    > & {
      id?: string
      playbook?: string
      agentName?: string
      schedule?: Schedule
      agent?: AgentInput
      notify?: NotifyOverride
      /** @deprecated use `agent`. */
      kind?: string
    }
  >
}

export type LoadedDesk = Omit<DeskConfig, 'tasks'> & {
  tasks: TaskConfig[]
}

export const CONFIG_NAMES = CONFIG_NAMES_
export function findConfigPath(repo: string): string | null {
  return findConfigPath_(repo)
}

/**
 * The one entry point every consumer uses: `run`, `discover`, `config show`,
 * `config explain`, and notify.
 *
 * Validation stays scoped to the repo's own file on purpose. Shared layers are
 * machine-owned, and a malformed one must not be able to break every repo on
 * the host at once; `doctor` is where a bad shared layer gets reported.
 */
export function loadDeskConfig(repo: string): LoadedDesk {
  const path = findConfigPath(repo)
  if (!path) {
    throw new Error(
      `no herdr-desk config in ${repo} (looked for ${CONFIG_NAMES.join(', ')})`,
    )
  }
  const own = JSON.parse(readFileSync(path, 'utf8')) as DeskConfig
  const errors = validateDeskJson(own, path, repo)
  if (errors.length) throw new Error(errors.join('\n'))
  const { config } = resolveConfig(repo)
  return applyDefaults(config, repo)
}

export function resolveTask(config: LoadedDesk, taskId?: string): TaskConfig {
  if (!taskId) {
    if (config.tasks.length === 1) return config.tasks[0]
    throw new Error(
      `pass a task id (${config.tasks.map((t) => t.id).join(', ')})`,
    )
  }
  const found = config.tasks.find((t) => t.id === taskId)
  if (!found) throw new Error(`unknown task '${taskId}'`)
  return found
}

export function resolveTaskPromptPath(task: TaskConfig, repo: string): string {
  const playbook = task.playbook
  if (
    playbook.endsWith('.md') ||
    playbook.includes('/') ||
    playbook.startsWith('.')
  ) {
    return isAbsolute(playbook) ? playbook : resolve(repo, playbook)
  }
  const bundled = join(DESK_ROOT, 'prompts', 'tasks', `${playbook}.md`)
  if (!existsSync(bundled)) {
    throw new Error(`bundled playbook not found: ${bundled}`)
  }
  return bundled
}

export function listBundledTasks(): string[] {
  const dir = join(DESK_ROOT, 'prompts', 'tasks')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''))
}

export function promptPath(name: string): string {
  return join(DESK_ROOT, 'prompts', `${name}.md`)
}
