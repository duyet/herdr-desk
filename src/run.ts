import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadDeskConfig, resolveTask, type TaskConfig } from './config'
import { agentNames, herdrJson, herdrReady, pickPane } from './herdr'
import { assembleManagerPrompt, taskVars } from './prompt'

export type RunMode = 'morning' | 'nightly'

function today(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function runDirFor(repo: string, task: TaskConfig, day: string): string {
  const rel = task.stateDir ?? join('.herdr-desk', 'runs', task.id)
  return join(repo, rel, day)
}

export async function runTask(opts: {
  repo: string
  taskId?: string
  mode: RunMode
}): Promise<{ skipped?: string; spawned?: boolean; prompted?: boolean }> {
  const config = loadDeskConfig(opts.repo)
  const repo = config.repo ?? opts.repo
  const task = resolveTask(config, opts.taskId)
  const day = today()
  const runDir = runDirFor(repo, task, day)
  mkdirSync(runDir, { recursive: true })
  mkdirSync(join(repo, '.herdr-desk', 'runs'), { recursive: true })
  writeFileSync(
    join(repo, '.herdr-desk', 'runs', 'LATEST'),
    `${task.id}/${day}\n`,
  )

  const ready = herdrReady()
  if (!ready.ok) {
    if (ready.reason.includes('socket')) {
      console.log(`${ready.reason} — skip`)
      return { skipped: ready.reason }
    }
    throw new Error(ready.reason)
  }

  const list = await herdrJson(ready.bin, ready.socket, ['agent', 'list'])
  const live = agentNames(list).includes(task.agentName)
  const vars = taskVars({ config, task, repo, day, runDir })

  if (live) {
    const text = assembleManagerPrompt(opts.mode, vars)
    await herdrJson(ready.bin, ready.socket, [
      'agent',
      'prompt',
      task.agentName,
      text,
    ])
    return { prompted: true }
  }

  if (opts.mode === 'nightly') {
    writeFileSync(
      join(runDir, 'nightly.md'),
      `# Nightly ${day}\n\nManager \`${task.agentName}\` was not running.\n`,
    )
    return { skipped: 'manager not live' }
  }

  const created = await herdrJson(ready.bin, ready.socket, [
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
  await herdrJson(ready.bin, ready.socket, [
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
  const fullVars = taskVars({
    config,
    task,
    repo,
    day,
    runDir,
    workspaceId,
    paneId,
  })
  await herdrJson(ready.bin, ready.socket, [
    'agent',
    'prompt',
    task.agentName,
    assembleManagerPrompt('morning', fullVars),
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
  return { spawned: true }
}
