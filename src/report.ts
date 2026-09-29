import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type LoadedDesk, loadDeskConfig, type TaskConfig } from './config'
import {
  esc,
  LEVEL_DOT,
  LEVEL_TAG,
  link,
  type NoticeLevel,
  tag,
} from './format'
import { markSettled } from './hub'
import { type NotifyConfig, notify, resolveNotify } from './notify'
import { pluginStateDir } from './paths'
import { runDirFor } from './run'

/**
 * One job's self-reported outcome, parsed from the small block a manager writes
 * into its run dir.
 *
 * A desk can have several jobs running against one repo at once, and a shared
 * Telegram channel is read by scanning. Fanning out one message per job turns a
 * morning of work into a wall of near-identical notices, so every job writes a
 * *fragment* and the fragments are merged into a single notice per repo.
 *
 * The fragment format is deliberately tiny, because it is authored by an agent
 * and a stricter grammar is a grammar that eventually fails to parse:
 *
 * ```markdown
 * level: ok
 * 3 PRs merged, 1 still in review
 * - PR #418 merged
 * - #412 filed
 * - [changes.md](file:///run/changes.md)
 * ```
 */

export const REPORT_FILE = 'status.md'

const LEVELS: NoticeLevel[] = ['ok', 'info', 'skip', 'blocked', 'fail']

/**
 * How bad each level is, worst last.
 *
 * The merged notice takes the worst level of its fragments, so one red job is
 * visible in the dot without the reader opening a message to find out. `skip` and
 * `info` sit above `ok` because a day where nothing was attempted is a different
 * fact from a day where work landed, and both deserve to outrank "ok".
 */
const SEVERITY: Record<NoticeLevel, number> = {
  ok: 0,
  info: 1,
  skip: 2,
  blocked: 3,
  fail: 4,
}

export function worstLevel(levels: NoticeLevel[]): NoticeLevel {
  return levels.reduce<NoticeLevel>(
    (worst, l) => (SEVERITY[l] > SEVERITY[worst] ? l : worst),
    'ok',
  )
}

export type ReportFragment = {
  level: NoticeLevel
  headline: string
  items: string[]
  links: Array<[string, string]>
  tags: string[]
}

export type JobReport = ReportFragment & { task: string }

export function isLevel(value: string): value is NoticeLevel {
  return (LEVELS as string[]).includes(value)
}

/** `[label](https://…)` — the only link shape a fragment may use. */
const MD_LINK = /^\[([^\]]+)\]\((https?:\/\/\S+)\)$/

/**
 * Parse a fragment. Returns `null` for an empty file, so a manager that wrote
 * nothing is "no report" rather than an empty notice that still pings the chat.
 */
export function parseReport(text: string): ReportFragment | null {
  const lines = text.split('\n').map((l) => l.trim())
  let level: NoticeLevel = 'info'
  const rest: string[] = []
  let sawLevel = false

  for (const line of lines) {
    if (!line) continue
    if (!sawLevel && line.toLowerCase().startsWith('level:')) {
      const value = line.slice('level:'.length).trim().toLowerCase()
      if (isLevel(value)) level = value
      sawLevel = true
      continue
    }
    rest.push(line)
  }
  if (rest.length === 0) return null

  const items: string[] = []
  const links: Array<[string, string]> = []
  const tags: string[] = []
  let headline = ''

  for (const line of rest) {
    const body = line.startsWith('- ') ? line.slice(2).trim() : line
    if (headline === '' && !line.startsWith('- ')) {
      headline = body
      continue
    }
    if (headline === '' && line.startsWith('- ')) {
      // A fragment that opens with a bullet has no headline of its own; the
      // first bullet is a better headline than "no message".
      headline = body
      continue
    }
    if (line.startsWith('#')) {
      tags.push(line.replace(/^#+/, '').trim())
      continue
    }
    if (!line.startsWith('- ')) continue
    const hit = MD_LINK.exec(body)
    if (hit) links.push([hit[1], hit[2]])
    else items.push(body)
  }

  return { level, headline, items, links, tags }
}

export function reportPath(runDir: string): string {
  return join(runDir, REPORT_FILE)
}

/** Read one job's fragment. Missing or unparseable means "no report". */
export function readJobReport(runDir: string, task: string): JobReport | null {
  const path = reportPath(runDir)
  if (!existsSync(path)) return null
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const parsed = parseReport(text)
  return parsed ? { ...parsed, task } : null
}

/** Bounds. A merged notice is read on a phone, not audited. */
export const MAX_JOBS = 8
export const MAX_ITEMS_PER_JOB = 4
export const MAX_LINKS = 5

/**
 * Merge every job's fragment into one body.
 *
 * The order is: verdict line, then one block per job (task id in code, headline
 * bold, its own bullets), then the links, then the searchable tag. Job id is in
 * backticks rather than prose so a reader can tell at a glance which job a
 * block belongs to without the messages being three near-identical blobs.
 */
export function renderMerged(reports: JobReport[]): string {
  if (reports.length === 0) return ''
  const shown = reports.slice(0, MAX_JOBS)
  const hidden = reports.length - shown.length
  const level = worstLevel(shown.map((r) => r.level))
  const jobs = shown.length === 1 ? '1 job' : `${shown.length} jobs`

  const out: string[] = [
    `${LEVEL_DOT[level]} ${esc(level)} ${esc(jobs)} · ${esc(summaryLine(shown))}`,
  ]

  for (const r of shown) {
    out.push(`• ${esc(r.task)} — ${esc(r.headline)}`)
    for (const item of r.items.slice(0, MAX_ITEMS_PER_JOB)) {
      out.push(`  • ${esc(item)}`)
    }
    const more = r.items.length - MAX_ITEMS_PER_JOB
    if (more > 0) out.push(`  • ${esc(`… +${more} more`)}`)
  }
  if (hidden > 0) {
    out.push(`• ${esc(`… +${hidden} more job${hidden === 1 ? '' : 's'}`)}`)
  }

  const links = shown.flatMap((r) => r.links).slice(0, MAX_LINKS)
  for (const [label, url] of links) out.push(`• ${link(label, url)}`)

  const extra = [...new Set(shown.flatMap((r) => r.tags))].slice(0, 3)
  out.push([LEVEL_TAG[level], tag('desk'), ...extra.map(tag)].join(' '))
  return out.join('\n')
}

/**
 * The one clause that says what happened, built from the fragments' own counts
 * rather than from their headlines.
 *
 * Jobs report different granularities — one says "3 PRs merged", another says
 * "nothing to do" — so the counts are taken at face value and only the shape is
 * shared: `2 ok · 1 blocked`.
 */
function summaryLine(reports: JobReport[]): string {
  const counts = new Map<NoticeLevel, number>()
  for (const r of reports) counts.set(r.level, (counts.get(r.level) ?? 0) + 1)
  return LEVELS.filter((l) => counts.has(l))
    .map((l) => `${counts.get(l)} ${l}`)
    .join(' · ')
}

/**
 * Fingerprint of what a notice would say.
 *
 * Two jobs finishing at the same moment both run `report`, and after the settle
 * window they merge to the *same* body. Hashing it lets the second one stand
 * down instead of posting a duplicate — which is the whole reason merging is
 * worth doing at all.
 */
export function fingerprint(body: string): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 16)
}

/** One merged notice's worth of jobs, plus where they have to go. */
export type ReportGroup = {
  dest: NotifyConfig
  reports: JobReport[]
}

/**
 * Read every job's fragment for a day and split them by where they must be sent.
 *
 * Splitting by destination is what keeps merging honest. A repo whose jobs are
 * routed to two different Telegram topics must not have their outcomes folded
 * into one message that lands in only one of them — a merged notice is only
 * ever sent when every job in it would have gone to the same place anyway.
 */
export function collectReports(opts: {
  repo: string
  day: string
  config?: LoadedDesk
}): ReportGroup[] {
  const config = opts.config ?? loadDeskConfig(opts.repo)
  const buckets = new Map<string, ReportGroup>()

  for (const task of config.tasks) {
    const report = readRunReport(opts.repo, task, opts.day)
    if (!report) continue
    const { config: dest } = resolveNotify({
      repo: opts.repo,
      taskNotify: task.notify,
    })
    const key = `${dest.chatId} ${dest.topicId}`
    const bucket = buckets.get(key) ?? { dest, reports: [] }
    bucket.reports.push(report)
    buckets.set(key, bucket)
  }

  for (const group of buckets.values()) {
    group.reports.sort((a, b) => a.task.localeCompare(b.task))
  }
  return [...buckets.values()]
}

/** One job's fragment, or `null` if it wrote none or its run dir is unusable. */
function readRunReport(
  repo: string,
  task: TaskConfig,
  day: string,
): JobReport | null {
  try {
    return readJobReport(runDirFor(repo, task, day), task.id)
  } catch {
    // A `stateDir` that escapes the repo is a config error. `validate` reports
    // it; a status notice must not fail because of it.
    return null
  }
}

/**
 * Fold one job's own fragment into the machine-wide hub.
 *
 * The level and the headline are the job's own words, not the plugin's — the
 * same values that go into the merged notice. That is deliberate: a second,
 * plugin-invented summary of what a job did would drift from the report the
 * manager actually wrote, and the two would eventually disagree in front of
 * whoever is trying to work out what the machine did overnight.
 */
function settleHub(repo: string, r: JobReport, desk?: string): void {
  try {
    markSettled({
      repo,
      task: r.task,
      desk,
      level: r.level,
      headline: r.headline,
      links: r.links,
    })
  } catch {
    // The hub is a convenience view. A failure to write it must not stop the
    // report the manager actually asked for from being sent.
  }
}

export type SendOutcome = {
  sent: boolean
  reason: string
  body: string
  jobs: number
}

/**
 * Merge and send, once per destination.
 *
 * A send is recorded *after* it succeeds, not before. Claiming the fingerprint
 * first would make a crash mid-send silently swallow the notice, and a desk that
 * goes quiet is a worse failure than a channel that says the same thing twice.
 */
export async function sendReports(opts: {
  repo: string
  groups: ReportGroup[]
  day: string
  desk?: string
  force?: boolean
  dryRun?: boolean
  send?: typeof notify
}): Promise<SendOutcome[]> {
  const out: SendOutcome[] = []
  for (const group of opts.groups) {
    const body = renderMerged(group.reports)
    const jobs = group.reports.length
    const label = `${jobs} job${jobs === 1 ? '' : 's'}`

    // Settle the hub *before* deciding whether to send, and including when the
    // send stands down as a duplicate. The job did finish; whether the channel
    // already heard about it is a separate question. Settling only on a real
    // send would leave a job that was already reported as `running` in the hub
    // for ever, and it would eventually go stale and be reported as `stuck` —
    // the one failure the hub exists to prevent.
    if (!opts.dryRun) {
      for (const r of group.reports) {
        settleHub(opts.repo, r, opts.desk)
      }
    }
    const key = ledgerKey(
      opts.repo,
      opts.day,
      group.dest.chatId,
      group.dest.topicId,
    )
    const hash = fingerprint(body)

    if (opts.dryRun) {
      out.push({ sent: false, reason: 'dry run', body, jobs })
      continue
    }
    if (!opts.force && lastSent(key) === hash) {
      out.push({
        sent: false,
        reason: 'unchanged since last notice',
        body,
        jobs,
      })
      continue
    }

    const result = await (opts.send ?? notify)(
      { message: body, repo: opts.repo, label },
      group.dest,
    )
    if (result.sent) recordSent(key, hash)
    out.push({
      sent: result.sent,
      reason: result.sent ? 'sent' : (result.reason ?? 'not sent'),
      body,
      jobs,
    })
  }
  return out
}

function ledgerPath(): string {
  return join(pluginStateDir(), 'reports.json')
}

function ledgerKey(
  repo: string,
  day: string,
  chatId: string,
  topicId: string,
): string {
  return `${repo}::${day}::${chatId}::${topicId}`
}

function loadLedger(): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(ledgerPath(), 'utf8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    return raw as Record<string, string>
  } catch {
    return {}
  }
}

function lastSent(key: string): string | undefined {
  return loadLedger()[key]
}

function recordSent(key: string, hash: string): void {
  mkdirSync(pluginStateDir(), { recursive: true })
  const all = loadLedger()
  all[key] = hash
  // Keep the ledger to today's keys plus a small tail, so it cannot grow
  // without bound on a machine that has been running for years.
  const keys = Object.keys(all).sort()
  for (const old of keys.slice(0, Math.max(0, keys.length - 200))) {
    delete all[old]
  }
  writeFileSync(ledgerPath(), `${JSON.stringify(all, null, 2)}\n`)
}
