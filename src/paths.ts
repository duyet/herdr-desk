import { homedir } from 'node:os'
import { join } from 'node:path'

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
