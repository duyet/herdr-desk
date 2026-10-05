/**
 * Waking a desk job on a repo event instead of (or as well as) a cron slot.
 *
 * The plugin does not learn what a PR is. It learns one thing: a repo can hand
 * the desk a command that prints events, and the desk turns events into runs.
 * "New PR opened" is `GET /pulls?sort=created` plus a filter; "a human
 * commented" is a search query; "the deploy finished" is a URL. A cron cannot
 * express any of them, so every repo hand-rolls a `while true; do …; done` loop
 * beside the desk and the two drift.
 *
 * So the split of ownership is: **the script owns what an event is, the desk
 * owns when to run and not running twice.** The script prints NDJSON on stdout
 * and keeps its own cursor; the desk dedupes on `id`, queues per task, and fires
 * one manager run carrying the whole queue. A storm is one manager with ten
 * items, not ten managers.
 *
 * Everything here is written on the assumption that it is running unattended on
 * a machine nobody is watching. A watcher that throws, times out, or prints
 * garbage must never be able to stop the cron path, and a watcher whose script
 * broke on day one must not look like a watcher with nothing to report — see
 * {@link WATCH_NOTIFY_AFTER}.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { WatchConfig } from './config'
import { formatLocal } from './day'
import { pluginStateDir } from './paths'
import { looksLikePathArg } from './schema'

/**
 * One event, as the script printed it.
 *
 * `id` is required and must be stable across polls — it is the dedupe key.
 * Everything else is optional and passes straight through to the manager
 * prompt, because the plugin has no business knowing what a repo means.
 */
export type WatchEvent = {
  id: string
  type?: string
  at?: string
  summary?: string
  [key: string]: unknown
}

export type ParsedOutput = {
  /** Events with a usable `id`, in the order the script printed them. */
  events: WatchEvent[]
  /**
   * Why a line was skipped. Counted and reported, never fatal: one bad line
   * must not mute a watcher, and a silent skip is how a script that has been
   * printing garbage for a week still reads as "nothing to report".
   */
  warnings: string[]
}

/**
 * Longest line the desk will look at.
 *
 * Events travel to a manager as prompt text and into `events.json` on disk, so
 * an unbounded line is an unbounded prompt. 64 KB is orders of magnitude above
 * what an event needs (`id`, `type`, `at`, `summary`, `url`) and bounded enough
 * that `maxPending` of them cannot fill a prompt. A line past it is a warning
 * like any other bad line: counted, skipped, visible in `watch status`.
 */
export const MAX_LINE_BYTES = 64 * 1024

/**
 * Longest stdout the desk will read before calling the poll failed.
 *
 * A script that prints without end would otherwise sit in memory until the
 * daemon is OOM-killed — on a host where an OOM kill takes the whole desk, not
 * one watcher, down with it. A truncated event list is worse than no event list,
 * because it is silently wrong, so this fails the poll rather than parsing a
 * prefix of it.
 */
export const MAX_STDOUT_BYTES = 4 * 1024 * 1024

/**
 * How long a dedupe key is remembered.
 *
 * Long enough that a cursor which rewinds (a force-push, a re-clone, a script
 * restarted from scratch) cannot replay a week of history at the desk; short
 * enough that the file does not become a permanent record of every event a repo
 * ever had.
 */
export const SEEN_TTL_MS = 7 * 86_400_000

/**
 * Hard cap on remembered dedupe keys.
 *
 * The TTL alone does not bound the file: a chatty watcher on a short interval
 * can produce keys far faster than seven days retires them. Dropping the oldest
 * is the right direction — an event this old will have been handled or will
 * have expired from the script's own cursor too — and the cap is set well above
 * the overflow case it exists for, so an event dropped as overflow stays
 * remembered rather than being re-queued forever.
 */
export const SEEN_MAX = 10_000

/** Consecutive failures before the desk says the watcher is broken. */
export const WATCH_NOTIFY_AFTER = 5

/**
 * How long to wait after the Nth consecutive failure.
 *
 * Exponential, capped at 8x the interval. Uncapped, a watcher that is broken
 * for a week is still polling every two minutes; capped, one dead script costs
 * one poll per eight intervals forever, which is cheap and enough to notice.
 */
export function backoffMs(intervalSec: number, fails: number): number {
  const interval = intervalSec * 1000
  return Math.min(interval * 2 ** Math.max(0, fails), interval * 8)
}

/** State for one watched task. */
export type WatchTaskState = {
  /** When the last pass ran, healthy or not. */
  lastPollAt: string
  /** When the last pass exited 0. `null` until the watcher has ever worked. */
  lastOkAt: string | null
  nextPollAt: string
  /** Consecutive failed passes; 0 while healthy. */
  fails: number
  /** When the current failure streak began. */
  firstFailAt: string | null
  lastError: string | null
  /** Events waiting to be carried by the next run of this task. */
  pending: WatchEvent[]
  /** Events dropped because `pending` was full. Counted, never queued. */
  overflow: number
  /** Events seen while the task was paused. Counted and dropped. */
  paused: number
  /** Skipped lines from the last pass. */
  warnings: number
  /** Lines of stdout from the last pass, when it failed. */
  code: number | null
  /** eventId -> when the desk first saw it. The dedupe ledger. */
  seen: Record<string, string>
}

export type WatchState = {
  tasks: Record<string, WatchTaskState>
}

/** Same identity every other per-job file uses: the repo path, not the name. */
export function watchKey(repo: string, taskId: string): string {
  return `${repo}::${taskId}`
}

export function watchStatePath(): string {
  return join(pluginStateDir(), 'watch.json')
}

export function watchStateBakPath(): string {
  return join(pluginStateDir(), 'watch.json.bak')
}

function emptyTaskState(at: Date): WatchTaskState {
  return {
    lastPollAt: at.toISOString(),
    lastOkAt: null,
    nextPollAt: at.toISOString(),
    fails: 0,
    firstFailAt: null,
    lastError: null,
    pending: [],
    overflow: 0,
    paused: 0,
    warnings: 0,
    code: null,
    seen: {},
  }
}

/**
 * Read the state, or start fresh.
 *
 * A corrupt file is moved to `watch.json.bak` and the desk starts over, which
 * is {@link loadFires}' recovery idiom rather than a second one: two ways to
 * recover from a bad state file is two ways to get them subtly different. The
 * cost is real — the `seen` ledger is gone, so a script whose cursor also
 * rewound can replay — and unavoidable, because the alternative is a desk that
 * cannot start.
 */
export function loadWatchState(): WatchState {
  if (!existsSync(watchStatePath())) return { tasks: {} }
  try {
    const raw = JSON.parse(readFileSync(watchStatePath(), 'utf8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('not an object')
    const tasks = (raw as WatchState).tasks
    if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) {
      throw new Error('no tasks')
    }
    return { tasks }
  } catch {
    const bak = watchStateBakPath()
    try {
      if (existsSync(bak)) rmSync(bak, { force: true })
      renameSync(watchStatePath(), bak)
    } catch {
      /* ignore */
    }
    return { tasks: {} }
  }
}

/**
 * Drop a task's `seen` ledger down to what is still in scope.
 *
 * Called on the way in and on the way out, so the file cannot be left huge by a
 * crash between two writes. Newest first, then re-sorted for a stable file.
 */
export function pruneSeen(
  seen: Record<string, string>,
  at = new Date(),
): Record<string, string> {
  const live: Array<[string, string]> = []
  for (const [id, when] of Object.entries(seen)) {
    const t = Date.parse(when)
    if (Number.isFinite(t) && at.getTime() - t <= SEEN_TTL_MS)
      live.push([id, when])
  }
  live.sort((a, b) => a[1].localeCompare(b[1]))
  const kept = live.slice(Math.max(0, live.length - SEEN_MAX))
  return Object.fromEntries(kept)
}

/** Prune every task's dedupe ledger. Age-only: events are never dropped. */
export function pruneWatchState(
  state: WatchState,
  at = new Date(),
): WatchState {
  const tasks: Record<string, WatchTaskState> = {}
  for (const [key, t] of Object.entries(state.tasks)) {
    tasks[key] = { ...t, seen: pruneSeen(t.seen ?? {}, at) }
  }
  return { tasks }
}

/**
 * Write the state the way the fire ledger is written: tmp file, then rename.
 *
 * A half-written `watch.json` is the one thing that cannot be recovered from
 * here — rename is atomic, so a reader either sees the old file or the new one
 * and never a half of either.
 */
export function saveWatchState(state: WatchState, at = new Date()): void {
  mkdirSync(pluginStateDir(), { recursive: true })
  const path = watchStatePath()
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(pruneWatchState(state, at), null, 2)}\n`)
  renameSync(tmp, path)
}

export function taskState(
  state: WatchState,
  repo: string,
  taskId: string,
  at = new Date(),
): WatchTaskState {
  const key = watchKey(repo, taskId)
  const hit = state.tasks[key]
  if (hit) {
    return {
      ...emptyTaskState(at),
      ...hit,
      pending: Array.isArray(hit.pending) ? hit.pending : [],
      seen: hit.seen && typeof hit.seen === 'object' ? hit.seen : {},
    }
  }
  return emptyTaskState(at)
}

/**
 * Is this task due?
 *
 * A task with no state is due immediately: the alternative is a watcher that
 * does nothing for a whole interval after its config lands, which reads as a
 * watcher that is broken.
 */
export function isDue(t: WatchTaskState, at: Date): boolean {
  const next = Date.parse(t.nextPollAt)
  if (!Number.isFinite(next)) return true
  return next <= at.getTime()
}

/**
 * Read NDJSON off stdout.
 *
 * `id` is required and a line without one is *counted and skipped*, never
 * fatal. The reasoning is about replay, not leniency: the desk cannot dedupe an
 * event it cannot name, so a line with no `id` is one that would be re-queued on
 * every poll forever if it were accepted — mutes the watcher forever if it
 * kills the pass. Counting it makes it visible in `watch status`, which is the
 * only place a silent failure is allowed to hide.
 */
export function parseWatchOutput(ndjson: string): ParsedOutput {
  const events: WatchEvent[] = []
  const warnings: string[] = []
  const lines = ndjson.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    // A blank line is not a bad line: every NDJSON writer ends its last record
    // with a newline, so warning here would report one warning per poll on a
    // perfectly healthy script.
    if (!line.trim()) continue
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      warnings.push(`line ${i + 1}: over ${MAX_LINE_BYTES} bytes`)
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      warnings.push(`line ${i + 1}: not JSON`)
      continue
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warnings.push(`line ${i + 1}: not a JSON object`)
      continue
    }
    const o = parsed as Record<string, unknown>
    const id = o.id
    if (typeof id !== 'string' || !id.trim()) {
      warnings.push(`line ${i + 1}: no id`)
      continue
    }
    events.push({ ...o, id: id.trim() })
  }
  return { events, warnings }
}

/**
 * Queue events, deduped, up to `maxPending`.
 *
 * The dedupe key is written **whether or not the event was queued**. That is the
 * whole point: an event dropped as overflow would otherwise be offered again on
 * the next poll, overflow again, and be offered again forever — so a task whose
 * watcher is louder than its cap spends every poll re-reading events it will
 * never run and never once runs the ones it is holding.
 *
 * Returns the counts, so the caller can log what happened without diffing.
 */
export function queueEvents(
  t: WatchTaskState,
  events: WatchEvent[],
  maxPending: number,
  at = new Date(),
): { queued: number; duplicates: number; overflow: number } {
  const seen = t.seen ?? {}
  let queued = 0
  let duplicates = 0
  let overflow = 0
  for (const event of events) {
    if (seen[event.id] !== undefined) {
      duplicates++
      continue
    }
    seen[event.id] = at.toISOString()
    if (t.pending.length >= maxPending) {
      t.overflow += 1
      overflow += 1
      continue
    }
    t.pending.push(event)
    queued += 1
  }
  t.seen = seen
  return { queued, duplicates, overflow }
}

/**
 * Forget a task's queue and dedupe ledger. `desk watch reset`.
 *
 * The split is deliberate: everything describing the watcher's **health** is
 * kept, everything describing the **queue** is dropped. A reset is a person
 * saying "the desk is holding things it should not be", and the answer to that
 * is an empty queue — not a clean sheet on how the script has been failing.
 * Zeroing `fails` here would let the one command whose whole job is proving a
 * watcher is broken (`watch status`, `fails: N from <date>`) be the command that
 * makes it look fine again.
 *
 * `nextPollAt` moves to now so the reset actually causes a poll, rather than
 * sitting out the remainder of an interval for a queue the desk has already
 * been told to forget.
 */
export function resetTask(
  state: WatchState,
  repo: string,
  taskId: string,
  at = new Date(),
): void {
  const key = watchKey(repo, taskId)
  const was = state.tasks[key]
  if (!was) return
  state.tasks[key] = {
    lastPollAt: was.lastPollAt,
    lastOkAt: was.lastOkAt,
    lastError: was.lastError,
    fails: was.fails,
    firstFailAt: was.firstFailAt,
    code: was.code,
    nextPollAt: at.toISOString(),
    pending: [],
    overflow: 0,
    paused: 0,
    warnings: 0,
    seen: {},
  }
}

/** Whether argv[0] may be run as written, and what it resolves to. */
export function resolveWatchArgv(
  repo: string,
  command: string[],
): { argv: string[]; error: string | null } {
  const [head, ...rest] = command
  if (head === undefined) return { argv: [], error: 'command is empty' }
  if (!looksLikePathArg(head)) return { argv: [head, ...rest], error: null }
  // Path-shaped: resolve against the repo root and refuse to leave it. The
  // validator already rejects `../escape` in the repo's own file, but a group
  // layer's tasks are never validated, so this has to hold at run time too.
  if (!isAbsolute(head)) {
    const abs = resolve(repo, head)
    if (abs !== resolve(repo) && !abs.startsWith(`${resolve(repo)}/`)) {
      return {
        argv: [],
        error: `command[0] '${head}' must stay inside the repo`,
      }
    }
    return { argv: [abs, ...rest], error: null }
  }
  // An absolute path cannot be checked against a repo the desk did not open,
  // but a watcher that reaches outside the checkout is a watcher the config was
  // not allowed to write.
  return {
    argv: [head, ...rest],
    error: `command[0] '${head}' must stay inside the repo`,
  }
}

export type WatchCommandResult = {
  /** Exit code, or `null` when the process was killed or never started. */
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** Set when the command could not be run at all (bad argv, spawn failed). */
  error: string | null
  /** Why a run that produced output still failed. */
  failure: string | null
  durationMs: number
}

/** Read a stream, keeping at most `cap` bytes. `capped` means it was longer. */
async function readCapped(
  stream: ReadableStream<Uint8Array>,
  cap: number,
): Promise<{ text: string; capped: boolean }> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let capped = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    chunks.push(value)
    total += value.byteLength
    if (total > cap) {
      // Stop reading rather than draining: the point of the cap is to stop
      // costing memory, and a script printing forever would otherwise keep this
      // loop alive forever too.
      await reader.cancel().catch(() => {})
      capped = true
      break
    }
  }
  const merged = new Uint8Array(Math.min(total, cap))
  let at = 0
  for (const chunk of chunks) {
    if (at >= cap) break
    const slice = chunk.subarray(0, Math.min(chunk.byteLength, cap - at))
    merged.set(slice, at)
    at += slice.byteLength
  }
  return { text: Buffer.from(merged).toString('utf8'), capped }
}

/**
 * Run the repo's poll command once.
 *
 * argv, never a shell string. `.herdr-desk.json` is committed, so there is
 * nothing to quote and nothing for a repo to inject: the desk builds the
 * argument vector and hands it to the kernel.
 *
 * cwd is the repo root, `stdin` is ignored (a poll that waits for input would
 * hold the tick forever), and a command that outruns `timeoutSec` is killed and
 * counted as a failure. It is killed rather than asked to stop: a script already
 * past its budget is the one that has stopped reading its own state, and the
 * daemon's tick must not wait on it.
 *
 * The four `HERDR_DESK_*` variables are all the plugin adds. There is no `env`
 * block in the config for the same reason there is no `notify.token` — a
 * committed file cannot carry a secret — so a watcher that needs one reads it
 * from the daemon's own environment like everything else on the host.
 */
export async function runWatchCommand(opts: {
  repo: string
  taskId: string
  watch: WatchConfig
  env?: Record<string, string | undefined>
  now?: () => number
}): Promise<WatchCommandResult> {
  const started = opts.now?.() ?? Date.now()
  const { argv, error } = resolveWatchArgv(opts.repo, opts.watch.command)
  if (error) {
    return {
      code: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      error,
      failure: error,
      durationMs: 0,
    }
  }
  const timeoutMs = Math.max(1, opts.watch.timeoutSec) * 1000
  let proc: Bun.Subprocess
  try {
    proc = Bun.spawn(argv, {
      cwd: opts.repo,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        ...(opts.env ?? {}),
        HERDR_DESK_REPO: opts.repo,
        HERDR_DESK_TASK: opts.taskId,
        HERDR_DESK_STATE_DIR: pluginStateDir(),
        HERDR_DESK_POLL_AT: new Date(started).toISOString(),
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      code: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      error: msg,
      failure: msg,
      durationMs: 0,
    }
  }

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      proc.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }, timeoutMs)

  try {
    const [out, err_] = await Promise.all([
      readCapped(proc.stdout as ReadableStream<Uint8Array>, MAX_STDOUT_BYTES),
      readCapped(proc.stderr as ReadableStream<Uint8Array>, MAX_STDOUT_BYTES),
    ])
    const code = await proc.exited
    const durationMs = (opts.now?.() ?? Date.now()) - started
    if (timedOut) {
      return {
        code: null,
        stdout: out.text,
        stderr: err_.text,
        timedOut: true,
        error: null,
        failure: `timed out after ${opts.watch.timeoutSec}s`,
        durationMs,
      }
    }
    if (out.capped) {
      const msg = `stdout over ${MAX_STDOUT_BYTES} bytes`
      return {
        code,
        stdout: out.text,
        stderr: err_.text,
        timedOut: false,
        error: null,
        failure: msg,
        durationMs,
      }
    }
    // exit 0 is healthy whether or not anything was printed. A poll that has
    // nothing to report is the normal case, not a failure.
    return {
      code,
      stdout: out.text,
      stderr: err_.text,
      timedOut: false,
      error: null,
      failure: code === 0 ? null : `exit ${code}`,
      durationMs,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    try {
      proc.kill('SIGKILL')
    } catch {
      /* ignore */
    }
    return {
      code: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      error: msg,
      failure: msg,
      durationMs: (opts.now?.() ?? Date.now()) - started,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** What one pass did. Every count here is something a log line can carry. */
export type WatchPass = {
  state: WatchState
  task: WatchTaskState
  ok: boolean
  paused: boolean
  /** Events the command printed, parsed. Empty on a failure or a pause. */
  events: WatchEvent[]
  warnings: number
  queued: number
  duplicates: number
  overflow: number
  dispatched: boolean
  error?: string
  code?: number | null
  timedOut?: boolean
  stderr?: string
  result?: WatchCommandResult
}

/**
 * One pass over one watched task. The tick's whole watch step, minus the loop.
 *
 * Exported on its own because the loop and the pass fail differently: the loop
 * is what must never break the cron path, and a test that has to fake four
 * tasks to prove one of them is healthy is a test that stops telling the truth
 * when a fifth one is added.
 *
 * The order is the design. The poll runs, and it is the only thing that can
 * fail; the health gate is never consulted here, because the queue *is* the
 * hold — a saturated box must absorb a burst rather than decide to throw it
 * away. And a paused task still polls, because the alternative is a `paused`
 * counter that can only ever read zero, which would be a number in `watch
 * status` that means nothing.
 *
 * The runner is injected so a test drives the state machine, and so `desk watch`
 * and the daemon share this one implementation rather than growing a second.
 */
export async function watchPass(opts: {
  repo: string
  taskId: string
  watch: WatchConfig
  state: WatchState
  at?: Date
  paused?: boolean
  run?: (o: {
    repo: string
    taskId: string
    watch: WatchConfig
  }) => Promise<WatchCommandResult>
}): Promise<WatchPass> {
  const at = opts.at ?? new Date()
  const { watch, state } = opts
  const key = watchKey(opts.repo, opts.taskId)
  const t = taskState(state, opts.repo, opts.taskId, at)
  const run = opts.run ?? runWatchCommand

  const result = await run({
    repo: opts.repo,
    taskId: opts.taskId,
    watch,
  })
  t.lastPollAt = at.toISOString()
  t.code = result.code
  if (result.failure) {
    t.fails += 1
    t.firstFailAt = t.firstFailAt ?? at.toISOString()
    t.lastError = result.timedOut
      ? `timed out after ${watch.timeoutSec}s`
      : (result.failure ?? 'poll failed')
    t.nextPollAt = new Date(
      at.getTime() + backoffMs(watch.intervalSec, t.fails),
    ).toISOString()
    // Nothing is queued from a failed poll. Its output is discarded rather than
    // parsed: a script that died halfway through writing its stdout would
    // otherwise contribute a partial line, and "half an event" is worse than a
    // poll the desk knows did not happen.
    state.tasks[key] = t
    return {
      state,
      task: t,
      ok: false,
      paused: false,
      error: t.lastError,
      code: result.code,
      timedOut: result.timedOut,
      events: [],
      warnings: 0,
      queued: 0,
      duplicates: 0,
      overflow: 0,
      dispatched: false,
      stderr: result.stderr,
      result,
    }
  }

  const parsed = parseWatchOutput(result.stdout)
  t.warnings = parsed.warnings.length
  t.fails = 0
  t.firstFailAt = null
  t.lastError = null
  t.lastOkAt = at.toISOString()
  t.nextPollAt = new Date(at.getTime() + watch.intervalSec * 1000).toISOString()

  if (opts.paused) {
    // Counted, then dropped. Not deduped and not queued: a paused task's queue
    // is empty by definition, so anything kept here would come back as a burst
    // the moment the pause lifted. Dedupe keys are deliberately not written
    // either — the script's cursor keeps advancing, so the script will not offer
    // them again.
    t.paused += parsed.events.length
    t.pending = []
    state.tasks[key] = t
    return {
      state,
      task: t,
      ok: true,
      paused: true,
      events: parsed.events,
      warnings: parsed.warnings.length,
      queued: 0,
      duplicates: 0,
      overflow: 0,
      dispatched: false,
    }
  }

  const counts = queueEvents(t, parsed.events, watch.maxPending, at)
  state.tasks[key] = t
  return {
    state,
    task: t,
    ok: true,
    paused: false,
    events: parsed.events,
    warnings: parsed.warnings.length,
    queued: counts.queued,
    duplicates: counts.duplicates,
    overflow: counts.overflow,
    dispatched: false,
  }
}

/**
 * Take a task's queued events, emptying the queue.
 *
 * The drain lives in `run.ts`, not the daemon, because it happens on *every*
 * fire of a task — cron, manual, or event. An event that arrived while the cron
 * path was also working is then not stranded behind a queue that only the watch
 * step knows how to empty.
 */
export function drainPending(
  state: WatchState,
  repo: string,
  taskId: string,
): WatchEvent[] {
  const t = state.tasks[watchKey(repo, taskId)]
  if (!t || !t.pending.length) return []
  const events = t.pending
  t.pending = []
  return events
}

/**
 * Claim a task's queued events from disk, for a run that is about to start.
 *
 * State is only written when something was actually taken, so a desk with no
 * watchers at all — which is every desk that has never set `watch` — pays one
 * `existsSync` per fire and never creates a file.
 */
export function claimEvents(repo: string, taskId: string): WatchEvent[] {
  const state = loadWatchState()
  const events = drainPending(state, repo, taskId)
  if (events.length) saveWatchState(state)
  return events
}

/**
 * Put claimed events back, for a run that failed before the manager saw them.
 *
 * The ledger has already recorded a fire by the time anything here can throw, so
 * swallowing the queue would be the queue's version of a lost held job: work
 * that is not recorded as done, and nowhere says it was not done. Events go back
 * at the *front*, because they arrived first, and nothing else can have run in
 * between — the claim and the restore are on one synchronous path.
 */
export function restoreEvents(
  repo: string,
  taskId: string,
  events: WatchEvent[],
): void {
  if (!events.length) return
  const state = loadWatchState()
  const t = state.tasks[watchKey(repo, taskId)]
  if (!t) return
  t.pending = [...events, ...t.pending]
  saveWatchState(state)
}

/**
 * One line per watched task for `desk watch status`.
 *
 * `fails: N from <date>` rather than a status word, deliberately. A watcher
 * whose script broke on day one looks exactly like a watcher with nothing to
 * report, and the ledger records both as "no events" — so the number and the day
 * it started are what has to be on the line. `ok` would be a claim, and the desk
 * is not in a position to make one.
 */
export function formatWatchStatus(
  state: WatchState,
  rows: Array<{ repo: string; taskId: string }>,
  now = new Date(),
): string {
  if (rows.length === 0) return 'no watched tasks'
  const out: string[] = []
  for (const { repo, taskId } of rows) {
    const t = state.tasks[watchKey(repo, taskId)]
    if (!t) {
      out.push(`${taskId}  never polled`)
      continue
    }
    const bits = [`pending ${t.pending.length}`]
    if (t.overflow > 0) bits.push(`overflow ${t.overflow}`)
    if (t.paused > 0) bits.push(`paused ${t.paused}`)
    if (t.warnings > 0) bits.push(`warnings ${t.warnings}`)
    if (t.lastError) bits.push(`lastError ${t.lastError}`)
    bits.push(
      t.fails > 0
        ? `fails ${t.fails} from ${(t.firstFailAt ?? t.lastPollAt).slice(0, 10)}`
        : `fails 0 (last ok ${t.lastOkAt ? formatLocal(new Date(t.lastOkAt)) : 'never'})`,
    )
    const next = Date.parse(t.nextPollAt)
    const inMs = Number.isFinite(next) ? next - now.getTime() : null
    bits.push(
      inMs === null
        ? 'next poll -'
        : inMs <= 0
          ? 'next poll due'
          : `next poll in ${Math.ceil(inMs / 1000)}s`,
    )
    out.push(`${taskId}  ${bits.join('  ')}`)
  }
  return out.join('\n')
}
