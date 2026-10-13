import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { pluginStateDir } from './paths'

/** Events older than this are dropped by compaction. */
export const RETENTION_DAYS = 90
const DAY_MS = 86_400_000

/**
 * One thing the desk did, as a local usage counter, as call sites describe it.
 * `repo` is a local path here and never reaches disk: `track` replaces it with
 * a repo id before writing.
 */
export type UsageEvent =
  | { kind: 'command'; command: string }
  | { kind: 'run.started'; repo: string; task: string }
  | {
      kind: 'run.finished'
      repo: string
      task: string
      outcome: 'ran' | 'skip' | 'fail'
      ms: number
    }
  | { kind: 'child.spawned'; repo: string; task: string; agent: string }
  | { kind: 'upgrade'; target: string }

/**
 * What is written. Fields are ids, counts and timings only: no prompt text, no
 * titles, no error messages, no filesystem paths. `repoId` is a short sha256 of
 * the resolved repo path. It cannot be turned back into the path, so a viewer
 * who needs the repo name maps ids to paths from the repos it already knows.
 */
export type StoredEvent =
  | Exclude<UsageEvent, { repo: string }>
  | (Omit<Extract<UsageEvent, { repo: string }>, 'repo'> & { repoId: string })

export type StampedEvent = StoredEvent & { at: string }

/** Stable, non-reversible id for a repo path. */
export function repoId(path: string): string {
  return createHash('sha256').update(resolve(path)).digest('hex').slice(0, 12)
}

function toStored(e: UsageEvent): StoredEvent {
  if (!('repo' in e)) return e
  const { repo, ...rest } = e
  return { ...rest, repoId: repoId(repo) }
}

export function usagePath(): string {
  return join(pluginStateDir(), 'usage.jsonl')
}

function compactedMarker(): string {
  return join(pluginStateDir(), 'usage.compacted')
}

/**
 * Drop events older than RETENTION_DAYS, at most once per UTC day. The rewrite
 * goes to a temp file and is renamed over the log, so a crash leaves either the
 * old log or the new one. Running it again changes nothing.
 */
export function compactUsage(now: Date): void {
  const today = now.toISOString().slice(0, 10)
  const marker = compactedMarker()
  if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === today)
    return
  if (existsSync(usagePath())) {
    const cutoff = now.getTime() - RETENTION_DAYS * DAY_MS
    const kept = readFileSync(usagePath(), 'utf8')
      .split('\n')
      .filter((line) => {
        if (!line.trim()) return false
        try {
          return Date.parse((JSON.parse(line) as StampedEvent).at) >= cutoff
        } catch {
          return false
        }
      })
    const tmp = `${usagePath()}.${process.pid}.tmp`
    writeFileSync(tmp, kept.map((l) => `${l}\n`).join(''))
    renameSync(tmp, usagePath())
  }
  writeFileSync(marker, `${today}\n`)
}

function appendLocal(e: StampedEvent): void {
  mkdirSync(pluginStateDir(), { recursive: true })
  appendFileSync(usagePath(), `${JSON.stringify(e)}\n`)
  compactUsage(new Date(e.at))
}

/**
 * Where tracked events go. Today that is the local file and nothing else.
 * A remote sender is one more entry here; call sites do not change.
 */
const SINKS: ((e: StampedEvent) => void)[] = [appendLocal]

/** Record one event. Never throws: counting must not break the command. */
export function track(event: UsageEvent, now = new Date()): void {
  const stamped: StampedEvent = { ...toStored(event), at: now.toISOString() }
  for (const sink of SINKS) {
    try {
      sink(stamped)
    } catch {
      /* a full disk must not fail a run */
    }
  }
}

export function loadUsageSince(since: Date): StampedEvent[] {
  if (!existsSync(usagePath())) return []
  const out: StampedEvent[] = []
  for (const line of readFileSync(usagePath(), 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line) as StampedEvent
      if (Date.parse(e.at) >= since.getTime()) out.push(e)
    } catch {
      /* skip bad line */
    }
  }
  return out
}

export type UsageCounts = {
  commands: Record<string, number>
  runsStarted: number
  runsFinished: number
  childrenSpawned: number
  upgrades: number
}

export function countUsage(events: StampedEvent[]): UsageCounts {
  const c: UsageCounts = {
    commands: {},
    runsStarted: 0,
    runsFinished: 0,
    childrenSpawned: 0,
    upgrades: 0,
  }
  for (const e of events) {
    if (e.kind === 'command')
      c.commands[e.command] = (c.commands[e.command] ?? 0) + 1
    else if (e.kind === 'run.started') c.runsStarted += 1
    else if (e.kind === 'run.finished') c.runsFinished += 1
    else if (e.kind === 'child.spawned') c.childrenSpawned += 1
    else c.upgrades += 1
  }
  return c
}

/** One line of local counters, or '' when nothing was counted yet. */
export function formatUsage(c: UsageCounts): string {
  const commands = Object.values(c.commands).reduce((a, b) => a + b, 0)
  const parts = [
    [commands, 'commands'],
    [c.runsStarted, 'runs started'],
    [c.runsFinished, 'finished'],
    [c.childrenSpawned, 'children spawned'],
    [c.upgrades, 'upgrades'],
  ] as const
  const shown = parts.filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}`)
  return shown.length ? `local usage  ${shown.join(' · ')}` : ''
}
