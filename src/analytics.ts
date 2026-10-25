import type { RunRecord } from './history'
import type { SessionRow } from './sessions/types'
import { textTable } from './table'
import { paint, type TermOpts } from './term'

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
  /** Median wall time of a fire that recorded one; null before `ms` existed. */
  medianMs: number | null
}

export type RepoStat = {
  repo: string
  name: string
  ran: number
  skipped: number
  failed: number
  rate: number | null
}

export type AgentStat = {
  agent: string
  sessions: number
  /** Median session length, started to ended. null when none has both. */
  medianMin: number | null
}

export type Rollup = {
  since: Date
  total: number
  perDay: number
  rate: number | null
  jobs: JobStat[]
  repos: RepoStat[]
  failCauses: [string, number][]
  skipCauses: [string, number][]
  agents: AgentStat[]
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
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
  const jobMs = new Map<string, number[]>()
  const byRepo = new Map<string, RepoStat>()
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
      medianMs: null,
    }
    const p = byRepo.get(r.repo) ?? {
      repo: r.repo,
      name: r.name,
      ran: 0,
      skipped: 0,
      failed: 0,
      rate: null,
    }
    const o = outcomeOf(r)
    s.total += 1
    if (r.at > s.last) s.last = r.at
    if (typeof r.ms === 'number')
      jobMs.set(job, [...(jobMs.get(job) ?? []), r.ms])
    if (o.kind === 'ran') {
      s.ran += 1
      p.ran += 1
      ran += 1
    } else if (o.kind === 'skip') {
      s.skipped += 1
      p.skipped += 1
      skips.push(o.cause ?? '')
    } else {
      s.failed += 1
      p.failed += 1
      failed += 1
      fails.push(o.cause ?? '')
    }
    byJob.set(job, s)
    byRepo.set(r.repo, p)
  }
  for (const s of byJob.values()) {
    s.rate = rateOf(s.ran, s.failed)
    s.medianMs = median(jobMs.get(s.job) ?? [])
  }
  for (const p of byRepo.values()) p.rate = rateOf(p.ran, p.failed)
  const days = Math.max(1, (now.getTime() - since.getTime()) / 86_400_000)
  return {
    since,
    total: runs.length,
    perDay: runs.length / days,
    rate: rateOf(ran, failed),
    jobs: [...byJob.values()].sort((a, b) => a.job.localeCompare(b.job)),
    repos: [...byRepo.values()].sort((a, b) => a.name.localeCompare(b.name)),
    failCauses: tally(fails),
    skipCauses: tally(skips),
    agents: agentStats(sessions),
  }
}

function agentStats(sessions: SessionRow[]): AgentStat[] {
  const by = new Map<string, number[]>()
  const counts = tally(sessions.map((s) => s.agent))
  for (const s of sessions) {
    const min = (Date.parse(s.ended) - Date.parse(s.started)) / 60_000
    if (Number.isFinite(min) && min >= 0)
      by.set(s.agent, [...(by.get(s.agent) ?? []), min])
  }
  return counts.map(([agent, n]) => ({
    agent,
    sessions: n,
    medianMin: median(by.get(agent) ?? []),
  }))
}

export const pct = (r: number | null): string =>
  r === null ? '-' : `${Math.round(r * 100)}%`

export function duration(ms: number | null): string {
  if (ms === null) return '-'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${(ms / 3_600_000).toFixed(1)}h`
}

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
      ['JOB', 'RAN', 'SKIP', 'FAIL', 'OK%', 'FIRE'],
      r.jobs.map((j) => [
        j.job,
        String(j.ran),
        String(j.skipped),
        String(j.failed),
        pct(j.rate),
        duration(j.medianMs),
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
  if (r.repos.length > 1) {
    lines.push('', 'per repo')
    for (const p of r.repos)
      lines.push(
        fit(
          `${pct(p.rate).padStart(5)}  ${p.name} ran ${p.ran} skip ${p.skipped} fail ${p.failed}`,
          opts.width,
        ),
      )
  }
  if (r.agents.length) {
    lines.push('', 'sessions per agent (median length)')
    for (const a of r.agents)
      lines.push(
        `${String(a.sessions).padStart(5)}  ${a.agent}${a.medianMin === null ? '' : `  ${duration(a.medianMin * 60_000)}`}`,
      )
  }
  return lines.join('\n')
}
