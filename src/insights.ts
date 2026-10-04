import { outcomeOf } from './analytics'
import type { RunRecord } from './history'
import type { SessionRow } from './sessions/types'

/**
 * A GitHub pull URL is the only PR we count.
 *
 * A bare `#418` in a title is an issue as often as a pull, and calling `gh`
 * to resolve it would put a network round-trip on every dashboard paint.
 * Unique URLs are the count: the same pull mentioned in a run and a session
 * is one PR.
 */
const PULL_URL = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g

/** How many pull URLs to list. The count is never capped. */
export const MAX_PRS_LISTED = 20

export type InsightCounts = {
  sessions: number
  agents: number
  prs: number
  runs: number
  ran: number
  skipped: number
  failed: number
}

export type Insights = {
  since: string
  counts: InsightCounts
  byAgent: { agent: string; sessions: number }[]
  /** Unique pull URLs, newest-looking order is not required — sorted, capped. */
  prs: string[]
}

export function pullUrls(text: string | undefined): string[] {
  if (!text) return []
  return text.match(PULL_URL) ?? []
}

/**
 * One pass over the runs and sessions already in memory.
 *
 * Callers load the ledger and the session index once and hand them here.
 * This function does not read the disk and does not reindex agent files:
 * a dashboard paint that walked every Claude/Codex/Grok session would be
 * the slow path `sessions index` already exists to avoid.
 */
export function insightsOf(input: {
  runs: RunRecord[]
  sessions: SessionRow[]
  since: Date
}): Insights {
  const sinceMs = input.since.getTime()
  const counts: InsightCounts = {
    sessions: 0,
    agents: 0,
    prs: 0,
    runs: 0,
    ran: 0,
    skipped: 0,
    failed: 0,
  }
  const byAgent = new Map<string, number>()
  const prs = new Set<string>()

  for (const row of input.sessions) {
    const t = Date.parse(row.started)
    if (!Number.isFinite(t) || t < sinceMs) continue
    counts.sessions += 1
    byAgent.set(row.agent, (byAgent.get(row.agent) ?? 0) + 1)
    for (const url of pullUrls(row.title)) prs.add(url)
  }
  counts.agents = byAgent.size

  for (const run of input.runs) {
    const t = Date.parse(run.at)
    if (!Number.isFinite(t) || t < sinceMs) continue
    counts.runs += 1
    const kind = outcomeOf(run).kind
    if (kind === 'ran') counts.ran += 1
    else if (kind === 'skip') counts.skipped += 1
    else counts.failed += 1
    for (const url of pullUrls(run.detail)) prs.add(url)
  }

  counts.prs = prs.size
  return {
    since: input.since.toISOString(),
    counts,
    byAgent: [...byAgent.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([agent, sessions]) => ({ agent, sessions })),
    prs: [...prs].sort().slice(0, MAX_PRS_LISTED),
  }
}
