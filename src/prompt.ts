import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DESK_ROOT,
  type LoadedDesk,
  promptPath,
  resolveTaskPromptPath,
  type TaskConfig,
} from './config'
import { interpolate } from './interpolate'
import { looksLikePath, resolveText } from './text'
import type { WatchEvent } from './watch'

export type PromptVars = Record<string, string>

export function taskVars(opts: {
  config: LoadedDesk
  task: TaskConfig
  repo: string
  day: string
  runDir: string
  workspaceId?: string
  paneId?: string
  /** What woke this run. Absent means a cron slot. */
  trigger?: 'manual' | 'event'
  /** Events claimed for this run. Empty on every run that is not event-driven. */
  events?: WatchEvent[]
}): PromptVars {
  const extra = resolveText(opts.repo, opts.task.extra)
  const playbook = resolveText(opts.repo, opts.task.playbook)
  const bundled = playbookFile(opts.repo, opts.task)
  const events = opts.events ?? []
  return {
    day: opts.day,
    repo: opts.repo,
    runDir: opts.runDir,
    taskId: opts.task.id,
    taskLabel: opts.task.label ?? opts.task.id,
    agentName: opts.task.agentName,
    maxChildren: String(opts.task.maxChildren ?? 5),
    // `kind` stays in the template vars: existing playbooks interpolate {{kind}},
    // and it now carries the first rung of the ladder.
    kind: opts.task.agent.ladder[0],
    identityPath: promptPath('identity'),
    taskPromptPath: bundled,
    taskPromptBody: bundled ? '' : playbook.text,
    childPromptPath: promptPath('child'),
    extraPath: extra.path ?? '',
    extraBody: extra.text,
    workspaceId: opts.workspaceId ?? '',
    paneId: opts.paneId ?? '',
    deskName: opts.config.name,
    // Absolute path to this plugin's CLI. The manager runs in a worktree with
    // its own PATH, where `herdr-desk` is usually not on it — a prompt that
    // says "run herdr-desk report" and cannot resolve the binary teaches the
    // agent to improvise, and it improvises by pasting the whole run into a
    // Telegram message itself.
    deskBin: join(DESK_ROOT, 'bin', 'desk'),
    // Event vars. Every one of them is empty or zero when the run carries no
    // events, which is what lets `assembleManagerPrompt` leave a cron run's
    // prompt byte-for-byte what it has always been.
    eventCount: String(events.length),
    eventSummary: eventSummary(events),
    eventJson: events.length ? JSON.stringify(events, null, 2) : '',
    eventPath: events.length ? join(opts.runDir, 'events.json') : '',
    triggerKind: opts.trigger ?? 'cron',
  }
}

/** One bullet per event: `- type — summary`. */
function eventSummary(events: WatchEvent[]): string {
  return events
    .map((e) => {
      const type = typeof e.type === 'string' && e.type ? e.type : 'event'
      const summary =
        typeof e.summary === 'string' && e.summary ? e.summary : e.id
      return `- ${type} — ${summary}`
    })
    .join('\n')
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

/**
 * Event guidance in `prompts/run.md`, marked so it can be removed whole.
 *
 * The text has to live in the manager envelope — that is the file every run
 * reads — but a cron run with an empty queue must not gain a sentence it has no
 * use for, because `assembleManagerPrompt` promises such a prompt is
 * byte-identical to before this feature existed. A marker is the cheapest way to
 * have both: the text is authored where the rest of the envelope is, and
 * stripped entirely rather than interpolated to an empty husk.
 *
 * **Two blocks, not one, because the two cases say opposite things.** A run
 * woken by an event should work the events and stop. A cron or manual run that
 * merely *found* a queue should do its own work and handle the events on the way
 * through — and a single block covering both had to say "work them and stop" to
 * the event run, which told a reconciliation sweep to abandon the slot's work on
 * the strength of a queue of no-op events, and told a hand-triggered run to
 * `level: skip`. `triggerKind` picks which one renders; the other is stripped
 * either way.
 */
const EVENT_BLOCK = /\n*<!-- events -->\n([\s\S]*?)\n?<!-- \/events -->/g

/** The `cron`/`manual` counterpart: events present, but not the reason to run. */
const DRAINED_BLOCK = /\n*<!-- drained -->\n([\s\S]*?)\n?<!-- \/drained -->/g

function renderEnvelope(path: string, vars: PromptVars): string {
  const raw = readFileSync(path, 'utf8')
  const hasEvents = Number(vars.eventCount ?? '0') > 0
  const wokenBy = vars.triggerKind === 'event'
  // The leading `\n*` is inside each pattern so removing a block removes the
  // blank line that introduced it too — otherwise a cron prompt ends with stray
  // newlines it did not have before this feature, which is the difference
  // between "identical" and "identical except for a byte".
  const text = raw
    .replace(EVENT_BLOCK, (_all, body: string) =>
      hasEvents && wokenBy ? `\n\n${body.trim()}` : '',
    )
    .replace(DRAINED_BLOCK, (_all, body: string) =>
      hasEvents && !wokenBy ? `\n\n${body.trim()}` : '',
    )
  return interpolate(text, vars)
}

export function assembleManagerPrompt(vars: PromptVars): string {
  const envelope = renderEnvelope(promptPath('run'), vars)
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
  const event = eventSection(vars)
  return `${envelope}${event}\n\n---\n${identity}\n\n---\n${taskBody}${extra}\n`
}

/**
 * The `# Event` section, and only when the run has events.
 *
 * Absent rather than empty, because a manager reading an empty "nothing is
 * waiting" heading spends a run deciding there is nothing to do — which is the
 * exact cost the cron path already pays once a slot. The pretty JSON is here for
 * fields the bullets do not carry; `events.json` is the path for anything too
 * big to belong in a prompt.
 */
function eventSection(vars: PromptVars): string {
  if (Number(vars.eventCount ?? '0') <= 0) return ''
  const bullets = vars.eventSummary ?? ''
  const json = vars.eventJson ?? ''
  return `\n\n---\n# Event\n\n${bullets}\n\n\`\`\`json\n${json}\n\`\`\`\n\nFull events: ${vars.eventPath}\n`
}
