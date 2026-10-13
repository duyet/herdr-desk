import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'

/**
 * A per-task lock file, held while one fire prompts or spawns its manager.
 *
 * Two fires of one task (a cron slot and an event, or two desks over the same
 * repo) both see "no manager registered" and both reach `worktree create` and
 * `agent start`. The file is repo-local so every contender computes the same
 * path, and it is created with O_EXCL so exactly one of them wins.
 */
type ClaimRecord = { pid: number; at: number }

export type Claim = { release(): void }

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function readClaim(path: string): ClaimRecord | null {
  try {
    const r = JSON.parse(readFileSync(path, 'utf8')) as Partial<ClaimRecord>
    return typeof r.pid === 'number' && typeof r.at === 'number'
      ? { pid: r.pid, at: r.at }
      : null
  } catch {
    return null
  }
}

/**
 * A claim nobody can still be holding: its process is gone, it is older than
 * `maxAgeMs`, or it cannot be read. Missing files are not stale; there is
 * nothing to take over.
 */
export function isStaleClaim(
  path: string,
  maxAgeMs: number,
  now = Date.now(),
  alive: (pid: number) => boolean = pidAlive,
): boolean {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return false
  }
  const rec = raw ? readClaim(path) : null
  if (!rec) return true
  return now - rec.at > maxAgeMs || !alive(rec.pid)
}

function create(path: string, now: number): boolean {
  let fd: number
  try {
    fd = openSync(path, 'wx')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, at: now }))
  } finally {
    closeSync(fd)
  }
  return true
}

/**
 * Take the claim at `path`, or `null` when someone live holds it.
 *
 * A stale claim is renamed aside before the retry, so of two contenders that
 * both judge it stale only the one whose rename lands gets to create.
 */
export function tryClaim(
  path: string,
  maxAgeMs: number,
  now = Date.now(),
  alive: (pid: number) => boolean = pidAlive,
): Claim | null {
  mkdirSync(dirname(path), { recursive: true })
  if (!create(path, now)) {
    if (!isStaleClaim(path, maxAgeMs, now, alive)) return null
    const aside = `${path}.stale-${process.pid}-${now}`
    try {
      renameSync(path, aside)
    } catch {
      return null
    }
    rmSync(aside, { force: true })
    if (!create(path, now)) return null
  }
  return {
    release() {
      // Only remove the file if it is still ours; a takeover may have replaced it.
      const rec = readClaim(path)
      if (rec && rec.pid === process.pid && rec.at === now)
        rmSync(path, { force: true })
    },
  }
}
