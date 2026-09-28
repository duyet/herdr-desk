import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import {
  type LoadedDesk,
  loadDeskConfig,
  resolveTask,
  type TaskConfig,
} from './config'
import { dayKey } from './day'
import { clearFailures, noteFailure } from './failures'
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
  /**
   * Withhold the notice while keeping the run recorded.
   *
   * A precondition is not something that can be acted on from a phone, and it
   * recurs on *every* tick for as long as the condition holds — announced, one
   * closed Herdr Space became a message every 30 minutes, per task, repeating
   * the same sentence forever. `false` keeps a skip announceable, for a task
   * whose skip really is worth a message.
   */
  quiet?: boolean
  spawned?: boolean
  prompted?: boolean
  /** Prompted an existing finished session rather than starting a new one. */
  reused?: boolean
  /** Set when the run threw; the message is already ledger-truncated upstream. */
  error?: string
}

/**
 * Whether a run outcome is worth a channel notice.
 *
 * A failure always is. A precondition skip is not, unless it opts back in with
 * {@link preconditionSkip}'s second argument. `ok` is never a notice either: the
 * manager's own merged report is the status signal for work that succeeded, and
 * the hub counts it.
 */
export function announceable(result: RunResult): boolean {
  if (result.error !== undefined) return true
  return result.skipped !== undefined && result.quiet !== true
}

/** A run stopped before doing any work. Recorded, and quiet unless overridden. */
export function preconditionSkip(
  skipped: string,
  quiet = true,
): { skipped: string; quiet: boolean } {
  return { skipped, quiet }
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
    // A job that got as far as prompting its manager is no longer broken in the
    // way it was. Clearing here means the *next* real failure announces again,
    // instead of being suppressed as a "repeat" of a fault that is over.
    if (result.spawned || result.prompted) clearFailures(repo, task.id)
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
  if (!announceable(result)) return
  try {
    const { config: notifyConfig } = resolveNotify({
      repo,
      taskNotify: task.notify,
    })
    if (!notifyConfig.enabled) return
    // A fault that cannot fix itself produced the identical message on every
    // tick — four copies of `agent_name_taken` arrived before the first could be
    // read. The first one announces; the repeats are recorded and counted, and
    // the hub is where a persistent fault is reported from.
    const verdict = noteFailure(
      repo,
      task.id,
      result.error ?? result.skipped ?? '',
    )
    if (!verdict.announce) return
    // `announceable` already established there is something to say, so the body
    // is never null here.
    await notify(
      { message: announceBody(result) as string, repo, label: task.id },
      notifyConfig,
    )
  } catch {
    // Intentionally silent. Reaching here means notify misbehaved; the run
    // outcome is already recorded and must not be altered by it.
  }
}

/**
 * The notice body for a run outcome, or `null` when it is not worth sending.
 *
 * Exported so the level and the headline can be asserted without a transport.
 * Both come from the outcome itself: hardcoding `fail` here would label a
 * non-quiet skip "run failed" and send a reader hunting for a crash that never
 * happened.
 *
 * `briefReason`, not `truncateDetail`: the ledger wants the full message with
 * its path, a phone wants one short line. Only the text is escaped; the markup
 * around it is deliberate, so a message full of `*` and `_` cannot 400.
 */
export function announceBody(result: RunResult): string | null {
  if (!announceable(result)) return null
  // Branch on the field itself rather than on a `failed` boolean: TypeScript
  // will not carry the narrowing through a captured value, and reading
  // `result.error` as `string | undefined` here would be a lie the compiler
  // correctly refuses.
  if (result.error !== undefined) {
    return noticeBody({
      level: 'fail',
      headline: briefReason(result.error) || 'run failed',
      tags: ['desk'],
    })
  }
  return noticeBody({
    level: 'skip',
    headline: briefReason(result.skipped ?? '') || 'skipped',
    tags: ['desk'],
  })
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
      // Quiet: herdr being down is a machine-level fact that repeats on every
      // tick, not a per-job problem. The run is still recorded.
      settleHub(repo, task.id, config.name, 'skip', 'herdr is not running')
      return done(preconditionSkip(ready.reason))
    }
    throw new Error(ready.reason)
  }

  const listed = listedWorkspaces(await herdrCall(['workspace', 'list']))
  const project = projectWorkspaceForRepo(listed, {
    repo,
    name: config.name,
  })
  if (!project) {
    // The full reason, with the path and the policy, goes to stdout and to
    // history where it is a diagnosable record. The notice headline and the hub
    // cell get the verdict alone — 35 characters instead of 108, and a closed
    // Space is not something a reader can act on from a phone.
    const reason = `no open Herdr session for ${config.name} (${repo}) — skip; will not create a sibling Space`
    console.log(reason)
    // Settled as `skip`, not left running: a repo that is never opened would
    // otherwise be counted as in-flight forever and go stale into a false
    // `stuck` — accusing a job of hanging when it was never allowed to start.
    settleHub(
      repo,
      task.id,
      config.name,
      'skip',
      `no open Herdr session for ${config.name}`,
    )
    return done(preconditionSkip(reason))
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

  // A session that exists under this name but is *not* live — typically `done`,
  // because the previous run finished and the process is still registered.
  //
  // `agent start` cannot be used on it: the name is already taken, and Herdr
  // rejects the call with `agent_name_taken`. That failure recurred on every
  // tick, forever, for any job whose manager had ever completed — the error
  // named a session that was sitting right there in its own pane. Prompting
  // revives the same session, which is what the "reused across ticks" design
  // intends anyway.
  if (restart) {
    markRunning({ repo, task: task.id, desk: config.name })
    await herdrCall([
      'agent',
      'prompt',
      task.agentName,
      assembleManagerPrompt(
        taskVars({ config, task, repo, day, runDir, workspaceId, paneId }),
      ),
    ])
    return done({ prompted: true, reused: true })
  }

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
  return `desk/${taskSlug(task)}`
}

/** Filesystem-safe form of a task id: `local:babysit` -> `local-babysit`. */
function taskSlug(task: TaskConfig): string {
  return task.id.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-|-$/g, '')
}

/**
 * Does this path belong to `task`'s manager worktree?
 *
 * The branch is `desk/local-babysit` but Herdr names the checkout directory
 * after the same slug with dashes (`desk-local-babysit`). Matching the branch
 * string against the path therefore never fired, so every finished manager
 * fell through to `agent start` and failed on `agent_name_taken` — 31
 * consecutive chmonitor fires for `local:babysit` and `local:prod` before the
 * run stopped. Accept either spelling.
 */
export function isManagerCheckout(path: string, task: TaskConfig): boolean {
  if (!path) return false
  const slug = taskSlug(task)
  const branch = `desk/${slug}`
  if (path.includes(branch)) return true
  const dir = basename(path)
  return dir === `desk-${slug}` || dir === slug
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
  for (const agent of agents) {
    if (agent.name !== task.agentName) continue
    if (isAgentLive(agent)) continue
    if (!agent.paneId || !agent.workspaceId) continue
    const ws = workspaces.find((w) => w.workspaceId === agent.workspaceId)
    // The checkout must still exist and still be this task's manager worktree.
    // A deleted worktree means the pane is gone too.
    if (ws) {
      if (!isManagerCheckout(ws.checkoutPath ?? '', task)) continue
    } else if (!isManagerCheckout(agent.cwd ?? '', task)) {
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
