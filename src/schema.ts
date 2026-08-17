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
  const allowed = new Set([
    '$schema',
    'name',
    'repo',
    'tasks',
    'extraPrompt',
    'schedule',
    'maxChildren',
    'agentName',
    'kind',
  ])
  for (const k of Object.keys(o)) {
    if (!allowed.has(k)) errors.push(`${path}: unknown field '${k}'`)
  }
  if (typeof o.name !== 'string' || !o.name.trim()) {
    errors.push(`${path}.name: required string`)
  }
  if (o.repo !== undefined && typeof o.repo !== 'string') {
    errors.push(`${path}.repo: must be a string`)
  }
  if (o.extraPrompt !== undefined && typeof o.extraPrompt !== 'string') {
    errors.push(`${path}.extraPrompt: string (inline markdown or a .md path)`)
  }
  if (o.maxChildren !== undefined) {
    const n = o.maxChildren
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 8) {
      errors.push(`${path}.maxChildren: integer 1–8`)
    }
  }
  if (
    o.agentName !== undefined &&
    (typeof o.agentName !== 'string' || !AGENT.test(o.agentName))
  ) {
    errors.push(`${path}.agentName: must match [a-z][a-z0-9_-]{0,31}`)
  }
  if (o.schedule !== undefined)
    errors.push(...validateSchedule(o.schedule, `${path}.schedule`))
  if (o.tasks !== undefined) {
    if (!Array.isArray(o.tasks) || o.tasks.length < 1) {
      errors.push(`${path}.tasks: if set, must be a non-empty array`)
    } else {
      o.tasks.forEach((task, i) => {
        errors.push(...validateTask(task, `${path}.tasks[${i}]`))
      })
    }
  }
  return errors
}

function validateSchedule(raw: unknown, path: string): string[] {
  const errors: string[] = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return [`${path}: must be an object`]
  }
  const s = raw as Record<string, unknown>
  for (const k of Object.keys(s)) {
    if (k !== 'morning' && k !== 'nightly') {
      errors.push(`${path}: unknown field '${k}'`)
    } else if (typeof s[k] !== 'string' || !CRON.test(s[k] as string)) {
      errors.push(`${path}.${k}: 5-field cron (e.g. 0 7 * * *)`)
    }
  }
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
  if (o.id !== undefined && (typeof o.id !== 'string' || !o.id.trim())) {
    errors.push(`${path}.id: must be a string`)
  }
  if (o.task !== undefined && typeof o.task !== 'string') {
    errors.push(`${path}.task: playbook id, .md path, or inline markdown`)
  }
  if (
    o.agentName !== undefined &&
    (typeof o.agentName !== 'string' || !AGENT.test(o.agentName))
  ) {
    errors.push(`${path}.agentName: must match [a-z][a-z0-9_-]{0,31}`)
  }
  if (o.extraPrompt !== undefined && typeof o.extraPrompt !== 'string') {
    errors.push(`${path}.extraPrompt: string (inline markdown or a .md path)`)
  }
  if (o.maxChildren !== undefined) {
    const n = o.maxChildren
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 8) {
      errors.push(`${path}.maxChildren: integer 1–8`)
    }
  }
  if (o.schedule !== undefined)
    errors.push(...validateSchedule(o.schedule, `${path}.schedule`))
  return errors
}
