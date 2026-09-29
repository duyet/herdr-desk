import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { loadDeskConfig } from './config'
import {
  collectReports,
  fingerprint,
  isLevel,
  type JobReport,
  MAX_ITEMS_PER_JOB,
  MAX_JOBS,
  parseReport,
  renderMerged,
  reportPath,
  worstLevel,
} from './report'
import { runDirFor } from './run'

const DAY = '2026-09-28'

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
    const many = Array.from({ length: MAX_JOBS + 2 }, (_, i) =>
      job({ task: `t${i}`, items: ['a', 'b', 'c', 'd', 'e', 'f'] }),
    )
    const body = renderMerged(many)
    expect(body).toContain('  • … \\+2 more')
    expect(body).toContain('• … \\+2 more jobs')
    expect(body).not.toMatch(/[^\\]\+\d/)
  })

  test('one job renders as a single readable block', () => {
    const body = renderMerged([
      job({
        task: 'desk:github-issues',
        headline: '3 PRs merged',
        items: ['PR #418 merged'],
      }),
    ])
    expect(body).toBe(
      [
        '🟢 ok 1 job · 1 ok',
        // `-` and `#` are reserved in MarkdownV2 and arrive escaped; `:` is
        // not, so the job id keeps its colon. Telegram renders each escape as
        // the plain character, so this is the text the reader actually sees.
        '• desk:github\\-issues — 3 PRs merged',
        '  • PR \\#418 merged',
        '#ok #desk',
      ].join('\n'),
    )
  })

  test('parallel jobs merge into one message, not one each', () => {
    const body = renderMerged([
      job({
        task: 'desk:github-issues',
        level: 'ok',
        headline: '3 PRs merged',
      }),
      job({
        task: 'local:deps',
        level: 'blocked',
        headline: 'upgrade needs a human',
      }),
    ])
    // One message, one dot, one tag line — and both jobs visible inside it.
    expect(body).toBe(
      [
        '🟠 blocked 2 jobs · 1 ok · 1 blocked',
        '• desk:github\\-issues — 3 PRs merged',
        '• local:deps — upgrade needs a human',
        '#blocked #desk',
      ].join('\n'),
    )
  })

  test('escapes text an agent wrote, so a title cannot 400 the notice', () => {
    // `fix *auth* in _middleware_` unescaped makes Telegram reject the whole
    // message. Notice would then retry as plain text, silently losing the
    // formatting instead of the notice — so escape here, once.
    const body = renderMerged([
      job({
        task: 'desk:github-issues',
        headline: 'fix *auth* race',
        items: ['a_b.c'],
      }),
    ])
    expect(body).toContain('fix \\*auth\\* race')
    expect(body).toContain('a\\_b\\.c')
  })

  test('links from every job are collected, and capped', () => {
    const body = renderMerged([
      job({
        task: 'desk:github-issues',
        links: [['PR #1', 'https://example.com/1']],
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
    expect(lines).toHaveLength(5)
  })

  test('a long job is summarised rather than pasted', () => {
    const items = Array.from(
      { length: MAX_ITEMS_PER_JOB + 3 },
      (_, i) => `item ${i}`,
    )
    const body = renderMerged([job({ task: 'desk:github-issues', items })])
    expect(body).toContain(`… \\+3 more`)
    expect(body.split('\n').filter((l) => l.startsWith('  • ')).length).toBe(
      MAX_ITEMS_PER_JOB + 1,
    )
  })

  test('more jobs than fit are counted, not dropped silently', () => {
    const body = renderMerged(
      Array.from({ length: MAX_JOBS + 2 }, (_, i) =>
        job({ task: `local:j${i}` }),
      ),
    )
    expect(body).toContain('• … \\+2 more jobs')
  })

  test('no reports render as nothing at all', () => {
    expect(renderMerged([])).toBe('')
  })
})

describe('fingerprint', () => {
  test('identical merged bodies collide, changed ones do not', () => {
    // This is the whole dedupe: two managers that merge to the same text must
    // produce the same hash, or the second notice is a duplicate.
    expect(fingerprint('a')).toBe(fingerprint('a'))
    expect(fingerprint('a')).not.toBe(fingerprint('b'))
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
