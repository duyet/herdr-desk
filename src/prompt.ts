import { existsSync, readFileSync } from 'node:fs'
import {
  type LoadedDesk,
  promptPath,
  resolveTaskPromptPath,
  type TaskConfig,
} from './config'
import { interpolate } from './interpolate'
import { looksLikePath, resolveText } from './text'

export type PromptVars = Record<string, string>

export function taskVars(opts: {
  config: LoadedDesk
  task: TaskConfig
  repo: string
  day: string
  runDir: string
  workspaceId?: string
  paneId?: string
}): PromptVars {
  const extra = resolveText(opts.repo, opts.task.extra)
  const playbook = resolveText(opts.repo, opts.task.playbook)
  const bundled = playbookFile(opts.repo, opts.task)
  return {
    day: opts.day,
    repo: opts.repo,
    runDir: opts.runDir,
    taskId: opts.task.id,
    taskLabel: opts.task.label ?? opts.task.id,
    agentName: opts.task.agentName,
    maxChildren: String(opts.task.maxChildren ?? 5),
    kind: opts.task.kind ?? 'grok',
    identityPath: promptPath('identity'),
    taskPromptPath: bundled,
    taskPromptBody: bundled ? '' : playbook.text,
    childPromptPath: promptPath('child'),
    extraPath: extra.path ?? '',
    extraBody: extra.text,
    workspaceId: opts.workspaceId ?? '',
    paneId: opts.paneId ?? '',
    deskName: opts.config.name,
  }
}

function playbookFile(repo: string, task: TaskConfig): string {
  const value = task.playbook
  if (value.includes('\n')) return ''
  if (looksLikePath(value)) {
    const hit = resolveText(repo, value)
    return hit.path ?? ''
  }
  try {
    return resolveTaskPromptPath(task, repo)
  } catch {
    return ''
  }
}

export function renderFile(path: string, vars: PromptVars): string {
  return interpolate(readFileSync(path, 'utf8'), vars)
}

export function assembleManagerPrompt(vars: PromptVars): string {
  const envelope = renderFile(promptPath('run'), vars)
  const identity = renderFile(vars.identityPath, vars)
  const taskBody = vars.taskPromptPath
    ? renderFile(vars.taskPromptPath, vars)
    : interpolate(vars.taskPromptBody ?? '', vars)
  const extraRaw = vars.extraBody ?? ''
  const extra = extraRaw.trim()
    ? `\n\n---\n# Repo addendum\n\n${interpolate(extraRaw, vars)}`
    : vars.extraPath && existsSync(vars.extraPath)
      ? `\n\n---\n# Repo addendum\n\n${renderFile(vars.extraPath, vars)}`
      : ''
  return `${envelope}\n\n---\n${identity}\n\n---\n${taskBody}${extra}\n`
}
