import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { cronDueToday } from './cron'
import { dayKey } from './day'
import { discoverDesks } from './discover'
import { pluginStateDir } from './paths'
import { runTask } from './run'

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
  cron: string,
  day: string,
): string {
  return `${repo}::${taskId}::${cron}::${day}`
}

export async function tickOnce(at = new Date()): Promise<number> {
  const desks = await discoverDesks()
  const fires = loadFires()
  const day = dayKey(at)
  let n = 0
  for (const d of desks) {
    for (const task of d.config.tasks) {
      for (const expr of task.crons) {
        if (!expr || !cronDueToday(expr, at)) continue
        const key = fireKey(d.repo, task.id, expr, day)
        if (fires[key]) continue
        log(`fire ${d.config.name}/${task.id} ${expr}`)
        try {
          const result = await runTask({ repo: d.repo, taskId: task.id })
          fires[key] = new Date().toISOString()
          log(`ok ${JSON.stringify(result)}`)
          n++
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          fires[key] = `fail ${new Date().toISOString()}`
          log(`fail ${d.config.name}/${task.id} ${expr}: ${msg}`)
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

function sourceNewerThanDaemon(): boolean {
  if (!existsSync(pidPath())) return false
  try {
    const pidM = statSync(pidPath()).mtimeMs
    const src = join(import.meta.dir, 'daemon.ts')
    if (!existsSync(src)) return false
    return statSync(src).mtimeMs > pidM
  } catch {
    return false
  }
}

export function startDaemon(): { already?: boolean; pid: number } {
  const live = daemonPid()
  if (live) {
    if (!sourceNewerThanDaemon()) return { already: true, pid: live }
    log(`restart stale daemon pid=${live}`)
    stopDaemon()
  }
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
