import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { cronMatches } from './cron'
import { dayKey } from './day'
import { discoverDesks } from './discover'
import { pluginStateDir } from './paths'
import { type RunMode, runTask } from './run'

const TICK_MS = 20_000

function pidPath(): string {
  return join(pluginStateDir(), 'daemon.pid')
}

function firesPath(): string {
  return join(pluginStateDir(), 'fires.json')
}

function logPath(): string {
  return join(pluginStateDir(), 'daemon.log')
}

export function daemonPid(): number | null {
  if (!existsSync(pidPath())) return null
  const pid = Number(readFileSync(pidPath(), 'utf8').trim())
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    process.kill(pid, 0)
    return pid
  } catch {
    return null
  }
}

function loadFires(): Record<string, string> {
  if (!existsSync(firesPath())) return {}
  try {
    return JSON.parse(readFileSync(firesPath(), 'utf8')) as Record<
      string,
      string
    >
  } catch {
    return {}
  }
}

function saveFires(map: Record<string, string>): void {
  mkdirSync(pluginStateDir(), { recursive: true })
  writeFileSync(firesPath(), `${JSON.stringify(map, null, 2)}\n`)
}

function log(line: string): void {
  mkdirSync(pluginStateDir(), { recursive: true })
  const stamp = new Date().toISOString()
  writeFileSync(logPath(), `${stamp} ${line}\n`, { flag: 'a' })
  console.log(line)
}

function fireKey(
  repo: string,
  taskId: string,
  mode: RunMode,
  day: string,
): string {
  return `${repo}::${taskId}::${mode}::${day}`
}

export async function tickOnce(at = new Date()): Promise<number> {
  const desks = await discoverDesks()
  const fires = loadFires()
  const day = dayKey(at)
  let n = 0
  for (const d of desks) {
    for (const task of d.config.tasks) {
      for (const mode of ['morning', 'nightly'] as const) {
        const expr = task.schedule?.[mode]
        if (!expr || !cronMatches(expr, at)) continue
        const key = fireKey(d.repo, task.id, mode, day)
        if (fires[key]) continue
        log(`fire ${d.config.name}/${task.id} ${mode}`)
        try {
          const result = await runTask({ repo: d.repo, taskId: task.id, mode })
          fires[key] = new Date().toISOString()
          log(`ok ${JSON.stringify(result)}`)
          n++
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          log(`fail ${d.config.name}/${task.id} ${mode}: ${msg}`)
        }
      }
    }
  }
  saveFires(fires)
  return n
}

export async function runDaemon(): Promise<void> {
  mkdirSync(pluginStateDir(), { recursive: true })
  writeFileSync(pidPath(), `${process.pid}\n`)
  log(`daemon start pid=${process.pid}`)
  const stop = () => {
    try {
      if (existsSync(pidPath())) unlinkSync(pidPath())
    } catch {
      /* ignore */
    }
    process.exit(0)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  for (;;) {
    try {
      await tickOnce()
    } catch (err) {
      log(`tick ${err instanceof Error ? err.message : err}`)
    }
    await Bun.sleep(TICK_MS)
  }
}

export function startDaemon(): { already?: boolean; pid: number } {
  const live = daemonPid()
  if (live) return { already: true, pid: live }
  mkdirSync(pluginStateDir(), { recursive: true })
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'cli.ts'), 'daemon'],
    {
      stdout: 'ignore',
      stderr: 'ignore',
      stdin: 'ignore',
      env: process.env,
    },
  )
  // child is detached-ish; we don't unref spawn in bun the same way — write pid after spawn
  const pid = child.pid
  writeFileSync(pidPath(), `${pid}\n`)
  child.unref()
  return { pid }
}

export function stopDaemon(): boolean {
  const pid = daemonPid()
  if (!pid) {
    if (existsSync(pidPath())) unlinkSync(pidPath())
    return false
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    /* already dead */
  }
  if (existsSync(pidPath())) unlinkSync(pidPath())
  return true
}
