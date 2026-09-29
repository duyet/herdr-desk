import { outcomeOf, pct, type Rollup } from './analytics'
import type { RunRecord } from './history'
import type { SessionRow } from './sessions/types'
import { DENSE, type Fire } from './timeline'

const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ] ?? c,
  )

const p = (n: number) => String(n).padStart(2, '0')
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const local = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? iso
    : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export type BoardData = {
  now: Date
  days: number
  fires: Fire[]
  runs: RunRecord[]
  rollup: Rollup
  sessions: SessionRow[]
}

/** Day x hour grid; each cell lists the jobs firing in that hour. */
function slotGrid(fires: Fire[], now: Date, days: number): string {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const dayIdx = (at: Date) =>
    Math.round(
      (new Date(at).setHours(0, 0, 0, 0) - start.getTime()) / 86_400_000,
    )
  // Like `agenda`: a job firing more than DENSE times in a day is one entry at
  // its first fire, not one per fire, or a */30 job buries the grid.
  const perJobDay = new Map<string, Fire[]>()
  for (const f of fires) {
    const k = `${dayIdx(f.at)}\0${f.repo}\0${f.job}`
    perJobDay.set(k, [...(perJobDay.get(k) ?? []), f])
  }
  const hm = (d: Date) => `${p(d.getHours())}:${p(d.getMinutes())}`
  const cells = new Map<string, { f: Fire; text: string }[]>()
  for (const [k, fs] of perJobDay) {
    const di = k.split('\0')[0]
    const shown =
      fs.length > DENSE
        ? [
            {
              f: fs[0],
              text: `${hm(fs[0].at)}-${hm(fs[fs.length - 1].at)} x${fs.length}`,
            },
          ]
        : fs.map((f) => ({ f, text: hm(f.at) }))
    for (const e of shown) {
      const ck = `${di}:${e.f.at.getHours()}`
      cells.set(ck, [...(cells.get(ck) ?? []), e])
    }
  }
  for (const list of cells.values())
    list.sort((a, b) => a.f.at.getTime() - b.f.at.getTime())
  const hours = [
    ...new Set([...cells.keys()].map((k) => Number(k.split(':')[1]))),
  ].sort((a, b) => a - b)
  if (hours.length === 0) return '<p class="muted">No fires scheduled.</p>'
  const head = Array.from({ length: days }, (_, i) => {
    const d = new Date(start)
    d.setDate(d.getDate() + i)
    return `<th>${DAY[d.getDay()]} ${p(d.getMonth() + 1)}-${p(d.getDate())}</th>`
  }).join('')
  const rows = hours
    .map((h) => {
      const tds = Array.from({ length: days }, (_, i) => {
        const fs = cells.get(`${i}:${h}`) ?? []
        if (fs.length === 0) return '<td></td>'
        const items = fs
          .map(
            ({ f, text }) =>
              `<div class="fire" title="${esc(f.agent)}">${text} ${esc(f.repo)}/${esc(f.job)}</div>`,
          )
          .join('')
        return `<td class="${fs.length > 1 ? 'busy' : 'on'}">${items}</td>`
      }).join('')
      return `<tr><th>${p(h)}:00</th>${tds}</tr>`
    })
    .join('\n')
  return `<div class="scroll"><table class="grid"><thead><tr><th></th>${head}</tr></thead><tbody>\n${rows}\n</tbody></table></div>`
}

function runsTable(runs: RunRecord[]): string {
  if (runs.length === 0) return '<p class="muted">No runs recorded.</p>'
  const rows = [...runs]
    .reverse()
    .map((r) => {
      const o = outcomeOf(r)
      return `<tr><td>${esc(local(r.at))}</td><td><span class="st ${o.kind}">${o.kind}</span></td><td>${esc(r.name)}/${esc(r.task)}</td><td class="muted">${esc(o.cause ?? '')}</td></tr>`
    })
    .join('\n')
  return `<div class="scroll"><table><thead><tr><th>When</th><th>Status</th><th>Job</th><th>Cause</th></tr></thead><tbody>\n${rows}\n</tbody></table></div>`
}

function rateTable(r: Rollup): string {
  if (r.jobs.length === 0) return '<p class="muted">No runs in range.</p>'
  const rows = r.jobs
    .map((j) => {
      const w = j.rate === null ? 0 : Math.round(j.rate * 100)
      return `<tr><td>${esc(j.job)}</td><td>${j.ran}</td><td>${j.skipped}</td><td>${j.failed}</td><td><span class="bar"><span style="width:${w}%"></span></span> ${pct(j.rate)}</td></tr>`
    })
    .join('\n')
  return `<div class="scroll"><table><thead><tr><th>Job</th><th>Ran</th><th>Skip</th><th>Fail</th><th>Success</th></tr></thead><tbody>\n${rows}\n</tbody></table></div>`
}

function sessionsTable(sessions: SessionRow[]): string {
  const rows = [...sessions]
    .sort((a, b) => b.started.localeCompare(a.started))
    .slice(0, 50)
    .map(
      (s) =>
        `<tr><td>${esc(local(s.started))}</td><td>${esc(s.agent)}</td><td>${esc(s.repo ?? '')}</td><td>${esc(s.title ?? '')}</td></tr>`,
    )
    .join('\n')
  return `<div class="scroll"><table><thead><tr><th>Started</th><th>Agent</th><th>Repo</th><th>Title</th></tr></thead><tbody>\n${rows}\n</tbody></table></div>`
}

/**
 * The whole board as one self-contained HTML page.
 *
 * No script, no external stylesheet, no font: it has to open from a file on a
 * machine with no network, and it is a snapshot, so nothing on it should move.
 */
export function formatBoard(d: BoardData): string {
  const sessions = d.sessions.length
    ? `<section><h2>Sessions</h2>${sessionsTable(d.sessions)}</section>`
    : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Desk Board</title>
<style>
:root{--bg:#fbfbfa;--fg:#1d1d1b;--muted:#6b6b66;--line:#e3e2de;--on:#e6f2ea;--busy:#fbecd6;--ok:#2f7d4a;--fail:#b3261e;--skip:#8a6d1f}
@media (prefers-color-scheme: dark){:root{--bg:#161615;--fg:#ebeae6;--muted:#9a9993;--line:#2e2d2a;--on:#1d3326;--busy:#3a2e17;--ok:#6cc58a;--fail:#f08a80;--skip:#e0c068}}
*{box-sizing:border-box}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,sans-serif}
main{max-width:1200px;margin:0 auto}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 8px}
.muted{color:var(--muted)}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{border-bottom:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}
.grid td{min-width:120px;font-size:12px}
.grid td.on{background:var(--on)}.grid td.busy{background:var(--busy)}
.fire{white-space:nowrap}
.st{font-weight:600}.st.ran{color:var(--ok)}.st.fail{color:var(--fail)}.st.skip{color:var(--skip)}
.bar{display:inline-block;width:80px;height:8px;background:var(--line);border-radius:4px;vertical-align:middle;overflow:hidden}
.bar span{display:block;height:100%;background:var(--ok)}
.kpi{display:flex;gap:24px;flex-wrap:wrap;margin-top:12px}.kpi b{display:block;font-size:20px}
</style>
</head>
<body>
<main>
<h1>Desk board</h1>
<div class="muted">Snapshot ${esc(local(d.now.toISOString()))}</div>
<div class="kpi">
<div><b>${d.fires.length}</b><span class="muted">fires next ${d.days}d</span></div>
<div><b>${d.rollup.total}</b><span class="muted">runs since ${esc(d.rollup.since.toISOString().slice(0, 10))}</span></div>
<div><b>${pct(d.rollup.rate)}</b><span class="muted">success</span></div>
<div><b>${d.sessions.length}</b><span class="muted">sessions</span></div>
</div>
<section><h2>Upcoming fires</h2>${slotGrid(d.fires, d.now, d.days)}</section>
<section><h2>Success rate per job</h2>${rateTable(d.rollup)}</section>
<section><h2>Recent runs</h2>${runsTable(d.runs)}</section>
${sessions}
</main>
</body>
</html>
`
}
