import { bar, color, gauge, gb, label, plainMode, sparkline } from './chart'
import { type Budget, defaultBudget, fmtLoad, readHealth } from './health'
import { loadRuns } from './history'
import { type HubSnapshot, snapshot } from './hub'
import { type QueueView, view as queueView } from './queue'

/**
 * The terminal dashboard: what this machine is doing, and whether it can keep
 * doing it.
 *
 * Four questions, in the order someone actually asks them:
 *
 * 1. **Is the host healthy enough to start anything?** Load, memory, and live
 *    sessions, each drawn against the limit the daemon enforces — so the number
 *    on screen is the same number the gate uses, and a bar that turns red means
 *    jobs are really being held, not that a threshold was crossed cosmetically.
 * 2. **What is the fleet doing?** The hub's counts, then one bar per desk.
 * 3. **What is waiting?** The queue, with the reason each job was held. A held
 *    job is the one thing here that is invisible everywhere else.
 * 4. **What has the desk been doing today?** Fire and failure counts from the
 *    run ledger, with a sparkline of the last runs.
 *
 * One command with no arguments on purpose. The reader is a person deciding
 * whether to intervene, and a dashboard that needs flags to answer the first
 * question is not a dashboard.
 */

export type Dashboard = {
  host: ReturnType<typeof readHealth>
  budget: Budget
  hub: HubSnapshot
  queue: QueueView
  today: { fired: number; failed: number; recent: number[] }
  plain: boolean
}

/** Assemble from live state. Split from `render` so the view is testable. */
export function collect(now = new Date()): Dashboard {
  const hub = snapshot(now)
  const runs = loadRuns(200)
  const since = now.getTime() - 24 * 60 * 60 * 1000
  const day = runs.filter((r) => Date.parse(r.at) >= since)
  return {
    // `running` comes from the hub so the count on screen is the same one the
    // digest reports. Two different numbers for "how much is going" is how a
    // reader stops trusting both.
    host: readHealth(hub.running),
    budget: defaultBudget(),
    hub,
    queue: queueView(now),
    today: {
      fired: day.length,
      failed: day.filter((r) => !r.ok).length,
      // 1 for a clean fire, 2 for a failure, so the sparkline's own scale shows
      // where the bad ones are instead of a flat line of identical 1s.
      recent: day.slice(-48).map((r) => (r.ok ? 1 : 2)),
    },
    plain: plainMode(),
  }
}

export function render(d: Dashboard): string {
  const c = color(!d.plain)
  const out: string[] = []

  out.push(c.bold('desk'))
  out.push(
    `${c.cyan('host')}   ${label(fmtLoad(d.host), 9)}  ${gauge(
      d.host.loadPerCore,
      d.budget.maxLoadPerCore,
      18,
      d.plain,
    )}  ${c.dim(`${d.host.cores} cores`)}`,
  )
  out.push(
    `        ${label(memText(d.host), 9)}  ${gauge(
      // Scaled to GB because a byte count is unreadable on a bar axis, and
      // `2.232172544` is a number nobody reads twice.
      d.host.memAvailable === null ? null : d.host.memAvailable / 1e9,
      d.budget.minMemAvailable / 1e9,
      18,
      d.plain,
      (v) => `${v.toFixed(1)}GB`,
    )}  ${c.dim('free')}`,
  )
  out.push(
    `        ${label(String(d.host.agents), 9)}  ${gauge(
      d.host.agents,
      d.budget.maxAgents,
      18,
      d.plain,
      (v) => String(Math.round(v)),
    )}  ${c.dim(`sessions · ${d.host.busy} working`)}`,
  )

  out.push('')
  out.push(
    `${c.cyan('desk')}    ${c.dim(
      `${d.hub.running} running · ${d.hub.stuck} stuck · ${d.hub.settled} settled`,
    )}`,
  )
  for (const line of deskRows(d)) out.push(`        ${line}`)

  const q = d.queue
  if (q.jobs.length || q.expired.length) {
    out.push('')
    out.push(`${c.cyan('queue')}   ${c.dim(`${q.jobs.length} held`)}`)
    for (const j of q.jobs.slice(0, 6)) {
      out.push(
        `        ${label(j.task, 28)} ${c.dim(`${j.reason} · ${j.tries} tries`)}`,
      )
    }
    for (const j of q.expired.slice(0, 3)) {
      out.push(
        `        ${c.yellow(`${j.task} gave up`)} ${c.dim(
          `held since ${j.since.slice(0, 16).replace('T', ' ')}`,
        )}`,
      )
    }
  }

  out.push('')
  out.push(
    `${c.cyan('24h')}     ${d.today.fired} fired · ${c.red(
      `${d.today.failed} failed`,
    )}  ${c.dim(sparkline(d.today.recent, 30))}`,
  )

  return out.join('\n')
}

function memText(host: Dashboard['host']): string {
  if (host.memAvailable === null) return '?'
  return gb(host.memAvailable)
}

/** One bar per desk, busiest first. */
function deskRows(d: Dashboard): string[] {
  const c = color(!d.plain)
  const byDesk = new Map<
    string,
    { total: number; running: number; stuck: number }
  >()
  for (const j of d.hub.jobs) {
    const key = j.desk || 'unknown'
    const hit = byDesk.get(key) ?? { total: 0, running: 0, stuck: 0 }
    hit.total++
    if (j.state === 'running') hit.running++
    if (j.state === 'stuck') hit.stuck++
    byDesk.set(key, hit)
  }
  const max = Math.max(1, ...[...byDesk.values()].map((x) => x.total))
  return [...byDesk.entries()]
    .sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([desk, x]) => {
      const drawn = bar(x.total, max, 12, {
        plain: d.plain,
        tint: x.stuck > 0 ? 'red' : x.running > 0 ? 'cyan' : 'green',
      })
      const detail = [
        x.stuck > 0 ? c.red(`${x.stuck} stuck`) : null,
        `${x.running}/${x.total} running`,
      ]
        .filter(Boolean)
        .join(' · ')
      return `${label(desk, 22)} ${drawn}  ${c.dim(detail)}`
    })
}
