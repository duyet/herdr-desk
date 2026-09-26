import { existsSync, readFileSync } from 'node:fs'
import { hostname, userInfo } from 'node:os'
import { basename, join } from 'node:path'
import type { NotifyOverride } from './config'
import { type Layer, resolveConfig } from './layers'
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

/** Where each destination field came from, for `config explain`. */
export type NotifyProvenance = {
  enabled?: string
  chatId?: string
  topicId?: string
}

export const NOTIFY_CONFIG_FILE = 'notify.json'

/**
 * Cap on the human message.
 *
 * The `[machine] [repo] [label]` prefix is mandatory and is never truncated —
 * a bare message in a shared chat is unattributable, which is the entire reason
 * a host-level channel needs the prefix. Only the body is capped, and 700 keeps
 * a notice comfortably inside Telegram's 4096 limit even with a long path.
 */
export const MAX_BODY = 700

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
    enabled: file.enabled !== false,
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
 *
 * Only the body is capped, never the prefix: truncating `[repo]` to save
 * characters would destroy the one field that makes the message useful.
 */
export function formatNotice(n: Notice, machine = machineName()): string {
  const parts = [`[${machine}]`, `[${repoName(n.repo)}]`]
  if (n.label) parts.push(`[${n.label}]`)
  const raw = n.message.trim() || '(no message)'
  const body =
    raw.length > MAX_BODY
      ? `${raw.slice(0, MAX_BODY)}… (+${raw.length - MAX_BODY} chars)`
      : raw
  return `${parts.join(' ')} ${body}`
}

/**
 * Shortest token worth hiding as a bare substring.
 *
 * A real Telegram bot token is `\d+:[A-Za-z0-9_-]{35}` — around 46 characters.
 * Redacting anything shorter is not protection, it is corruption: a 1-character
 * token would rewrite the `t` in "telegram" and mangle every message.
 */
export const MIN_REDACT_LEN = 12

/**
 * Strip the bot token out of any string bound for a log, a ledger, or a chat.
 *
 * Telegram puts the token in the URL path (`/bot<TOKEN>/sendMessage`), so every
 * error from `fetch` — including a DNS or TLS failure — embeds it. Without this
 * a transient network blip writes a live credential into `daemon.log`.
 */
export function redactToken(text: string, token?: string): string {
  const t = token?.trim()
  if (!t) return text
  // The URL form is the real leak vector and is unambiguous at any length.
  let out = text.split(`/bot${t}/`).join('/bot<redacted>/')
  if (t.length >= MIN_REDACT_LEN) out = out.split(t).join('<redacted>')
  return out
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

  const fail = (reason: string): NotifyResult => ({
    sent: false,
    // The token is in the request URL, so every failure reason is filtered
    // before it can reach a log line, the ledger, or a chat.
    reason: redactToken(reason, config.token),
    machine,
    repo,
  })

  try {
    const res = await fetchImpl(
      `https://api.telegram.org/bot${config.token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
    )
    if (!res.ok) return fail(`telegram HTTP ${res.status}`)
    return { sent: true, machine, repo }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
}

/**
 * Layered destination for one desk: host default <- group <- repo <- task.
 *
 * The token is *never* taken from a repo layer. It comes from the host
 * `notify.json` or the environment only, so a committed repo config can
 * retarget where a notice goes but can never change who it goes as, and can
 * never carry the secret.
 */
export function resolveNotify(opts: {
  repo: string
  taskNotify?: NotifyOverride
}): { config: NotifyConfig; provenance: NotifyProvenance } {
  const host = loadNotifyConfig()
  const { config: folded, fieldProvenance } = resolveConfig(opts.repo)

  const out: NotifyConfig = {
    // Host-owned, like the token: a repo may narrow this but never re-enable
    // what the machine turned off.
    enabled: host.enabled,
    token: host.token,
    chatId: host.chatId,
    topicId: host.topicId,
  }
  const p: NotifyProvenance = {}

  const from = (field: string): Layer | undefined =>
    fieldProvenance[`notify.${field}`]

  const r = folded.notify
  if (r?.enabled !== undefined) {
    // `enabled` only ever narrows. A layer cannot re-enable what a host or a
    // nearer layer turned off.
    out.enabled = out.enabled && r.enabled !== false
    p.enabled = from('enabled')
  }
  if (r?.chatId) {
    out.chatId = r.chatId
    p.chatId = from('chatId')
  }
  if (r?.topicId !== undefined) {
    out.topicId = r.topicId
    p.topicId = from('topicId')
  }

  // Task is the most specific layer, so it wins last.
  const t = opts.taskNotify
  if (t?.enabled !== undefined) {
    out.enabled = out.enabled && t.enabled !== false
    p.enabled = 'task'
  }
  if (t?.chatId) {
    out.chatId = t.chatId
    p.chatId = 'task'
  }
  if (t?.topicId !== undefined) {
    out.topicId = t.topicId
    p.topicId = 'task'
  }
  return { config: out, provenance: p }
}
