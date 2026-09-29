import { dirname, join, resolve, sep } from 'node:path'
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
/** Job handle: desk: / local: prefixes, no path separators. */
const TASK_ID = /^[a-z0-9][a-z0-9_.:-]*$/i

/** A rung: a bare Herdr kind, or a command with arguments. */
const RUNG = /^\S[\s\S]*$/

/**
 * Validate an `agent` field.
 *
 * Returns errors only. A deprecated `kind` on the same object is a warning, not
 * an error, so a 0.1.x config still passes `validate` unchanged.
 */
function validateAgent(raw: unknown, path: string, errors: string[]): void {
  if (typeof raw === 'string') {
    if (!RUNG.test(raw.trim())) {
      errors.push(`${path}: must be an agent kind or command`)
    }
    return
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`${path}: agent kind/command, or an object`)
    return
  }
  const o = raw as Record<string, unknown>
  const allowed = new Set(['ladder', 'default', 'permission', 'timeoutMs'])
  for (const k of Object.keys(o)) {
    if (!allowed.has(k)) errors.push(`${path}: unknown field '${k}'`)
  }
  const ladder = o.ladder ?? o.default
  if (ladder !== undefined) {
    const list =
      typeof ladder === 'string'
        ? [ladder]
        : Array.isArray(ladder)
          ? ladder
          : null
    if (!list) {
      errors.push(`${path}.ladder: string or array of strings`)
    } else if (list.length === 0) {
      errors.push(`${path}.ladder: must not be empty`)
    } else {
      list.forEach((rung, i) => {
        if (typeof rung !== 'string' || !RUNG.test(rung.trim())) {
          errors.push(`${path}.ladder[${i}]: must be a non-empty string`)
        }
      })
    }
  }
  if (
    o.permission !== undefined &&
    (typeof o.permission !== 'string' || !o.permission.trim())
  ) {
    errors.push(`${path}.permission: non-empty string`)
  }
  if (o.timeoutMs !== undefined) {
    const n = o.timeoutMs
    if (
      typeof n !== 'number' ||
      !Number.isInteger(n) ||
      n < 1_000 ||
      n > 300_000
    ) {
      errors.push(`${path}.timeoutMs: integer 1000–300000`)
    }
  }
}

/**
 * Validate a `notify` block.
 *
 * `token` is rejected outright. This block lands in a committed repo file, and
 * Telegram tokens are credentials — a silent strip would leave the user with a
 * secret already in git history and no idea. Failing loudly is the only safe
 * response; the host-level `notify.json` is where the token belongs.
 */
function validateNotify(raw: unknown, path: string, errors: string[]): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`${path}: must be an object`)
    return
  }
  const o = raw as Record<string, unknown>
  const allowed = new Set(['enabled', 'chatId', 'topicId'])
  for (const k of Object.keys(o)) {
    if (k === 'token') {
      errors.push(
        `${path}.token: not allowed — a repo config is committed. Put the bot token in notify.json (host) or HERDR_DESK_TELEGRAM_TOKEN`,
      )
      continue
    }
    if (!allowed.has(k)) errors.push(`${path}: unknown field '${k}'`)
  }
  if (o.enabled !== undefined && typeof o.enabled !== 'boolean') {
    errors.push(`${path}.enabled: must be true or false`)
  }
  for (const key of ['chatId', 'topicId'] as const) {
    const v = o[key]
    if (v !== undefined && (typeof v !== 'string' || !v.trim())) {
      errors.push(`${path}.${key}: must be a non-empty string`)
    }
  }
}

export function insideRepo(repo: string, rel: string): boolean {
  const root = resolve(repo)
  const abs = resolve(root, rel)
  return abs.startsWith(root + sep)
}

export function validateDeskJson(
  raw: unknown,
  path = '.herdr-desk.json',
  repo?: string,
): string[] {
  const errors: string[] = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return [`${path}: must be an object`]
  }
  const o = raw as Record<string, unknown>
  const allowed = new Set([
    '$schema',
    'name',
    'group',
    'repo',
    'tasks',
    'extra',
    'playbook',
    'schedule',
    'maxChildren',
    'agentName',
    'agent',
    'notify',
    'kind',
  ])
  for (const k of Object.keys(o)) {
    if (!allowed.has(k)) errors.push(`${path}: unknown field '${k}'`)
  }
  if (typeof o.name !== 'string' || !o.name.trim()) {
    errors.push(`${path}.name: required string`)
  }
  if (o.group !== undefined && typeof o.group !== 'boolean') {
    errors.push(`${path}.group: must be true or false`)
  }
  if (o.repo !== undefined && typeof o.repo !== 'string') {
    errors.push(`${path}.repo: must be a string`)
  }
  if (o.extra !== undefined && typeof o.extra !== 'string') {
    errors.push(`${path}.extra: string (inline markdown or a .md path)`)
  }
  if (o.playbook !== undefined && typeof o.playbook !== 'string') {
    errors.push(
      `${path}.playbook: bundled id, .md path, gh:owner/repo/name, or inline markdown`,
    )
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
  if (o.agent !== undefined) validateAgent(o.agent, `${path}.agent`, errors)
  if (o.notify !== undefined) validateNotify(o.notify, `${path}.notify`, errors)
  if (o.kind !== undefined) {
    if (typeof o.kind !== 'string' || !RUNG.test(o.kind.trim())) {
      errors.push(`${path}.kind: must be a non-empty string`)
    } else if (o.agent !== undefined) {
      errors.push(`${path}.kind: ignored because 'agent' is also set`)
    }
  }
  if (o.tasks !== undefined) {
    if (!Array.isArray(o.tasks) || o.tasks.length < 1) {
      errors.push(`${path}.tasks: if set, must be a non-empty array`)
    } else {
      o.tasks.forEach((task, i) => {
        errors.push(...validateTask(task, `${path}.tasks[${i}]`, repo))
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

function validateTask(raw: unknown, path: string, repo?: string): string[] {
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
    'agent',
    'notify',
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
  if (o.id !== undefined && (typeof o.id !== 'string' || !TASK_ID.test(o.id))) {
    errors.push(`${path}.id: must match [a-z0-9][a-z0-9_.:-]*`)
  }
  if (o.stateDir !== undefined) {
    if (typeof o.stateDir !== 'string' || !o.stateDir.trim()) {
      errors.push(`${path}.stateDir: must be a string`)
    } else if (repo && !insideRepo(repo, o.stateDir)) {
      errors.push(`${path}.stateDir: must stay inside the repo`)
    }
  }
  if (o.playbook !== undefined && typeof o.playbook !== 'string') {
    errors.push(
      `${path}.playbook: bundled id, .md path, gh:owner/repo/name, or inline markdown`,
    )
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
  if (o.agent !== undefined) validateAgent(o.agent, `${path}.agent`, errors)
  if (o.notify !== undefined) validateNotify(o.notify, `${path}.notify`, errors)
  if (o.kind !== undefined) {
    if (typeof o.kind !== 'string' || !RUNG.test(o.kind.trim())) {
      errors.push(`${path}.kind: must be a non-empty string`)
    } else if (o.agent !== undefined) {
      errors.push(`${path}.kind: ignored because 'agent' is also set`)
    }
  }
  return errors
}
