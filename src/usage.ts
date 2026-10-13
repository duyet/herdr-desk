import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pluginStateDir } from './paths'

/**
 * One thing the desk did, as a local usage counter.
 *
 * Fields are ids and counts only: no prompt text, no titles, no error
 * messages. That keeps the log safe to ship somewhere later without a
 * second scrub pass.
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

export type StampedEvent = UsageEvent & { at: string }

export function usagePath(): string {
  return join(pluginStateDir(), 'usage.jsonl')
}

function appendLocal(e: StampedEvent): void {
  mkdirSync(pluginStateDir(), { recursive: true })
  appendFileSync(usagePath(), `${JSON.stringify(e)}\n`)
}

/**
 * Where tracked events go. Today that is the local file and nothing else.
 * A remote sender is one more entry here; call sites do not change.
 */
const SINKS: ((e: StampedEvent) => void)[] = [appendLocal]

/** Record one event. Never throws: counting must not break the command. */
export function track(event: UsageEvent, now = new Date()): void {
  const stamped: StampedEvent = { ...event, at: now.toISOString() }
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
