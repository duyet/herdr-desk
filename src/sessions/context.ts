import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { loadDeskConfig } from '../config'
import { pluginStateDir } from '../paths'
import { runDirFor } from '../run'
import {
  filterSessions,
  gitRoot,
  localStamp,
  type SessionRow,
  sessionLength,
} from './index'

export const CONTEXT_LIMIT = 20

/** `/home/me/project/foo` → `home-me-project-foo`. */
export function repoSlug(repo: string): string {
  return repo.replace(/[^A-Za-z0-9._]+/g, '-').replace(/^-+|-+$/g, '')
}

export function contextPath(repo: string, stateDir = pluginStateDir()): string {
  return join(stateDir, 'context', `${repoSlug(repo)}.md`)
}

/**
 * The per-repo history file any agent can read: the last `CONTEXT_LIMIT`
 * sessions across agents, newest first, plus the latest desk run and the first
 * line of its `changes.md`. Titles only; never a message body.
 */
export function renderContext(
  repo: string,
  rows: SessionRow[],
  changesLine?: string,
  now = new Date(),
): string {
  const mine = filterSessions(rows, { repo }).sort(
    (a, b) => Date.parse(b.ended) - Date.parse(a.ended),
  )
  const agentRows = mine
    .filter((r) => r.agent !== 'desk')
    .slice(0, CONTEXT_LIMIT)
  const lastRun = mine.find((r) => r.agent === 'desk')
  const out = [
    `# Recent agent history — ${repo}`,
    '',
    `_Written by herdr-desk at ${localStamp(now.toISOString())}. Titles only; open the source file for detail._`,
    '',
    '## Last desk run',
    '',
    lastRun
      ? `- ${localStamp(lastRun.ended)} · ${lastRun.title}`
      : '- none recorded',
  ]
  if (changesLine) out.push(`- changes.md: ${changesLine}`)
  out.push('', `## Last ${CONTEXT_LIMIT} sessions`, '')
  if (!agentRows.length) out.push('- none indexed')
  for (const r of agentRows) {
    out.push(
      `- ${localStamp(r.ended)} · ${r.agent} · ${sessionLength(r)} · ${r.title || '(untitled)'}`,
      `  \`${r.path}\``,
    )
  }
  return `${out.join('\n')}\n`
}

/**
 * First non-empty line of the latest `changes.md` for the desk run's job, read
 * through the job's `LATEST` pointer. Undefined when the repo has no desk
 * config or the run left no file.
 */
export function lastChangesLine(
  repo: string,
  run?: SessionRow,
): string | undefined {
  if (!run) return undefined
  try {
    const desk = loadDeskConfig(repo)
    const task = desk.tasks.find((t) => run.title.startsWith(`${t.id} `))
    if (!task) return undefined
    // `LATEST` sits beside the day dirs and holds `<task>/<day>`.
    const pointer = join(dirname(runDirFor(repo, task, 'x')), 'LATEST')
    const day = readFileSync(pointer, 'utf8').trim().split('/').pop() ?? ''
    const file = join(runDirFor(repo, task, day), 'changes.md')
    if (!existsSync(file)) return undefined
    return readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0)
  } catch {
    return undefined
  }
}

export function writeContext(
  repoDir: string,
  rows: SessionRow[],
  stateDir = pluginStateDir(),
): { path: string; text: string } {
  const repo = gitRoot(repoDir) ?? resolve(repoDir)
  const run = filterSessions(rows, { repo, agent: 'desk' })[0]
  const text = renderContext(repo, rows, lastChangesLine(repo, run))
  const path = contextPath(repo, stateDir)
  mkdirSync(join(stateDir, 'context'), { recursive: true })
  writeFileSync(path, text)
  return { path, text }
}
