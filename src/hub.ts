import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { dayKey } from './day'
import {
  clip,
  esc,
  LEVEL_DOT,
  LEVEL_TAG,
  link,
  type NoticeLevel,
  tag,
} from './format'
import { type NotifyConfig, notify } from './notify'
import { pluginStateDir } from './paths'

/**
 * The hub: one place that knows what every job on the machine is doing.
 *
 * The merged report answers "what happened to this repo" and only exists once a
 * job has finished. Nothing answered "what is happening right now, across
 * everything", which is why the only notices that used to arrive mid-run were
 * the useless ones — `spawned manager` on every slot, `re-prompted live
 * manager` on every tick, four times a day per job, saying only that something
 * happened. Counting is the signal. "11 tasks running, 1 stuck" is worth one
 * message; the eleventh identical `ok` is worth none.
 *
 * Two rules make this a hub rather than another source of noise:
 *
 * - **A report settles a job, it does not announce it.** `report.ts` already
 *   sends the meaningful per-repo outcome. It only writes hub state here, so a
 *   job that finished while nobody was listening still shows up as done instead
 *   of as a stuck run.
 * - **The hub repeats nothing.** {@link publish} sends only on a changed
 *   state signature, at most once per window unless something needs a human.
 */

/** Where every job's state lives, one file per job. */
const HUB_DIR = 'hub'
const DIGEST_FILE = 'digest.json'

/**
 * How long a job may run before it reads as stuck.
 *
 * Generous on purpose: a job that crosses into `stuck` while still working
 * produces a false alarm, and a false alarm is what teaches you to ignore the
 * channel. A manager's own timeout (the agent ladder's `timeoutMs`) is the
 * prompt side of this; this is the backstop for a manager that died without
 * writing a report at all.
 */
export const STUCK_MS = 45 * 60 * 1000

/** Quiet period between two routine hub messages. Urgent news ignores it. */
export const MIN_INTERVAL_MS = 30 * 60 * 1000

/** A record older than this is a job that has not run in days, not "now". */
export const STALE_MS = 7 * 24 * 60 * 60 * 1000

/** Bound on the hub message. It is read on a phone between other messages. */
export const MAX_BODY = 1200

/** One job's current state. Written by the fire path and by `report`. */
export type HubRecord = {
  repo: string
  task: string
  /** Display name of the desk, from its config. */
  desk: string
  /** `running` until a report, a failure, or a skip settles it. */
  status: 'running' | 'settled'
  /** The reported level, once settled. */
  level?: NoticeLevel
  /** One line of insight from the job's own report. */
  headline?: string
  links?: Array<[string, string]>
  startedAt: string
  updatedAt: string
  /** Local day this record belongs to; a new day starts the job over. */
  day: string
}

/** A record with `stuck` computed, ready to render. */
export type HubJob = HubRecord & {
  /** `running`, `stuck`, or the settled level. */
  state: NoticeLevel | 'running' | 'stuck'
  /** Milliseconds since the last sign of life. */
  ageMs: number
}

/** What a snapshot is, in one line — the thing worth a phone message. */
export type HubSnapshot = {
  jobs: HubJob[]
  running: number
  stuck: number
  settled: number
  byLevel: Record<NoticeLevel, number>
  /** True when something needs a human. */
  attention: boolean
  /** Worsest state present, for the coloured dot. */
  worst: NoticeLevel | 'running' | 'stuck'
  /** Stable hash of the state, so an unchanged hub never re-sends. */
  signature: string
}

function hubDir(): string {
  return join(pluginStateDir(), HUB_DIR)
}

/**
 * File name for a job.
 *
 * `{repo}::{task}` hashed, with a readable prefix. A repo path or a task id can
 * both contain anything a user typed, so the hash is the identity and the prefix
 * is only there to make `ls` of the state dir useful while debugging. The digest
 * is hashed for the same reason: two repos can be named `anyrouter`.
 */
function recordPath(repo: string, task: string): string {
  const key = `${repo}::${task}`
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 16)
  const label = `${basenameOf(repo)}--${task}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return join(hubDir(), `${label || 'job'}--${hash}.json`)
}

function basenameOf(repo: string): string {
  const parts = repo.replace(/[/\\]+$/, '').split(/[/\\]/)
  return parts[parts.length - 1] || 'repo'
}

function readRecord(path: string): HubRecord | null {
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as HubRecord
    // A record is only usable if it can be placed on a desk. Anything else is
    // a corrupt file, and treating a corrupt file as state would show a job
    // that does not exist.
    if (!raw || typeof raw !== 'object') return null
    if (typeof raw.repo !== 'string' || typeof raw.task !== 'string')
      return null
    if (raw.status !== 'running' && raw.status !== 'settled') return null
    return raw
  } catch {
    return null
  }
}

/**
 * Every record, minus the ones no longer worth showing.
 *
 * Pruning happens on read rather than on write so a desk that stops being
 * opened disappears from the hub without a cron job dedicated to tidying, and
 * a prune failure can never block a run.
 */
function readRecords(now = Date.now()): HubRecord[] {
  const dir = hubDir()
  if (!existsSync(dir)) return []
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'))
  } catch {
    return []
  }
  const out: HubRecord[] = []
  for (const name of names) {
    const rec = readRecord(join(dir, name))
    // A file that cannot be read as a record is either stale or was truncated
    // by a crash mid-write. It can never become readable again — every future
    // read would skip it — so it is removed here rather than left to sit in
    // the state dir for as long as the machine is on.
    if (!rec) {
      rmSync(join(dir, name), { force: true })
      continue
    }
    if (now - Date.parse(rec.updatedAt) > STALE_MS) {
      rmSync(join(dir, name), { force: true })
      continue
    }
    out.push(rec)
  }
  return out
}

/** Write a record for a job that has just started running. */
export function markRunning(rec: {
  repo: string
  task: string
  desk: string
  at?: Date
}): void {
  const at = (rec.at ?? new Date()).toISOString()
  write({
    ...rec,
    status: 'running',
    startedAt: at,
    updatedAt: at,
    day: dayKey(rec.at),
  })
}

/**
 * Write a record for a job that has finished, from either direction.
 *
 * `outcome` is the level a job reported about its own work. `error` is the
 * daemon's own verdict when the job never got far enough to report — a Herdr
 * call that failed is a `fail` regardless of what the job would have said.
 *
 * `startedAt` is carried forward from the previous record when the caller does
 * not know it, so a job that settles in a different process still has the age
 * the hub was already showing.
 */
export function markSettled(rec: {
  repo: string
  task: string
  desk?: string
  level: NoticeLevel
  headline?: string
  links?: Array<[string, string]>
  startedAt?: string
  at?: Date
}): void {
  const path = recordPath(rec.repo, rec.task)
  const previous = readRecord(path)
  const at = (rec.at ?? new Date()).toISOString()
  const record: HubRecord = {
    repo: rec.repo,
    task: rec.task,
    desk: rec.desk ?? previous?.desk ?? basenameOf(rec.repo),
    status: 'settled',
    level: rec.level,
    headline: rec.headline,
    links: rec.links,
    // A settle with no known start is as old as the run that produced it: using
    // `now` would make a job that finished 20 minutes ago read as 0 minutes old
    // in the digest, which is worse than not knowing.
    startedAt: rec.startedAt ?? previous?.startedAt ?? at,
    updatedAt: at,
    day: dayKey(rec.at),
  }
  write(record, path)
}

function write(
  record: HubRecord,
  path = recordPath(record.repo, record.task),
): void {
  mkdirSync(hubDir(), { recursive: true })
  // Written to a temp name and renamed: a reader that catches a half-written
  // record mid-tick must see the previous state, never `{}`.
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`)
  renameSync(tmp, path)
}

const LEVELS: NoticeLevel[] = ['ok', 'info', 'skip', 'blocked', 'fail']

/**
 * Rank of a state, worst last. `stuck` outranks a clean `ok` because a job
 * nobody has heard from is worse news than a job that finished, and `running`
 * ranks above `ok` only so a live job is visible as such.
 */
const RANK: Record<NoticeLevel | 'running' | 'stuck', number> = {
  ok: 0,
  info: 1,
  skip: 2,
  running: 3,
  stuck: 4,
  blocked: 5,
  fail: 6,
}

/**
 * The level a hub state is *rendered* as.
 *
 * `running` and `stuck` are hub states, not report levels — a job cannot report
 * "running", it simply has not reported yet. So they borrow a level for
 * presentation: `running` reads as `info` (blue, in progress) and `stuck` as
 * `fail`, because a job that has been silent past {@link STUCK_MS} is the most
 * urgent thing on the machine and must not be rendered as a neutral dot.
 *
 * Mapping rather than extending `NoticeLevel` keeps the search tag honest: the
 * hub posts `#fail` for a stuck job, so a search for failures finds it.
 */
const DOT_LEVEL: Record<NoticeLevel | 'running' | 'stuck', NoticeLevel> = {
  ok: 'ok',
  info: 'info',
  skip: 'skip',
  running: 'info',
  stuck: 'fail',
  blocked: 'blocked',
  fail: 'fail',
}

function worse(
  a: NoticeLevel | 'running' | 'stuck',
  b: NoticeLevel | 'running' | 'stuck',
): NoticeLevel | 'running' | 'stuck' {
  return RANK[b] > RANK[a] ? b : a
}

/**
 * The state of every job, with `stuck` derived.
 *
 * A job is stuck when it has been `running` for longer than {@link STUCK_MS} and
 * has written no report since. That is a real signal rather than a guess: the
 * two ways a job ends — a `status.md` and a thrown run — are both recorded, so
 * the only way to still be `running` this long is a manager that died, hung, or
 * was never started.
 */
export function snapshot(now = new Date()): HubSnapshot {
  const jobs: HubJob[] = readRecords(now.getTime()).map((rec) => {
    const ageMs = now.getTime() - Date.parse(rec.updatedAt)
    const state: NoticeLevel | 'running' | 'stuck' =
      rec.status === 'running' && ageMs > STUCK_MS
        ? 'stuck'
        : rec.status === 'running'
          ? 'running'
          : (rec.level ?? 'ok')
    return { ...rec, state, ageMs: now.getTime() - Date.parse(rec.startedAt) }
  })
  jobs.sort(
    (a, b) =>
      RANK[b.state] - RANK[a.state] ||
      b.ageMs - a.ageMs ||
      a.task.localeCompare(b.task),
  )

  const byLevel = Object.fromEntries(LEVELS.map((l) => [l, 0])) as Record<
    NoticeLevel,
    number
  >
  let running = 0
  let stuck = 0
  let settled = 0
  let worst: NoticeLevel | 'running' | 'stuck' = 'ok'
  for (const j of jobs) {
    worst = worse(worst, j.state)
    if (j.state === 'running') running++
    else if (j.state === 'stuck') stuck++
    else {
      settled++
      byLevel[j.state] = (byLevel[j.state] ?? 0) + 1
    }
  }
  return {
    jobs,
    running,
    stuck,
    settled,
    byLevel,
    attention: stuck > 0 || byLevel.blocked > 0 || byLevel.fail > 0,
    worst,
    signature: signature(jobs),
  }
}

/**
 * Hash of the state a message would describe.
 *
 * Deliberately over the *state*, not the text: `3 running` twice is the same
 * fact, but the two runs behind them are not, so a job that finishes and is
 * re-fired produces a new signature. Ages are excluded — otherwise every
 * heartbeat would look like a change and nothing would ever be suppressed.
 */
export function signature(jobs: HubJob[]): string {
  const shape = jobs
    .map((j) => `${j.repo}::${j.task}=${j.state}${j.level ?? ''}`)
    .sort()
    .join('\n')
  return createHash('sha256').update(shape).digest('hex').slice(0, 16)
}

/** `12m`, `3h`, `2d`. An age is only ever read next to a state. */
export function ago(ms: number): string {
  return formatAge(ms, false)
}

/**
 * How long a job has been silent.
 *
 * A stuck job is the one line where the number *is* the message, so it stays in
 * minutes for the whole first day. `2h` next to a stuck job reads as a rounded
 * guess; `135m` reads as "it has been dead for over two hours", which is the
 * difference between glancing and investigating. Past a day the precision is
 * noise, so it collapses to days.
 */
function formatAge(ms: number, exact: boolean): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (!exact) {
    if (m < 60) return `${m}m`
    const h = Math.round(m / 60)
    if (h < 48) return `${h}h`
    return `${Math.round(h / 24)}d`
  }
  if (m < 60 * 24) return `${m}m`
  return `${Math.round(m / (60 * 24))}d`
}

/** The one clause that says how many of what. */
export function countsLine(s: HubSnapshot): string {
  const bits: string[] = []
  if (s.running) bits.push(`${s.running} running`)
  if (s.stuck) bits.push(`${s.stuck} stuck`)
  const done = s.byLevel.ok + s.byLevel.info
  if (done) bits.push(`${done} done`)
  if (s.byLevel.skip) bits.push(`${s.byLevel.skip} skipped`)
  if (s.byLevel.blocked) bits.push(`${s.byLevel.blocked} blocked`)
  if (s.byLevel.fail) bits.push(`${s.byLevel.fail} failed`)
  return bits.length ? bits.join(' · ') : 'nothing running'
}

const MAX_RUNNING_LISTED = 6
const MAX_ATTENTION_LISTED = 5
const MAX_LINKS = 4

/**
 * The hub message: one headline of counts, then what needs a human.
 *
 * Running jobs get one shared line rather than a line each — the count is the
 * information, and eleven lines of `anyrouter/local:collect 4m` is the same wall
 * of text this was built to remove. Blocked, failed, and stuck jobs each get a
 * line with their own headline, because those are the ones a human is being
 * woken for.
 */
export function renderDigest(s: HubSnapshot): string {
  if (s.jobs.length === 0) return ''
  const level = DOT_LEVEL[s.worst]
  const out: string[] = [`${LEVEL_DOT[level]} ${esc(countsLine(s))}`]

  const running = s.jobs.filter((j) => j.state === 'running')
  if (running.length) {
    const shown = running.slice(0, MAX_RUNNING_LISTED)
    const rest = running.length - shown.length
    out.push(
      `• ${esc(
        shown.map((j) => `${deskOf(j)}  ${ago(j.ageMs)}`).join(' · '),
      )}${rest > 0 ? esc(` · +${rest} more`) : ''}`,
    )
  }

  for (const j of s.jobs
    .filter(
      (x) => x.state === 'stuck' || x.state === 'blocked' || x.state === 'fail',
    )
    .slice(0, MAX_ATTENTION_LISTED)) {
    const why = j.headline?.trim()
    const silent =
      j.state === 'stuck' ? esc(` (${formatAge(j.ageMs, true)})`) : ''
    out.push(
      `• ${esc(j.state)} ${esc(deskOf(j))}${why ? ` — ${esc(why)}` : ''}${silent}`,
    )
  }

  const links = s.jobs.flatMap((j) => j.links ?? []).slice(0, MAX_LINKS)
  for (const [label, url] of links) out.push(`• ${link(label, url)}`)

  const tags = [tag('desk'), tag('hub')]
  if (s.attention) tags.push(tag('attention'))
  out.push([LEVEL_TAG[level], ...tags].join(' '))

  const body = out.join('\n')
  return body.length > MAX_BODY
    ? `${clip(body, MAX_BODY - 1).trimEnd()}…`
    : body
}

/** `repo/task`, which is the only label that identifies a job across repos. */
function deskOf(j: HubJob): string {
  return `${j.desk || basenameOf(j.repo)}/${j.task}`
}

export type HubSend = {
  sent: boolean
  reason: string
  body: string
}

type DigestRecord = {
  signature: string
  at: string
}

/**
 * Send the hub, at most once per window, and never twice for the same state.
 *
 * Three gates, and the order matters:
 *
 * 1. **Unchanged state is never re-sent.** A desk that ticks every 20s must not
 *    produce 180 identical messages an hour.
 * 2. **A routine change waits for the window.** Count going 2 running to 3
 *    running is not news.
 * 3. **A job that needs a human does not wait.** `stuck`, `blocked`, and `fail`
 *    bypass the window, because the whole cost of this design is that a job
 *    needing a human is the one thing that must not wait for a timer.
 *
 * The claim is written **before** the send and released if the send fails, which
 * is the opposite of `report.ts` on purpose. There the two callers are the same
 * manager taking two turns, and a crash between claim and send would lose one
 * notice. Here the callers are concurrent — two `report` runs can finish at the
 * same instant — and two readers both seeing "not yet sent" both send. So the
 * claim is the lock: the first caller wins, the second stands down, and a failed
 * send gives the claim back so the next tick retries.
 */
export async function publish(opts: {
  dest?: NotifyConfig
  now?: Date
  force?: boolean
  send?: typeof notify
}): Promise<HubSend> {
  const now = opts.now ?? new Date()
  const snap = snapshot(now)
  const body = renderDigest(snap)
  if (!body) return { sent: false, reason: 'no jobs', body }

  const last = readDigest()

  if (!opts.force) {
    if (last?.signature === snap.signature) {
      return { sent: false, reason: 'unchanged since last hub', body }
    }
    if (
      !snap.attention &&
      last &&
      now.getTime() - Date.parse(last.at) < MIN_INTERVAL_MS
    ) {
      return { sent: false, reason: 'inside the quiet window', body }
    }
  }

  const dest = opts.dest
  if (dest && !dest.enabled) return { sent: false, reason: 'disabled', body }

  const claim: DigestRecord = {
    signature: snap.signature,
    at: now.toISOString(),
  }
  if (!claimDigest(claim, last)) {
    return { sent: false, reason: 'another tick is sending this', body }
  }

  const result = await (opts.send ?? notify)(
    { message: body, label: 'hub' },
    dest,
  )
  if (!result.sent) releaseDigest(claim)
  return {
    sent: result.sent,
    reason: result.sent ? 'sent' : (result.reason ?? 'not sent'),
    body,
  }
}

function digestPath(): string {
  return join(pluginStateDir(), DIGEST_FILE)
}

function readDigest(): DigestRecord | null {
  if (!existsSync(digestPath())) return null
  try {
    const raw = JSON.parse(readFileSync(digestPath(), 'utf8')) as DigestRecord
    if (typeof raw?.signature !== 'string' || typeof raw?.at !== 'string') {
      return null
    }
    return raw
  } catch {
    return null
  }
}

function writeDigest(rec: DigestRecord): void {
  mkdirSync(pluginStateDir(), { recursive: true })
  const tmp = `${digestPath()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`)
  renameSync(tmp, digestPath())
}

/**
 * Take the claim, unless someone else already holds this exact state.
 *
 * `mkdir` is the atomic step: exactly one caller can create the claim file, so
 * exactly one caller sends. A read-then-write would let two concurrent ticks
 * both observe an absent claim and both send — the exact duplicate the dedupe
 * exists to prevent, and one that only shows up when two jobs finish together,
 * which is when the channel is busiest.
 */
function claimDigest(rec: DigestRecord, seen: DigestRecord | null): boolean {
  const pending = `${digestPath()}.pending`
  mkdirSync(pluginStateDir(), { recursive: true })
  try {
    writeFileSync(pending, `${JSON.stringify(rec)}\n`, { flag: 'wx' })
  } catch {
    return false
  }
  // A pending claim older than the window belongs to a process that died
  // mid-send. Leaving it would silence the hub until someone deleted a file by
  // hand, so an expired one is taken over rather than respected.
  try {
    if (seen && seen.signature === rec.signature) return false
    if (seen && Date.now() - Date.parse(seen.at) >= MIN_INTERVAL_MS) {
      rmSync(pending, { force: true })
      try {
        writeFileSync(pending, `${JSON.stringify(rec)}\n`, { flag: 'wx' })
      } catch {
        return false
      }
    }
    writeDigest(rec)
    return true
  } finally {
    rmSync(pending, { force: true })
  }
}

/** Give the claim back after a send that did not land. */
function releaseDigest(rec: DigestRecord): void {
  const current = readDigest()
  // Only the caller's own claim may be released. Otherwise a slow send that
  // failed after a newer tick already succeeded would erase the newer claim
  // and let the same state be sent again.
  if (current?.signature === rec.signature && current.at === rec.at) {
    rmSync(digestPath(), { force: true })
  }
}

/** Terminal view: every job, one row, newest trouble first. */
export function formatHub(s: HubSnapshot): string {
  if (s.jobs.length === 0) return 'hub empty — no job has run on this machine'
  const head = countsLine(s)
  const rows = s.jobs.map((j) => [
    j.state,
    `${j.desk || basenameOf(j.repo)}/${j.task}`,
    ago(j.ageMs),
    (j.headline ?? '').slice(0, 60),
  ])
  return [
    `${head}`,
    '',
    textTableLines(['STATE', 'JOB', 'AGE', 'INSIGHT'], rows),
  ].join('\n')
}

/** Local copy of the table renderer, to keep this module free of CLI imports. */
function textTableLines(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  )
  const line = (cells: string[]) =>
    `| ${cells.map((c, i) => (c ?? '').padEnd(widths[i])).join(' | ')} |`
  return [
    line(headers),
    `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`,
    ...rows.map((r) => line(r)),
  ].join('\n')
}
