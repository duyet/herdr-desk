import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { findConfigPath, type LoadedDesk, loadDeskConfig } from './config'
import { herdrCall, listedWorkspaces } from './herdr'
import { findGroupLayers, globalRepoRoots } from './layers'
import { pluginStateDir } from './paths'

export type Discovered = {
  repo: string
  configPath: string
  config: LoadedDesk
  source: 'workspace' | 'remembered' | 'plugin-config'
  /** Ancestor `group: true` configs that also apply, nearest first. */
  groups?: string[]
}

function knownPath(): string {
  return join(pluginStateDir(), 'known-repos.json')
}

export function loadKnownRepos(): string[] {
  const path = knownPath()
  if (!existsSync(path)) return []
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { repos?: string[] }
    return (raw.repos ?? []).map((p) => resolve(p))
  } catch {
    return []
  }
}

export function rememberRepos(repos: string[]): void {
  mkdirSync(pluginStateDir(), { recursive: true })
  const merged = [
    ...new Set([...loadKnownRepos(), ...repos.map((p) => resolve(p))]),
  ].sort()
  writeFileSync(knownPath(), `${JSON.stringify({ repos: merged }, null, 2)}\n`)
}

export async function workspaceRepoRoots(): Promise<string[]> {
  try {
    const listed = listedWorkspaces(await herdrCall(['workspace', 'list']))
    const roots: string[] = []
    for (const w of listed) {
      const root = w.repoRoot ?? w.cwd ?? w.checkoutPath
      if (root) roots.push(resolve(root))
    }
    return [...new Set(roots)]
  } catch {
    return []
  }
}

function tryLoad(
  repo: string,
  source: Discovered['source'],
): Discovered | null {
  const configPath = findConfigPath(repo)
  if (!configPath) return null
  try {
    const config = loadDeskConfig(repo)
    return {
      repo: config.repo ?? repo,
      configPath,
      config,
      source,
      groups: findGroupLayers(repo).map((g) => g.path),
    }
  } catch {
    return null
  }
}

/** Open workspaces + remembered + plugin config extras. */
export async function discoverDesks(): Promise<Discovered[]> {
  const live = await workspaceRepoRoots()
  const extras = globalRepoRoots()
  const remembered = loadKnownRepos()

  const found: Discovered[] = []
  const seen = new Set<string>()

  const add = (repo: string, source: Discovered['source']) => {
    const key = resolve(repo)
    if (seen.has(key)) return
    const hit = tryLoad(key, source)
    if (!hit) return
    seen.add(key)
    found.push(hit)
  }

  for (const repo of live) add(repo, 'workspace')
  for (const repo of extras) add(repo, 'plugin-config')
  for (const repo of remembered) add(repo, 'remembered')

  rememberRepos(found.map((d) => d.repo))
  return found
}

export function formatScan(desks: Discovered[]): string {
  if (desks.length === 0)
    return 'no desks (no open workspace has .herdr-desk.json)'
  const lines: string[] = []
  for (const d of desks) {
    const group = d.groups?.length
      ? `  <- ${d.groups.length} group config(s)`
      : ''
    lines.push(`${d.config.name}  ${d.repo}  (${d.source})${group}`)
    for (const t of d.config.tasks) {
      lines.push(
        `  ${t.id}  ${t.agentName}  ${t.crons.join(' | ') || '-'}  ${t.agent.ladder[0]}`,
      )
    }
  }
  return lines.join('\n')
}
