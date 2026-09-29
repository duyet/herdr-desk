import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { DeskConfig, NotifyOverride, Schedule } from './config'
import { CONFIG_NAMES, findConfigPath, pluginConfigDir } from './paths'

/**
 * Where a resolved value came from. `explain` renders this, which is the only
 * reason a four-layer config stays auditable.
 */
export type Layer = 'env' | 'repo' | 'group' | 'global' | 'default'

export type Provenance = Record<string, Layer>

/** Machine-wide settings. The 0.1.x `{ "repos": [...] }` shape is still valid. */
export type GlobalConfig = {
  repos?: string[]
  agent?: unknown
  notify?: unknown
  features?: Record<string, unknown>
  defaults?: Record<string, unknown>
  limits?: Record<string, unknown>
  tasks?: DeskConfig['tasks']
  [k: string]: unknown
}

export function globalConfigPath(): string {
  return join(pluginConfigDir(), 'config.json')
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(
      `${path}: ${err instanceof Error ? err.message : 'invalid JSON'}`,
    )
  }
}

/** `~/…` and relative paths from the config file, made absolute. */
export function expandPath(value: string, base?: string): string {
  const t = value.trim()
  if (t === '~') return homedir()
  if (t.startsWith('~/')) return join(homedir(), t.slice(2))
  if (isAbsolute(t)) return t
  return resolve(base ?? process.cwd(), t)
}

export function loadGlobalConfig(): GlobalConfig {
  const raw = readJson(globalConfigPath())
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return raw as GlobalConfig
}

/** Extra repo roots from the global config. Supports one level of `*`. */
export function globalRepoRoots(global = loadGlobalConfig()): string[] {
  const base = dirname(globalConfigPath())
  const out = new Set<string>()
  for (const entry of global.repos ?? []) {
    if (typeof entry !== 'string' || !entry.trim()) continue
    const abs = expandPath(entry, base)
    if (!abs.includes('*')) {
      out.add(abs)
      continue
    }
    // Only `dir/*` is supported. Recursive globs need a dependency the plugin
    // does not have, and a machine with a two-level repo tree is rare.
    const parent = abs.slice(0, abs.lastIndexOf('*')).replace(/\/+$/, '')
    if (!existsSync(parent)) continue
    for (const name of readdirSafe(parent)) {
      const dir = join(parent, name)
      if (findConfigPath(dir)) out.add(resolve(dir))
    }
  }
  return [...out].sort()
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}

export type GroupLayer = {
  dir: string
  path: string
  config: DeskConfig
}

/**
 * Ancestor configs that opt in with `"group": true`, nearest first.
 *
 * The marker is required rather than inferred so a stray config in an unrelated
 * parent directory can never silently start steering a repo.
 */
/** Depth cap, so a repo outside $HOME cannot walk all the way to `/`. */
const MAX_GROUP_DEPTH = 6

export function findGroupLayers(
  repo: string,
  stopAt = homedir(),
): GroupLayer[] {
  const out: GroupLayer[] = []
  const stop = resolve(stopAt)
  let dir = resolve(repo)
  for (let depth = 0; depth < MAX_GROUP_DEPTH; depth++) {
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
    const hit = groupAt(dir)
    if (hit) out.push(hit)
    if (dir === stop) break
  }
  return out
}

function groupAt(dir: string): GroupLayer | null {
  for (const name of CONFIG_NAMES) {
    const path = join(dir, name)
    if (!existsSync(path)) continue
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      return null
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    if ((raw as { group?: unknown }).group !== true) continue
    return { dir, path, config: raw as DeskConfig }
  }
  return null
}

function own<T extends object>(...objs: Array<T | undefined>): T {
  return Object.assign({}, ...objs.filter(Boolean)) as T
}

/**
 * Merge the `agent` field across layers.
 *
 * This has to be a deep merge, and getting it wrong is silent: a repo that
 * overrides only `permission` must still inherit the machine-wide ladder, which
 * is the entire reason the object form exists. A shallow merge drops the ladder
 * and quietly falls back to the built-in default.
 */
function mergeAgentField(
  base: DeskConfig['agent'],
  over: DeskConfig['agent'],
): DeskConfig['agent'] {
  if (over === undefined) return base
  // A string is a deliberate pin of the whole selection.
  if (typeof over === 'string') return over
  const fromBase: Record<string, unknown> =
    typeof base === 'string'
      ? base.trim()
        ? { ladder: [base.trim()] }
        : {}
      : { ...(base ?? {}) }
  const next: Record<string, unknown> = { ...fromBase }
  // `ladder` and `default` are one setting spelled two ways, and `ladder` wins
  // when both survive the merge. So a layer that sets either one replaces the
  // inherited pair, or a repo's `default` loses to a global `ladder`.
  if (over.ladder !== undefined || over.default !== undefined) {
    delete next.ladder
    delete next.default
  }
  for (const [k, v] of Object.entries(over)) {
    if (v !== undefined) next[k] = v
  }
  return next as DeskConfig['agent']
}

/**
 * Merge a `notify` block across layers.
 *
 * Same deep-merge shape as {@link mergeAgentField}, and for the same reason: a
 * repo that only overrides `chatId` must keep the inherited `topicId`, or a
 * dedicated forum topic silently reverts to the general one.
 *
 * Only destination fields are copied. A `token` in a layer that is not the host
 * file is dropped here as well as rejected by the validator, so a committed
 * secret cannot reach the send path even if validation is bypassed.
 */
function mergeNotifyField(
  base: DeskConfig['notify'],
  over: DeskConfig['notify'],
): DeskConfig['notify'] {
  if (over === undefined) return base
  const out: NotifyOverride = { ...(base ?? {}) }
  if (over.enabled !== undefined) out.enabled = over.enabled
  if (over.chatId !== undefined) out.chatId = over.chatId
  if (over.topicId !== undefined) out.topicId = over.topicId
  return out
}

/** Later layers win. `schedule` and `tasks` are replaced wholesale. */
export function mergeConfigs(base: DeskConfig, over: DeskConfig): DeskConfig {
  const out: DeskConfig = { ...own(base), ...own(over) }
  if (over.playbook !== undefined) out.playbook = over.playbook
  if (over.schedule !== undefined) out.schedule = over.schedule as Schedule
  if (over.tasks !== undefined) out.tasks = over.tasks
  out.agent = mergeAgentField(base.agent, over.agent) as DeskConfig['agent']
  out.notify = mergeNotifyField(base.notify, over.notify)
  if (out.notify && Object.keys(out.notify).length === 0) delete out.notify
  return out
}

export type ConfigSource = {
  config: Record<string, unknown>
  from: Layer
  origin: string
}

export type ResolvedConfig = {
  /** Folded config, before `applyDefaults`. */
  config: DeskConfig
  sources: ConfigSource[]
  /** Which layer supplied each top-level key. */
  provenance: Provenance
  /**
   * Which layer supplied each *sub-field* of a merged object, keyed
   * `notify.chatId`. A top-level answer is not enough for `notify`: a repo that
   * overrides only `chatId` must still be able to report that the `topicId`
   * beside it came from the group, or the explain table lies.
   */
  fieldProvenance: Record<string, Layer>
  /** Key -> layer, for fields set anywhere in the stack. */
  originOf: (key: string) => Layer | undefined
}

/**
 * Fold every layer that applies to a repo, lowest priority first.
 *
 * Order is the documented precedence: machine `config.json`, then ancestor
 * group configs from the furthest to the nearest, then the repo's own file. The
 * repo is last because only the repo may set `name`.
 *
 * This is the single fold. `config show`, `config explain`, and notify all go
 * through it, so what notify does and what `explain` reports cannot disagree.
 */
export function resolveConfig(repo: string): ResolvedConfig {
  const root = resolve(repo)
  const sources: ConfigSource[] = []

  const global = loadGlobalConfig()
  if (Object.keys(global).length) {
    sources.push({ config: global, from: 'global', origin: globalConfigPath() })
  }
  for (const g of findGroupLayers(root).reverse()) {
    sources.push({
      config: g.config as Record<string, unknown>,
      from: 'group',
      origin: g.path,
    })
  }
  const repoPath = findConfigPath(root)
  if (repoPath) {
    try {
      const own_ = JSON.parse(readFileSync(repoPath, 'utf8'))
      if (own_ && typeof own_ === 'object' && !Array.isArray(own_)) {
        sources.push({ config: own_, from: 'repo', origin: repoPath })
      }
    } catch {
      // A malformed repo config is reported by `validate`, not here.
    }
  }

  const provenance: Provenance = {}
  const fieldProvenance: Record<string, Layer> = {}
  let folded: DeskConfig = {} as DeskConfig
  for (const s of sources) {
    // Lower this layer's legacy `kind` into this layer's `agent` *before* the
    // merge. Doing it after would let a global `agent` outrank a repo's
    // `kind`, because `kind` is only consulted where `agent` is absent — so a
    // 0.1.x repo would silently get a different agent the moment a global
    // config appeared. Per-layer, the repo still wins.
    const layer = normalizeLegacyAgent(s.config)
    folded = mergeConfigs(folded, layer as DeskConfig)
    for (const k of Object.keys(s.config)) provenance[k] = s.from
    if (s.config.agent === undefined && s.config.kind !== undefined) {
      provenance.agent = s.from
    }
    // Later layers win, so recording as we go leaves the last writer standing.
    for (const [parent, sub] of SUBFIELDS) {
      const block = layer[parent]
      if (!block || typeof block !== 'object' || Array.isArray(block)) continue
      for (const field of sub) {
        if ((block as Record<string, unknown>)[field] !== undefined) {
          fieldProvenance[`${parent}.${field}`] = s.from
        }
      }
    }
    // A task may set `agent`/`notify` too, and `tasks` is replaced wholesale
    // rather than deep-merged, so a task's block is the effective one. Without
    // this, `explain` blames the global layer for a ladder the repo's task
    // actually overrode.
    const tasks = layer.tasks
    if (Array.isArray(tasks)) {
      for (const task of tasks) {
        if (!task || typeof task !== 'object' || Array.isArray(task)) continue
        const t = task as Record<string, unknown>
        const tAgent = normalizeLegacyAgent(t)
        for (const [parent, sub] of SUBFIELDS) {
          const block = tAgent[parent]
          if (!block || typeof block !== 'object' || Array.isArray(block))
            continue
          for (const field of sub) {
            if ((block as Record<string, unknown>)[field] !== undefined) {
              fieldProvenance[`tasks.${parent}.${field}`] = s.from
            }
          }
        }
      }
    }
  }

  return {
    config: folded,
    sources,
    provenance,
    fieldProvenance,
    originOf: (key) => provenance[key],
  }
}

/**
 * A layer that still uses the 0.1.x `kind` field contributes it as `agent`.
 *
 * Returns a new object; the caller's config is never mutated, so provenance
 * still reflects what each layer actually wrote to disk.
 */
function normalizeLegacyAgent(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const { kind, agent, ...rest } = config
  if (kind === undefined) return config
  if (agent !== undefined) {
    // Both set: `agent` wins, but `kind` must not linger in the fold and
    // shadow a later layer's `agent`.
    return { ...rest, agent }
  }
  return { ...rest, agent: kind }
}

/** Merged object blocks whose sub-fields are tracked individually. */
const SUBFIELDS: Array<[string, string[]]> = [
  ['notify', ['enabled', 'chatId', 'topicId']],
  ['agent', ['ladder', 'default', 'permission', 'timeoutMs']],
]
