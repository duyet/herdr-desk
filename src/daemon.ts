import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { cronSlotsToday } from './cron'
import { dayKey } from './day'
import { discoverDesks } from './discover'
import { publish } from './hub'
import { loadNotifyConfig } from './notify'
import { pluginStateDir } from './paths'
import { runTask } from './run'

const TICK_MS = 20_000
/** Keep fire keys whose day is within this many days of today (cronNext horizon). */
const FIRE_KEEP_DAYS = 8

function pidPath(): string {
  return join(pluginStateDir(), 'daemon.pid')
}

function firesPath(): string {
  return join(pluginStateDir(), 'fires.json')
}

function firesBakPath(): string {
  return join(pluginStateDir(), 'fires.json.bak')
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

function fireDay(key: string): string | null {
  // Keys end in `::<day>` (legacy) or `::<day>::<HH:MM>` (slot-keyed), so scan
  // the segments for the date rather than assuming it is last — otherwise every
  // slot-keyed entry looks dayless and pruneFires drops it on the next write.
  for (const seg of key.split('::')) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(seg)) return seg
  }
  return null
}

export function pruneFires(
  map: Record<string, string>,
  at = new Date(),
): Record<string, string> {
  const cutoff = new Date(at)
  cutoff.setHours(0, 0, 0, 0)
  cutoff.setDate(cutoff.getDate() - FIRE_KEEP_DAYS)
  const minDay = dayKey(cutoff)
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(map)) {
    const d = fireDay(k)
    if (d && d >= minDay) out[k] = v
  }
  return out
}

/**
 * Rewrite legacy day-keyed fire entries into slot keys.
 *
 * The old ledger recorded one entry per (repo, task, cron, day) and the daemon
 * never fired that job again that day. A legacy entry therefore expands into
 * **every slot of that day**, not just the ones before the recorded stamp:
 * anything less re-introduces the bug as a stampede — a half-hourly job
 * recorded at 01:20 would otherwise fire ~30 times on the first tick after the
 * upgrade. The cost is that the day of the upgrade runs no new slots; the job
 * is back to normal from the next day, which is the safe trade for unattended
 * work.
 */
export function migrateFires(
  map: Record<string, string>,
  now = new Date(),
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(map)) {
    const parts = k.split('::')
    if (parts.length !== 4 || !/^\d{4}-\d{2}-\d{2}$/.test(parts[3])) {
      out[k] = v
      continue
    }
    const [repo, taskId, cron, day] = parts
    // End of that local day, so the whole day is claimed.
    const endOfDay = new Date(
      Number(day.slice(0, 4)),
      Number(day.slice(5, 7)) - 1,
      Number(day.slice(8, 10)),
      23,
      59,
    )
    for (const slot of Number.isNaN(endOfDay.getTime())
      ? cronSlotsToday(cron, now)
      : cronSlotsToday(cron, endOfDay)) {
      out[`${repo}::${taskId}::${cron}::${day}::${slot}`] = v
    }
  }
  return out
}

export function loadFires(): Record<string, string> {
  if (!existsSync(firesPath())) return {}
  try {
    return migrateFires(
      JSON.parse(readFileSync(firesPath(), 'utf8')) as Record<string, string>,
    )
  } catch {
    const bak = firesBakPath()
    try {
      if (existsSync(bak)) unlinkSync(bak)
      renameSync(firesPath(), bak)
    } catch {
      /* ignore */
    }
    return {}
  }
}

export function saveFires(map: Record<string, string>, at = new Date()): void {
  mkdirSync(pluginStateDir(), { recursive: true })
  writeFileSync(
    firesPath(),
    `${JSON.stringify(pruneFires(map, at), null, 2)}\n`,
  )
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
  slot: string,
): string {
  return `${repo}::${taskId}::${cron}::${day}::${slot}`
}

/**
 * Which slot to run, and which missed slots to write off.
 *
 * A daemon that was down — or a tick that never finished — leaves slots
 * unfired, and firing all of them is how one machine hands its live managers
 * the same prompt thirty times in nine seconds (duyet/herdr-desk#40). So only
 * the newest missed slot runs; the rest are consumed without running, and the
 * desk resumes where it left off instead of replaying the day.
 */
export function catchUpPlan(
  slots: string[],
  isFired: (slot: string) => boolean,
): { run?: string; stale: string[] } {
  const due = slots.filter((slot) => !isFired(slot))
  if (due.length <= 1) return { run: due[0], stale: [] }
  return { run: due[due.length - 1], stale: due.slice(0, -1) }
}

export async function tickOnce(at = new Date()): Promise<number> {
  const desks = await discoverDesks()
  const fires = loadFires()
  const day = dayKey(at)
  let n = 0
  // Set when any fire was a problem, so the hub is published immediately rather
  // than waiting for the next tick to notice.
  let needsHub = false
  for (const d of desks) {
    for (const task of d.config.tasks) {
      for (const expr of task.crons) {
        if (!expr) continue
        // Key on the SLOT, not the day. A day-keyed ledger let the first fire
        // of the day consume the whole schedule, so `*/30 * * * *` fired once
        // a day instead of 48 times — and `status` showed nothing wrong,
        // because the job was never recorded as failing.
        const plan = catchUpPlan(cronSlotsToday(expr, at), (slot) =>
          Boolean(fires[fireKey(d.repo, task.id, expr, day, slot)]),
        )
        // The skipped slots are consumed *before* anything runs, and written
        // before it, so a tick that is interrupted half way cannot replay the
        // day on the next start. A ledger only saved at the end of a tick is a
        // ledger that never advances while the tick is busy — which is exactly
        // when it is needed.
        for (const slot of plan.stale) {
          fires[fireKey(d.repo, task.id, expr, day, slot)] =
            `skip ${new Date().toISOString()}`
        }
        if (plan.stale.length) {
          saveFires(fires)
          log(
            `skip ${d.config.name}/${task.id} ${expr}: ${plan.stale.length} missed slots, oldest ${plan.stale[0]}`,
          )
        }
        const slot = plan.run
        if (!slot) continue
        const key = fireKey(d.repo, task.id, expr, day, slot)
        log(`fire ${d.config.name}/${task.id} ${expr} slot ${slot}`)
        try {
          const result = await runTask({ repo: d.repo, taskId: task.id })
          fires[key] = new Date().toISOString()
          saveFires(fires)
          log(`ok ${JSON.stringify(result)}`)
          n++
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          fires[key] = `fail ${new Date().toISOString()}`
          saveFires(fires)
          log(`fail ${d.config.name}/${task.id} ${expr} slot ${slot}: ${msg}`)
          needsHub = true
        }
      }
    }
  }
  saveFires(fires)
  if (n > 0 || needsHub) await publishHub()
  return n
}

/**
 * One hub message per tick, at most.
 *
 * The hub is published from the tick rather than from each run, so N jobs
 * starting in the same tick produce one "N running" line instead of N messages.
 * `publish` applies the change and window gates; this only has to make sure a
 * hub failure is logged and swallowed, because a reporting problem must never
 * stop the next tick from firing work.
 */
async function publishHub(): Promise<void> {
  try {
    // The host config, not a repo layer resolved from whatever directory the
    // daemon happens to have been started in. The hub is about the machine, so
    // it goes where every machine-level notice goes — and a repo's committed
    // config must not be able to retarget where the whole machine reports to.
    const result = await publish({ dest: loadNotifyConfig() })
    if (result.sent) log(`hub sent (${result.body.split('\n')[0]})`)
  } catch (err) {
    log(`hub ${err instanceof Error ? err.message : String(err)}`)
  }
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
