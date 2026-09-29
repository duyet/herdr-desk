import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pluginStateDir } from './paths'

export type RunRecord = {
  at: string
  name: string
  repo: string
  task: string
  mode: string
  ok: boolean
  detail?: string
  /** Set when a person fired the job (`desk trigger`), not a cron slot. */
  trigger?: 'manual'
}

/** How a job is identified in the ledger, independent of its display name. */
export type JobKey = { repo: string; task: string }

const MAX = 200

/**
 * Hard cap on a stored `detail`.
 *
 * `detail` carries whatever a caller passed, and a thrown Herdr error once
 * embedded an entire manager prompt. Truncating at the sink means no future
 * caller can poison the ledger, notify a whole prompt to a chat, or blow up
 * `history` — regardless of how the message was built.
 */
export const MAX_DETAIL = 300

export function truncateDetail(detail?: string): string | undefined {
  if (detail === undefined) return undefined
  if (detail.length <= MAX_DETAIL) return detail
  return `${detail.slice(0, MAX_DETAIL)}… (${detail.length} chars)`
}

export function historyPath(): string {
  return join(pluginStateDir(), 'runs.jsonl')
}

export function appendRun(rec: RunRecord): void {
  mkdirSync(pluginStateDir(), { recursive: true })
  const safe: RunRecord = { ...rec, detail: truncateDetail(rec.detail) }
  if (safe.detail === undefined) delete safe.detail
  writeFileSync(historyPath(), `${JSON.stringify(safe)}\n`, { flag: 'a' })
}

export function recordRun(rec: Omit<RunRecord, 'at'> & { at?: string }): void {
  appendRun({ at: rec.at ?? new Date().toISOString(), ...rec })
}

/**
 * The newest `limit` records, oldest first, optionally for one job only.
 *
 * `job` filters *before* the `MAX` bound, not after. The ledger is shared by
 * every repo and every job, so bounding the file first handed each job
 * whatever slice of the global tail happened to survive: a busy desk scrolled a
 * failure streak off the front of the window, and the streak under-reported the
 * job it was supposed to describe. `MAX` still caps how far back the scan goes,
 * it just counts this job's own records now.
 */
export function loadRuns(limit = 40, job?: JobKey): RunRecord[] {
  if (!existsSync(historyPath())) return []
  const lines = readFileSync(historyPath(), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
  const cap = Math.max(1, Math.min(limit, MAX))
  const out: RunRecord[] = []
  for (let i = lines.length - 1; i >= 0 && out.length < cap; i--) {
    try {
      const rec = JSON.parse(lines[i]) as RunRecord
      if (job && (rec.repo !== job.repo || rec.task !== job.task)) continue
      out.push(rec)
    } catch {
      /* skip bad line */
    }
  }
  return out.reverse()
}

/**
 * Every record at or after `since`, oldest first.
 *
 * Unbounded by {@link MAX} on purpose: analytics over 30 days must see all
 * 30 days, not the newest 200 fires. Bad lines are skipped like in `loadRuns`.
 */
export function loadRunsSince(since: Date): RunRecord[] {
  if (!existsSync(historyPath())) return []
  const out: RunRecord[] = []
  for (const line of readFileSync(historyPath(), 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const rec = JSON.parse(line) as RunRecord
      const t = Date.parse(rec.at)
      if (Number.isFinite(t) && t >= since.getTime()) out.push(rec)
    } catch {
      /* skip bad line */
    }
  }
  return out
}

export function formatHistory(runs: RunRecord[]): string {
  if (runs.length === 0) return 'no runs yet'
  return runs
    .map((r) => {
      const mark = r.ok ? 'ok' : 'fail'
      const extra = r.detail ? `  ${r.detail}` : ''
      const how = r.trigger ? ` (${r.trigger})` : ''
      return `${r.at}  ${mark}  ${r.name}/${r.task}  ${r.mode}${how}${extra}`
    })
    .join('\n')
}

/**
 * Consecutive failed fires for one job, counting back from its most recent
 * record.
 *
 * `since` is the *oldest* failure in the streak (when the break started) and
 * `detail` is the *newest* error (what it is failing on now). `status` shows
 * the last fire only, so a job that failed 24 times in a row reads as one red
 * word; the streak is the number that says "this desk went quiet", which is the
 * failure mode that actually cost weeks here.
 *
 * Keyed on `{repo, task}`, not `{name, task}`: two different checkouts on one
 * machine can both be called `chmonitor`, and keying on the display name merged
 * their streaks into one number that belonged to neither. `repo` is also what
 * `fireKey` already uses, so a run and its streak now agree on identity.
 */
export function failureStreak(
  runs: RunRecord[],
  job: JobKey,
): { count: number; since: string | null; detail: string | null } {
  const mine = runs.filter((r) => r.repo === job.repo && r.task === job.task)
  let count = 0
  let since: string | null = null
  let detail: string | null = null
  for (let i = mine.length - 1; i >= 0; i--) {
    const r = mine[i]
    if (r.ok) break
    count += 1
    since = r.at
    detail ??= r.detail ?? null
  }
  return { count, since, detail }
}
