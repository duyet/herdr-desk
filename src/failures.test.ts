import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearFailures,
  REANNOUNCE_MS,
  recordAnnounced,
  shouldAnnounce,
} from './failures'

const REPO = '/p/chmonitor'
const TASK = 'local:babysit'
// The line a reader is actually shown, which is what the ledger keys on.
const ERR = 'agent_name_taken: agent name chm-babysit is already used'

const T0 = new Date('2026-10-04T09:00:00Z')
const HOUR = 60 * 60 * 1000
const after = (ms: number) => new Date(T0.getTime() + ms)

let stateDir: string
let saved: string | undefined

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'herdr-desk-fail-'))
  saved = process.env.HERDR_PLUGIN_STATE_DIR
  process.env.HERDR_PLUGIN_STATE_DIR = stateDir
})

afterEach(() => {
  if (saved === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR
  else process.env.HERDR_PLUGIN_STATE_DIR = saved
  rmSync(stateDir, { recursive: true, force: true })
})

function rows(): Record<string, { hash: string; first: string; last: string }> {
  return JSON.parse(
    readFileSync(join(stateDir, 'failures.json'), 'utf8'),
  ) as Record<string, { hash: string; first: string; last: string }>
}

describe('shouldAnnounce', () => {
  test('the first sighting of a fault always announces', () => {
    // The one rule nothing may break. A failure notice exists for the failure
    // nobody saw yet; if the ledger could suppress a first sighting, the whole
    // file would be a way of losing failures silently.
    expect(shouldAnnounce(REPO, TASK, ERR, T0)).toBe(true)
  })

  test('the same fault on the same job does not announce again', () => {
    // The symptom this file exists for: a fault that cannot fix itself, ticked
    // every 30 minutes, produced the identical sentence every tick until the
    // channel was muted — and a muted channel hears nothing at all, including
    // about the faults that were new.
    recordAnnounced(REPO, TASK, ERR, T0)
    expect(shouldAnnounce(REPO, TASK, ERR, after(30 * 60_000))).toBe(false)
    expect(shouldAnnounce(REPO, TASK, ERR, after(6 * HOUR))).toBe(false)
  })

  test('a different fault on the same job announces', () => {
    // Dedupe keyed on the job alone would hide a *new* problem behind an old
    // one, which is how a second fault gets found days late.
    recordAnnounced(REPO, TASK, ERR, T0)
    expect(shouldAnnounce(REPO, TASK, 'worktree is locked', T0)).toBe(true)
  })

  test('the same fault on another job announces', () => {
    // One broken machine, several desks running against it. Each job's failure
    // is its own news, and the notice names one job.
    recordAnnounced(REPO, TASK, ERR, T0)
    expect(shouldAnnounce(REPO, 'local:prod', ERR, T0)).toBe(true)
    expect(shouldAnnounce('/p/other', TASK, ERR, T0)).toBe(true)
  })

  test('it speaks again once the quiet period has passed', () => {
    // Deliberate, and the reason a repeat is not permanent: a fault that has
    // outlived half a day was not fixed by being ignored, and the reader who
    // muted the channel after the first copy needs it to come back on its own.
    recordAnnounced(REPO, TASK, ERR, T0)
    expect(shouldAnnounce(REPO, TASK, ERR, after(REANNOUNCE_MS - 1000))).toBe(
      false,
    )
    expect(shouldAnnounce(REPO, TASK, ERR, after(REANNOUNCE_MS + 1000))).toBe(
      true,
    )
  })

  test('the quiet period restarts from the last word, not the first', () => {
    // Measured from the first sighting instead, every tick after the window
    // would announce and the fault would be back to filling the channel — just
    // slower, which reads as fixed while nothing is.
    const again = after(REANNOUNCE_MS + HOUR)
    recordAnnounced(REPO, TASK, ERR, T0)
    expect(shouldAnnounce(REPO, TASK, ERR, again)).toBe(true)
    recordAnnounced(REPO, TASK, ERR, again)
    expect(
      shouldAnnounce(REPO, TASK, ERR, new Date(again.getTime() + 60_000)),
    ).toBe(false)
  })

  test('a record it cannot read announces rather than going quiet for good', () => {
    // A stamp that does not parse compares as `NaN`, and every later sighting
    // would then fail the window test and be held back. A fault that is real,
    // seen on every tick, and silent from here on is the worst outcome this file
    // could produce.
    recordAnnounced(REPO, TASK, ERR, T0)
    const broken = rows()
    for (const rec of Object.values(broken)) rec.last = 'not a date'
    writeFileSync(join(stateDir, 'failures.json'), JSON.stringify(broken))
    expect(shouldAnnounce(REPO, TASK, ERR, T0)).toBe(true)
  })

  test('a half-written ledger announces', () => {
    // The realistic corruption: a crash between write and rename. Unreadable is
    // not "already said".
    writeFileSync(join(stateDir, 'failures.json'), '{"chmonitor::local:')
    expect(shouldAnnounce(REPO, TASK, ERR, T0)).toBe(true)
  })

  test('a ledger that cannot be written costs a duplicate, not the fault', () => {
    // A full or read-only state dir must not throw. `announce` swallows whatever
    // goes wrong after its verdict, so a throw while recording would drop the
    // failure notice itself, and `clearFailures` runs on the *success* path,
    // where a throw turns a good run into a failed one.
    const blocker = join(stateDir, 'blocker')
    writeFileSync(blocker, 'not a directory')
    process.env.HERDR_PLUGIN_STATE_DIR = join(blocker, 'state')

    expect(() => recordAnnounced(REPO, TASK, ERR, T0)).not.toThrow()
    expect(() => clearFailures(REPO, TASK)).not.toThrow()
    expect(shouldAnnounce(REPO, TASK, ERR, T0)).toBe(true)
  })
})

describe('recordAnnounced', () => {
  test('drops a record it can no longer suppress', () => {
    // Behaviour-preserving by construction: a fault whose last word was longer
    // ago than the quiet period announces on its next sighting whether its row
    // is here or not. Kept because without it the ledger grows one row per
    // sentence this machine ever produced, and it is read by hand when something
    // has to be explained.
    recordAnnounced(REPO, TASK, ERR, T0)
    recordAnnounced('/p/other', TASK, ERR, after(REANNOUNCE_MS + HOUR))

    const left = Object.entries(rows())
    expect(left).toHaveLength(1)
    expect(left[0]?.[0].startsWith('/p/other::')).toBe(true)
    expect(shouldAnnounce(REPO, TASK, ERR, after(REANNOUNCE_MS + HOUR))).toBe(
      true,
    )
  })
})

describe('clearFailures', () => {
  test('a job that reached its manager announces its next fault', () => {
    // Otherwise the dedupe outlives the fault it was written for: fail, recover,
    // fail the same way — and the second outage is silent because the first
    // record is still on file.
    recordAnnounced(REPO, TASK, ERR, T0)
    clearFailures(REPO, TASK)
    expect(shouldAnnounce(REPO, TASK, ERR, T0)).toBe(true)
  })

  test("clearing one job leaves the others' faults held back", () => {
    // A job recovering says nothing about its neighbours. Clearing by anything
    // coarser than the job would hand every desk on the machine its first
    // failure back.
    recordAnnounced(REPO, TASK, ERR, T0)
    recordAnnounced(REPO, 'local:prod', ERR, T0)
    clearFailures(REPO, TASK)
    expect(shouldAnnounce(REPO, 'local:prod', ERR, T0)).toBe(false)
    expect(shouldAnnounce(REPO, TASK, ERR, T0)).toBe(true)
  })
})
