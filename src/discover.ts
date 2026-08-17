import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { findConfigPath, type LoadedDesk, loadDeskConfig } from './config'
import { herdrCall } from './herdr'
import { pluginConfigDir, pluginStateDir } from './paths'

export type Discovered = {
  repo: string
  configPath: string
  config: LoadedDesk
  source: 'workspace' | 'remembered' | 'plugin-config'
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

function extraReposFromPluginConfig(): string[] {
  const dir = pluginConfigDir()
  const json = join(dir, 'config.json')
  if (!existsSync(json)) return []
  try {
    const raw = JSON.parse(readFileSync(json, 'utf8')) as { repos?: string[] }
    return (raw.repos ?? []).map((p) =>
      resolve(p.replace(/^~(?=\/|$)/, homedir())),
    )
  } catch {
    return []
  }
}

export async function workspaceRepoRoots(): Promise<string[]> {
  try {
    const parsed = (await herdrCall(['workspace', 'list'])) as {
      result?: {
        workspaces?: Array<{
          worktree?: { repo_root?: string; checkout_path?: string }
        }>
      }
    }
    const roots: string[] = []
    for (const ws of parsed.result?.workspaces ?? []) {
      const root = ws.worktree?.repo_root ?? ws.worktree?.checkout_path
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
    return { repo: config.repo ?? repo, configPath, config, source }
  } catch {
    return null
  }
}

/** Open workspaces + remembered + plugin config extras. */
export async function discoverDesks(): Promise<Discovered[]> {
  const live = await workspaceRepoRoots()
  const extras = extraReposFromPluginConfig()
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
    lines.push(`${d.config.name}  ${d.repo}  (${d.source})`)
    for (const t of d.config.tasks) {
      lines.push(
        `  ${t.id}  ${t.agentName}  morning=${t.schedule?.morning ?? '-'}  nightly=${t.schedule?.nightly ?? '-'}`,
      )
    }
  }
  return lines.join('\n')
}
