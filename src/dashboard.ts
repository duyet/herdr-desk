import { bar, color, gauge, gb, label, plainMode, sparkline } from './chart'
import { type Budget, defaultBudget, fmtLoad, readHealth } from './health'
import { loadRuns } from './history'
import { type HubSnapshot, snapshot } from './hub'
import { type InsightCounts, type Insights, insightsOf } from './insights'
import { type QueueView, view as queueView } from './queue'
import { loadSessions } from './sessions'

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
 *    run ledger, with a sparkline of the last runs. Sessions, agents, and
 *    pull URLs from that same window sit on the next lines when any count
 *    is non-zero.
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
  /** Same 24h window as `today`. Counts come from the session index. */
  insights: Insights
  plain: boolean
}

/** Assemble from live state. Split from `render` so the view is testable. */
export function collect(now = new Date()): Dashboard {
  const hub = snapshot(now)
  const runs = loadRuns(200)
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const day = runs.filter((r) => Date.parse(r.at) >= since.getTime())
  // Index only. `sessions index` already walked the agent files; doing it
  // again on every paint is the slow path that command exists to avoid.
  const sessions = loadSessions()
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
    insights: insightsOf({ runs, sessions, since }),
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
  for (const line of insightLines(d)) out.push(line)

  return out.join('\n')
}

/**
 * The object `dash --json` and `GET /api/dashboard` both serialize.
 *
 * One shape, two doors. A field added on only one of them is how the page
 * and the terminal stop agreeing.
 */
export function dashboardJson(d: Dashboard) {
  return {
    host: d.host,
    budget: d.budget,
    hub: {
      running: d.hub.running,
      stuck: d.hub.stuck,
      settled: d.hub.settled,
      byLevel: d.hub.byLevel,
    },
    queue: { jobs: d.queue.jobs, expired: d.queue.expired },
    today: d.today,
    insights: d.insights,
  }
}

/** Counts worth a line. A zero is noise, so it is left out. */
function insightCountParts(n: InsightCounts): string[] {
  const parts: string[] = []
  if (n.sessions > 0) parts.push(`${n.sessions} sessions`)
  if (n.agents > 0) parts.push(`${n.agents} agents`)
  if (n.prs > 0) parts.push(`${n.prs} PRs`)
  if (n.runs > 0) parts.push(`${n.runs} runs`)
  if (n.failed > 0) parts.push(`${n.failed} failed`)
  return parts
}

function agentBreakdown(d: Dashboard): string {
  return d.insights.byAgent.map((a) => `${a.agent} ${a.sessions}`).join(' · ')
}

/** The insight block. Empty when every count is zero. */
function insightLines(d: Dashboard): string[] {
  const parts = insightCountParts(d.insights.counts)
  if (parts.length === 0) return []
  const c = color(!d.plain)
  const painted = parts.map((part) =>
    part.endsWith(' failed') ? c.red(part) : part,
  )
  // Wider than the other row names, so the counts start two spaces after
  // the word and the agent line lines up under them.
  const lines = [`${c.cyan('insights')}  ${painted.join(' · ')}`]
  const agents = agentBreakdown(d)
  if (agents) lines.push(`${label('', 10)}${c.dim(agents)}`)
  return lines
}

const escHtml = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        ch
      ] ?? ch,
  )

function queueHtml(d: Dashboard): string {
  const q = d.queue
  if (q.jobs.length === 0 && q.expired.length === 0) return ''
  const items = [
    ...q.jobs.map(
      (j) =>
        `<li>${escHtml(j.repo)}/${escHtml(j.task)} <span class="muted">${escHtml(j.reason)} · ${j.tries} tries</span></li>`,
    ),
    ...q.expired.map(
      (j) =>
        `<li>${escHtml(j.repo)}/${escHtml(j.task)} gave up <span class="muted">held since ${escHtml(j.since.slice(0, 16).replace('T', ' '))}</span></li>`,
    ),
  ]
  return `<section><h2>queue</h2><p>${q.jobs.length} held</p><ul>${items.join('')}</ul></section>`
}

function deskListHtml(d: Dashboard): string {
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
  if (byDesk.size === 0) return ''
  const items = [...byDesk.entries()]
    .sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([desk, x]) => {
      const detail = [
        x.stuck > 0 ? `${x.stuck} stuck` : null,
        `${x.running}/${x.total} running`,
      ]
        .filter(Boolean)
        .join(' · ')
      return `<li>${escHtml(desk)} <span class="muted">${detail}</span></li>`
    })
  return `<ul>${items.join('')}</ul>`
}

function insightsHtml(d: Dashboard): string {
  const parts = insightCountParts(d.insights.counts)
  const agents = agentBreakdown(d)
  const prs = d.insights.prs
  if (parts.length === 0 && !agents && prs.length === 0) return ''
  const counts = parts.length ? `<p>${parts.map(escHtml).join(' · ')}</p>` : ''
  const by = agents ? `<p class="muted">${escHtml(agents)}</p>` : ''
  const links =
    prs.length === 0
      ? ''
      : `<ul>${prs
          .map(
            (url) => `<li><a href="${escHtml(url)}">${escHtml(url)}</a></li>`,
          )
          .join('')}</ul>`
  return `<section><h2>insights</h2>${counts}${by}${links}</section>`
}

/**
 * The same facts as {@link render}, as one page.
 *
 * No script and no external asset: a meta refresh is the whole update
 * mechanism, so the page still reads with JavaScript off.
 */
export function renderWeb(d: Dashboard): string {
  const mem = d.host.memAvailable === null ? '?' : `${memText(d.host)} free`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="15">
<title>desk</title>
<style>
:root{--bg:#fbfbfa;--fg:#1d1d1b;--muted:#6b6b66;--line:#e3e2de}
@media (prefers-color-scheme: dark){:root{--bg:#161615;--fg:#ebeae6;--muted:#9a9993;--line:#2e2d2a}}
*{box-sizing:border-box}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,sans-serif}
main{max-width:40rem;margin:0 auto}
h1{font-size:18px;margin:0 0 8px}
h2{font-size:12px;font-weight:600;margin:18px 0 4px}
p,li{margin:0;padding:3px 0;border-bottom:1px solid var(--line)}
ul{list-style:none;margin:0;padding:0}
.muted{color:var(--muted)}
a{color:inherit}
</style>
</head>
<body>
<main>
<h1>desk</h1>
<section>
<h2>host</h2>
<p>${escHtml(fmtLoad(d.host))} · ${d.host.cores} cores</p>
<p>${escHtml(mem)}</p>
<p>${d.host.agents} sessions · ${d.host.busy} working</p>
</section>
<section>
<h2>desk</h2>
<p>${d.hub.running} running · ${d.hub.stuck} stuck · ${d.hub.settled} settled</p>
${deskListHtml(d)}
</section>
${queueHtml(d)}
<section>
<h2>24h</h2>
<p>${d.today.fired} fired · ${d.today.failed} failed</p>
</section>
${insightsHtml(d)}
</main>
</body>
</html>
`
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
