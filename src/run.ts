import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import {
  type LoadedDesk,
  loadDeskConfig,
  resolveTask,
  type TaskConfig,
} from './config'
import { dayKey } from './day'
import type { NoticeLevel } from './format'
import {
  herdrCall,
  herdrReady,
  isAgentLive,
  type ListedAgent,
  type ListedWorkspace,
  listedWorkspaces,
  namedAgents,
  pickPane,
  projectWorkspaceForRepo,
} from './herdr'
import { recordRun } from './history'
import { markRunning, markSettled } from './hub'
import { briefReason, noticeBody, notify, resolveNotify } from './notify'
import { assembleManagerPrompt, taskVars } from './prompt'

type RunResult = {
  skipped?: string
  spawned?: boolean
  prompted?: boolean
  /** Set when the run threw; the message is already ledger-truncated upstream. */
  error?: string
}

export function runDirFor(repo: string, task: TaskConfig, day: string): string {
  const rel = task.stateDir ?? join('.herdr-desk', 'runs', task.id)
  const root = resolve(repo)
  const abs = resolve(root, rel, day)
  if (!abs.startsWith(root + sep)) {
    throw new Error(`stateDir escapes repo: ${rel}`)
  }
  return join(repo, rel, day)
}

/**
 * Point `<task state dir>/LATEST` at today's run dir.
 *
 * A plain `writeFileSync` throws `EISDIR` when a *directory* already sits at
 * that path, and one such leftover makes every later fire fail the same way —
 * the desk goes quiet forever and the only symptom is a run dir with no files
 * in it. Clear whatever is there first, so a stale dir or symlink is
 * self-healing instead of terminal.
 */
export function writeLatestPointer(
  stateDir: string,
  taskId: string,
  day: string,
): void {
  const pointer = join(stateDir, 'LATEST')
  rmSync(pointer, { recursive: true, force: true })
  writeFileSync(pointer, `${taskId}/${day}\n`)
}

export async function runTask(opts: {
  repo: string
  taskId?: string
}): Promise<RunResult> {
  const config = loadDeskConfig(opts.repo)
  const repo = config.repo ?? opts.repo
  const task = resolveTask(config, opts.taskId)
  try {
    const result = await execute(config, repo, task)
    await announce(repo, task, result)
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    recordRun({
      name: config.name,
      repo,
      task: task.id,
      mode: 'run',
      ok: false,
      detail: message,
    })
    // The hub has to learn that this job is over, or it keeps counting as
    // running until it goes stale and reads as stuck — a failure reported as a
    // hang, which sends whoever reads it looking in the wrong place.
    settleHub(repo, task.id, config.name, 'fail', message)
    // A failure is the one thing worth waking someone for, so it is announced
    // before the error propagates. `announce` never throws, so a broken webhook
    // cannot replace a real failure with a notification failure.
    await announce(repo, task, { error: message })
    throw err
  }
}

/**
 * Send a run *failure* to the host notice channel.
 *
 * Only a failure is worth waking someone for. A success and a skip used to
 * notify too, and both were noise:
 *
 * - `spawned manager` fired on every cron slot for every job and said nothing
 *   about the outcome. The manager's own merged report is the status signal.
 * - `skipped` fires when a repo is not open in Herdr, which is a standing
 *   configuration fact rather than news. Four jobs on one repo produced four
 *   identical notices in forty minutes, which is how a channel gets muted.
 *
 * Skips are still recorded in the ledger and printed to stdout, so `status` and
 * `history` answer "why did this not run" without a phone alert.
 *
 * Best-effort in the strongest sense: it resolves rather than rejects, and its
 * result is never recorded as a run outcome. A failed notice must not be able
 * to turn a successful run into a failed one, because that self-amplifies into
 * an alert storm where every run reports that reporting is broken.
 */
async function announce(
  repo: string,
  task: TaskConfig,
  result: RunResult,
): Promise<void> {
  if (result.error === undefined) return
  try {
    const { config: notifyConfig } = resolveNotify({
      repo,
      taskNotify: task.notify,
    })
    if (!notifyConfig.enabled) return
    // Structured, so the channel gets a bold verdict and a searchable tag
    // instead of a flat line. Only the text is escaped; the markup around it is
    // deliberate, so an issue full of `*` and `_` cannot break the parse.
    // `briefReason`, not `truncateDetail`: the ledger wants the full message
    // with its path, a phone wants one short line.
    const body = noticeBody({
      level: 'fail',
      headline: briefReason(result.error) || 'run failed',
      tags: ['desk'],
    })
    await notify({ message: body, repo, label: task.id }, notifyConfig)
  } catch {
    // Intentionally silent. Reaching here means notify misbehaved; the run
    // outcome is already recorded and must not be altered by it.
  }
}

/**
 * Record a job's end in the hub, and never let that bookkeeping fail a run.
 *
 * The hub is a convenience view. A run whose *work* succeeded must not be
 * reported as a failure because writing one small JSON file went wrong, and the
 * caller here is often already handling the real error — so a broken hub is
 * swallowed rather than allowed to replace a failure with a different one.
 */
function settleHub(
  repo: string,
  taskId: string,
  desk: string,
  level: NoticeLevel,
  headline?: string,
): void {
  try {
    markSettled({
      repo,
      task: taskId,
      desk,
      level,
      // The hub line is read on a phone; the full reason, with its absolute
      // path and internal vocabulary, lives in `runs.jsonl` and the notice.
      headline: headline ? briefReason(headline, 90) : undefined,
    })
  } catch {
    /* the hub is best-effort */
  }
}

async function execute(
  config: LoadedDesk,
  repo: string,
  task: TaskConfig,
): Promise<RunResult> {
  const day = dayKey()
  const runDir = runDirFor(repo, task, day)
  mkdirSync(runDir, { recursive: true })
  writeLatestPointer(dirname(runDir), task.id, day)

  const done = (result: RunResult) => {
    recordRun({
      name: config.name,
      repo,
      task: task.id,
      mode: 'run',
      ok: true,
      detail: JSON.stringify(result),
    })
    return result
  }

  const ready = herdrReady()
  if (!ready.ok) {
    if (ready.reason.includes('socket')) {
      console.log(`${ready.reason} — skip`)
      settleHub(repo, task.id, config.name, 'skip', ready.reason)
      return done({ skipped: ready.reason })
    }
    throw new Error(ready.reason)
  }

  const listed = listedWorkspaces(await herdrCall(['workspace', 'list']))
  const project = projectWorkspaceForRepo(listed, {
    repo,
    name: config.name,
  })
  if (!project) {
    const reason = `no open Herdr session for ${config.name} (${repo}) — skip; will not create a sibling Space`
    console.log(reason)
    // Settled as `skip`, not left running: a repo that is never opened would
    // otherwise be counted as in-flight forever and go stale into a false
    // `stuck` — accusing a job of hanging when it was never allowed to start.
    settleHub(repo, task.id, config.name, 'skip', reason)
    return done({ skipped: reason })
  }

  // One long-lived manager session per task. Reuse the session that is already
  // running; restart it in its existing pane if it finished; only fork a new
  // worktree when there is nothing to reuse. The manager's branch is also
  // stable across days, so a daily tick re-prompts the same session instead of
  // stacking a new workspace + pane per run.
  const allAgents = namedAgents(await herdrCall(['agent', 'list']))
  const live = allAgents.find(
    (a) => a.name === task.agentName && isAgentLive(a),
  )
  const vars = taskVars({
    config,
    task,
    repo,
    day,
    runDir,
    workspaceId: project.workspaceId,
  })

  if (live) {
    // Marked before the prompt is sent, not after: the work starts when the
    // manager is prompted, and a run that dies in the prompt call has to look
    // started-and-failed rather than never having happened.
    markRunning({ repo, task: task.id, desk: config.name })
    await herdrCall([
      'agent',
      'prompt',
      task.agentName,
      assembleManagerPrompt(vars),
    ])
    return done({ prompted: true })
  }

  const label = `${config.name} ${task.id}`
  const restart = reusableManagerPane(allAgents, listed, task)
  const child =
    restart ?? (await spawnDeskWorktree(project.workspaceId, task, label, repo))
  const paneId = child.paneId
  const childWorkspaceId = child.workspaceId
  const workspaceId = project.workspaceId
  await Bun.sleep(2000)
  markRunning({ repo, task: task.id, desk: config.name })
  await herdrCall([
    'agent',
    'start',
    task.agentName,
    '--kind',
    task.agent.ladder[0],
    '--pane',
    paneId,
    '--timeout',
    String(task.agent.timeoutMs ?? 180000),
  ])
  await herdrCall([
    'agent',
    'prompt',
    task.agentName,
    assembleManagerPrompt(
      taskVars({ config, task, repo, day, runDir, workspaceId, paneId }),
    ),
  ])
  writeFileSync(
    join(runDir, 'spawn.json'),
    `${JSON.stringify(
      {
        day,
        task: task.id,
        agent: task.agentName,
        workspaceId,
        childWorkspaceId,
        paneId,
        reusedWorktree: Boolean(restart),
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  )
  return done({ spawned: true })
}

/**
 * Branch for the manager's own worktree. Stable per task (no date) so the
 * daily tick reuses one checkout instead of creating a new worktree per day.
 */
export function deskWorktreeBranch(task: TaskConfig): string {
  const slug = task.id.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-|-$/g, '')
  return `desk/${slug}`
}

/**
 * Pane of a finished manager session whose worktree is still open.
 *
 * Restarting there keeps the workspace count flat. `agent start` on a pane
 * whose agent already exited would otherwise stack a new session, so this is
 * only used when the session is not live.
 */
function reusableManagerPane(
  agents: ListedAgent[],
  workspaces: ListedWorkspace[],
  task: TaskConfig,
): { paneId: string; workspaceId: string } | undefined {
  const branch = deskWorktreeBranch(task)
  for (const agent of agents) {
    if (agent.name !== task.agentName) continue
    if (isAgentLive(agent)) continue
    if (!agent.paneId || !agent.workspaceId) continue
    const ws = workspaces.find((w) => w.workspaceId === agent.workspaceId)
    // The checkout must still exist and still be this task's manager branch.
    // A deleted worktree means the pane is gone too.
    if (ws) {
      if (!(ws.checkoutPath ?? '').includes(branch)) continue
    } else if (!agent.cwd?.includes(branch)) {
      continue
    }
    return { paneId: agent.paneId, workspaceId: agent.workspaceId }
  }
  return undefined
}

/**
 * Base ref for a new manager worktree, from `git symbolic-ref origin/HEAD`.
 *
 * The default branch is not always `main`. Hardcoding `origin/main` made every
 * fire on a `master` repo fail with `fatal: invalid reference: origin/main`
 * before the manager was ever started.
 */
export function baseRefFrom(
  originHead: string | null | undefined,
  fallback = 'origin/main',
): string {
  const ref = (originHead ?? '').trim()
  return /^origin\/\S+$/.test(ref) ? ref : fallback
}

async function resolveBaseRef(repo: string): Promise<string> {
  try {
    const proc = Bun.spawn(
      [
        'git',
        '-C',
        repo,
        'symbolic-ref',
        '--short',
        'refs/remotes/origin/HEAD',
      ],
      { stdout: 'pipe', stderr: 'ignore' },
    )
    const out = await new Response(proc.stdout).text()
    const code = await proc.exited
    if (code === 0) return baseRefFrom(out)
  } catch {
    // git missing, or the repo has no origin/HEAD. Fall through.
  }
  return baseRefFrom(null)
}

/**
 * Worktree child of the open project Space — never a sibling workspace.
 *
 * `worktree open` re-attaches an existing branch, so a manager worktree that
 * is still on disk is reused rather than duplicated.
 */
async function spawnDeskWorktree(
  parentWorkspaceId: string,
  task: TaskConfig,
  label: string,
  repo: string,
): Promise<{ paneId: string; workspaceId: string }> {
  const branch = deskWorktreeBranch(task)
  const base = await resolveBaseRef(repo)
  let created: unknown
  try {
    created = await herdrCall([
      'worktree',
      'open',
      '--workspace',
      parentWorkspaceId,
      '--branch',
      branch,
      '--label',
      label,
      '--no-focus',
    ])
  } catch {
    created = await herdrCall([
      'worktree',
      'create',
      '--workspace',
      parentWorkspaceId,
      '--branch',
      branch,
      '--base',
      base,
      '--label',
      label,
      '--no-focus',
    ])
  }
  const pane = pickPane(created)
  return { paneId: pane.paneId, workspaceId: pane.workspaceId }
}
