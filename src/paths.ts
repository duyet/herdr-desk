import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Where a repo's desk config may live, in precedence order.
 *
 * This lives here, in the leaf module, rather than in `config.ts`: both
 * `config.ts` and `layers.ts` need it, and `config.ts` also needs
 * `resolveConfig` from `layers.ts`. Keeping the path helpers here is what
 * stops that from becoming an import cycle.
 */
export const CONFIG_NAMES = [
  '.herdr-desk.json',
  'herdr-desk.json',
  'ops/desk.json',
] as const

export function findConfigPath(repo: string): string | null {
  for (const name of CONFIG_NAMES) {
    const path = join(repo, name)
    if (existsSync(path)) return path
  }
  return null
}

export function pluginConfigDir(): string {
  return (
    process.env.HERDR_PLUGIN_CONFIG_DIR ??
    join(homedir(), '.config', 'herdr', 'plugins', 'herdr-desk')
  )
}

export function pluginStateDir(): string {
  return (
    process.env.HERDR_PLUGIN_STATE_DIR ??
    join(homedir(), '.local', 'state', 'herdr', 'plugins', 'herdr-desk')
  )
}
