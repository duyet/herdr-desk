import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyDefaults } from './defaults'
import { validateDeskJson } from './schema'

export const DESK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Cron string, or several crons that all run the same playbook. */
export type Schedule = string | string[]

export type TaskConfig = {
  id: string
  label?: string
  playbook: string
  agentName: string
  kind?: string
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
  repo?: string
  extra?: string
  playbook?: string
  schedule?: Schedule
  maxChildren?: number
  agentName?: string
  kind?: string
  tasks?: Array<
    Partial<Omit<TaskConfig, 'crons' | 'playbook' | 'agentName' | 'id'>> & {
      id?: string
      playbook?: string
      agentName?: string
      schedule?: Schedule
    }
  >
}

export type LoadedDesk = Omit<DeskConfig, 'tasks'> & {
  tasks: TaskConfig[]
}

export const CONFIG_NAMES = [
  '.herdr-desk.json',
  'herdr-desk.json',
  'ops/desk.json',
] as const

export function findConfigPath(repo: string): string | null {
  for (const name of CONFIG_NAMES) {
    const path = join(repo, name)
    if (existsSync(path)) return path
  }
  return null
}

export function loadDeskConfig(repo: string): LoadedDesk {
  const path = findConfigPath(repo)
  if (!path) {
    throw new Error(
      `no herdr-desk config in ${repo} (looked for ${CONFIG_NAMES.join(', ')})`,
    )
  }
  const raw = JSON.parse(readFileSync(path, 'utf8')) as DeskConfig
  const errors = validateDeskJson(raw, path)
  if (errors.length) throw new Error(errors.join('\n'))
  return applyDefaults(raw, repo)
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
