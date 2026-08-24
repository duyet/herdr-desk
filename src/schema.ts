import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cronExprOk } from './cron'

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
    'extra',
    'playbook',
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
  if (o.extra !== undefined && typeof o.extra !== 'string') {
    errors.push(`${path}.extra: string (inline markdown or a .md path)`)
  }
  if (o.playbook !== undefined && typeof o.playbook !== 'string') {
    errors.push(`${path}.playbook: bundled id, .md path, or inline markdown`)
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

function validateCron(raw: unknown, path: string): string[] {
  if (typeof raw !== 'string' || !CRON.test(raw) || !cronExprOk(raw)) {
    return [`${path}: 5-field cron (e.g. "0 8 * * *")`]
  }
  return []
}

function validateSchedule(raw: unknown, path: string): string[] {
  if (typeof raw === 'string') return validateCron(raw, path)
  if (Array.isArray(raw)) {
    if (raw.length < 1) return [`${path}: array must not be empty`]
    return raw.flatMap((item, i) => validateCron(item, `${path}[${i}]`))
  }
  return [`${path}: cron string or array of cron strings`]
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
    'playbook',
    'agentName',
    'kind',
    'maxChildren',
    'stateDir',
    'extra',
    'describe',
    'schedule',
  ])
  for (const k of Object.keys(o)) {
    if (!allowed.has(k)) errors.push(`${path}: unknown field '${k}'`)
  }
  if (o.id !== undefined && (typeof o.id !== 'string' || !o.id.trim())) {
    errors.push(`${path}.id: must be a string`)
  }
  if (o.playbook !== undefined && typeof o.playbook !== 'string') {
    errors.push(`${path}.playbook: bundled id, .md path, or inline markdown`)
  }
  if (
    o.agentName !== undefined &&
    (typeof o.agentName !== 'string' || !AGENT.test(o.agentName))
  ) {
    errors.push(`${path}.agentName: must match [a-z][a-z0-9_-]{0,31}`)
  }
  if (o.extra !== undefined && typeof o.extra !== 'string') {
    errors.push(`${path}.extra: string (inline markdown or a .md path)`)
  }
  if (o.describe !== undefined && typeof o.describe !== 'string') {
    errors.push(`${path}.describe: string`)
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
