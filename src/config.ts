import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DESK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export type TaskSchedule = {
  morning?: string
  nightly?: string
}

export type TaskConfig = {
  id: string
  label?: string
  /** Bundled prompt id (`github-issues`) or path to a .md file. */
  task: string
  agentName: string
  kind?: string
  maxChildren?: number
  schedule?: TaskSchedule
  /** Run folder relative to the repo. */
  stateDir?: string
  /** Extra repo-local markdown appended to the manager prompt. */
  extraPrompt?: string
}

export type DeskConfig = {
  name: string
  repo?: string
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

export function loadDeskConfig(repo: string): DeskConfig {
  const path = findConfigPath(repo)
  if (!path) {
    throw new Error(
      `no herdr-desk config in ${repo} (looked for ${CONFIG_NAMES.join(', ')})`,
    )
  }
  const raw = JSON.parse(readFileSync(path, 'utf8')) as DeskConfig
  if (!raw?.name || !Array.isArray(raw.tasks)) {
    throw new Error(`${path}: expected { name, tasks[] }`)
  }
  for (const task of raw.tasks) {
    if (!task.id || !task.task || !task.agentName) {
      throw new Error(`${path}: each task needs id, task, agentName`)
    }
  }
  return { ...raw, repo: raw.repo ?? repo }
}

export function resolveTask(config: DeskConfig, taskId?: string): TaskConfig {
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
  if (task.task.endsWith('.md') || task.task.includes('/') || task.task.startsWith('.')) {
    return isAbsolute(task.task) ? task.task : resolve(repo, task.task)
  }
  const bundled = join(DESK_ROOT, 'prompts', 'tasks', `${task.task}.md`)
  if (!existsSync(bundled)) {
    throw new Error(`bundled task prompt not found: ${bundled}`)
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
