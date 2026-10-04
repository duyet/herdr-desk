import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pluginStateDir } from './paths'

/**
 * Faults already announced, so a fault that cannot fix itself is said once.
 *
 * A failure is the one thing worth waking someone for — it is the only reason a
 * failure notice exists at all. But that notice is sent per tick, and a tick
 * every 30 minutes turns one dead pane into the same sentence forever. On
 * 2026-10-04 a Herdr restart killed a child agent's pane after that child had
 * already merged its PR: nothing left to do, nothing left to fix, and a failure
 * due to be announced again on the next tick and the next one after that. A
 * reader who mutes that channel then hears nothing at all, which is the one
 * outcome a failure notice must not cause.
 *
 * So a repeat is held back and a *first* sighting never is. That is the way
 * round `report.ts` settled on when it stopped hashing its rendered body: a
 * repeated notice is a nuisance, a dropped one is invisible.
 *
 * **What this ledger is not.** Every run outcome is already recorded once, in
 * `runs.jsonl`, and `history.failureStreak` counts a streak out of it for
 * `status` and the hub. So nothing here counts and nothing here summarises: the
 * file answers one question — has this exact fault already been said — and a
 * fault it has forgotten is announced again. Counting a repeat a second time
 * would be two ledgers disagreeing about the same run.
 *
 * Keyed on the job *and* a hash of the announced line, never on either alone.
 * The job alone would hide a new fault behind an old one, which is how a second
 * problem gets found days late; the line alone would let one broken machine say
 * the same fault once per desk running it. So two repos failing for the same
 * reason each say so once, and one repo failing twice for two reasons says so
 * twice.
 *
 * Nothing here throws, and that is load-bearing on both sides. `announce`
 * swallows whatever goes wrong after its verdict, so a ledger that threw while
 * being read would silently drop the very notice this exists to deliver once.
 * And `clearFailures` is called on the *success* path, where a throw would turn
 * a good run into a failed one. A ledger that cannot be read is a ledger with no
 * history, and one that cannot be written costs at most a duplicate — both the
 * safe direction, so both are swallowed rather than propagated.
 */

const FILE = 'failures.json'

/**
 * How long a said fault stays quiet.
 *
 * Half a day is long enough that a desk ticking every 30 minutes says its fault
 * twice rather than 48 times, and short enough that a fault nobody fixed by
 * tomorrow morning is raised again instead of being written off as handled.
 *
 * The clock runs from the last time the fault was *said*, never from the last
 * time it happened: measured against a sighting it is refreshed on every tick,
 * so a fault that recurs forever would stop being worth mentioning at all — and
 * recurring forever is the case this file exists for.
 */
export const REANNOUNCE_MS = 12 * 60 * 60 * 1000

export type FailureRecord = {
  /** Hash of the announced line, so a different reason is a different fault. */
  hash: string
  /** When this fault was first announced. For reading the file, not for a sum. */
  first: string
  /**
   * When it was last announced. The quiet period is measured from here — see
   * {@link REANNOUNCE_MS} for why this is not the last sighting.
   */
  last: string
}

function ledgerPath(): string {
  return join(pluginStateDir(), FILE)
}

function load(): Record<string, FailureRecord> {
  if (!existsSync(ledgerPath())) return {}
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(ledgerPath(), 'utf8')) as unknown
  } catch {
    // Unreadable is not "already said". Every fault announces, which is the one
    // outcome worse than a duplicate and the one this file must never cause.
    return {}
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, FailureRecord> = {}
  for (const [k, v] of Object.entries(raw)) {
    // A record whose stamp does not parse cannot say when the fault was last
    // announced. Keeping it would compare every later sighting against `NaN` and
    // go quiet for good, which is exactly how a real failure disappears.
    if (isRecord(v) && Number.isFinite(Date.parse(v.last))) out[k] = v
  }
  return out
}

function isRecord(v: unknown): v is FailureRecord {
  if (!v || typeof v !== 'object') return false
  const rec = v as Partial<FailureRecord>
  return typeof rec.hash === 'string' && typeof rec.last === 'string'
}

/**
 * Write the ledger, or give up and let the next tick repeat the fault.
 *
 * Losing a write costs one duplicate notice. Propagating the error would cost
 * either the notice itself or the whole run, depending on the caller, and a
 * duplicate is the cheaper of the two.
 */
function save(all: Record<string, FailureRecord>): void {
  try {
    mkdirSync(pluginStateDir(), { recursive: true })
    writeFileSync(ledgerPath(), `${JSON.stringify(all, null, 2)}\n`)
  } catch {
    /* the fault announces again next tick */
  }
}

function key(repo: string, task: string, hash: string): string {
  return `${repo}::${task}::${hash}`
}

function fingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

/**
 * Should this fault be announced, or is it a repeat of one already said?
 *
 * A fault that has never been announced always is, including when the ledger is
 * missing, unreadable or corrupt — a first failure is the whole point of a
 * failure notice, so nothing here may be able to suppress one.
 */
export function shouldAnnounce(
  repo: string,
  task: string,
  message: string,
  at = new Date(),
): boolean {
  const rec = load()[key(repo, task, fingerprint(message))]
  if (!rec) return true
  return at.getTime() - Date.parse(rec.last) > REANNOUNCE_MS
}

/**
 * Note that a fault was announced.
 *
 * Called only once the notice has actually gone out. Recording the *attempt*
 * instead is how a fault goes silent for good: nobody read the first copy
 * because the send failed, and the next tick sees a repeat and says nothing.
 */
export function recordAnnounced(
  repo: string,
  task: string,
  message: string,
  at = new Date(),
): void {
  const hash = fingerprint(message)
  const all = load()
  const k = key(repo, task, hash)
  const now = at.toISOString()
  all[k] = { hash, first: all[k]?.first ?? now, last: now }

  // A record older than the quiet period cannot suppress anything: a fault whose
  // last word was that long ago announces on its next sighting whether or not
  // its record survived. Dropped on the way out so the ledger cannot grow one
  // row per sentence this machine ever produced.
  for (const [stale, rec] of Object.entries(all)) {
    if (at.getTime() - Date.parse(rec.last) > REANNOUNCE_MS) delete all[stale]
  }
  save(all)
}

/**
 * Forget a job's faults, because it reached its manager and whatever was wrong
 * with it is not wrong any more.
 *
 * Without this a job that failed, recovered, and then failed again the same way
 * would be treated as repeating a fault that has already been fixed, and the
 * second outage would be silent — the dedupe outliving the fault it was
 * written for.
 */
export function clearFailures(repo: string, task: string): void {
  const all = load()
  const prefix = `${repo}::${task}::`
  const kept = Object.fromEntries(
    Object.entries(all).filter(([k]) => !k.startsWith(prefix)),
  )
  if (Object.keys(kept).length !== Object.keys(all).length) save(kept)
}
