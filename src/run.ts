import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  type DeskConfig,
  loadDeskConfig,
  resolveTask,
  type TaskConfig,
} from './config'
import { dayKey } from './day'
import { agentNames, herdrCall, herdrReady, pickPane } from './herdr'
import { recordRun } from './history'
import { assembleManagerPrompt, taskVars } from './prompt'

export type RunMode = 'morning' | 'nightly'

type RunResult = {
  skipped?: string
  spawned?: boolean
  prompted?: boolean
}

export function runDirFor(repo: string, task: TaskConfig, day: string): string {
  const rel = task.stateDir ?? join('.herdr-desk', 'runs', task.id)
  return join(repo, rel, day)
}

export async function runTask(opts: {
  repo: string
  taskId?: string
  mode: RunMode
}): Promise<RunResult> {
  const config = loadDeskConfig(opts.repo)
  const repo = config.repo ?? opts.repo
  const task = resolveTask(config, opts.taskId)
  try {
    return await execute(config, repo, task, opts.mode)
  } catch (err) {
    recordRun({
      name: config.name,
      repo,
      task: task.id,
      mode: opts.mode,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}

async function execute(
  config: DeskConfig,
  repo: string,
  task: TaskConfig,
  mode: RunMode,
): Promise<RunResult> {
  const day = dayKey()
  const runDir = runDirFor(repo, task, day)
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(dirname(runDir), 'LATEST'), `${task.id}/${day}\n`)

  const done = (result: RunResult) => {
    recordRun({
      name: config.name,
      repo,
      task: task.id,
      mode,
      ok: true,
      detail: JSON.stringify(result),
    })
    return result
  }

  const ready = herdrReady()
  if (!ready.ok) {
    if (ready.reason.includes('socket')) {
      console.log(`${ready.reason} — skip`)
      return done({ skipped: ready.reason })
    }
    throw new Error(ready.reason)
  }

  const live = agentNames(await herdrCall(['agent', 'list'])).includes(
    task.agentName,
  )
  const vars = taskVars({ config, task, repo, day, runDir })

  if (live) {
    await herdrCall([
      'agent',
      'prompt',
      task.agentName,
      assembleManagerPrompt(mode, vars),
    ])
    return done({ prompted: true })
  }

  if (mode === 'nightly') {
    writeFileSync(
      join(runDir, 'nightly.md'),
      `# Nightly ${day}\n\nManager \`${task.agentName}\` was not running.\n`,
    )
    return done({ skipped: 'manager not live' })
  }

  const created = await herdrCall([
    'workspace',
    'create',
    '--cwd',
    repo,
    '--label',
    `${config.name} ${task.id} ${day}`,
    '--no-focus',
  ])
  const { workspaceId, paneId } = pickPane(created)
  await Bun.sleep(2000)
  await herdrCall([
    'agent',
    'start',
    task.agentName,
    '--kind',
    task.kind ?? 'grok',
    '--pane',
    paneId,
    '--timeout',
    '180000',
  ])
  await herdrCall([
    'agent',
    'prompt',
    task.agentName,
    assembleManagerPrompt(
      'morning',
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
        paneId,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  )
  return done({ spawned: true })
}
