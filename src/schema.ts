import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SCHEMA_URL =
  'https://raw.githubusercontent.com/duyet/herdr-desk/main/herdr-desk.schema.json'

export const SCHEMA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'herdr-desk.schema.json',
)

const CRON = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/
const AGENT = /^[a-z][a-z0-9_-]{0,31}$/

export function validateDeskJson(
  raw: unknown,
  path = '.herdr-desk.json',
): string[] {
  const errors: string[] = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return [`${path}: must be an object`]
  }
  const o = raw as Record<string, unknown>
  const allowed = new Set(['$schema', 'name', 'repo', 'tasks'])
  for (const k of Object.keys(o)) {
    if (!allowed.has(k)) errors.push(`${path}: unknown field '${k}'`)
  }
  if (typeof o.name !== 'string' || !o.name.trim()) {
    errors.push(`${path}.name: required string`)
  }
  if (o.repo !== undefined && typeof o.repo !== 'string') {
    errors.push(`${path}.repo: must be a string`)
  }
  if (!Array.isArray(o.tasks) || o.tasks.length < 1) {
    errors.push(`${path}.tasks: required non-empty array`)
    return errors
  }
  o.tasks.forEach((task, i) => {
    errors.push(...validateTask(task, `${path}.tasks[${i}]`))
  })
  return errors
}

function validateTask(raw: unknown, path: string): string[] {
  const errors: string[] = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return [`${path}: must be an object`]
  }
  const o = raw as Record<string, unknown>
  const allowed = new Set([
    'id',
    'label',
    'task',
    'agentName',
    'kind',
    'maxChildren',
    'stateDir',
    'extraPrompt',
    'describe',
    'schedule',
  ])
  for (const k of Object.keys(o)) {
    if (!allowed.has(k)) errors.push(`${path}: unknown field '${k}'`)
  }
  if (typeof o.id !== 'string' || !o.id.trim()) {
    errors.push(`${path}.id: required string`)
  }
  if (typeof o.task !== 'string' || !o.task.trim()) {
    errors.push(`${path}.task: required string (github-issues or a .md path)`)
  }
  if (typeof o.agentName !== 'string' || !AGENT.test(o.agentName)) {
    errors.push(`${path}.agentName: must match [a-z][a-z0-9_-]{0,31}`)
  }
  if (o.maxChildren !== undefined) {
    const n = o.maxChildren
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 8) {
      errors.push(`${path}.maxChildren: integer 1–8`)
    }
  }
  if (o.schedule !== undefined) {
    if (
      !o.schedule ||
      typeof o.schedule !== 'object' ||
      Array.isArray(o.schedule)
    ) {
      errors.push(`${path}.schedule: must be an object`)
    } else {
      const s = o.schedule as Record<string, unknown>
      for (const k of Object.keys(s)) {
        if (k !== 'morning' && k !== 'nightly') {
          errors.push(`${path}.schedule: unknown field '${k}'`)
        } else if (typeof s[k] !== 'string' || !CRON.test(s[k] as string)) {
          errors.push(`${path}.schedule.${k}: 5-field cron (e.g. 0 7 * * *)`)
        }
      }
    }
  }
  return errors
}
