import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeReader } from './sessions/claude'
import { codexReader } from './sessions/codex'
import { contextPath, renderContext, writeContext } from './sessions/context'
import { deskReader } from './sessions/desk'
import { geminiReader } from './sessions/gemini'
import { grokReader } from './sessions/grok'
import {
  filterSessions,
  formatSessions,
  gitRoot,
  indexSessions,
  loadSessions,
  type SessionRow,
  sessionsPath,
} from './sessions/index'
import { titleLine } from './sessions/types'
import { parseSince } from './since'

const FIXTURES = join(import.meta.dir, 'sessions', 'fixtures')
// Strings that only appear in message bodies or model-written summaries.
const BODIES = [
  'SECRET BODY LINE',
  'ASSISTANT BODY',
  'TOOL BODY',
  'ENV BODY',
  'CODEX BODY',
  'GROK SUMMARY BODY',
  'GROK TURN BODY',
  'and its tests',
]

let tmp: string
let home: string
let stateDir: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'desk-sessions-'))
  home = join(tmp, 'home')
  stateDir = join(tmp, 'state')
  cpSync(join(FIXTURES, 'home'), home, { recursive: true })
  cpSync(join(FIXTURES, 'state'), stateDir, { recursive: true })
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function parseOne(reader: typeof claudeReader, rel: string): SessionRow[] {
  const path = join(home, rel)
  return reader.parse(path, readFileSync(path, 'utf8'))
}

describe('readers', () => {
  test('claude: first real prompt line, skipping meta, commands and tool results', () => {
    const [r] = parseOne(claudeReader, '.claude/projects/-work-alpha/c-1.jsonl')
    expect(r).toMatchObject({
      agent: 'claude',
      id: 'c-1',
      cwd: '/work/alpha',
      started: '2026-09-29T08:00:00.000Z',
      ended: '2026-09-29T08:31:00.000Z',
      title: 'Fix the flaky login test',
    })
  })

  test('claude: an ai-title record wins over the first prompt', () => {
    const rows = claudeReader.parse(
      '/x.jsonl',
      [
        '{"type":"user","sessionId":"s","timestamp":"2026-01-01T00:00:00Z","message":{"content":"long prompt"}}',
        '{"type":"ai-title","sessionId":"s","aiTitle":"Short title"}',
      ].join('\n'),
    )
    expect(rows[0].title).toBe('Short title')
  })

  test('claude: a file with no session id throws so the indexer can skip it', () => {
    expect(() => claudeReader.parse('/x.jsonl', 'not json\n')).toThrow()
  })

  test('codex: id and cwd from session_meta, title from the first user_message', () => {
    const [r] = parseOne(
      codexReader,
      '.codex/sessions/2026/09/29/rollout-x.jsonl',
    )
    expect(r).toMatchObject({
      agent: 'codex',
      id: 'x-1',
      cwd: '/work/alpha',
      started: '2026-09-29T09:00:00.000Z',
      ended: '2026-09-29T10:15:00.000Z',
      title: 'Bump the deps and open a PR',
    })
  })

  test('gemini: one row per sessionId, keyed by the project hash dir', () => {
    const rows = geminiReader.list(home, stateDir)
    expect(rows).toHaveLength(1)
    const [r] = geminiReader.parse(rows[0], readFileSync(rows[0], 'utf8'))
    expect(r).toMatchObject({
      agent: 'gemini',
      id: 'm-1',
      projectHash:
        '017094432d2c0fa9e513bc92fcaa73c82a31edb49508616674baa758e7715797',
      title: 'Explain the cron parser',
      ended: '2026-09-27T10:05:00.000Z',
    })
  })

  test('grok: generated title and git root, never the summary prose', () => {
    const [path] = grokReader.list(home, stateDir)
    const [r] = grokReader.parse(path, readFileSync(path, 'utf8'))
    expect(r).toMatchObject({
      agent: 'grok',
      id: 'g-1',
      cwd: '/work/alpha',
      started: '2026-09-28T07:00:00.000Z',
      ended: '2026-09-28T07:40:00.000Z',
      title: 'Triage open issues',
    })
  })

  test('desk: one row per ledger record', () => {
    const [path] = deskReader.list(home, stateDir)
    const rows = deskReader.parse(path, readFileSync(path, 'utf8'))
    expect(rows.map((r) => r.title)).toEqual([
      'github-issues ok',
      'deps failed: no agent',
    ])
  })

  test('titles are capped at 80 chars', () => {
    const long = 'word '.repeat(100)
    const [r] = codexReader.parse(
      '/r.jsonl',
      [
        `{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"id":"i","cwd":"/w"}}`,
        `{"timestamp":"2026-01-01T00:00:00Z","type":"event_msg","payload":{"type":"user_message","message":"${long}"}}`,
      ].join('\n'),
    )
    expect(r.title.length).toBe(80)
  })
})

describe('titleLine', () => {
  test('keeps one line and redacts obvious secrets from prompt text', () => {
    const t = titleLine(
      'use sk-proj-abcDEF123456 and ghp_abcdefghij0123456789 then abcdef0123456789abcdef0123456789abcdef\nsecond line',
    )
    expect(t).toBe('use [redacted] and [redacted] then [redacted]')
  })

  test('ordinary words and paths survive', () => {
    expect(titleLine('Fix src/sessions/index.ts for PR #54')).toBe(
      'Fix src/sessions/index.ts for PR #54',
    )
  })
})

describe('indexSessions', () => {
  test('indexes every agent, skips the unparseable file, copies no bodies', () => {
    const stats = indexSessions({ home, stateDir })
    expect(stats.found).toEqual({
      claude: 2,
      codex: 1,
      gemini: 1,
      grok: 1,
      desk: 1,
    })
    expect(stats.skipped).toEqual({ claude: 1 })
    expect(stats.read).toBe(6)
    const rows = loadSessions(stateDir)
    expect(rows.map((r) => `${r.agent}:${r.id}`).sort()).toEqual([
      'claude:c-1',
      'codex:x-1',
      'desk:2026-09-29T07:00:00.000Z:github-issues',
      'desk:2026-09-29T11:00:00.000Z:deps',
      'gemini:m-1',
      'grok:g-1',
    ])
    // the gemini hash resolves through the cwd other agents reported
    expect(rows.find((r) => r.agent === 'gemini')?.repo).toBe('/work/alpha')
    const raw = readFileSync(sessionsPath(stateDir), 'utf8')
    for (const body of BODIES) expect(raw).not.toContain(body)
  })

  test('a second run over unchanged files reads zero files', () => {
    indexSessions({ home, stateDir })
    const again = indexSessions({ home, stateDir })
    expect(again.read).toBe(0)
    expect(again.unchanged).toBe(6)
    expect(again.rows).toBe(6)
  })

  test('only a changed file is re-read', () => {
    indexSessions({ home, stateDir })
    appendFileSync(
      join(home, '.codex/sessions/2026/09/29/rollout-x.jsonl'),
      '{"timestamp":"2026-09-29T12:00:00.000Z","type":"event_msg","payload":{"type":"agent_message","message":"later"}}\n',
    )
    const again = indexSessions({ home, stateDir })
    expect(again.read).toBe(1)
    const codex = loadSessions(stateDir).find((r) => r.agent === 'codex')
    expect(codex?.ended).toBe('2026-09-29T12:00:00.000Z')
  })

  test('a deleted source drops its rows', () => {
    indexSessions({ home, stateDir })
    rmSync(join(home, '.grok'), { recursive: true })
    indexSessions({ home, stateDir })
    expect(loadSessions(stateDir).some((r) => r.agent === 'grok')).toBe(false)
  })

  test('an agent with no data dir is found 0 times, not an error', () => {
    rmSync(join(home, '.gemini'), { recursive: true })
    expect(indexSessions({ home, stateDir }).found.gemini).toBe(0)
  })
})

describe('filters', () => {
  const rows: SessionRow[] = [
    {
      agent: 'claude',
      id: 'a',
      repo: '/work/alpha',
      started: '2026-09-29T08:00:00Z',
      ended: '2026-09-29T09:00:00Z',
      title: 'a',
      path: '/a',
    },
    {
      agent: 'codex',
      id: 'b',
      repo: '/work/alpha',
      started: '2026-09-20T08:00:00Z',
      ended: '2026-09-20T08:10:00Z',
      title: 'b',
      path: '/b',
    },
    {
      agent: 'codex',
      id: 'c',
      repo: '/work/beta',
      started: '2026-09-29T08:00:00Z',
      ended: '2026-09-29T08:05:00Z',
      title: 'c',
      path: '/c',
    },
  ]
  const now = Date.parse('2026-09-30T00:00:00Z')

  test('--repo, --agent and --since combine', () => {
    const ids = (f: Parameters<typeof filterSessions>[1]) =>
      filterSessions(rows, f).map((r) => r.id)
    expect(ids({ repo: '/work/alpha' })).toEqual(['a', 'b'])
    expect(ids({ agent: 'codex' })).toEqual(['b', 'c'])
    expect(ids({ since: parseSince('7d', now) })).toEqual(['a', 'c'])
    expect(
      ids({
        repo: '/work/alpha',
        agent: 'codex',
        since: parseSince('7d', now),
      }),
    ).toEqual([])
  })

  test('the table shows When, Agent, Repo, Length, Title', () => {
    const out = formatSessions(rows)
    expect(out.split('\n')[0]).toMatch(/When .*Agent .*Repo .*Length .*Title/)
    expect(out).toContain('| 1h00m ')
    expect(out).toContain('| alpha ')
  })
})

describe('gitRoot', () => {
  test('a linked worktree resolves to its main checkout', () => {
    const main = join(tmp, 'main')
    const wt = join(tmp, 'wt', 'sub')
    mkdirSync(join(main, '.git', 'worktrees', 'wt'), { recursive: true })
    mkdirSync(wt, { recursive: true })
    writeFileSync(
      join(tmp, 'wt', '.git'),
      `gitdir: ${join(main, '.git', 'worktrees', 'wt')}\n`,
    )
    expect(gitRoot(wt)).toBe(main)
    expect(gitRoot(join(main))).toBe(main)
  })
})

describe('context', () => {
  test('a repo with Claude and Codex sessions gets both, newest first, no bodies', () => {
    indexSessions({ home, stateDir })
    const { path, text } = writeContext(
      '/work/alpha',
      loadSessions(stateDir),
      stateDir,
    )
    expect(path).toBe(contextPath('/work/alpha', stateDir))
    expect(path.endsWith('context/work-alpha.md')).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(text)
    const codex = text.indexOf('Bump the deps')
    const claude = text.indexOf('Fix the flaky login test')
    expect(codex).toBeGreaterThan(-1)
    expect(claude).toBeGreaterThan(codex)
    expect(text).toContain('Triage open issues')
    expect(text).toContain('Explain the cron parser')
    expect(text).toContain('github-issues ok')
    // the beta repo's run is not this repo's history
    expect(text).not.toContain('deps failed')
    for (const body of BODIES) expect(text).not.toContain(body)
  })

  test('caps the list at 20 sessions', () => {
    const many: SessionRow[] = Array.from({ length: 30 }, (_, i) => ({
      agent: 'claude',
      id: `s${i}`,
      repo: '/r',
      started: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      ended: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      title: `t${i}`,
      path: `/p${i}`,
    }))
    const text = renderContext('/r', many)
    expect(text.match(/ · claude · /g)).toHaveLength(20)
    expect(text).toContain('t29')
    expect(text).not.toContain('· t9\n')
  })
})
