import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { LoadedDesk } from './config'
import type { Discovered } from './discover'
import { emptyPause, pauseKey, withPause } from './pause'
import {
  formatAgenda,
  formatIn,
  formatNext,
  nextFires,
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

describe('upcomingFires', () => {
  test('a daily cron that already fired today starts tomorrow: 6 fires left in the window', () => {
    // The agenda answers "what will run", so a slot that is already past today
    // must not appear — otherwise it contradicts `status`'s Next column.
    const fires = upcomingFires([desk('a', { triage: ['0 7 * * *'] })], NOW)
    expect(fires.length).toBe(6)
    expect(fires[0].at).toEqual(new Date(2026, 9, 1, 7, 0))
  })

  test('the window ends at local midnight, not at now + 7x24h', () => {
    const fires = upcomingFires([desk('a', { wrap: ['0 18 * * *'] })], NOW)
    // today 18:00 plus six more days.
    expect(fires.length).toBe(7)
    expect(fires.at(-1)?.at).toEqual(new Date(2026, 9, 6, 18, 0))
  })

  test('two crons of one job hitting the same minute fire once', () => {
    // The daemon keys its ledger per job-minute, so the agenda must too.
    const fires = upcomingFires(
      [desk('a', { t: ['0 12 * * *', '0 12 * * 1-5'] })],
      NOW,
      1,
    )
    expect(fires.length).toBe(1)
  })
})

describe('formatAgenda', () => {
  test('groups by day and flags jobs that share a slot', () => {
    const out = formatAgenda(
      [desk('a', { t: ['0 12 * * *'] }), desk('b', { t: ['0 12 * * *'] })],
      NOW,
      1,
    )
    expect(out.split('\n')[0]).toBe('Wed 2026-09-30')
    expect(out).toContain('12:00  a  t  (a-desk)  [shares slot x2]')
    expect(out).toContain('12:00  b  t  (b-desk)  [shares slot x2]')
  })

  test('a dense cron collapses to one range line per day', () => {
    const out = formatAgenda([desk('a', { poll: ['*/30 * * * *'] })], NOW, 1)
    const body = out.split('\n').slice(1)
    expect(body).toEqual(['  10:30-23:30  a  poll  (a-desk)  x27 fires'])
  })

  test('no crons in range says so', () => {
    expect(formatAgenda([], NOW)).toBe('no fires in the next 7 day(s)')
  })
})

describe('nextFires', () => {
  const desks = [
    desk('a', { triage: ['0 12 * * *'] }),
    desk('b', { wrap: ['30 10 * * *', '0 11 * * *'] }),
  ]

  test('next 3 over two desks are the three earliest fires, in order', () => {
    const got = nextFires(desks, 3, NOW)
    expect(got.map((f) => `${f.repo}/${f.job}`)).toEqual([
      'b/wrap',
      'b/wrap',
      'a/triage',
    ])
    expect(got.map((f) => f.at.getHours())).toEqual([10, 11, 12])
  })

  test('In renders hours and minutes as 2h05m', () => {
    expect(formatIn((2 * 60 + 5) * 60_000)).toBe('2h05m')
    expect(formatIn(45 * 60_000)).toBe('45m')
    expect(formatIn((26 * 60 + 3) * 60_000)).toBe('1d02h')
    const out = formatNext([desk('a', { t: ['5 12 * * *'] })], 1, NOW)
    expect(out).toContain('2h05m')
    expect(out.split('\n')[0]).toMatch(/When\s+\|\s+In\s+\|\s+Repo/)
  })
})

describe('paused jobs', () => {
  const desks = [desk('a', { triage: ['0 12 * * *'], wrap: ['0 13 * * *'] })]
  const paused = withPause(emptyPause(), pauseKey('/r/a', 'triage'))

  test('a paused job is absent from upcomingFires and next, and named in a note', () => {
    expect(upcomingFires(desks, NOW, 1, paused).map((f) => f.job)).toEqual([
      'wrap',
    ])
    expect(new Set(nextFires(desks, 5, NOW, paused).map((f) => f.job))).toEqual(
      new Set(['wrap']),
    )
    const agenda = formatAgenda(desks, NOW, 1, paused)
    expect(agenda).not.toContain('12:00')
    expect(agenda).toContain('paused:')
    expect(agenda).toContain('a  triage  paused')
  })

  test('--until lets the job back in once the pause ends', () => {
    const until = withPause(emptyPause(), 'all', new Date(2026, 9, 1, 12, 30))
    const got = upcomingFires(desks, NOW, 3, until).map((f) => f.at.getTime())
    expect(got).toEqual(
      upcomingFires(desks, NOW, 3)
        .filter((f) => f.at.getTime() >= new Date(2026, 9, 1, 13).getTime())
        .map((f) => f.at.getTime()),
    )
  })
})
