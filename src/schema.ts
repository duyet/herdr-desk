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

/** Kinds `herdr agent start --kind` accepts (from `herdr agent start --help`). */
export const HERDR_AGENT_KINDS: ReadonlySet<string> = new Set([
  'pi',
  'claude',
  'codex',
  'gemini',
  'cursor',
  'devin',
  'agy',
  'cline',
  'omp',
  'mastracode',
  'opencode',
  'copilot',
  'kimi',
  'kiro',
  'droid',
  'amp',
  'grok',
  'hermes',
  'kilo',
  'qodercli',
  'qwen',
  'maki',
  'muse',
])

/**
 * The run path launches the first rung Herdr can `agent start`; a ladder with
 * none can never run, so it is an error here rather than at every fire.
 */
function requireHerdrKind(
  ladder: string[],
  path: string,
  errors: string[],
): void {
  if (!ladder.some((rung) => HERDR_AGENT_KINDS.has(rung.trim()))) {
    errors.push(
      `${path}: [${ladder.join(', ')}] has no Herdr agent kind (${[...HERDR_AGENT_KINDS].join(', ')})`,
    )
  }
}

function validateKindField(
  o: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  if (o.kind === undefined) return
  if (typeof o.kind !== 'string' || !RUNG.test(o.kind.trim())) {
    errors.push(`${path}.kind: must be a non-empty string`)
  } else if (o.agent !== undefined) {
    errors.push(`${path}.kind: ignored because 'agent' is also set`)
  } else {
    requireHerdrKind([o.kind], `${path}.kind`, errors)
  }
}

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
    } else {
      requireHerdrKind([raw], path, errors)
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
      if (list.every((rung) => typeof rung === 'string')) {
        requireHerdrKind(list, `${path}.ladder`, errors)
      }
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

/** Seconds between polls. Below 15 the daemon is a busy loop, not a watcher. */
export const WATCH_RANGES = {
  intervalSec: { min: 15, max: 3600 },
  timeoutSec: { min: 5, max: 300 },
  maxPending: { min: 1, max: 64 },
} as const

/**
 * Validate a `watch` block.
 *
 * `command` is argv, so there is nothing to quote and nothing to inject a repo
 * into — which is why a shell string is not accepted rather than being split.
 * argv[0] that *looks* like a path is resolved against the repo and must land
 * inside it, using the same {@link insideRepo} the state dir uses: a committed
 * config is not allowed to reach out of the checkout and run something there.
 *
 * `env` is rejected outright, like `notify.token`. A block that could carry a
 * credential would put it in git history with nothing left to notice, and the
 * command inherits the daemon's environment anyway.
 */
export function validateWatch(
  raw: unknown,
  path: string,
  repo?: string,
): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return [`${path}: must be an object`]
  }
  const o = raw as Record<string, unknown>
  const allowed = new Set([
    'command',
    'intervalSec',
    'timeoutSec',
    'maxPending',
  ])
  const errors: string[] = []
  for (const k of Object.keys(o)) {
    if (k === 'env') {
      errors.push(
        `${path}.env: not allowed — a repo config is committed. The command inherits the daemon env plus HERDR_DESK_REPO, HERDR_DESK_TASK, HERDR_DESK_STATE_DIR and HERDR_DESK_POLL_AT`,
      )
      continue
    }
    if (!allowed.has(k)) errors.push(`${path}: unknown field '${k}'`)
  }
  const cmd = o.command
  if (!Array.isArray(cmd) || cmd.length === 0) {
    errors.push(
      `${path}.command: non-empty argv array, e.g. ["bun", "scripts/watch-prs.ts"]`,
    )
  } else {
    cmd.forEach((part, i) => {
      if (typeof part !== 'string' || !part.trim()) {
        errors.push(`${path}.command[${i}]: must be a non-empty string`)
      }
    })
    const head = cmd[0]
    if (
      typeof head === 'string' &&
      head.trim() &&
      repo &&
      looksLikePathArg(head) &&
      !insideRepo(repo, head)
    ) {
      errors.push(`${path}.command[0]: must stay inside the repo`)
    }
  }
  for (const key of ['intervalSec', 'timeoutSec', 'maxPending'] as const) {
    if (o[key] === undefined) continue
    const { min, max } = WATCH_RANGES[key]
    const n = o[key]
    if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
      errors.push(`${path}.${key}: integer ${min}–${max}`)
    }
  }
  return errors
}

/**
 * Does this argv[0] name a file rather than a binary?
 *
 * Deliberately narrow. `./x`, `../x`, `a/b` and `/x` are paths; `bun` is not,
 * and treating `bun` as a repo-relative path would run the repo's own `bun`
 * instead of the one on PATH.
 */
export function looksLikePathArg(value: string): boolean {
  return (
    value.startsWith('./') ||
    value.startsWith('../') ||
    value === '.' ||
    value === '..' ||
    value.startsWith('/') ||
    value.includes('/')
  )
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
    'autoUpdate',
  ])
  for (const k of Object.keys(o)) {
    if (!allowed.has(k)) errors.push(`${path}: unknown field '${k}'`)
  }
  if (o.autoUpdate !== undefined && typeof o.autoUpdate !== 'boolean') {
    errors.push(`${path}.autoUpdate: must be a boolean`)
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
  validateKindField(o, path, errors)
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
    // An empty array is the *event-only* form: `["schedule": []]` means never on
    // cron. It used to be an error, which left a task with `watch` and no cron
    // unable to say what it wanted — and omitting `schedule` instead inherits
    // the root cron, so the reconciliation sweep fired a task that asked to be
    // event-only. See `docs/watch.md`.
    return raw.flatMap((item, i) => validateCron(item, `${path}[${i}]`))
  }
  return [`${path}: cron string or array of cron strings`]
}

/** `[]` and `[""]` and friends: a schedule that names no cron at all. */
function isEmptySchedule(raw: unknown): boolean {
  if (!Array.isArray(raw)) return false
  return raw.every((s) => typeof s !== 'string' || !s.trim())
}

const NEVER_RUNS =
  'no cron and no "watch" block, so this task can never run. add a "watch" block, or give it a cron'

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
    'watch',
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
  if (o.watch !== undefined)
    errors.push(...validateWatch(o.watch, `${path}.watch`, repo))
  // The event-only form is only meaningful with something to be woken by. A
  // `schedule: []` with no `watch` is a job that validates, renders its cron as
  // `-` in `status`, and is never owed anything — a typo reading as "unset"
  // rather than "never fires". `schedule: []` is new in #94, so no existing
  // config can break on this.
  if (isEmptySchedule(o.schedule) && o.watch === undefined)
    errors.push(`${path}.schedule: ${NEVER_RUNS}`)
  if (o.agent !== undefined) validateAgent(o.agent, `${path}.agent`, errors)
  if (o.notify !== undefined) validateNotify(o.notify, `${path}.notify`, errors)
  validateKindField(o, path, errors)
  return errors
}
