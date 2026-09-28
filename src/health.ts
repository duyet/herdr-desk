import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { cpus, freemem, loadavg, totalmem } from 'node:os'

/**
 * Host load, and whether a new job is allowed to start.
 *
 * `docs/machine-health.md` has always said "one heavy node run per host" and
 * "check before starting, not after". It was advice every agent had to
 * remember. This module makes it something the daemon checks, so the rule
 * holds even when the agent that would break it is the one being scheduled.
 *
 * The failure this prevents is documented in that file: load 21 on a 16-core
 * box with 2 GB free, caused not by one big job but by two children
 * re-running `vitest` in a loop. Nothing in that picture is individually
 * alarming, which is exactly why it needs a number in front of it.
 *
 * Three signals, and they fail differently on purpose:
 *
 * - **load average** — from `os.loadavg()`, no subprocess. Normalised per core,
 *   because a load of 21 means something very different on 4 cores than on 16.
 * - **memory** — `MemAvailable`, not `MemFree`. `MemFree` excludes reclaimable
 *   page cache and reads as an emergency on a healthy Linux box, which trains
 *   you to ignore it. The host runs `earlyoom` tuned to evict `node` first, so
 *   a starved `node` run looks like a half-finished test, not an OOM.
 * - **live agents** — from Herdr, so it counts the *desk's own* children. A
 *   desk that is already fanning out five worktrees is the load it is causing.
 *
 * Every reading is defensive. This runs before every fire on every tick, so a
 * throw here would stop the desk entirely — the exact opposite of what a
 * health check is for. An unreadable signal reads as "unknown" and never
 * blocks.
 */

/** A reading that could not be taken. Never blocks a fire. */
export type Reading = number | null

export type HostHealth = {
  at: string
  /** 1-minute load average, per core. */
  loadPerCore: Reading
  cores: number
  /** Bytes of memory the kernel says are genuinely available. */
  memAvailable: Reading
  memTotal: number
  /** Herdr sessions alive right now. */
  agents: number
  /** Of those, ones that are actually working. */
  busy: number
  /** Managers currently running, from the hub. */
  running: number
}

export type Budget = {
  /** Max load per core before a fire is held. */
  maxLoadPerCore: number
  /** Min available memory before a fire is held. */
  minMemAvailable: number
  /** Max live Herdr sessions before a fire is held. */
  maxAgents: number
}

/**
 * Defaults, from this host's observed failure.
 *
 * `maxLoadPerCore: 1.5` is deliberately not 1.0. A box at exactly 1.0 per core
 * is fully committed with nothing left for the new job, and the queue is the
 * right place for that job to wait. The number is also a *hold*, never a
 * refusal: a job that cannot run is deferred to the next tick, so a
 * permanently over-budget host delays work rather than silently dropping it.
 *
 * `minMemAvailable: 3 GB` is the figure the health doc already gave, and 15% of
 * total, whichever is larger, so a smaller host is not held to a bar set for a
 * 16 GB one.
 */
export function defaultBudget(total?: number): Budget {
  return {
    maxLoadPerCore: 1.5,
    minMemAvailable: Math.max(
      3 * 1024 ** 3,
      Math.round((total ?? totalmem()) * 0.15),
    ),
    maxAgents: 24,
  }
}

/**
 * Memory the kernel would actually hand out, in bytes.
 *
 * Prefers `MemAvailable` from `/proc/meminfo` because it accounts for reclaimable
 * page cache. Falls back to `freemem()` only where there is no procfs; on such a
 * host the value is pessimistic, which errs toward holding a fire rather than
 * toward overloading it.
 */
export function memAvailable(): Reading {
  try {
    const raw = readFileSync('/proc/meminfo', 'utf8')
    const hit = /^MemAvailable:\s+(\d+)\s*kB$/m.exec(raw)
    if (hit?.[1]) return Number(hit[1]) * 1024
  } catch {
    /* no procfs — macOS, or a container without it mounted */
  }
  try {
    const free = freemem()
    return free > 0 ? free : null
  } catch {
    return null
  }
}

/** Load average over 1 minute, divided by cores. */
export function loadPerCore(): Reading {
  try {
    const [one] = loadavg()
    const cores = cpus().length || 1
    return one > 0 ? one / cores : 0
  } catch {
    return null
  }
}

/**
 * Live and busy session counts from `herdr agent list`.
 *
 * Returns zeros rather than throwing when Herdr is unreachable: a health check
 * that throws stops the desk, and "cannot count" is not "everything is fine"
 * but it is also not an emergency worth blocking on.
 */
export function agentCounts(listJson: unknown): {
  agents: number
  busy: number
} {
  const agents =
    (listJson as { result?: { agents?: Array<Record<string, unknown>> } })
      ?.result?.agents ?? []
  if (!Array.isArray(agents)) return { agents: 0, busy: 0 }
  let busy = 0
  for (const a of agents) {
    const status = String(a.agent_status ?? a.status ?? '')
    if (status === 'working') busy++
  }
  return { agents: agents.length, busy }
}

/** Read the host. `running` comes from the hub, which is the desk's own count. */
export function readHealth(running = 0): HostHealth {
  const { agents, busy } = agentCounts(safeAgentList())
  const cores = cpus().length || 1
  return {
    at: new Date().toISOString(),
    loadPerCore: loadPerCore(),
    cores,
    memAvailable: memAvailable(),
    memTotal: safeTotalmem(),
    agents,
    busy,
    running,
  }
}

function safeTotalmem(): number {
  try {
    return totalmem()
  } catch {
    return 0
  }
}

/**
 * `herdr agent list`, or `null` when it cannot be read.
 *
 * `execFileSync` with a short timeout: this is on the path before every single
 * fire, and a Herdr socket that hangs must not hang the daemon with it.
 */
function safeAgentList(): unknown {
  const bin =
    process.env.HERDR_BIN ?? `${process.env.HOME ?? ''}/.local/bin/herdr`
  try {
    const out = execFileSync(bin, ['agent', 'list'], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: process.env,
    })
    return JSON.parse(out)
  } catch {
    return null
  }
}

export type Verdict = {
  ok: boolean
  /** Every breached limit, for the reason a fire was held. */
  breaches: string[]
  /** The signal that came closest to its limit, for the dashboard. */
  pressure: number
}

/**
 * Decide whether the host can take one more job.
 *
 * Each signal is checked on its own and the first breach wins, so the reason is
 * specific: "load 2.1/core" says something different from "2 GB free", and a
 * single vague "busy" would send the reader looking in the wrong place.
 *
 * An unknown signal never blocks. A reading of `null` is skipped, so a machine
 * where `/proc` is unavailable is governed by whichever signals it *can* report
 * rather than being treated as broken.
 */
export function check(
  h: HostHealth,
  budget: Budget = defaultBudget(h.memTotal || undefined),
): Verdict {
  const breaches: string[] = []

  if (h.loadPerCore !== null && h.loadPerCore > budget.maxLoadPerCore) {
    breaches.push(
      `load ${h.loadPerCore.toFixed(1)}/core over ${budget.maxLoadPerCore}`,
    )
  }
  if (h.memAvailable !== null && h.memAvailable < budget.minMemAvailable) {
    breaches.push(
      `${(h.memAvailable / 1024 ** 3).toFixed(1)}GB free of ${(budget.minMemAvailable / 1024 ** 3).toFixed(0)}GB`,
    )
  }
  if (h.agents > budget.maxAgents) {
    breaches.push(`${h.agents} agents over ${budget.maxAgents}`)
  }

  return {
    ok: breaches.length === 0,
    breaches,
    pressure: Math.max(...ratios(h, budget), 0),
  }
}

/** How close each known signal is to its limit, 0..n. Worst is the headline. */
function ratios(h: HostHealth, budget: Budget): number[] {
  const out: number[] = []
  if (h.loadPerCore !== null && budget.maxLoadPerCore > 0) {
    out.push(h.loadPerCore / budget.maxLoadPerCore)
  }
  if (h.memAvailable !== null && h.memAvailable > 0) {
    out.push(1 - h.memAvailable / budget.minMemAvailable)
  }
  if (h.agents > 0) out.push(h.agents / budget.maxAgents)
  return out
}

/** `2.1/core`, or `?` when the reading is unavailable. */
export function fmtLoad(h: HostHealth): string {
  return h.loadPerCore === null ? '?' : `${h.loadPerCore.toFixed(1)}/core`
}

export function fmtMem(bytes: Reading): string {
  if (bytes === null) return '?'
  const gb = bytes / 1024 ** 3
  return gb >= 1 ? `${gb.toFixed(1)}GB` : `${Math.round(bytes / 1024 ** 2)}MB`
}
