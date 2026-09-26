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
}

const MAX = 200

export function historyPath(): string {
  return join(pluginStateDir(), 'runs.jsonl')
}

export function appendRun(rec: RunRecord): void {
  mkdirSync(pluginStateDir(), { recursive: true })
  writeFileSync(historyPath(), `${JSON.stringify(rec)}\n`, { flag: 'a' })
}

export function recordRun(rec: Omit<RunRecord, 'at'> & { at?: string }): void {
  appendRun({ at: rec.at ?? new Date().toISOString(), ...rec })
}

export function loadRuns(limit = 40): RunRecord[] {
  if (!existsSync(historyPath())) return []
  const lines = readFileSync(historyPath(), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
  const slice = lines.slice(-Math.max(1, Math.min(limit, MAX)))
  const out: RunRecord[] = []
  for (const line of slice) {
    try {
      out.push(JSON.parse(line) as RunRecord)
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
      return `${r.at}  ${mark}  ${r.name}/${r.task}  ${r.mode}${extra}`
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
 */
export function failureStreak(
  runs: RunRecord[],
  job: { name: string; task: string },
): { count: number; since: string | null; detail: string | null } {
  const mine = runs.filter((r) => r.name === job.name && r.task === job.task)
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
