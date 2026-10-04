import { afterEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { loadDeskConfig } from './config'
import { markRunning } from './hub'
import { MAX_BODY, type NotifyConfig, type notify } from './notify'
import {
  collectReports,
  fingerprint,
  formatDuration,
  formatNext,
  isLevel,
  type JobReport,
  MAX_JOBS,
  parseReport,
  type ReportGroup,
  renderMerged,
  reportPath,
  sendReports,
  worstLevel,
} from './report'
import { runDirFor } from './run'

const DAY = '2026-09-28'

// Thu 2026-10-01 07:00 local, built like timeline.test.ts so the snapshot does
// not depend on the machine's zone.
const NEXT = new Date(2026, 9, 1, 7, 0)

const roots: string[] = []
let savedConfigDir: string | undefined

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `herdr-desk-report-${prefix}-`))
  roots.push(dir)
  return dir
}

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
}

afterEach(() => {
  while (roots.length)
    rmSync(roots.pop() as string, { recursive: true, force: true })
  if (savedConfigDir === undefined) delete process.env.HERDR_PLUGIN_CONFIG_DIR
  else process.env.HERDR_PLUGIN_CONFIG_DIR = savedConfigDir
  savedConfigDir = undefined
})

function job(over: Partial<JobReport> & { task: string }): JobReport {
  return {
    level: 'ok',
    headline: 'nothing to report',
    items: [],
    links: [],
    tags: [],
    ...over,
  }
}

describe('parseReport', () => {
  test('reads the small block a manager writes', () => {
    const got = parseReport(
      [
        'level: ok',
        '3 PRs merged, 1 still in review',
        '- PR #418 merged',
        '- #412 filed',
        '- [changes.md](https://example.com/run/changes.md)',
        '#deps',
      ].join('\n'),
    )
    expect(got).toEqual({
      level: 'ok',
      headline: '3 PRs merged, 1 still in review',
      items: ['PR #418 merged', '#412 filed'],
      links: [['changes.md', 'https://example.com/run/changes.md']],
      tags: ['deps'],
    })
  })

  test('an absent or unknown level is info, never a throw', () => {
    // The file is written by an agent. A typo must degrade the dot, not lose
    // the whole run report.
    expect(parseReport('level: wobbly\ndid a thing')?.level).toBe('info')
    expect(parseReport('did a thing')?.level).toBe('info')
    expect(isLevel('wobbly')).toBe(false)
    expect(isLevel('blocked')).toBe(true)
  })

  test('an empty file is no report, not an empty notice', () => {
    // A notice with no content still pings the channel, so silence has to be
    // representable as "nothing to send".
    expect(parseReport('')).toBeNull()
    expect(parseReport('\n\n  \n')).toBeNull()
  })

  test('a fragment that opens with a bullet still gets a headline', () => {
    const got = parseReport('level: skip\n- nothing to do this week')
    expect(got?.headline).toBe('nothing to do this week')
    expect(got?.items).toEqual([])
  })
})

describe('worstLevel', () => {
  test('one bad job colours the merged notice', () => {
    // The dot is the only thing a phone glance reads, so the worst fragment
    // has to win — otherwise a failed job hides behind two green ones.
    expect(worstLevel(['ok', 'fail', 'ok'])).toBe('fail')
    expect(worstLevel(['ok', 'blocked'])).toBe('blocked')
    expect(worstLevel(['skip', 'info'])).toBe('skip')
    expect(worstLevel([])).toBe('ok')
  })
})

describe('renderMerged', () => {
  test('overflow markers are escaped for MarkdownV2', () => {
    // `+` is reserved; a bare `+2 more` makes Telegram reject the notice.
    // Items are not rendered, so the only overflow is hidden jobs, and its
    // `+` stays escaped.
    const many = Array.from({ length: MAX_JOBS + 2 }, (_, i) =>
      job({ task: `t${i}`, items: ['a', 'b', 'c', 'd', 'e', 'f'] }),
    )
    const body = renderMerged(many)
    expect(body).not.toContain('  • … \\+2 more')
    expect(body).toContain('• … \\+2 more jobs')
    expect(body).not.toMatch(/[^\\]\+\d/)
  })

  const pr = (n: number): [string, string] => [
    `PR #${n}`,
    `https://github.com/o/aidr/pull/${n}`,
  ]

  test('ok: one fixed verdict line, then headline and one link', () => {
    const body = renderMerged([
      job({
        task: 'desk:github-issues',
        repo: 'aidr',
        agent: 'grok',
        durationMs: 12 * 60_000,
        nextAt: NEXT,
        headline: '2 PRs merged',
        items: ['#412 filed'],
        links: [
          pr(418),
          pr(419),
          ['#412', 'https://github.com/o/aidr/issues/412'],
        ],
      }),
    ])
    expect(body).toBe(
      [
        // `-` and `#` are reserved in MarkdownV2 and arrive escaped; `:` is
        // not. Telegram renders each escape as the plain character. Next
        // fire, the issue count, and the play-by-play are not the insight.
        // One pull link: the first, not the issue.
        '🟢 *ok* aidr/desk:github\\-issues · grok · 12m · 2 PRs',
        '  2 PRs merged',
        '  • [PR \\#418](https://github.com/o/aidr/pull/418)',
        '#ok #desk',
      ].join('\n'),
    )
  })

  test('fail: same shape, unknown fields left out rather than guessed', () => {
    const body = renderMerged([
      job({
        task: 'local:prod',
        level: 'fail',
        repo: 'chmonitor',
        agent: 'claude',
        durationMs: 65 * 60_000,
        headline: 'deploy check failed',
      }),
    ])
    expect(body).toBe(
      [
        '🔴 *fail* chmonitor/local:prod · claude · 1h05m',
        '  deploy check failed',
        '#fail #desk',
      ].join('\n'),
    )
  })

  test('blocked: parallel jobs merge into one message with a count line', () => {
    const body = renderMerged([
      job({
        task: 'desk:github-issues',
        repo: 'aidr',
        agent: 'grok',
        nextAt: NEXT,
        headline: '3 PRs merged',
      }),
      job({
        task: 'local:deps',
        level: 'blocked',
        repo: 'aidr',
        agent: 'grok',
        durationMs: 30_000,
        nextAt: NEXT,
        headline: 'upgrade needs a human',
      }),
    ])
    // One message, one tag line — and both jobs visible inside it.
    expect(body).toBe(
      [
        '🟠 *blocked* 2 jobs · 1 ok · 1 blocked',
        '🟢 *ok* aidr/desk:github\\-issues · grok',
        '  3 PRs merged',
        '🟠 *blocked* aidr/local:deps · grok · <1m',
        '  upgrade needs a human',
        '#blocked #desk',
      ].join('\n'),
    )
  })

  test('a busy morning stays inside the notice body cap', () => {
    // The tag line is last, so an over-long body loses `#fail` to the clip.
    // Each job still carries items, a next fire, and a second link. None of
    // that is rendered, and the tag still survives.
    const tasks = ['desk:github-issues', 'local:deps', 'local:prod']
    const body = renderMerged(
      tasks.map((task, i) =>
        job({
          task,
          level: i === 2 ? 'fail' : 'ok',
          repo: 'anyrouter',
          agent: 'grok',
          durationMs: 25 * 60_000,
          nextAt: NEXT,
          headline: 'merged the dependency bumps',
          items: ['CI green on main'],
          links: [pr(3651 + i), pr(3700 + i)],
        }),
      ),
    )
    expect(body.length).toBeLessThan(MAX_BODY)
    expect(body).not.toContain('CI green on main')
    expect(body).not.toContain('next ')
    expect(body.split('\n').pop()).toBe('#fail #desk')
  })

  test('duration and next fire are stable text', () => {
    expect(formatDuration(0)).toBe('<1m')
    expect(formatDuration(59 * 60_000)).toBe('59m')
    expect(formatDuration(125 * 60_000)).toBe('2h05m')
    expect(formatNext(NEXT)).toBe('Thu 07:00')
  })

  test('escapes text an agent wrote, so a title cannot 400 the notice', () => {
    // `fix *auth* in _middleware_` unescaped makes Telegram reject the whole
    // message. Notice would then retry as plain text, silently losing the
    // formatting instead of the notice — so escape here, once. An unescaped
    // `*` 400s the notice. Items are not the insight, so they are not rendered.
    const body = renderMerged([
      job({
        task: 'desk:github-issues',
        headline: 'fix *auth* in _middleware_',
        items: ['a_b.c'],
      }),
    ])
    expect(body).toContain('fix \\*auth\\* in \\_middleware\\_')
    expect(body).not.toContain('a_b.c')
    expect(body).not.toContain('a\\_b')
  })

  test('each job contributes at most one link', () => {
    // A merged notice cannot grow a link list. Each job shows one link: the
    // first pull if it has one, otherwise its first link, even when that
    // first link is not a pull. Two jobs with several links yield two lines.
    const body = renderMerged([
      job({
        task: 'desk:github-issues',
        links: [['#1', 'https://github.com/o/aidr/issues/1'], pr(9), pr(10)],
      }),
      job({
        task: 'local:deps',
        links: [
          ['dep a', 'https://example.com/a'],
          ['dep b', 'https://example.com/b'],
          ['dep c', 'https://example.com/c'],
          ['dep d', 'https://example.com/d'],
        ],
      }),
    ])
    const lines = body.split('\n').filter((l) => l.includes(']('))
    expect(lines).toEqual([
      '  • [PR \\#9](https://github.com/o/aidr/pull/9)',
      '  • [dep a](https://example.com/a)',
    ])
    // Both pulls on the first job count, not only the one link it shows.
    expect(body.split('\n')[0]).toContain('· 2 PRs')
  })

  test('the header counts distinct pull URLs on the shown jobs', () => {
    // The same PR linked from two jobs is one PR, not two.
    const shared = pr(7)
    const body = renderMerged([
      job({ task: 'a', links: [shared] }),
      job({ task: 'b', links: [shared] }),
    ])
    expect(body.split('\n')[0]).toBe('🟢 *ok* 2 jobs · 2 ok · 1 PR')
  })

  test('a long job is summarised rather than pasted', () => {
    // Items are the play-by-play. The headline is the insight, so none of
    // the bullets are rendered, including the old "+N more" overflow.
    const items = ['item 0', 'item 1', 'item 2', 'item 3', 'item 4', 'item 5']
    const body = renderMerged([
      job({ task: 'desk:github-issues', headline: 'shipped the fix', items }),
    ])
    for (const item of items) expect(body).not.toContain(item)
    expect(body).toContain('shipped the fix')
  })

  test('more jobs than fit are counted, not dropped silently', () => {
    // Pulls that exist only on a hidden job are not part of the notice, so
    // they do not add a PR count to the header.
    const body = renderMerged(
      Array.from({ length: MAX_JOBS + 2 }, (_, i) =>
        job({
          task: `local:j${i}`,
          links:
            i >= MAX_JOBS
              ? [['PR #1', `https://github.com/o/r/pull/${i}`]]
              : [],
        }),
      ),
    )
    expect(body).toContain('• … \\+2 more jobs')
    expect(body.split('\n')[0]).not.toContain('PR')
  })

  test('no reports render as nothing at all', () => {
    expect(renderMerged([])).toBe('')
  })
})

describe('fingerprint', () => {
  test('identical reports collide, changed ones do not', () => {
    // This is the whole dedupe: two managers that merge to the same text must
    // produce the same hash, or the second notice is a duplicate.
    expect(fingerprint([job({ task: 't' })])).toBe(
      fingerprint([job({ task: 't' })]),
    )
    expect(fingerprint([job({ task: 't' })])).not.toBe(
      fingerprint([job({ task: 't', headline: 'merged the bumps' })]),
    )
  })

  test('fields that move on their own do not change the hash', () => {
    // `nextAt` rolls with the schedule and duration changes on every re-fire
    // of the same fragment. Neither is something the manager wrote. Hashing
    // either resent a notice whose words had not changed.
    const base = { task: 't', nextAt: NEXT, durationMs: 7 * 60_000 }
    expect(fingerprint([job(base)])).toBe(
      fingerprint([
        job({
          ...base,
          nextAt: new Date(2026, 9, 1, 8, 0),
          durationMs: 9 * 60_000,
        }),
      ]),
    )
  })
})

describe('sendReports', () => {
  const dest: NotifyConfig = {
    enabled: true,
    token: 't',
    chatId: 'c',
    topicId: '',
  }
  let savedState: string | undefined

  /** The ledger lands in a throwaway state dir, never the real machine's. */
  function ledger(): void {
    savedState = process.env.HERDR_PLUGIN_STATE_DIR
    process.env.HERDR_PLUGIN_STATE_DIR = tmp('state')
  }

  /** Stand in for the notifier, keeping every body it was asked to send. */
  function recorder(): { send: typeof notify; bodies: string[] } {
    const bodies: string[] = []
    return {
      bodies,
      send: async (notice) => {
        bodies.push(notice.message)
        return { sent: true, machine: 'm', repo: notice.repo ?? '' }
      },
    }
  }

  /** One destination, one job — the shape `collectReports` hands over. */
  function groups(over: Partial<JobReport> & { task: string }): ReportGroup[] {
    return [{ dest, reports: [job(over)] }]
  }

  afterEach(() => {
    if (savedState === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR
    else process.env.HERDR_PLUGIN_STATE_DIR = savedState
    savedState = undefined
  })

  test('a schedule boundary does not resend an unchanged report', async () => {
    // 2026-10-03: three sends, one byte-identical `status.md`, only `next` moved.
    ledger()
    const { send, bodies } = recorder()
    const report = { task: 'desk:github-issues', repo: 'herdr-desk' }
    const args = { repo: '/repo', day: DAY, send }

    const [first] = await sendReports({
      ...args,
      groups: groups({ ...report, nextAt: NEXT }),
    })
    expect(first.sent).toBe(true)

    const [again] = await sendReports({
      ...args,
      groups: groups({ ...report, nextAt: new Date(2026, 9, 1, 8, 0) }),
    })
    expect(again.sent).toBe(false)
    expect(again.reason).toBe('unchanged since last notice')
    // Next is not on the notice, so the stood-down body is the same text. The
    // fingerprint still ignores `nextAt`: hashing it would send again for a
    // paragraph that did not change.
    expect(bodies).toHaveLength(1)
    expect(again.body).toBe(bodies[0])
  })

  test('a changed level sends again', async () => {
    // The direction of failure: a changed report must never be swallowed, because
    // a notice that does not arrive leaves no trace at all.
    ledger()
    const { send, bodies } = recorder()
    const args = { repo: '/repo', day: DAY, send }

    await sendReports({ ...args, groups: groups({ task: 't', level: 'ok' }) })
    const [again] = await sendReports({
      ...args,
      groups: groups({ task: 't', level: 'fail' }),
    })
    expect(again.sent).toBe(true)
    expect(bodies).toHaveLength(2)
  })

  test('a changed headline sends again', async () => {
    ledger()
    const { send, bodies } = recorder()
    const args = { repo: '/repo', day: DAY, send }

    await sendReports({
      ...args,
      groups: groups({ task: 't', headline: '3 PRs merged' }),
    })
    const [again] = await sendReports({
      ...args,
      groups: groups({ task: 't', headline: 'bumped deps' }),
    })
    expect(again.sent).toBe(true)
    expect(bodies).toHaveLength(2)
  })
})

describe('collectReports', () => {
  /** A repo with a desk config, plus a host notify.json so a destination exists. */
  function desk(config: Record<string, unknown> = { name: 'repo' }): string {
    const configDir = tmp('cfg')
    savedConfigDir = process.env.HERDR_PLUGIN_CONFIG_DIR
    process.env.HERDR_PLUGIN_CONFIG_DIR = configDir
    write(
      join(configDir, 'notify.json'),
      JSON.stringify({ token: 't', chatId: 'c' }),
    )

    const repo = tmp('repo')
    write(join(repo, '.herdr-desk.json'), JSON.stringify(config, null, 2))
    return repo
  }

  /**
   * Write a fragment where the job will actually look for it.
   *
   * The run dir is derived from the resolved config rather than reconstructed
   * here: a bundled `desk:` task uses `.herdr-desk/runs/<playbook>` while a
   * `local:` one uses a slug of its id, and a test that guesses the wrong one
   * would pass for the wrong reason.
   */
  function status(repo: string, taskId: string, body: string): void {
    const task = loadDeskConfig(repo).tasks.find((t) => t.id === taskId)
    if (!task) throw new Error(`no task ${taskId}`)
    write(reportPath(runDirFor(repo, task, DAY)), body)
  }

  test('reads every job that wrote a status, and skips the ones that did not', () => {
    const repo = desk()
    status(repo, 'desk:github-issues', 'level: ok\nmerged 2')
    const groups = collectReports({ repo, day: DAY })
    expect(groups).toHaveLength(1)
    expect(groups[0].reports.map((r) => r.task)).toEqual(['desk:github-issues'])
    expect(groups[0].reports[0].headline).toBe('merged 2')
  })

  test('fills the verdict line from stored stamps, not from the clock', () => {
    const repo = desk()
    const state = tmp('state')
    const saved = process.env.HERDR_PLUGIN_STATE_DIR
    process.env.HERDR_PLUGIN_STATE_DIR = state
    try {
      const [y, m, d] = DAY.split('-').map(Number)
      const started = new Date(y, m - 1, d, 7, 0)
      markRunning({ repo, task: 'desk:github-issues', desk: 'x', at: started })
      status(repo, 'desk:github-issues', 'level: ok\nmerged 2')
      const task = loadDeskConfig(repo).tasks[0]
      const wrote = new Date(y, m - 1, d, 7, 42)
      utimesSync(reportPath(runDirFor(repo, task, DAY)), wrote, wrote)

      const now = new Date(y, m - 1, d, 9, 0)
      const [r] = collectReports({ repo, day: DAY, now })[0].reports
      expect(r.repo).toBe(loadDeskConfig(repo).name)
      expect(r.agent).toBe(task.agent.ladder[0])
      expect(r.durationMs).toBe(42 * 60_000)
      // The default `0 7 * * *` already fired today, so next is tomorrow 07:00.
      expect(r.nextAt).toEqual(new Date(y, m - 1, d + 1, 7, 0))
      // Same inputs later in the day render the same body: dedupe holds.
      const later = collectReports({
        repo,
        day: DAY,
        now: new Date(y, m - 1, d, 11, 0),
      })[0].reports
      expect(renderMerged(later)).toBe(renderMerged([r]))
    } finally {
      if (saved === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR
      else process.env.HERDR_PLUGIN_STATE_DIR = saved
    }
  })

  test('splits jobs that are routed to different topics', () => {
    // Merging across destinations would put a job's outcome in a channel that
    // job never chose. Two topics must stay two notices.
    const repo = desk({
      name: 'repo',
      tasks: [
        { id: 'desk:github-issues' },
        { id: 'local:deps', playbook: './p.md', notify: { topicId: '7' } },
      ],
    })
    status(repo, 'desk:github-issues', 'level: ok\nmerged 2')
    status(repo, 'local:deps', 'level: ok\nbumped deps')

    const groups = collectReports({ repo, day: DAY })
    expect(groups).toHaveLength(2)
    expect(groups.map((g) => g.dest.topicId).sort()).toEqual(['', '7'])
    // Each group carries only its own job.
    expect(groups.every((g) => g.reports.length === 1)).toBe(true)
  })

  test('an invalid config surfaces rather than sending a partial notice', () => {
    // `stateDir` escaping the repo is caught by `validate`. Sending a notice
    // that silently omits a job would hide the very breakage worth knowing
    // about, so this throws and the operator sees it.
    const repo = desk({
      name: 'repo',
      tasks: [{ id: 'local:bad', playbook: './p.md', stateDir: '../outside' }],
    })
    expect(() => collectReports({ repo, day: DAY })).toThrow(/stateDir/)
  })

  test('reportPath is the file a manager is told to write', () => {
    expect(reportPath('/run')).toBe(join('/run', 'status.md'))
  })
})
