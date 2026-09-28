import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pluginStateDir } from './paths'

/**
 * Jobs the host could not take yet.
 *
 * The health gate's contract is that a job is *held*, never dropped. A
 * half-hourly job that is skipped because the box was busy silently becomes a
 * job that never runs — and the ledger records it as a fire, so nothing anywhere
 * says it was missed. So a held job is written here, survives a daemon restart,
 * and is retried on the next tick until it runs.
 *
 * The queue is deliberately small and dumb: a list of `{repo, task, slot}`,
 * oldest first. There is no priority and no rebalancing, because a desk has a
 * handful of jobs and every one of them is equally owed. The only ordering that
 * matters is first-in, and adding a scheduler on top would be a way to starve a
 * job without anyone noticing.
 *
 * Growth is bounded by age rather than by count. A job that cannot run for three
 * days is not queued work, it is a broken desk, and the hub saying `stuck` is
 * more useful than a queue that grows forever waiting for capacity that is never
 * coming.
 */

const QUEUE_FILE = 'queue.json'

/** How long a held job stays queued before it is given up on. */
export const MAX_HELD_MS = 6 * 60 * 60 * 1000

export type HeldJob = {
  repo: string
  task: string
  /** The cron slot it was originally due for, for the ledger key. */
  slot: string
  /** When it was first held. Drives the give-up age. */
  since: string
  /** How many ticks have deferred it. */
  tries: number
  /** Why it was held, from the health check. */
  reason: string
}

function queuePath(): string {
  return join(pluginStateDir(), QUEUE_FILE)
}

function load(): HeldJob[] {
  if (!existsSync(queuePath())) return []
  try {
    const raw = JSON.parse(readFileSync(queuePath(), 'utf8')) as unknown
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (j): j is HeldJob =>
        !!j &&
        typeof (j as HeldJob).repo === 'string' &&
        typeof (j as HeldJob).task === 'string',
    )
  } catch {
    // A corrupt queue must not stop the desk from running. The cost is that
    // whatever was held is forgotten, and the job's next scheduled slot will
    // pick it up anyway.
    return []
  }
}

function save(jobs: HeldJob[]): void {
  mkdirSync(pluginStateDir(), { recursive: true })
  writeFileSync(queuePath(), `${JSON.stringify(jobs, null, 2)}\n`)
}

function key(j: { repo: string; task: string }): string {
  return `${j.repo}::${j.task}`
}

/**
 * Add a job to the queue, or note another attempt at it.
 *
 * Re-holding a job that is already queued keeps its original `since`, so a job
 * held every tick for six hours is given up on after six hours rather than
 * living forever — the `tries` counter alone would never reach that.
 */
export function hold(
  job: Omit<HeldJob, 'since' | 'tries'>,
  at = new Date(),
): void {
  const jobs = load()
  const hit = jobs.find((j) => key(j) === key(job))
  if (hit) {
    hit.tries += 1
    hit.reason = job.reason
    hit.slot = job.slot
  } else {
    jobs.push({ ...job, since: at.toISOString(), tries: 1 })
  }
  save(jobs)
}

/** Take one job off the queue, oldest first. */
export function next(): HeldJob | null {
  const jobs = load()
  if (jobs.length === 0) return null
  jobs.sort(
    (a, b) => a.since.localeCompare(b.since) || a.task.localeCompare(b.task),
  )
  const [first] = jobs
  if (!first) return null
  save(jobs.slice(1))
  return first
}

/**
 * Put a job back after a failed attempt, keeping its age.
 *
 * The job is appended unconditionally. Looking for an existing entry first —
 * which is what this did first — silently drops the job whenever there is no
 * match, and the common case *is* no match: `next()` has just taken it off the
 * queue. A retry that vanishes is the worst failure a queue can have, because
 * the ledger recorded a fire and nothing anywhere says the work was lost.
 */
export function requeue(job: HeldJob, reason: string): void {
  const jobs = load()
  if (jobs.some((j) => key(j) === key(job))) {
    hold({ ...job, reason }, new Date(job.since))
    return
  }
  jobs.push({ ...job, reason, tries: job.tries + 1 })
  save(jobs)
}

export function queued(): HeldJob[] {
  return load().sort(
    (a, b) => a.since.localeCompare(b.since) || a.task.localeCompare(b.task),
  )
}

export type QueueView = {
  jobs: HeldJob[]
  /** Jobs given up on because they waited too long. */
  expired: HeldJob[]
  /** How long the oldest job has been waiting, in ms. */
  oldestMs: number
}

/**
 * The queue with anything past its age dropped, for display and for the tick.
 *
 * Expired jobs are returned rather than silently deleted so the caller can
 * report them. A job that waited six hours and never ran is a fact about the
 * desk, and dropping it quietly would make a machine that is too busy look
 * exactly like a machine where everything is fine.
 */
export function view(now = new Date()): QueueView {
  const jobs = load()
  const held: HeldJob[] = []
  const expired: HeldJob[] = []
  for (const j of jobs) {
    if (now.getTime() - Date.parse(j.since) > MAX_HELD_MS) expired.push(j)
    else held.push(j)
  }
  if (expired.length) save(held)
  held.sort(
    (a, b) => a.since.localeCompare(b.since) || a.task.localeCompare(b.task),
  )
  const oldest = held[0]
  return {
    jobs: held,
    expired,
    oldestMs: oldest ? now.getTime() - Date.parse(oldest.since) : 0,
  }
}
