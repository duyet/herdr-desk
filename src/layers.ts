import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  CONFIG_NAMES,
  type DeskConfig,
  findConfigPath,
  type Schedule,
} from './config'
import { pluginConfigDir } from './paths'

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

/**
 * Flatten the layers that can supply shared settings, lowest priority first.
 *
 * Order matches the documented precedence: global, then group configs from the
 * furthest ancestor to the nearest, so a nearer group overrides a further one.
 * The repo itself is applied by the caller on top, because only the repo's own
 * config may set `name`.
 */
export function sharedLayers(
  repo: string,
  global = loadGlobalConfig(),
): {
  layers: DeskConfig[]
  provenance: Provenance
} {
  const provenance: Provenance = {}
  const layers: DeskConfig[] = []

  if (Object.keys(global).length) {
    layers.push(global as DeskConfig)
    provenance.global = 'global'
  }
  const groups = findGroupLayers(repo).reverse()
  for (const g of groups) {
    layers.push(g.config)
    provenance[g.path] = 'group'
  }
  return { layers, provenance }
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
  for (const [k, v] of Object.entries(over)) {
    if (v !== undefined) next[k] = v
  }
  return next as DeskConfig['agent']
}

/** Later layers win. `schedule` and `tasks` are replaced wholesale. */
export function mergeConfigs(base: DeskConfig, over: DeskConfig): DeskConfig {
  const out: DeskConfig = { ...own(base), ...own(over) }
  if (over.playbook !== undefined) out.playbook = over.playbook
  if (over.schedule !== undefined) out.schedule = over.schedule as Schedule
  if (over.tasks !== undefined) out.tasks = over.tasks
  out.agent = mergeAgentField(base.agent, over.agent) as DeskConfig['agent']
  return out
}

export function envOverrides(env = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('HERDR_DESK_') && typeof v === 'string' && v) out[k] = v
  }
  return out
}
