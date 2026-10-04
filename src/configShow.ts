import { relative, resolve } from 'node:path'
import { type DeskConfig, loadDeskConfig } from './config'
import { applyDefaults } from './defaults'
import { resolveConfig } from './layers'
import { textTable } from './table'

/**
 * Effective values after defaults, with no provenance.
 *
 * Folds through `resolveConfig`, the same entry point notify uses, so what
 * notify does and what `explain` reports cannot disagree.
 */
export function showConfig(repo: string): string {
  const root = resolve(repo)
  const { config: merged } = resolveConfig(root)
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
  'notify',
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
  const { config: folded, sources, provenance } = resolveConfig(root)
  if (sources.length === 0) return `no config found for ${root}`

  const rows: string[][] = []
  for (const key of KEYS) {
    // Show the *effective* value, not the raw one from the winning layer: a
    // repo that overrides only `chatId` would otherwise hide the inherited
    // ladder/topic and read as if it had wiped them.
    const value = (folded as Record<string, unknown>)[key]
    if (value === undefined) continue
    rows.push([key, fmt(value), provenance[key] ?? 'default'])
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
