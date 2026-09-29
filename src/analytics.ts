import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RunRecord } from './history'
import { pluginStateDir } from './paths'
import { textTable } from './table'
import { paint, type TermOpts } from './term'

/**
 * One row of `sessions.jsonl`, the P2 session index.
 *
 * That index is built by another command and its format may still grow, so
 * only `agent` and `started` are required; everything else is optional.
 */
export type SessionRow = {
  agent: string
  started: string
  repo?: string
  ended?: string
  title?: string
}

export function sessionsPath(): string {
  return join(pluginStateDir(), 'sessions.jsonl')
}

/** Rows at or after `since`; a missing file or a bad line is not an error. */
export function loadSessions(since?: Date): SessionRow[] {
  if (!existsSync(sessionsPath())) return []
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
  const out: SessionRow[] = []
  for (const line of readFileSync(sessionsPath(), 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line) as Record<string, unknown>
      if (typeof r.agent !== 'string' || typeof r.started !== 'string') continue
      const t = Date.parse(r.started)
      if (!Number.isFinite(t) || (since && t < since.getTime())) continue
      out.push({
        agent: r.agent,
        started: r.started,
        repo: str(r.repo),
        ended: str(r.ended),
        title: str(r.title),
      })
    } catch {
      /* skip bad line */
    }
  }
  return out
}

/** `30d`, `12h`, `2w` -> a Date that far before `now`; null when unparsable. */
export function parseSince(spec: string, now = new Date()): Date | null {
  const m = /^(\d+)([hdw])$/.exec(spec.trim())
  if (!m) return null
  const hours = { h: 1, d: 24, w: 168 }[m[2] as 'h' | 'd' | 'w']
  return new Date(now.getTime() - Number(m[1]) * hours * 3_600_000)
}

/**
 * What one ledger record means.
 *
 * A successful record's `detail` is the run result as JSON: `spawned` or
 * `prompted` did work, `skipped` did not. A failed record's `detail` is the
 * error text, so its first line is the cause.
 */
export function outcomeOf(r: RunRecord): {
  kind: 'ran' | 'skip' | 'fail'
  cause?: string
} {
  if (!r.ok) {
    const first = (r.detail ?? 'unknown error').split('\n')[0]
    return { kind: 'fail', cause: first }
  }
  try {
    const d = JSON.parse(r.detail ?? '{}') as { skipped?: unknown }
    if (typeof d.skipped === 'string') return { kind: 'skip', cause: d.skipped }
  } catch {
    /* a free-text ok detail still counts as a run */
  }
  return { kind: 'ran' }
}

export type JobStat = {
  job: string
  total: number
  ran: number
  skipped: number
  failed: number
  /** ran / (ran + failed); skips are not attempts. null when never attempted. */
  rate: number | null
  last: string
}

export type Rollup = {
  since: Date
  total: number
  perDay: number
  rate: number | null
  jobs: JobStat[]
  failCauses: [string, number][]
  skipCauses: [string, number][]
  agents: [string, number][]
}

function tally(xs: string[]): [string, number][] {
  const m = new Map<string, number>()
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1)
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

const rateOf = (ran: number, failed: number) =>
  ran + failed === 0 ? null : ran / (ran + failed)

export function rollup(
  runs: RunRecord[],
  sessions: SessionRow[],
  since: Date,
  now = new Date(),
): Rollup {
  const byJob = new Map<string, JobStat>()
  const fails: string[] = []
  const skips: string[] = []
  let ran = 0
  let failed = 0
  for (const r of runs) {
    const job = `${r.name}/${r.task}`
    const s = byJob.get(job) ?? {
      job,
      total: 0,
      ran: 0,
      skipped: 0,
      failed: 0,
      rate: null,
      last: r.at,
    }
    const o = outcomeOf(r)
    s.total += 1
    if (r.at > s.last) s.last = r.at
    if (o.kind === 'ran') {
      s.ran += 1
      ran += 1
    } else if (o.kind === 'skip') {
      s.skipped += 1
      skips.push(o.cause ?? '')
    } else {
      s.failed += 1
      failed += 1
      fails.push(o.cause ?? '')
    }
    byJob.set(job, s)
  }
  for (const s of byJob.values()) s.rate = rateOf(s.ran, s.failed)
  const days = Math.max(1, (now.getTime() - since.getTime()) / 86_400_000)
  return {
    since,
    total: runs.length,
    perDay: runs.length / days,
    rate: rateOf(ran, failed),
    jobs: [...byJob.values()].sort((a, b) => a.job.localeCompare(b.job)),
    failCauses: tally(fails),
    skipCauses: tally(skips),
    agents: tally(sessions.map((s) => s.agent)),
  }
}

export const pct = (r: number | null): string =>
  r === null ? '-' : `${Math.round(r * 100)}%`

const fit = (s: string, w: number) =>
  s.length > w ? `${s.slice(0, Math.max(1, w - 1))}…` : s

export function formatAnalytics(
  r: Rollup,
  opts: TermOpts,
  wide = false,
): string {
  const rateColor = (x: number | null) =>
    x === null ? '0' : x >= 0.9 ? '32' : x >= 0.6 ? '33' : '31'
  const lines = [
    `since ${r.since.toISOString().slice(0, 10)}: ${r.total} fire(s), ${r.perDay.toFixed(1)}/day, success ${paint(opts.color, rateColor(r.rate), pct(r.rate))}`,
  ]
  if (r.jobs.length) {
    lines.push('')
    const table = textTable(
      ['JOB', 'RAN', 'SKIP', 'FAIL', 'OK%'],
      r.jobs.map((j) => [
        j.job,
        String(j.ran),
        String(j.skipped),
        String(j.failed),
        pct(j.rate),
      ]),
    )
    // A table wider than the terminal wraps into noise; one line per job
    // stays readable at any width.
    if (table.split('\n')[0].length <= opts.width) lines.push(table)
    else
      for (const j of r.jobs)
        lines.push(
          fit(
            `${j.job} ran ${j.ran} skip ${j.skipped} fail ${j.failed} ${pct(j.rate)}`,
            opts.width,
          ),
        )
  }
  // Never truncate a cause: two errors that differ only past the cut would
  // read as one. Wrap to the width instead, or keep one line with `wide`.
  const causeW = Math.max(12, opts.width - 7)
  const wrap = (c: string): string[] => {
    if (wide) return [c]
    const out: string[] = []
    for (let i = 0; i < c.length; i += causeW) out.push(c.slice(i, i + causeW))
    return out.length ? out : ['']
  }
  const causes = (title: string, xs: [string, number][]) => {
    if (!xs.length) return
    lines.push('', title)
    for (const [c, n] of xs.slice(0, 5))
      for (const [i, part] of wrap(c).entries())
        lines.push(`${i === 0 ? String(n).padStart(5) : '     '}  ${part}`)
  }
  causes('failure causes', r.failCauses)
  causes('skip reasons', r.skipCauses)
  if (r.agents.length) {
    lines.push('', 'sessions per agent')
    for (const [a, n] of r.agents) lines.push(`${String(n).padStart(5)}  ${a}`)
  }
  return lines.join('\n')
}
