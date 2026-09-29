import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { LoadedDesk } from './config'
import type { Discovered } from './discover'
import { formatAgenda, upcomingFires } from './timeline'

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
