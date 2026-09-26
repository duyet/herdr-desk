import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { type DeskConfig, findConfigPath, loadDeskConfig } from './config'
import { applyDefaults } from './defaults'
import type { Discovered } from './discover'
import {
  findGroupLayers,
  type Layer,
  loadGlobalConfig,
  mergeConfigs,
} from './layers'
import { textTable } from './table'

type Source = { config: Record<string, unknown>; from: Layer; origin: string }

/**
 * Every layer that applies to a repo, lowest priority first.
 *
 * Shared by `show` and `explain` so both commands fold the config through
 * exactly the same path. A second implementation here would drift, and a
 * drifted fold would report provenance that does not match behaviour.
 */
export function layerSources(repo: string): Source[] {
  const root = resolve(repo)
  const out: Source[] = []

  const global = loadGlobalConfig()
  if (Object.keys(global).length) {
    out.push({ config: global, from: 'global', origin: 'config.json' })
  }
  for (const g of findGroupLayers(root).reverse()) {
    out.push({
      config: g.config as Record<string, unknown>,
      from: 'group',
      origin: g.path,
    })
  }
  const repoPath = findConfigPath(root)
  if (repoPath) {
    try {
      const own = JSON.parse(readFileSync(repoPath, 'utf8'))
      if (own && typeof own === 'object' && !Array.isArray(own)) {
        out.push({ config: own, from: 'repo', origin: repoPath })
      }
    } catch {
      // A malformed repo config is reported by `validate`, not here.
    }
  }
  return out
}

function fold(sources: Source[]): DeskConfig {
  let merged: Record<string, unknown> = {}
  for (const s of sources) {
    merged = mergeConfigs(
      merged as DeskConfig,
      s.config as DeskConfig,
    ) as Record<string, unknown>
  }
  return merged as DeskConfig
}

/** Effective values after defaults, with no provenance. */
export function showConfig(repo: string): string {
  const root = resolve(repo)
  const merged = fold(layerSources(root))
  // `name` is the one field only the repo may set, so fall back for the preview.
  const withName: DeskConfig = {
    ...merged,
    name: String(merged.name ?? 'repo'),
  }
  return JSON.stringify(applyDefaults(withName, root), null, 2)
}

const KEYS = [
  'name',
  'schedule',
  'playbook',
  'maxChildren',
  'agentName',
  'agent',
  'kind',
]

function fmt(v: unknown): string {
  if (Array.isArray(v)) return v.join(', ')
  if (v && typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/**
 * Effective config with the layer each value came from.
 *
 * Provenance is the whole point. A four-layer config that cannot answer "why is
 * this repo using grok" is not maintainable.
 */
export function explainConfig(repo: string): string {
  const root = resolve(repo)
  const sources = layerSources(root)
  if (sources.length === 0) return `no config found for ${root}`

  const rows: string[][] = []
  for (const key of KEYS) {
    for (let i = sources.length - 1; i >= 0; i--) {
      const v = sources[i].config[key]
      if (v === undefined) continue
      rows.push([key, fmt(v), sources[i].from])
      break
    }
  }

  return [
    `config for ${relative(process.cwd(), root) || root}`,
    '',
    ...sources.map(
      (s) =>
        `  ${s.from.padEnd(7)} ${relative(process.cwd(), s.origin) || s.origin}`,
    ),
    '',
    rows.length
      ? textTable(['FIELD', 'VALUE', 'FROM'], rows)
      : '(no fields set)',
  ].join('\n')
}

/** Resolved task rows for `desk config explain --tasks`. */
export function explainTasks(repo: string): string {
  const config = loadDeskConfig(repo)
  const rows = config.tasks.map((t) => [
    t.id,
    t.agent.ladder.join(' > '),
    t.agent.permission,
    t.crons.join(' | '),
    String(t.maxChildren ?? 5),
  ])
  return textTable(['JOB', 'LADDER', 'PERM', 'CRON', 'MAX'], rows)
}

export function explainDesk(desk: Discovered): string {
  return explainConfig(desk.repo)
}
