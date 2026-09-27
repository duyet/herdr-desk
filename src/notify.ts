import { existsSync, readFileSync } from 'node:fs'
import { hostname, userInfo } from 'node:os'
import { basename, join } from 'node:path'
import { pluginConfigDir } from './paths'

/**
 * Notifications are host-level, not per-repo: the same Telegram destination
 * receives notices from every desk on the machine, so the token must never be
 * committed into a repo's `.herdr-desk.json`.
 */
export type NotifyConfig = {
  enabled: boolean
  token: string
  chatId: string
  /** Optional Telegram forum topic id. */
  topicId: string
}

export type Notice = {
  /** Human message. Machine and repo are added automatically. */
  message: string
  /** Repo directory; only its name is used. */
  repo?: string
  /** Overrides the detected machine name. */
  machine?: string
  /** Short label such as a task id, e.g. `desk:github-issues`. */
  label?: string
}

export type NotifyResult = {
  sent: boolean
  /** Why nothing was sent, when `sent` is false. */
  reason?: string
  machine: string
  repo: string
}

export const NOTIFY_CONFIG_FILE = 'notify.json'

/** Host-level config path: `~/.config/herdr/plugins/herdr-desk/notify.json`. */
export function notifyConfigPath(): string {
  return join(pluginConfigDir(), NOTIFY_CONFIG_FILE)
}

/**
 * Env wins over the file so a scheduled daemon or CI can inject a token
 * without writing to the host config.
 */
export function loadNotifyConfig(): NotifyConfig {
  const path = notifyConfigPath()
  let file: Record<string, unknown> = {}
  if (existsSync(path)) {
    try {
      file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    } catch {
      file = {}
    }
  }
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
  return {
    enabled: file.enabled === false ? false : true,
    token: process.env.HERDR_DESK_TELEGRAM_TOKEN?.trim() || str(file.token),
    chatId: process.env.HERDR_DESK_TELEGRAM_CHAT_ID?.trim() || str(file.chatId),
    topicId:
      process.env.HERDR_DESK_TELEGRAM_TOPIC_ID?.trim() || str(file.topicId),
  }
}

/** Machine identity, so a notice is attributable when several hosts report. */
export function machineName(): string {
  let user = ''
  try {
    user = userInfo().username
  } catch {
    user = ''
  }
  const host = hostname() || 'unknown-host'
  return user ? `${host} (${user})` : host
}

/** Repo identity from its directory name, falling back to the full path. */
export function repoName(repo?: string): string {
  if (!repo) return 'no-repo'
  const name = basename(repo)
  return name || repo
}

/**
 * Every notice carries machine and repo. Without them a message from a fleet of
 * desks is unattributable, which is the whole point of a host-level channel.
 */
export function formatNotice(n: Notice, machine = machineName()): string {
  const parts = [`[${machine}]`, `[${repoName(n.repo)}]`]
  if (n.label) parts.push(`[${n.label}]`)
  const body = n.message.trim() || '(no message)'
  return `${parts.join(' ')} ${body}`
}

/**
 * Best-effort send. Never throws: a failed notice must not abort a desk run.
 */
export async function notify(
  n: Notice,
  config: NotifyConfig = loadNotifyConfig(),
  fetchImpl: typeof fetch = fetch,
): Promise<NotifyResult> {
  const machine = n.machine ?? machineName()
  const repo = repoName(n.repo)
  const text = formatNotice(n, machine)

  if (!config.enabled) return { sent: false, reason: 'disabled', machine, repo }
  if (!config.token || !config.chatId) {
    return {
      sent: false,
      reason: `not configured (set token + chatId in ${NOTIFY_CONFIG_FILE})`,
      machine,
      repo,
    }
  }

  const payload: Record<string, unknown> = {
    chat_id: config.chatId,
    text,
    disable_web_page_preview: true,
  }
  if (config.topicId) payload.message_thread_id = Number(config.topicId)

  try {
    const res = await fetchImpl(
      `https://api.telegram.org/bot${config.token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
    )
    if (!res.ok) {
      return {
        sent: false,
        reason: `telegram HTTP ${res.status}`,
        machine,
        repo,
      }
    }
    return { sent: true, machine, repo }
  } catch (err) {
    return {
      sent: false,
      reason: err instanceof Error ? err.message : String(err),
      machine,
      repo,
    }
  }
}
