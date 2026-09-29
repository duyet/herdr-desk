import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pluginStateDir } from './paths'

/** `until` is an ISO instant; absent means paused until `resume`. */
export type PauseEntry = { until?: string }

export type PauseState = {
  all?: PauseEntry
  /** Keyed by {@link pauseKey}. */
  jobs: Record<string, PauseEntry>
}

export const emptyPause = (): PauseState => ({ jobs: {} })

/** Same identity the fire ledger uses: the repo path, not the display name. */
export const pauseKey = (repo: string, job: string): string => `${repo}::${job}`

export function pausePath(): string {
  return join(pluginStateDir(), 'paused.json')
}

/**
 * Read the pause state.
 *
 * A corrupt file throws instead of reading as "nothing paused": silently
 * unpausing would fire jobs the user explicitly stopped. The daemon logs the
 * error and fires nothing until the file is fixed.
 */
export function loadPaused(): PauseState {
  if (!existsSync(pausePath())) return emptyPause()
  try {
    const raw = JSON.parse(
      readFileSync(pausePath(), 'utf8'),
    ) as Partial<PauseState>
    return { all: raw.all, jobs: raw.jobs ?? {} }
  } catch (err) {
    throw new Error(
      `${pausePath()} is not valid JSON (${err instanceof Error ? err.message : err}); fix or delete it`,
    )
  }
}

export function savePaused(state: PauseState): void {
  mkdirSync(pluginStateDir(), { recursive: true })
  writeFileSync(pausePath(), `${JSON.stringify(state, null, 2)}\n`)
}

const active = (e: PauseEntry | undefined, at: Date): boolean =>
  e !== undefined && (!e.until || at.getTime() < new Date(e.until).getTime())

/** Whether a fire at instant `at` is suppressed. Works for now and for future slots. */
export function isPaused(
  state: PauseState,
  repo: string,
  job: string,
  at: Date,
): boolean {
  return active(state.all, at) || active(state.jobs[pauseKey(repo, job)], at)
}

/** The active entry for a job right now, or null. Prefers the job's own entry. */
export function pausedNow(
  state: PauseState,
  repo: string,
  job: string,
  at = new Date(),
): PauseEntry | null {
  const own = state.jobs[pauseKey(repo, job)]
  if (active(own, at)) return own
  return active(state.all, at) ? (state.all as PauseEntry) : null
}

export function describePause(e: PauseEntry): string {
  if (!e.until) return 'paused'
  const d = new Date(e.until)
  const p = (n: number) => String(n).padStart(2, '0')
  return `paused until ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`, read as local time like the crons. */
export function parseUntil(text: string, now = new Date()): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(text)
  const d = m
    ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0))
    : null
  if (!d || Number.isNaN(d.getTime())) {
    throw new Error(`--until '${text}': use YYYY-MM-DD or YYYY-MM-DDTHH:MM`)
  }
  if (d.getTime() <= now.getTime()) {
    throw new Error(`--until '${text}' is in the past`)
  }
  return d
}

/** `target` is a {@link pauseKey}, or `'all'`. Returns the new state; does not save. */
export function withPause(
  state: PauseState,
  target: string,
  until?: Date,
): PauseState {
  const entry: PauseEntry = until ? { until: until.toISOString() } : {}
  return target === 'all'
    ? { ...state, all: entry }
    : { ...state, jobs: { ...state.jobs, [target]: entry } }
}

/** `resume all` clears every pause; `resume <key>` clears only that job's. */
export function withoutPause(state: PauseState, target: string): PauseState {
  if (target === 'all') return emptyPause()
  const { [target]: _gone, ...jobs } = state.jobs
  return { ...state, jobs }
}
