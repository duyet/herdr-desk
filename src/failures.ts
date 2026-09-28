import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pluginStateDir } from './paths'

/**
 * Failures that have already been announced, so a permanent fault is said once.
 *
 * A failure is the one thing worth waking someone for — that is the whole reason
 * a failure is announced at all. But a fault that cannot fix itself produces
 * the identical message on every tick, and the channel filled with four copies
 * of the same `agent_name_taken` before anyone could read the first one. Once
 * announced, the same failure on the same job stays quiet; the hub still counts
 * it every day, and a *different* failure still announces immediately.
 *
 * Keyed on the job and a hash of the message, not on the text alone, so two
 * repos failing for the same reason each say so once, while one repo failing
 * twice for two different reasons says so twice.
 *
 * A repeat is not a notification decision that expires. It persists until the
 * message changes, because a fault that is still true an hour later is still the
 * same fault — the reader has already been told, and the hub is where they
 * check. What does expire is the *summary*: a long-lived fault is folded into
 * one "N jobs have been failing for M" line rather than N separate repeats.
 */

const FILE = 'failures.json'

/** A fault older than this is announced again, if it is still happening. */
export const REANNOUNCE_MS = 12 * 60 * 60 * 1000

export type FailureRecord = {
  /** Hash of the message, so a different reason is a different record. */
  hash: string
  first: string
  last: string
  /** How many times this exact failure has been seen. */
  count: number
}

function path(): string {
  return join(pluginStateDir(), FILE)
}

function load(): Record<string, FailureRecord> {
  if (!existsSync(path())) return {}
  try {
    const raw = JSON.parse(readFileSync(path(), 'utf8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    return raw as Record<string, FailureRecord>
  } catch {
    return {}
  }
}

function save(map: Record<string, FailureRecord>): void {
  mkdirSync(pluginStateDir(), { recursive: true })
  writeFileSync(path(), `${JSON.stringify(map, null, 2)}\n`)
}

function key(repo: string, task: string, hash: string): string {
  return `${repo}::${task}::${hash}`
}

export type RepeatVerdict = {
  announce: boolean
  /** Times this exact failure has now been seen, including this one. */
  count: number
  /** How long it has been failing, in ms. */
  forMs: number
  /** True when this is a repeat rather than a first sighting. */
  repeat: boolean
}

/**
 * Record a failure and say whether it is worth announcing.
 *
 * The first sighting of a fault announces. The same fault on the same job
 * afterwards does not, until {@link REANNOUNCE_MS} has passed — long enough that
 * the reader has long since seen it, short enough that a machine which is still
 * broken tomorrow morning is not silently assumed to have been fixed.
 *
 * Recording happens regardless of the verdict, so a suppressed repeat still
 * advances `count` and `last`. That is what lets the hub report "failing 47
 * times since 03:40" for a fault nobody was paged about again.
 */
export function noteFailure(
  repo: string,
  task: string,
  message: string,
  at = new Date(),
): RepeatVerdict {
  const hash = fingerprint(message)
  const k = key(repo, task, hash)
  const all = load()
  const prev = all[k]
  const now = at.toISOString()

  if (!prev) {
    all[k] = { hash, first: now, last: now, count: 1 }
    save(all)
    return { announce: true, count: 1, forMs: 0, repeat: false }
  }

  const count = prev.count + 1
  const forMs = at.getTime() - Date.parse(prev.first)
  all[k] = { ...prev, last: now, count }
  save(all)
  return {
    // A repeat is only worth the channel again after a long silence, and only
    // if the fault never stopped happening in between.
    announce:
      forMs > REANNOUNCE_MS &&
      at.getTime() - Date.parse(prev.last) > REANNOUNCE_MS,
    count,
    forMs,
    repeat: true,
  }
}

/** Clear a job's failure records — it succeeded, so the fault is over. */
export function clearFailures(repo: string, task: string): void {
  const all = load()
  const prefix = `${repo}::${task}::`
  const kept = Object.fromEntries(
    Object.entries(all).filter(([k]) => !k.startsWith(prefix)),
  )
  if (Object.keys(kept).length !== Object.keys(all).length) save(kept)
}

/** Longest-failing faults, for the hub's one-line summary. */
export function activeFailures(
  now = new Date(),
): Array<{ repo: string; task: string; rec: FailureRecord }> {
  const out: Array<{ repo: string; task: string; rec: FailureRecord }> = []
  for (const [k, rec] of Object.entries(load())) {
    const parts = k.split('::')
    if (parts.length < 2) continue
    out.push({ repo: parts[0] as string, task: parts[1] as string, rec })
  }
  return out.sort((a, b) => Date.parse(a.rec.first) - Date.parse(b.rec.first))
}

function fingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}
