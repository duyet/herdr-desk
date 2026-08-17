import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type DeskConfig,
  promptPath,
  resolveTaskPromptPath,
  type TaskConfig,
} from './config'
import { interpolate } from './interpolate'

export type PromptVars = Record<string, string>

export function taskVars(opts: {
  config: DeskConfig
  task: TaskConfig
  repo: string
  day: string
  runDir: string
  workspaceId?: string
  paneId?: string
}): PromptVars {
  const extra = opts.task.extraPrompt
    ? join(opts.repo, opts.task.extraPrompt)
    : ''
  return {
    day: opts.day,
    repo: opts.repo,
    runDir: opts.runDir,
    taskId: opts.task.id,
    taskLabel: opts.task.label ?? opts.task.id,
    agentName: opts.task.agentName,
    maxChildren: String(opts.task.maxChildren ?? 3),
    kind: opts.task.kind ?? 'grok',
    identityPath: promptPath('identity'),
    taskPromptPath: resolveTaskPromptPath(opts.task, opts.repo),
    childPromptPath: promptPath('child'),
    extraPromptPath: extra,
    workspaceId: opts.workspaceId ?? '',
    paneId: opts.paneId ?? '',
    deskName: opts.config.name,
  }
}

export function renderFile(path: string, vars: PromptVars): string {
  return interpolate(readFileSync(path, 'utf8'), vars)
}

export function assembleManagerPrompt(
  mode: 'morning' | 'nightly',
  vars: PromptVars,
): string {
  const envelope = renderFile(promptPath(mode), vars)
  const identity = renderFile(vars.identityPath, vars)
  const task = renderFile(vars.taskPromptPath, vars)
  const extra =
    vars.extraPromptPath && existsSync(vars.extraPromptPath)
      ? `\n\n---\n# Repo addendum\n\n${renderFile(vars.extraPromptPath, vars)}`
      : ''
  return `${envelope}\n\n---\n${identity}\n\n---\n${task}${extra}\n`
}
