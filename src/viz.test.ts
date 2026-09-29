import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { formatAnalytics, outcomeOf, rollup } from './analytics'
import { formatBoard } from './board'
import type { LoadedDesk } from './config'
import type { Discovered } from './discover'
import type { RunRecord } from './history'
import type { SessionRow } from './sessions/types'
import { parseSince } from './since'
import {
  formatHeatmap,
  formatTimeline,
  heatOf,
  toIcs,
  upcomingFires,
} from './timeline'

function desk(name: string, jobs: Record<string, string[]>): Discovered {
  const config: LoadedDesk = {
    name,
    tasks: Object.entries(jobs).map(([id, crons]) => ({
      id,
      playbook: 'github-issues',
      agentName: `${name}-desk`,
      agent: { ladder: ['grok'], permission: 'default' },
      crons,
    })),
  }
  const repo = `/r/${name}`
  return {
    repo,
    configPath: join(repo, '.herdr-desk.json'),
    config,
    source: 'workspace',
  }
}

// Wed 2026-09-30 10:00 local.
const NOW = new Date(2026, 8, 30, 10, 0)

const sess = (agent: SessionRow['agent'], started: string): SessionRow => ({
  agent,
  id: agent,
  repo: null,
  started,
  ended: started,
  title: '',
  path: '',
})
const plain = { width: 100, color: false }

const run = (
  task: string,
  ok: boolean,
  detail: string,
  at = '2026-09-29T08:00:00.000Z',
): RunRecord => ({ at, name: 'a', repo: '/r/a', task, mode: 'run', ok, detail })

// A fixture ledger: triage ran twice and failed once; wrap only ever skipped.
const LEDGER: RunRecord[] = [
  run('triage', true, '{"spawned":true}'),
  run('triage', true, '{"prompted":true}'),
  run('triage', false, 'herdr socket gone\nstack...'),
  run('wrap', true, '{"skipped":"repo not open in Herdr","quiet":true}'),
  run('wrap', true, '{"skipped":"repo not open in Herdr","quiet":true}'),
]

describe('formatTimeline', () => {
  test('one lane per job, first fire time per day, a dot on days off', () => {
    const out = formatTimeline(
      [
        desk('a', { triage: ['0 7 * * 1,3,5'] }),
        desk('b', { deps: ['30 9 * * *'] }),
      ],
      plain,
      NOW,
    )
    const lines = out.split('\n')
    expect(lines[0].trim().split(/\s+/)).toEqual([
      'wed',
      'thu',
      'fri',
      'sat',
      'sun',
      'mon',
      'tue',
    ])
    // Today's 07:00 is already past, so the lane starts with a dot, not 07:00.
    expect(lines[1]).toMatch(/^a\/triage\s+· +· +07:00 +· +· +07:00 +·$/)
    expect(lines[2]).toMatch(/^b\/deps\s+· +(09:30\s+){5}09:30$/)
  })

  test('narrow terminal: one mark per day, fits the width, no ANSI', () => {
    const out = formatTimeline(
      [desk('a', { t: ['0 12,18 * * *'] })],
      { width: 20, color: false },
      NOW,
    )
    for (const l of out.split('\n')) expect(l.length).toBeLessThanOrEqual(20)
    expect(out).toContain('█')
    expect(out).not.toContain('\x1b[')
  })
})

describe('heatmap', () => {
  test('--actual: a 0 7 job that really fired at 09:00 lands in the 09 column', () => {
    // The point of --actual: the schedule says 07, the ledger says 09.
    const out = formatHeatmap(
      heatOf([new Date(2026, 8, 30, 9, 12)]),
      plain,
      'actual',
    )
    const wed = out.split('\n').find((l) => l.startsWith('wed')) ?? ''
    expect(wed.slice(5)).toBe(`${'·'.repeat(9)}█${'·'.repeat(14)}`)
  })

  test('narrow width merges hours into buckets instead of wrapping a day', () => {
    const out = formatHeatmap(
      heatOf([new Date(2026, 8, 30, 9, 0)]),
      { width: 16, color: false },
      't',
    )
    const wed = out.split('\n').find((l) => l.startsWith('wed')) ?? ''
    expect(wed.length).toBe(5 + 6)
    expect(out).toContain('4h per column')
  })

  test('color only when allowed', () => {
    const heat = heatOf([new Date(2026, 8, 30, 9, 0)])
    expect(formatHeatmap(heat, { width: 80, color: true }, 't')).toContain(
      '\x1b[',
    )
    expect(formatHeatmap(heat, plain, 't')).not.toContain('\x1b[')
  })
})

describe('toIcs', () => {
  test('one VEVENT per fire, CRLF, escaped TEXT, lines within 75 octets', () => {
    const fires = upcomingFires([desk('a,b', { t: ['0 12 * * *'] })], NOW, 2)
    const ics = toIcs(fires, NOW)
    expect(ics.endsWith('\r\n')).toBe(true)
    const lines = ics.split('\r\n').filter(Boolean)
    expect(lines[0]).toBe('BEGIN:VCALENDAR')
    expect(lines.at(-1)).toBe('END:VCALENDAR')
    expect(lines.filter((l) => l === 'BEGIN:VEVENT').length).toBe(fires.length)
    expect(lines).toContain(
      `DTSTART:${fires[0].at.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`,
    )
    expect(lines).toContain('SUMMARY:a\\,b/t')
    for (const l of lines)
      expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75)
  })
})

describe('analytics', () => {
  test('outcomeOf reads the run result JSON and the first error line', () => {
    expect(outcomeOf(LEDGER[0]).kind).toBe('ran')
    expect(outcomeOf(LEDGER[2])).toEqual({
      kind: 'fail',
      cause: 'herdr socket gone',
    })
    expect(outcomeOf(LEDGER[3])).toEqual({
      kind: 'skip',
      cause: 'repo not open in Herdr',
    })
  })

  test('rollup: skips are not attempts, so they do not lower the rate', () => {
    const since = new Date(parseSince('30d', NOW.getTime()))
    const r = rollup(
      LEDGER,
      [sess('claude', '2026-09-29T00:00:00Z')],
      since,
      NOW,
    )
    expect(r.total).toBe(5)
    expect(r.rate).toBeCloseTo(2 / 3)
    const triage = r.jobs.find((j) => j.job === 'a/triage')
    const wrap = r.jobs.find((j) => j.job === 'a/wrap')
    expect(triage).toMatchObject({ ran: 2, failed: 1, skipped: 0 })
    expect(wrap?.rate).toBeNull()
    expect(r.skipCauses).toEqual([['repo not open in Herdr', 2]])
    expect(r.failCauses).toEqual([['herdr socket gone', 1]])
    expect(r.agents).toEqual([['claude', 1]])
  })

  test('format degrades to one line per job when the table is too wide', () => {
    const r = rollup(
      LEDGER,
      [],
      new Date(parseSince('30d', NOW.getTime())),
      NOW,
    )
    const wide = formatAnalytics(r, plain)
    expect(wide).toContain('| JOB')
    const narrow = formatAnalytics(r, { width: 30, color: false })
    expect(narrow).not.toContain('| JOB')
    for (const l of narrow.split('\n').slice(1))
      expect(l.length).toBeLessThanOrEqual(30)
  })

  test('long causes wrap in full, so errors differing late stay distinct', () => {
    const base =
      'EISDIR: illegal operation on a directory, open /home/u/project/x'
    const r = rollup(
      [run('t', false, `${base}/a.json`), run('t', false, `${base}/b.json`)],
      [],
      new Date(parseSince('30d', NOW.getTime())),
      NOW,
    )
    const out = formatAnalytics(r, { width: 40, color: false })
    for (const l of out.split('\n').slice(1))
      expect(l.length).toBeLessThanOrEqual(40)
    expect(out.replace(/\n +/g, '')).toContain('x/a.json')
    expect(out.replace(/\n +/g, '')).toContain('x/b.json')
    const wide = formatAnalytics(r, { width: 40, color: false }, true)
    expect(wide).toContain(`${base}/a.json`)
  })
})

describe('formatBoard', () => {
  const since = new Date(parseSince('30d', NOW.getTime()))
  const html = formatBoard({
    now: NOW,
    days: 7,
    fires: upcomingFires([desk('a', { triage: ['0 12 * * *'] })], NOW),
    runs: [...LEDGER, run('x', false, '<script>alert(1)</script>')],
    rollup: rollup(LEDGER, [], since, NOW),
    sessions: [sess('codex', '2026-09-29T01:00:00Z')],
  })

  test('renders with no network: no script, no external href/src', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/(href|src)=["']?https?:/i)
    expect(html).toContain('&lt;script&gt;')
  })

  test('has the slot grid, recent runs with status, rates, and sessions', () => {
    expect(html).toContain('12:00 a/triage')
    expect(html).toContain('<span class="st fail">fail</span>')
    expect(html).toContain('<span class="st skip">skip</span>')
    expect(html).toContain('67%')
    expect(html).toContain('<h2>Sessions</h2>')
  })

  test('a dense job is one range entry per day, not one per fire', () => {
    const dense = formatBoard({
      now: NOW,
      days: 1,
      fires: upcomingFires([desk('a', { poll: ['*/30 * * * *'] })], NOW, 1),
      runs: [],
      rollup: rollup([], [], since, NOW),
      sessions: [],
    })
    expect(dense.match(/class="fire"/g)?.length).toBe(1)
    expect(dense).toContain('10:30-23:30 x27 a/poll')
  })

  test('no sessions section when there is no index', () => {
    const bare = formatBoard({
      now: NOW,
      days: 7,
      fires: [],
      runs: [],
      rollup: rollup([], [], since, NOW),
      sessions: [],
    })
    expect(bare).not.toContain('<h2>Sessions</h2>')
    expect(bare).toContain('No fires scheduled.')
  })
})
