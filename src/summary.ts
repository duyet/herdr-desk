import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DESK_ROOT,
  type LoadedDesk,
  promptPath,
  type TaskConfig,
} from './config'
import { dayKey } from './day'
import {
  herdrCall,
  listedWorkspaces,
  namedAgents,
  projectWorkspaceForRepo,
} from './herdr'
import { historyPath, type RunRecord } from './history'
import { interpolate } from './interpolate'
import { pluginStateDir } from './paths'
import { canPromptManager, runDirFor, spawnDeskWorktree } from './run'
import { deskSlug } from './text'

/**
 * `desk summary`: gather what the desk already recorded, and hand it to an
 * agent to write up.
 *
 * The desk is a scheduler and router, not an agent (design.md §1), so it never
 * calls a model itself. It builds one prompt — the history slice, fenced as
 * data — and delivers it to a ladder agent the same way a job fire does. The
 * agent writes the prose. Manual only: a summary costs an agent run, and there
 * is no scheduled summary until that cost is known (roadmap §7.2).
 */

/** A desk whose run dirs are read for `changes.md` / `status.md`. */
export type SummaryDesk = { repo: string; config: LoadedDesk }

/** Files a job leaves in its run dir that say what it did, in reading order. */
const RUN_FILES = ['changes.md', 'status.md']

/** Bounds, so a busy week cannot build a prompt nobody can read. */
export const MAX_RUN_LINES = 300
export const MAX_FILE_CHARS = 2000

/** `30m`, `12h`, `7d` → milliseconds. `null` for anything else. */
export function parseSince(text: string): number | null {
  const m = /^(\d+)([mhd])$/.exec(text.trim())
  if (!m) return null
  const n = Number(m[1])
  if (n <= 0) return null
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[
    m[2] as 'm' | 'h' | 'd'
  ]
  return n * unit
}

/**
 * Every ledger record at or after `since`, oldest first, optionally for one
 * repo.
 *
 * Not `loadRuns`: that keeps the newest 200 records machine-wide, so a
 * `--since 7d` on a busy machine would silently drop the start of the window.
 * This reads back from the end until a record is older than `since`.
 */
export function runsSince(
  since: Date,
  repo?: string,
  path = historyPath(),
): RunRecord[] {
  if (!existsSync(path)) return []
  const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
  const out: RunRecord[] = []
  for (let i = lines.length - 1; i >= 0; i--) {
    let rec: RunRecord
    try {
      rec = JSON.parse(lines[i]) as RunRecord
    } catch {
      continue
    }
    const at = Date.parse(rec.at)
    if (!Number.isFinite(at)) continue
    if (at < since.getTime()) break
    if (repo && rec.repo !== repo) continue
    out.push(rec)
  }
  return out.reverse()
}

/** Every local day from `since` to `now`, inclusive, oldest first. */
export function daysBetween(since: Date, now: Date): string[] {
  const out: string[] = []
  const d = new Date(since)
  d.setHours(0, 0, 0, 0)
  const last = dayKey(now)
  for (let guard = 0; guard < 400; guard++) {
    const key = dayKey(d)
    out.push(key)
    if (key === last) break
    d.setDate(d.getDate() + 1)
  }
  return out
}

/** `changes.md` / `status.md` for each job and day in the window. */
function runFiles(desks: SummaryDesk[], days: string[]): string[] {
  const out: string[] = []
  for (const d of desks) {
    for (const t of d.config.tasks) {
      for (const day of days) {
        let dir: string
        try {
          dir = runDirFor(d.repo, t, day)
        } catch {
          continue
        }
        for (const name of RUN_FILES) {
          const path = join(dir, name)
          if (!existsSync(path)) continue
          let text: string
          try {
            text = readFileSync(path, 'utf8').trim()
          } catch {
            continue
          }
          if (!text) continue
          const cut =
            text.length > MAX_FILE_CHARS
              ? `${text.slice(0, MAX_FILE_CHARS)}\n… (${text.length - MAX_FILE_CHARS} more chars)`
              : text
          out.push(
            `### ${d.config.name} / ${t.id} / ${day} / ${name}\n\n${cut}`,
          )
        }
      }
    }
  }
  return out
}

/**
 * The history slice handed to the agent, as text. Pure over its inputs so the
 * `--since` boundary is testable without a real ledger.
 */
export function summaryInput(opts: {
  runs: RunRecord[]
  desks: SummaryDesk[]
  since: Date
  now: Date
}): string {
  const runs = opts.runs.slice(-MAX_RUN_LINES)
  const omitted = opts.runs.length - runs.length
  const out: string[] = [`## Run ledger (${opts.runs.length} records)`, '']
  if (omitted > 0) out.push(`(${omitted} older records omitted)`)
  if (runs.length === 0) out.push('(no runs in this window)')
  for (const r of runs) {
    const detail = r.detail ? `  ${r.detail}` : ''
    out.push(
      `${r.at}  ${r.ok ? 'ok' : 'fail'}  ${r.name}/${r.task}  ${r.mode}${detail}`,
    )
  }
  const files = runFiles(opts.desks, daysBetween(opts.since, opts.now))
  out.push('', '## Job reports', '')
  out.push(files.length ? files.join('\n\n') : '(no changes.md or status.md)')
  return out.join('\n')
}

/** Where the agent writes its answer: the plugin state dir, never a run dir. */
export function summaryOutPath(now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  return join(pluginStateDir(), 'summaries', `${stamp}.txt`)
}

/**
 * The exact prompt the agent receives. `--dry-run` prints this string, so what
 * you preview is what would be sent.
 */
export function buildSummaryPrompt(opts: {
  input: string
  scope: string
  since: Date
  now: Date
  outPath: string
  /** Repo the notice is attributed to, when `--notify` is set. */
  notifyRepo?: string
}): string {
  const deskBin = join(DESK_ROOT, 'bin', 'desk')
  const notifyStep = opts.notifyRepo
    ? [
        'After writing the file, send it with exactly this command. The desk',
        'escapes it for Telegram; do not send it any other way:',
        '',
        `    ${deskBin} summary --send ${opts.outPath} --repo ${opts.notifyRepo}`,
      ].join('\n')
    : 'Do not send it anywhere. The person who asked will read the file.'
  return interpolate(readFileSync(promptPath('summary'), 'utf8'), {
    scope: opts.scope,
    since: opts.since.toISOString(),
    now: opts.now.toISOString(),
    outPath: opts.outPath,
    notifyStep,
    input: opts.input,
  })
}

/**
 * The job-shaped identity a summary runs under.
 *
 * Its own agent name and id, so a summary never prompts a real job's manager,
 * never writes into its run dir, and never lands in its failure streak. The
 * ladder is borrowed from the desk's first job, since that is the agent the
 * repo already chose.
 */
export function summaryTask(config: LoadedDesk): TaskConfig {
  const base = config.tasks[0]
  if (!base) throw new Error(`${config.name}: no jobs to borrow an agent from`)
  const agentName = `${deskSlug(config.name)}-summary`
  if (config.tasks.some((t) => t.agentName === agentName)) {
    throw new Error(
      `${config.name}: a job already uses agent name ${agentName}; a summary must not prompt it`,
    )
  }
  return {
    id: 'desk:summary',
    label: 'summary',
    playbook: 'summary',
    agentName,
    agent: base.agent,
    crons: [],
  }
}

/**
 * Deliver a prompt through the same Herdr path a job fire uses: prompt the
 * summary agent if Herdr still holds its name, otherwise open its worktree
 * under the project Space, start the first rung, and prompt it.
 *
 * Never `agent start` a name Herdr already holds (`agent_name_taken`), and
 * nothing here touches the hub or the run ledger.
 */
export async function handToAgent(opts: {
  config: LoadedDesk
  repo: string
  prompt: string
}): Promise<{ agent: string; how: 'prompted' | 'spawned' }> {
  const task = summaryTask(opts.config)
  const listed = listedWorkspaces(await herdrCall(['workspace', 'list']))
  const project = projectWorkspaceForRepo(listed, {
    repo: opts.repo,
    name: opts.config.name,
  })
  if (!project) {
    throw new Error(
      `no open Herdr session for ${opts.config.name} (${opts.repo}); open it, or use --dry-run`,
    )
  }
  const agents = namedAgents(await herdrCall(['agent', 'list']))
  if (canPromptManager(agents, listed, task)) {
    await herdrCall(['agent', 'prompt', task.agentName, opts.prompt])
    return { agent: task.agentName, how: 'prompted' }
  }
  const child = await spawnDeskWorktree(
    project.workspaceId,
    task,
    `${opts.config.name} summary`,
    opts.repo,
  )
  await Bun.sleep(2000)
  await herdrCall([
    'agent',
    'start',
    task.agentName,
    '--kind',
    task.agent.ladder[0],
    '--pane',
    child.paneId,
    '--timeout',
    String(task.agent.timeoutMs ?? 180000),
  ])
  await herdrCall(['agent', 'prompt', task.agentName, opts.prompt])
  return { agent: task.agentName, how: 'spawned' }
}
