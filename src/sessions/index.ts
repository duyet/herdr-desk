import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pluginStateDir } from '../paths'
import { textTable } from '../table'
import { claudeReader } from './claude'
import { codexReader } from './codex'
import { deskReader } from './desk'
import { geminiReader } from './gemini'
import { grokReader } from './grok'
import type { AgentName, SessionReader, SessionRow } from './types'

export type { AgentName, SessionRow } from './types'

export const READERS: SessionReader[] = [
  claudeReader,
  codexReader,
  geminiReader,
  grokReader,
  deskReader,
]

type FileStamp = { agent: AgentName; mtimeMs: number; size: number }
type Store = { files: Record<string, FileStamp>; rows: SessionRow[] }

export type IndexStats = {
  /** Files parsed this run (new or changed since the last index). */
  read: number
  /** Files whose mtime and size matched, so their cached rows were kept. */
  unchanged: number
  /** Files a reader could not understand, per agent. */
  skipped: Partial<Record<AgentName, number>>
  /** Source files found per agent, including agents with none. */
  found: Record<AgentName, number>
  rows: number
}

export function sessionsPath(stateDir = pluginStateDir()): string {
  return join(stateDir, 'sessions.jsonl')
}

function filesPath(stateDir: string): string {
  return join(stateDir, 'sessions-files.json')
}

export function loadSessions(stateDir = pluginStateDir()): SessionRow[] {
  const p = sessionsPath(stateDir)
  if (!existsSync(p)) return []
  const rows: SessionRow[] = []
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      // a hand-edited or torn index line; the next `index` rewrites the file
    }
  }
  return rows
}

function loadStore(stateDir: string): Store {
  let files: Record<string, FileStamp> = {}
  try {
    files = JSON.parse(readFileSync(filesPath(stateDir), 'utf8'))
  } catch {
    // no stamps yet: every file counts as new
  }
  return { files, rows: loadSessions(stateDir) }
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}

/**
 * Build or refresh `sessions.jsonl`. A file whose mtime and size are unchanged
 * keeps its cached rows and is not opened; a file a reader throws on is
 * counted in `skipped` and remembered, so it is not retried until it changes.
 */
export function indexSessions(
  opts: { home?: string; stateDir?: string; readers?: SessionReader[] } = {},
): IndexStats {
  const home = opts.home ?? homedir()
  const stateDir = opts.stateDir ?? pluginStateDir()
  const readers = opts.readers ?? READERS
  const prev = loadStore(stateDir)
  const cached = new Map<string, SessionRow[]>()
  for (const r of prev.rows)
    cached.set(r.path, [...(cached.get(r.path) ?? []), r])

  const stats: IndexStats = {
    read: 0,
    unchanged: 0,
    skipped: {},
    found: { claude: 0, codex: 0, gemini: 0, grok: 0, desk: 0 },
    rows: 0,
  }
  const files: Record<string, FileStamp> = {}
  let rows: SessionRow[] = []

  for (const reader of readers) {
    for (const path of reader.list(home, stateDir)) {
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(path)
      } catch {
        continue
      }
      stats.found[reader.agent]++
      const stamp = { agent: reader.agent, mtimeMs: st.mtimeMs, size: st.size }
      files[path] = stamp
      const old = prev.files[path]
      if (old && old.mtimeMs === stamp.mtimeMs && old.size === stamp.size) {
        stats.unchanged++
        rows.push(...(cached.get(path) ?? []))
        continue
      }
      stats.read++
      try {
        rows.push(...reader.parse(path, readFileSync(path, 'utf8')))
      } catch {
        stats.skipped[reader.agent] = (stats.skipped[reader.agent] ?? 0) + 1
      }
    }
  }

  rows = resolveRepos(rows)
  rows.sort((a, b) => Date.parse(b.ended) - Date.parse(a.ended))
  stats.rows = rows.length

  mkdirSync(stateDir, { recursive: true })
  writeAtomic(
    sessionsPath(stateDir),
    rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''),
  )
  writeAtomic(filesPath(stateDir), JSON.stringify(files))
  return stats
}

/**
 * Fill `repo` from `cwd` (walked up to its git root) and, for Gemini, from a
 * project hash matched against every cwd and root the other agents reported.
 */
function resolveRepos(rows: SessionRow[]): SessionRow[] {
  const memo = new Map<string, string | null>()
  const root = (cwd: string) => {
    if (!memo.has(cwd)) memo.set(cwd, gitRoot(cwd))
    return memo.get(cwd) ?? null
  }
  const byHash = new Map<string, string>()
  for (const r of rows) {
    if (!r.cwd) continue
    const repo = root(r.cwd)
    r.repo = repo
    for (const p of [r.cwd, repo]) {
      if (p) byHash.set(createHash('sha256').update(p).digest('hex'), repo ?? p)
    }
  }
  for (const r of rows) {
    if (r.projectHash && !r.repo) r.repo = byHash.get(r.projectHash) ?? null
  }
  return rows
}

/**
 * The repo a path belongs to. A linked worktree (`.git` is a file pointing at
 * `<main>/.git/worktrees/<name>`) resolves to its main checkout, so a session
 * in a child worktree counts toward the repo it works on. A path that no longer
 * exists, or is not in a repo, resolves to itself.
 */
export function gitRoot(cwd: string): string | null {
  let dir = resolve(cwd)
  if (!existsSync(dir)) return dir
  for (;;) {
    const dotGit = join(dir, '.git')
    if (existsSync(dotGit)) {
      try {
        if (statSync(dotGit).isFile()) {
          const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))
          const gitdir = m ? resolve(dir, m[1].trim()) : ''
          const at = gitdir.lastIndexOf(`${join('.git', 'worktrees')}`)
          if (at > 0) return dirname(gitdir.slice(0, at + 4))
        }
      } catch {
        // unreadable .git file: treat the dir itself as the root
      }
      return dir
    }
    const up = dirname(dir)
    if (up === dir) return resolve(cwd)
    dir = up
  }
}

export type SessionFilter = {
  repo?: string
  agent?: string
  /** Only sessions that ended at or after this epoch ms. */
  since?: number
}

export function filterSessions(
  rows: SessionRow[],
  f: SessionFilter,
): SessionRow[] {
  const repo = f.repo ? (gitRoot(f.repo) ?? resolve(f.repo)) : undefined
  return rows.filter(
    (r) =>
      (!repo || r.repo === repo) &&
      (!f.agent || r.agent === f.agent) &&
      (f.since === undefined || Date.parse(r.ended) >= f.since),
  )
}

/** `7d`, `12h`, `30m` → epoch ms that long before `now`; null when invalid. */
export function parseSince(text: string, now = Date.now()): number | null {
  const m = /^(\d+)([dhm])$/.exec(text.trim())
  if (!m) return null
  const unit = { d: 86_400_000, h: 3_600_000, m: 60_000 }[
    m[2] as 'd' | 'h' | 'm'
  ]
  return now - Number(m[1]) * unit
}

export function formatDuration(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000))
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  return `${h}h${String(min % 60).padStart(2, '0')}m`
}

export function localStamp(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function sessionLength(r: SessionRow): string {
  return r.agent === 'desk'
    ? '-'
    : formatDuration(Date.parse(r.ended) - Date.parse(r.started))
}

export function formatSessions(rows: SessionRow[], limit = 40): string {
  if (!rows.length) return 'no sessions (run `herdr-desk sessions index`)'
  const cut = (s: string, n: number) =>
    s.length > n ? `${s.slice(0, n - 1)}…` : s
  return textTable(
    ['When', 'Agent', 'Repo', 'Length', 'Title'],
    rows
      .slice(0, limit)
      .map((r) => [
        localStamp(r.ended),
        r.agent,
        r.repo ? basename(r.repo) : '?',
        sessionLength(r),
        cut(r.title, 70),
      ]),
  )
}

export function formatIndexStats(
  s: IndexStats,
  stateDir = pluginStateDir(),
): string {
  const found = (Object.keys(s.found) as AgentName[])
    .map((a) => `${a} ${s.found[a]}`)
    .join(', ')
  const skipped = Object.entries(s.skipped)
    .map(([a, n]) => `${a} ${n}`)
    .join(', ')
  return [
    `indexed ${s.rows} session(s) → ${sessionsPath(stateDir)}`,
    `files: ${found}`,
    `read ${s.read}, unchanged ${s.unchanged}${skipped ? `, skipped (unparseable) ${skipped}` : ''}`,
  ].join('\n')
}
