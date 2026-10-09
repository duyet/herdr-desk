import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { cronSlotsOnDay, cronSlotsToday } from './cron'
import { dayKey } from './day'
import {
  type Discovered,
  discoverAll,
  firstLine,
  type LoadFailure,
} from './discover'
import { clearFailures, recordAnnounced, shouldAnnounce } from './failures'
import { check, type HostHealth, readHealth, type Verdict } from './health'
import { defaultHerdrBin, herdrReady } from './herdr'
import type { RunTrigger } from './history'
import { publish } from './hub'
import { loadNotifyConfig, noticeBody, notify } from './notify'
import { pluginStateDir } from './paths'
import { isPaused, loadPaused, type PauseState } from './pause'
import { clear, type HeldJob, hold, requeue, view } from './queue'
import { formatDuration } from './report'
import { runTask } from './run'
import { maybeAutoUpdate, updateLockHeld } from './update'
import {
  isDue,
  loadWatchState,
  saveWatchState,
  WATCH_NOTIFY_AFTER,
  watchPass,
  taskState as watchTaskState,
} from './watch'
import { syncWorkspaceBadges } from './workspaceBadge'

const TICK_MS = 20_000
/** Keep fire keys whose day is within this many days of today (cronNext horizon). */
const FIRE_KEEP_DAYS = 8
/**
 * How stale the alive stamp may be and still count as a liveness record.
 *
 * Two reasons, and both are about not claiming. A stamp nobody has maintained
 * for a year is an artifact, not evidence the desk was alive until then; and
 * the day-walk in {@link missedBeforeToday} starts from it, so an unbounded
 * window is a restart trying to enumerate a decade of slots. Past this the
 * honest answer is "no record", which is what a desk reporting no gap says.
 */
const ALIVE_MAX_AGE_MS = 366 * 86_400_000

function pidPath(): string {
  return join(pluginStateDir(), 'daemon.pid')
}

function alivePath(): string {
  return join(pluginStateDir(), 'alive')
}

function firesPath(): string {
  return join(pluginStateDir(), 'fires.json')
}

function firesBakPath(): string {
  return join(pluginStateDir(), 'fires.json.bak')
}

function logPath(): string {
  return join(pluginStateDir(), 'daemon.log')
}

export function daemonPid(): number | null {
  if (!existsSync(pidPath())) return null
  const pid = Number(readFileSync(pidPath(), 'utf8').trim())
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    process.kill(pid, 0)
    return pid
  } catch {
    return null
  }
}

/**
 * When this desk was last known to be alive. Null when there is no record.
 *
 * A stamp that does not parse, is in the future, or is older than
 * `ALIVE_MAX_AGE_MS` reads as no record at all. Each of those is a stamp that
 * cannot support a claim: a fault, a clock that moved, or an artifact nobody
 * maintains. Every gap figure this plugin reports is measured from this instant
 * and from nothing else, so an instant that cannot carry one produces silence
 * rather than a number.
 */
function readLastAlive(now = new Date()): Date | null {
  let raw: string
  try {
    if (!existsSync(alivePath())) return null
    raw = readFileSync(alivePath(), 'utf8').trim()
  } catch {
    return null
  }
  const at = new Date(raw)
  const age = now.getTime() - at.getTime()
  if (!Number.isFinite(age) || age < 0 || age > ALIVE_MAX_AGE_MS) return null
  return at
}

function writeLastAlive(at = new Date()): void {
  mkdirSync(pluginStateDir(), { recursive: true })
  writeFileSync(alivePath(), `${at.toISOString()}\n`)
}

function fireDay(key: string): string | null {
  // Keys end in `::<day>` (legacy) or `::<day>::<HH:MM>` (slot-keyed), so scan
  // the segments for the date rather than assuming it is last — otherwise every
  // slot-keyed entry looks dayless and pruneFires drops it on the next write.
  for (const seg of key.split('::')) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(seg)) return seg
  }
  return null
}

export function pruneFires(
  map: Record<string, string>,
  at = new Date(),
): Record<string, string> {
  const cutoff = new Date(at)
  cutoff.setHours(0, 0, 0, 0)
  cutoff.setDate(cutoff.getDate() - FIRE_KEEP_DAYS)
  const minDay = dayKey(cutoff)
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(map)) {
    const d = fireDay(k)
    if (d && d >= minDay) out[k] = v
  }
  return out
}

/**
 * Rewrite legacy day-keyed fire entries into slot keys.
 *
 * The old ledger recorded one entry per (repo, task, cron, day) and the daemon
 * never fired that job again that day. A legacy entry therefore expands into
 * **every slot of that day**, not just the ones before the recorded stamp:
 * anything less re-introduces the bug as a stampede — a half-hourly job
 * recorded at 01:20 would otherwise fire ~30 times on the first tick after the
 * upgrade. The cost is that the day of the upgrade runs no new slots; the job
 * is back to normal from the next day, which is the safe trade for unattended
 * work.
 */
export function migrateFires(
  map: Record<string, string>,
  now = new Date(),
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(map)) {
    const parts = k.split('::')
    if (parts.length !== 4 || !/^\d{4}-\d{2}-\d{2}$/.test(parts[3])) {
      out[k] = v
      continue
    }
    const [repo, taskId, cron, day] = parts
    // End of that local day, so the whole day is claimed.
    const endOfDay = new Date(
      Number(day.slice(0, 4)),
      Number(day.slice(5, 7)) - 1,
      Number(day.slice(8, 10)),
      23,
      59,
    )
    for (const slot of Number.isNaN(endOfDay.getTime())
      ? cronSlotsToday(cron, now)
      : cronSlotsToday(cron, endOfDay)) {
      out[`${repo}::${taskId}::${cron}::${day}::${slot}`] = v
    }
  }
  return out
}

export function loadFires(): Record<string, string> {
  if (!existsSync(firesPath())) return {}
  try {
    return migrateFires(
      JSON.parse(readFileSync(firesPath(), 'utf8')) as Record<string, string>,
    )
  } catch {
    const bak = firesBakPath()
    try {
      if (existsSync(bak)) unlinkSync(bak)
      renameSync(firesPath(), bak)
    } catch {
      /* ignore */
    }
    return {}
  }
}

/**
 * Persist the fire ledger, pruned.
 *
 * `at` is the clock the retention window is measured against, and every caller
 * inside a tick passes the tick's own `at` rather than letting this default to
 * the wall clock. The tick already resolves its day, its slots and its fire
 * keys against `at`; a ledger pruned against a different instant than the one
 * that wrote it is a ledger that can discard keys the same tick still needs.
 * In production the two coincide, and a tick driven with a stamped `at` — the
 * daemon loop after a resume, or a test — behaves the same way it reads.
 */
export function saveFires(map: Record<string, string>, at = new Date()): void {
  mkdirSync(pluginStateDir(), { recursive: true })
  writeFileSync(
    firesPath(),
    `${JSON.stringify(pruneFires(map, at), null, 2)}\n`,
  )
}

function log(line: string): void {
  mkdirSync(pluginStateDir(), { recursive: true })
  const stamp = new Date().toISOString()
  writeFileSync(logPath(), `${stamp} ${line}\n`, { flag: 'a' })
  console.log(line)
}

/**
 * Configs the daemon could not read, as of the last tick.
 *
 * The ledger is a `repo -> error` map, not a counter, because the thing worth
 * logging is a *change*: a repo whose config breaks is one line, and a repo
 * whose config stays broken is silence after the first. A config does not edit
 * itself, so per tick would be a line every 20 seconds forever; per process
 * would be a line every restart. Distinct-error is the shape that carries news.
 */
type LoadErrorLedger = Record<string, string>

function loadErrorPath(): string {
  return join(pluginStateDir(), 'load-errors.json')
}

function loadLoadErrors(): LoadErrorLedger {
  if (!existsSync(loadErrorPath())) return {}
  try {
    const raw = JSON.parse(readFileSync(loadErrorPath(), 'utf8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: LoadErrorLedger = {}
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  } catch {
    // Unreadable is "nothing has been said", so every failure logs once again
    // rather than being silently held back.
    return {}
  }
}

function saveLoadErrors(ledger: LoadErrorLedger): void {
  try {
    mkdirSync(pluginStateDir(), { recursive: true })
    writeFileSync(loadErrorPath(), `${JSON.stringify(ledger, null, 2)}\n`)
  } catch {
    /* next tick logs the same fault again, which is the safe direction */
  }
}

/**
 * Log a config that cannot be read, once per repo per distinct error.
 *
 * A repo that failed to load is not in the fire loop, so nothing else in the
 * daemon says it stopped existing — before #97 that was the whole story: a
 * healthy-looking machine, no failed runs, and a job that had silently stopped
 * being owed anything. This is the line that says otherwise, and it is in
 * `daemon.log` rather than in a notice because it is a machine fact, not
 * something to wake someone for at 03:00; `status` carries the count.
 *
 * Never throws. It runs inside the tick, and a state file that cannot be
 * written must not take the cron path down with it.
 */
export function logLoadFailures(failed: LoadFailure[]): void {
  try {
    const seen = loadLoadErrors()
    const next: LoadErrorLedger = {}
    let changed = false
    for (const f of failed) {
      const first = firstLine(f.error)
      next[f.repo] = first
      // Keyed on the message, so the same repo with a *different* error is new
      // information and says so, while an unchanged one stays quiet.
      if (seen[f.repo] !== first) {
        changed = true
        log(`load error ${f.repo}: ${first}`)
      }
    }
    // A repo that loads again is dropped from the ledger, so a later breakage
    // says so again instead of being held back as a repeat of one that is over.
    if (Object.keys(next).length !== Object.keys(seen).length) changed = true
    if (changed) saveLoadErrors(next)
  } catch (err) {
    log(
      `load error: could not report unreadable configs (${
        err instanceof Error ? err.message : String(err)
      })`,
    )
  }
}

function fireKey(
  repo: string,
  taskId: string,
  cron: string,
  day: string,
  slot: string,
): string {
  return `${repo}::${taskId}::${cron}::${day}::${slot}`
}

/**
 * Which slot to run, and which missed slots to write off.
 *
 * A daemon that was down — or a tick that never finished — leaves slots
 * unfired, and firing all of them is how one machine hands its live managers
 * the same prompt thirty times in nine seconds (duyet/herdr-desk#40). So only
 * the newest missed slot runs; the rest are consumed without running, and the
 * desk resumes where it left off instead of replaying the day.
 */
export function catchUpPlan(
  slots: string[],
  isFired: (slot: string) => boolean,
): { run?: string; stale: string[] } {
  const due = slots.filter((slot) => !isFired(slot))
  if (due.length <= 1) return { run: due[0], stale: [] }
  return { run: due[due.length - 1], stale: due.slice(0, -1) }
}

/** A slot named the way the ledger and the log name it: a local day and `HH:MM`. */
export type SlotStamp = { day: string; slot: string }

/**
 * Slots this desk was owed on days that have already ended, since `from`.
 *
 * {@link catchUpPlan} counts today, and that is correct for *firing*: only the
 * newest unfired slot runs, and the rest are consumed into the ledger. It is
 * wrong for *accounting*. A fire key is `repo::task::cron::day::slot`, so a slot
 * from an earlier day is not miscounted by that plan — it is outside the query.
 * A restart after 27 hours therefore wrote off "5 missed slots" while 154 had
 * gone by: arithmetically true, and the reason 27 hours of outage read as a
 * quiet morning (duyet/herdr-desk#60).
 *
 * So the count gets a wider window than the plan does, and the days before
 * today are counted but **not** written to the ledger. They are not written
 * because `fires.json` keeps `FIRE_KEEP_DAYS` and a key for a day that has
 * ended is a key nothing will read again: back-filling a multi-day gap is a lot
 * of keys to answer a question the `daemon start` line already answers in one
 * number. They are still *skipped*, which is what the log says — they just
 * leave no key behind.
 *
 * "Unfired" is what "missed" means here. A slot with a key was handled — fired,
 * written off, or skipped — and only the desk itself could have written it. A
 * desk that was dark writes no keys, so an absent key on a day inside the gap is
 * proof the slot went by unrun.
 *
 * `from` is exclusive. The stamp is the instant a tick began, and the tick that
 * began it had already accounted for everything up to there; re-counting from
 * the stamp inclusive would bill the gap for its own first slot.
 */
export function missedBeforeToday(
  expr: string,
  from: Date,
  to: Date,
  isFired: (day: string, slot: string) => boolean,
): { count: number; oldest: SlotStamp | null } {
  const today = dayKey(to)
  const day = new Date(from)
  day.setHours(0, 0, 0, 0)
  let count = 0
  let oldest: SlotStamp | null = null
  for (;;) {
    const key = dayKey(day)
    if (key >= today) break
    for (const slot of cronSlotsOnDay(expr, day)) {
      const at = new Date(day)
      at.setHours(Number(slot.slice(0, 2)), Number(slot.slice(3, 5)), 0, 0)
      if (at.getTime() <= from.getTime()) continue
      if (isFired(key, slot)) continue
      count++
      if (!oldest) oldest = { day: key, slot }
    }
    day.setDate(day.getDate() + 1)
  }
  return { count, oldest }
}

/**
 * Consume every unfired slot of a paused job as `skip paused`.
 *
 * Written into the fire ledger, not just ignored: a slot that is merely
 * skipped this tick would still be unfired, and the catch-up plan would run it
 * the moment the job is resumed. Returns how many slots it consumed.
 */
export function skipPausedSlots(
  fires: Record<string, string>,
  repo: string,
  taskId: string,
  expr: string,
  day: string,
  slots: string[],
  at = new Date(),
): number {
  let n = 0
  for (const slot of slots) {
    const key = fireKey(repo, taskId, expr, day, slot)
    if (fires[key]) continue
    fires[key] = `skip paused ${at.toISOString()}`
    n++
  }
  return n
}

/**
 * One pass over every desk: fire what is due, then retry one held job.
 *
 * `gate` is the host health check, injected so a test can drive the tick on a
 * machine too busy to pass it. Production always passes the real one.
 */
export async function tickOnce(
  at = new Date(),
  gate: (h: HostHealth) => Verdict = check,
): Promise<number> {
  // Read before anything is written, so the first tick after a restart still
  // sees how long the desk was gone — and then the stamp is advanced, so the
  // next tick's horizon is the present and the gap is counted exactly once.
  const lastAlive = readLastAlive(at)
  // Written at the tick's start rather than its end: a tick that throws has
  // still proven the process is alive, and a stamp that only moved on success
  // would have a permanently broken desk re-report the same outage every 20
  // seconds. The cost is that the recorded instant is the tick's start, so a
  // desk killed part way through a long tick reopens the hole by one tick —
  // 20s against a window that is measured in hours.
  writeLastAlive(at)
  const { desks, failed } = await discoverAll()
  // Before the fire loop, and not inside it: a repo that could not be read has
  // no jobs, so there is nothing to hold back, and reporting it must not be able
  // to stop a desk that is fine from firing.
  logLoadFailures(failed)
  const fires = loadFires()
  // Read once per tick; a corrupt file throws and fires nothing (fail closed).
  const paused: PauseState = loadPaused()
  const day = dayKey(at)
  let n = 0
  // Set when any fire was a problem, so the hub is published immediately rather
  // than waiting for the next tick to notice.
  let needsHub = false
  for (const d of desks) {
    for (const task of d.config.tasks) {
      for (const expr of task.crons) {
        if (!expr) continue
        if (isPaused(paused, d.repo, task.id, at)) {
          const skipped = skipPausedSlots(
            fires,
            d.repo,
            task.id,
            expr,
            day,
            cronSlotsToday(expr, at),
            at,
          )
          if (skipped) {
            saveFires(fires, at)
            log(
              `skip ${d.config.name}/${task.id} ${expr}: paused, ${skipped} slot(s)`,
            )
          }
          continue
        }
        // Key on the SLOT, not the day. A day-keyed ledger let the first fire
        // of the day consume the whole schedule, so `*/30 * * * *` fired once
        // a day instead of 48 times — and `status` showed nothing wrong,
        // because the job was never recorded as failing.
        const plan = catchUpPlan(cronSlotsToday(expr, at), (slot) =>
          Boolean(fires[fireKey(d.repo, task.id, expr, day, slot)]),
        )
        // The plan is today's, and stays today's — one job runs, not a
        // stampede. The *number* attached to it is not: a restart measures from
        // the last tick, so the days the desk was gone are counted too. No
        // record means no claim, which is the same accounting as today.
        const dark = lastAlive
          ? missedBeforeToday(expr, lastAlive, at, (gone, slot) =>
              Boolean(fires[fireKey(d.repo, task.id, expr, gone, slot)]),
            )
          : { count: 0, oldest: null }
        // Today's stale first, so the count reads oldest-first with it.
        const missed = plan.stale.length + dark.count
        // The skipped slots are consumed *before* anything runs, and written
        // before it, so a tick that is interrupted half way cannot replay the
        // day on the next start. A ledger only saved at the end of a tick is a
        // ledger that never advances while the tick is busy — which is exactly
        // when it is needed.
        for (const slot of plan.stale) {
          fires[fireKey(d.repo, task.id, expr, day, slot)] =
            `skip ${new Date().toISOString()}`
        }
        if (plan.stale.length) saveFires(fires, at)
        if (missed) {
          const oldest = dark.oldest ?? { day, slot: plan.stale[0] }
          // With the day when it is not today. A bare `00:10` says nothing
          // about *which* 00:10, and that ambiguity is the whole bug: it read
          // as this morning's when it was three days ago's.
          const since =
            oldest.day === day ? oldest.slot : `${oldest.day} ${oldest.slot}`
          log(
            `skip ${d.config.name}/${task.id} ${expr}: ${missed} missed slots, oldest ${since}`,
          )
        }
        const slot = plan.run
        if (!slot) continue
        const key = fireKey(d.repo, task.id, expr, day, slot)
        // Checked immediately before the fire, not once at the top of the
        // tick: a tick can run for minutes, and a host that was comfortable
        // when the tick began may be saturated by the time this job is
        // reached. `docs/machine-health.md` says "check before starting, not
        // after", and this is that check.
        const verdict = gate(readHealth())
        if (!verdict.ok) {
          // Held, not dropped. `key` is deliberately NOT written to `fires`, so
          // the slot stays due and the same job is offered on a later tick —
          // and the queue is what says out loud that it was held, rather than
          // the ledger claiming a fire that never happened.
          hold(
            {
              repo: d.repo,
              task: task.id,
              slot,
              reason: verdict.breaches.join(', '),
            },
            at,
          )
          log(
            `hold ${d.config.name}/${task.id} slot ${slot}: ${verdict.breaches.join(', ')}`,
          )
          continue
        }
        log(`fire ${d.config.name}/${task.id} ${expr} slot ${slot}`)
        try {
          const result = await runTask({ repo: d.repo, taskId: task.id })
          fires[key] = new Date().toISOString()
          saveFires(fires, at)
          // This tick just ran the job, so the queue must stop owing it. The
          // held slot is deliberately absent from `fires`, so the ledger cannot
          // answer "is this still due?" — and `retryHeld` runs later in this
          // same tick. Without this the recovered job ran twice, and the ledger
          // recorded two honest fires for one due slot.
          clear(d.repo, task.id)
          log(`ok ${JSON.stringify(result)}`)
          n++
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          fires[key] = `fail ${new Date().toISOString()}`
          saveFires(fires, at)
          log(`fail ${d.config.name}/${task.id} ${expr} slot ${slot}: ${msg}`)
          needsHub = true
        }
      }
    }
  }
  // A held job is retried *after* the scheduled ones, so the queue can never
  // starve a job that was actually due.
  if (await retryHeld(at, gate)) n++
  // And the watch step is after both, so a repo's poll script — which is the
  // one piece of this daemon that runs code a repo wrote — can never delay a
  // cron slot that was genuinely due.
  const watched = await watchStep(desks, at, gate, paused)
  n += watched.fired
  if (watched.problem) needsHub = true
  // Sidebar badges last, and fail-open: a metadata failure is a log line, not
  // a missed fire. Cron and watch already ran above, so a Herdr that is down
  // cannot hold them up — and a throw here must not escape the tick either.
  // When Herdr is unavailable (no bin/socket) skip silently: sync would just
  // fail its list call and log the same socket error every 20s tick.
  try {
    if (herdrReady().ok) {
      const badges = await syncWorkspaceBadges(desks, failed)
      for (const err of badges.errors) log(`badge ${err}`)
    }
  } catch (err) {
    log(`badge ${err instanceof Error ? err.message : String(err)}`)
  }
  saveFires(fires, at)
  if (n > 0 || needsHub) await publishHub()
  return n
}

/**
 * What the watch step starts a job with.
 *
 * Injected for the same reason `gate` is: a test needs to drive the tick on a
 * machine with no Herdr at all, and faking a Herdr binary to make `runTask`
 * resolve would be testing the fake rather than the step. Production always
 * passes the real {@link runTask}.
 */
export type WatchRunner = (opts: {
  repo: string
  taskId?: string
  trigger?: RunTrigger
}) => Promise<unknown>

/**
 * The watch step: poll every due watched task, then dispatch what it queued.
 *
 * Last in the tick, and separately guarded, for two reasons that both come from
 * the same fact: the command comes from a repo config. A script that hangs is
 * killed by its own timeout; a script that throws must not take the tick with
 * it. So the whole step is one `try`/`catch` that logs and carries on — the
 * catch is not defensive decoration, it is the only thing standing between a
 * broken watcher in one repo and a desk that stops firing every other repo.
 *
 * One pass per task per tick, and only when `nextPollAt` has come. The interval
 * is the repo's, and a task that is not due is not polled at all — so a desk with
 * ten watched tasks at a 15s interval is not running sixty commands a minute
 * because the tick is 20s.
 *
 * The health gate is consulted *after* the events are queued, never before:
 * the queue is the backpressure. A saturated box holds a burst and absorbs it on
 * a later tick rather than being handed ten managers, and nothing is written to
 * `fires` — an event is not a slot, and claiming it fired would be a lie.
 */
export async function watchStep(
  desks: Discovered[],
  at: Date,
  gate: (h: HostHealth) => Verdict = check,
  paused: PauseState = loadPaused(),
  run: WatchRunner = runTask,
): Promise<{ fired: number; problem: boolean }> {
  try {
    // `let`, not `const`: a dispatch makes this snapshot stale. `runTask` claims
    // the queue on its way into the run and rewrites the file itself, so the
    // next task's save would otherwise write back the events the run just took —
    // and a desk with two watched tasks would re-fire the first task's event on
    // every later poll, forever. The reload is the fix; the comment is so the
    // next reader does not "tidy" it back to a `const`.
    let state = loadWatchState()
    let fired = 0
    let problem = false
    for (const d of desks) {
      for (const task of d.config.tasks) {
        if (!task.watch) continue
        if (!isDue(watchTaskState(state, d.repo, task.id, at), at)) continue
        const pass = await watchPass({
          repo: d.repo,
          taskId: task.id,
          watch: task.watch,
          state,
          at,
          paused: isPaused(paused, d.repo, task.id, at),
        })
        // Written before anything is dispatched, so a run that fails or a tick
        // that dies cannot replay the same events as new ones.
        saveWatchState(state, at)

        if (!pass.ok) {
          log(
            `watch fail ${d.config.name}/${task.id}: ${pass.error} (fails ${pass.task.fails})`,
          )
          await announceWatchFailure(
            d.repo,
            task.id,
            pass.task.fails,
            pass.error ?? 'poll failed',
          )
          continue
        }
        // A recovered watcher clears its own notice, so the next outage is said
        // rather than held back as a repeat of one that is already over.
        clearFailures(d.repo, task.id)
        if (pass.paused && pass.events.length) {
          log(
            `watch paused ${d.config.name}/${task.id}: ${pass.events.length} event(s) dropped`,
          )
        }
        if (pass.warnings) {
          log(`watch ${d.config.name}/${task.id}: ${pass.warnings} bad line(s)`)
        }
        if (pass.queued || pass.duplicates || pass.overflow) {
          log(
            `watch ${d.config.name}/${task.id}: ${pass.queued} new, ${pass.duplicates} duplicate, ${pass.overflow} overflow, ${pass.task.pending.length} pending`,
          )
        }
        if (pass.task.pending.length === 0) continue
        // Checked here, immediately before the fire, for the same reason the
        // cron path checks there: a tick can run for minutes.
        const verdict = gate(readHealth())
        if (!verdict.ok) {
          log(
            `watch hold ${d.config.name}/${task.id}: ${pass.task.pending.length} pending, ${verdict.breaches.join(', ')}`,
          )
          continue
        }
        log(
          `watch fire ${d.config.name}/${task.id}: ${pass.task.pending.length} event(s)`,
        )
        try {
          await run({ repo: d.repo, taskId: task.id, trigger: 'event' })
          fired++
        } catch (err) {
          // A run that threw did not happen. The events stay queued — `run.ts`
          // drains on success only — so the next pass retries them rather than
          // the queue losing work nobody was told about.
          log(
            `watch fail ${d.config.name}/${task.id}: run: ${err instanceof Error ? err.message : String(err)}`,
          )
          problem = true
        }
        // Re-read after every dispatch, and after every failure: `runTask` owns
        // the queue while it runs, and both the claim and the restore-on-throw
        // write the file behind this loop's back.
        state = loadWatchState()
      }
    }
    return { fired, problem }
  } catch (err) {
    log(`watch ${err instanceof Error ? err.message : String(err)}`)
    return { fired: 0, problem: false }
  }
}

/**
 * The text announced for a dead watcher.
 *
 * Deliberately carries no failure count. `shouldAnnounce` keys on a hash of this
 * line, so `watch poll failed ${fails}x: ${error}` made every consecutive failure
 * of one watcher a *different* fault: fails 5, 6, 7 and 8 were four first
 * sightings and four notices, where the intent was one. On a script dead since
 * day one that is one message per poll — and because the poll interval backs off
 * to `intervalSec * 8`, roughly one every eight minutes at the 60s default, not
 * one a minute. The count belongs in the log line `watchStep` writes on every
 * failure, which already has it.
 *
 * The error *is* in the text, and has to be: two different reasons are two
 * different faults, and a watcher that breaks a second way must say so rather
 * than be held back as a repeat of the first.
 */
export function watchFailureMessage(error: string): string {
  return `watch poll failed: ${error}`
}

/**
 * Say a dead watcher once.
 *
 * A watcher whose script broke on day one looks exactly like a watcher with
 * nothing to report, and the ledger records both as "no events" — so silence
 * here is indistinguishable from a quiet night. Five consecutive failures is the
 * line: enough that a flaky network does not page anyone, few enough that a
 * script which died on deployment is caught the same evening.
 *
 * Dedupe comes from `failures.ts` rather than a counter here, so one dead script
 * is one message rather than one per poll, and so the fault clears on recovery
 * through the same door every other announced fault uses. "One" means one per
 * `REANNOUNCE_MS` quiet period, not one ever.
 */

export type WatchAnnounceDeps = {
  /**
   * Send the notice, and report whether it went out.
   *
   * Injected for the same reason `maybeAutoUpdate` injects its notifier: the
   * thing worth testing here is *which line* is announced and *when* it is held
   * back, and `shouldAnnounce` keys on a hash of that line. With the real
   * `notify` behind it, a test cannot get a notice out of a machine with no
   * Telegram token, so the previous version of these tests re-implemented the
   * dedupe in the test body and proved the test's own string was stable. An
   * injected notifier makes the function itself the thing under test.
   */
  notify?: (repo: string, taskId: string, said: string) => Promise<boolean>
  now?: () => Date
}

export async function announceWatchFailure(
  repo: string,
  taskId: string,
  fails: number,
  error: string,
  deps: WatchAnnounceDeps = {},
): Promise<void> {
  if (fails < WATCH_NOTIFY_AFTER) return
  const said = watchFailureMessage(error)
  const now = deps.now ?? (() => new Date())
  try {
    const config = loadNotifyConfig()
    if (!config.enabled) return
    const at = now()
    if (!shouldAnnounce(repo, taskId, said, at)) return
    const sent = deps.notify
      ? await deps.notify(repo, taskId, said)
      : (
          await notify(
            {
              message: noticeBody({
                level: 'fail',
                headline: said,
                tags: ['desk', 'watch'],
              }) as string,
              repo,
              label: taskId,
            },
            config,
          )
        ).sent
    // Recorded only once the notice is out. A send that failed leaves the fault
    // armed, because a repeat nobody read is not a repeat.
    if (sent) recordAnnounced(repo, taskId, said, at)
  } catch {
    // Reporting must never be able to stop the next poll, exactly as in `run.ts`.
  }
}

/**
 * The line a give-up leaves, naming the repo the way every other one does.
 *
 * A desk is machine-wide, so a task name does not identify a job: chmonitor and
 * llm-over-dns both run a `local:improve` and both run a `local:babysit`, and
 * every repo runs the bundled `desk:github-issues` in the same tick. A give-up
 * has no other record anywhere — no run, no fire, no ledger key — so matching a
 * bare task name back to its hold line by timestamp was the only way left, and
 * it attributed 74 of 94 give-ups to the wrong task while 11 stayed
 * unattributed altogether. The repo is what the line is missing.
 */
export function giveUpLine(job: HeldJob): string {
  return `give up ${job.repo}/${job.task}: held since ${job.since} without running`
}

/**
 * Retry one held job, if the host now has room.
 *
 * One per tick, and only the oldest. Draining the whole queue the moment the
 * load dips would reproduce the exact stack-up the gate exists to prevent —
 * the host looks idle for one tick and gets handed every deferred job at once.
 *
 * A retry that fails goes back with the age it already had, so a job that can
 * never run is eventually given up on rather than circling the queue forever.
 *
 * The head is read, not popped: the entry is dropped by `clear()` once the run
 * has actually happened. Taking it off first — `next()` — would make the queue
 * lose the job outright if the daemon died between the pop and the run, and a
 * lost job is the one failure this queue does not get to have.
 */
async function retryHeld(
  at: Date,
  gate: (h: HostHealth) => Verdict = check,
): Promise<boolean> {
  const { jobs, expired } = view(at)
  for (const gone of expired) {
    log(giveUpLine(gone))
    // The tick is what retires a give-up. `view()` only reports one, so the
    // entry stays owed until somebody acts on that — and nothing else writes
    // this file, so left here it is reported again by every tick for as long as
    // the desk runs, and the queue only ever grows.
    clear(gone.repo, gone.task)
  }
  const next_ = jobs[0]
  if (!next_) return false
  const health = readHealth()
  if (!gate(health).ok) return false
  try {
    const result = await runTask({ repo: next_.repo, taskId: next_.task })
    // The same discharge the scheduled path does: the job ran, so the queue
    // must stop owing it. Left in place, a held job that finally ran stayed at
    // the head of the queue and ran again on every tick until it aged out.
    clear(next_.repo, next_.task)
    log(`held ran ${next_.task}: ${JSON.stringify(result)}`)
    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    requeue(next_, msg)
    log(`held failed ${next_.task}: ${msg}`)
    return false
  }
}

/**
 * One hub message per tick, at most.
 *
 * The hub is published from the tick rather than from each run, so N jobs
 * starting in the same tick produce one "N running" line instead of N messages.
 * `publish` applies the change and window gates; this only has to make sure a
 * hub failure is logged and swallowed, because a reporting problem must never
 * stop the next tick from firing work.
 */
async function publishHub(): Promise<void> {
  try {
    // The host config, not a repo layer resolved from whatever directory the
    // daemon happens to have been started in. The hub is about the machine, so
    // it goes where every machine-level notice goes — and a repo's committed
    // config must not be able to retarget where the whole machine reports to.
    const result = await publish({ dest: loadNotifyConfig() })
    if (result.sent) log(`hub sent (${result.body.split('\n')[0]})`)
  } catch (err) {
    log(`hub ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** The signals the daemon answers. */
export type StopSignal = 'SIGTERM' | 'SIGINT'

/**
 * Record the stop, drop the pid file, exit clean.
 *
 * The line is the only trace a stop leaves. Without it a daemon killed by
 * earlyoom under memory pressure left a hole in `daemon.log` with no end and
 * no sign the process had been there — `daemon start` was the last line of one
 * run and the first of the next (duyet/herdr-desk#60). `log` stamps it, so the
 * hole gets an end even when the cause does not.
 *
 * SIGINT reads differently from SIGTERM because the events differ. SIGINT
 * comes from a terminal; SIGTERM also comes from `desk stop`, a supervisor or
 * the memory watchdog, and the daemon cannot tell those apart, so the line
 * says the sender is not recorded here.
 *
 * Exit code 0, unchanged. A supervisor that read a requested stop as a crash
 * would restart the daemon into the same pressure.
 */
export function stopOn(
  signal: StopSignal,
  exit: (code: number) => void = process.exit,
): void {
  log(
    signal === 'SIGINT'
      ? `daemon stop pid=${process.pid} on SIGINT: at a terminal`
      : `daemon stop pid=${process.pid} on ${signal}: asked to stop, sender not in this log`,
  )
  try {
    if (existsSync(pidPath())) unlinkSync(pidPath())
  } catch {
    /* ignore */
  }
  exit(0)
}

/**
 * The line a start leaves, carrying the gap when there is one to carry.
 *
 * `stopOn` gives a requested stop an end, and this gives an unrequested death a
 * size. `daemon start pid=N` on its own said nothing about the hours before it:
 * the 2026-09-28 outage left 27h41m between one start line and the next, and
 * the only way to measure it was to read two timestamps by hand
 * (duyet/herdr-desk#60). No record — a first ever run, or a stamp older than
 * `ALIVE_MAX_AGE_MS` — gets the bare line, because there is nothing true to add
 * to it.
 */
export function startLine(pid: number, now = new Date()): string {
  const lastAlive = readLastAlive(now)
  if (!lastAlive) return `daemon start pid=${pid}`
  return `daemon start pid=${pid}: dark for ${formatDuration(now.getTime() - lastAlive.getTime())}, last alive ${lastAlive.toISOString()}`
}

export async function runDaemon(): Promise<void> {
  mkdirSync(pluginStateDir(), { recursive: true })
  writeFileSync(pidPath(), `${process.pid}\n`)
  log(startLine(process.pid))
  process.on('SIGTERM', () => stopOn('SIGTERM'))
  process.on('SIGINT', () => stopOn('SIGINT'))
  for (;;) {
    try {
      await tickOnce()
    } catch (err) {
      log(`tick ${err instanceof Error ? err.message : err}`)
    }
    await autoUpdateStep()
    await Bun.sleep(TICK_MS)
  }
}

/**
 * Once a day, check for a release and apply it when `autoUpdate` is on.
 *
 * The daemon cannot run `desk update` itself — that stops the daemon, which
 * would be this process. So after a successful reinstall it drops its pid file,
 * asks Herdr to start the (new) plugin, and exits. A failure only logs and
 * notifies: the next tick must still fire work.
 */
async function autoUpdateStep(): Promise<void> {
  try {
    const outcome = await maybeAutoUpdate({
      log,
      notify: async (message) => {
        await notify({ message, label: 'update' }, loadNotifyConfig())
      },
    })
    if (outcome !== 'updated') return
    if (existsSync(pidPath())) unlinkSync(pidPath())
    Bun.spawn(
      [defaultHerdrBin(), 'plugin', 'action', 'invoke', 'herdr-desk.start'],
      { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', env: process.env },
    ).unref()
    log('restarting on the updated plugin')
    process.exit(0)
  } catch (err) {
    log(`update ${err instanceof Error ? err.message : String(err)}`)
  }
}

function sourceNewerThanDaemon(): boolean {
  if (!existsSync(pidPath())) return false
  try {
    const pidM = statSync(pidPath()).mtimeMs
    const src = join(import.meta.dir, 'daemon.ts')
    if (!existsSync(src)) return false
    return statSync(src).mtimeMs > pidM
  } catch {
    return false
  }
}

export function startDaemon(): {
  already?: boolean
  updating?: boolean
  pid: number
} {
  // `desk update` holds this while the checkout is being replaced; starting now
  // would run the old code from files that are changing underneath it.
  if (updateLockHeld()) return { updating: true, pid: 0 }
  const live = daemonPid()
  if (live) {
    if (!sourceNewerThanDaemon()) return { already: true, pid: live }
    log(`restart stale daemon pid=${live}`)
    stopDaemon()
  }
  mkdirSync(pluginStateDir(), { recursive: true })
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'cli.ts'), 'daemon'],
    {
      stdout: 'ignore',
      stderr: 'ignore',
      stdin: 'ignore',
      env: process.env,
    },
  )
  // child is detached-ish; we don't unref spawn in bun the same way — write pid after spawn
  const pid = child.pid
  writeFileSync(pidPath(), `${pid}\n`)
  child.unref()
  return { pid }
}

export function stopDaemon(): boolean {
  const pid = daemonPid()
  if (!pid) {
    if (existsSync(pidPath())) unlinkSync(pidPath())
    return false
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    /* already dead */
  }
  if (existsSync(pidPath())) unlinkSync(pidPath())
  return true
}
