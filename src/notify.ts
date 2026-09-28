import { existsSync, readFileSync } from 'node:fs'
import { hostname, userInfo } from 'node:os'
import { basename, join } from 'node:path'
import type { NotifyOverride } from './config'

import { esc, link } from './format'
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

/** Where each destination field came from, for `config explain`. */
export type NotifyProvenance = {
  enabled?: string
  chatId?: string
  topicId?: string
}

export const NOTIFY_CONFIG_FILE = 'notify.json'

export type NotifyResult = {
  sent: boolean
  /** Why nothing was sent, or a caveat when it was sent degraded. */
  reason?: string
  machine: string
  repo: string
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
  /**
   * Primary link — a PR, issue, run, or doc. Rendered as the headline's anchor
   * so the message is one tap from the thing it describes.
   */
  url?: string
  /**
   * Send the body as Telegram MarkdownV2. Default true.
   *
   * A parse failure is retried once as plain text rather than losing the notice.
   */
  markdown?: boolean
}

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
 * The header is a `·`-separated breadcrumb rather than `[a] [b] [c]`. Brackets
 * are reserved in MarkdownV2 and force an escape on every notice, and a shared
 * channel is read by scanning, not parsing: repo is bold because it is the
 * field a reader with five lanes open actually looks for first.
 *
 * Only the body is capped, never the header: truncating the repo to save
 * characters would destroy the one field that makes the message useful.
 *
 * Two forms are produced on purpose. The MarkdownV2 form escapes the header,
 * because `·` and any punctuation in a repo or task id may be reserved. But
 * those same escapes would appear as literal backslashes if the message were
 * sent as plain text, so the plain form is built separately rather than by
 * stripping escapes from the other.
 */
export function formatNotice(n: Notice, machine = machineName()): string {
  return render(n, machine, esc)
}

/** Unescaped, markup-free text, for the plain-text retry. */
export function formatNoticePlain(n: Notice, machine = machineName()): string {
  return render(n, machine, (s) => s)
}

/**
 * Display text for a link: the URL minus its scheme and `www.`.
 *
 * `https://github.com/duyet/anyrouter/pull/3651` reads as
 * `github.com/duyet/anyrouter/pull/3651` — still enough to recognise at a
 * glance, and short enough not to wrap. A non-URL falls back to the raw string.
 */
export function linkLabel(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/^www\./, '')
}

function render(
  n: Notice,
  machine: string,
  safe: (s: string) => string,
): string {
  const bold = safe === esc
  const out = [header(n, machine, safe, bold), body(n)]
  if (n.url) {
    const shown = linkLabel(n.url)
    out.push(bold ? `→ ${link(shown, n.url)}` : `→ ${shown}`)
  }
  return out.filter((line) => line !== '').join('\n')
}

function header(
  n: Notice,
  machine: string,
  safe: (s: string) => string,
  bold: boolean,
): string {
  const parts = [
    bold ? `*${safe(repoName(n.repo))}*` : safe(repoName(n.repo)),
    safe(shortMachine(machine)),
  ]
  if (n.label) parts.push(bold ? `\`${safe(n.label)}\`` : safe(n.label))
  return parts.join(' · ')
}

/**
 * Drop the `(user)` suffix from `machineName()` for display.
 *
 * The user is the same on every host this runs on, so repeating it in every
 * notice is noise; the hostname is the field that distinguishes a message from
 * another machine's.
 */
function shortMachine(machine: string): string {
  return machine.replace(/\s*\([^)]*\)\s*$/, '')
}

function body(n: Notice): string {
  const raw = n.message.trim() || '(no message)'
  return raw.length > MAX_BODY
    ? `${raw.slice(0, MAX_BODY)}… (+${raw.length - MAX_BODY} chars)`
    : raw
}

/**
 * Shortest token worth hiding as a bare substring.
 *
 * A real Telegram bot token is `\d+:[A-Za-z0-9_-]{35}` — around 46 characters.
 * Redacting anything shorter is not protection, it is corruption: a 1-character
 * token would rewrite the `t` in "telegram" and mangle every message.
 */
export const MIN_REDACT_LEN = 12

/** A notice reason is a sentence on a phone, not a log line. */
export const MAX_REASON = 120

/**
 * Turn an internal reason into something worth reading on a phone.
 *
 * The reasons this plugin generates are written for `daemon.log`, where the
 * full sentence and the absolute path are exactly what you want. Forwarded
 * verbatim to a channel they arrive as a paragraph of internal vocabulary:
 * `no open Herdr session for anyrouter (/Users/duyet/project/anyrouter) — skip;
 * will not create a sibling Space`. Three lines of the machine talking to
 * itself, repeated for every job, for a condition that did not change.
 *
 * Paths collapse to their last segment, which is usually the thing being named
 * anyway, and the rest is capped. URLs are protected first: shortening a path
 * must not reduce a PR link to a bare `#418`.
 */
export function briefReason(text: string, max = MAX_REASON): string {
  const shortened = humanizeHerdr(text)
    .split(/\s+/)
    .filter(Boolean)
    .map(shortenPathToken)
    .join(' ')
  if (shortened.length <= max) return shortened
  return `${shortened.slice(0, max - 1).trimEnd()}\u2026`
}

/**
 * Herdr's own error code, when the message carries one.
 *
 * `agent start` rejects a taken name with a machine-shaped message —
 * `{"error":{"code":"agent_name_taken","message":"agent name chm-babysit is
 * already used; candidates: terminal_id=…"}}` — which truncated on a phone
 * reads as a wall of escaped punctuation and tells the reader nothing. The
 * `code` is the one field that names the fault in a word, so it is lifted to
 * the front and the raw payload is dropped.
 */
const HERDR_ERROR = /"code"\s*:\s*"([a-z0-9_]+)"/
const HERDR_MESSAGE = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/

/**
 * Turn a Herdr failure into one readable line.
 *
 * Only the shape Herdr actually produces is rewritten. Anything else is passed
 * through untouched, because this runs on messages that are already prose and a
 * clever guess would only corrupt the cases that were fine.
 *
 * The trailing `candidates:` dump is dropped: it lists every terminal, pane and
 * workspace on the machine, which is what pushed the useful part past the cap.
 * The pane and session that matter are in the full error in `daemon.log`.
 */
export function humanizeHerdr(text: string): string {
  const brace = text.indexOf('{')
  if (brace === -1) return text
  const body = text.slice(brace)
  const code = HERDR_ERROR.exec(body)?.[1]
  if (!code) return text
  const detail = HERDR_MESSAGE.exec(body)?.[1]
  const cleaned = (detail ?? '')
    .replace(/\\"/g, '"')
    .replace(/;?\s*candidates:.*$/i, '')
    .trim()
  return cleaned ? `${code}: ${cleaned}` : code
}

/**
 * `/Users/duyet/project/anyrouter` becomes `anyrouter`, keeping trailing
 * punctuation so `(~/project/anyrouter) - skip` still reads as `(anyrouter)`.
 *
 * URLs are left completely alone. A PR link is the most useful thing in the
 * whole message, and a path-shortening pass that reduced it to `#418` would
 * destroy the one field worth tapping.
 */
function shortenPathToken(word: string): string {
  if (/^https?:\/\//i.test(word)) return word
  const cut = word.lastIndexOf('/')
  if (cut <= 0) return word
  const head = /^[([{]+/.exec(word)?.[0] ?? ''
  const tail = /[).,;:!?]+$/.exec(word)?.[0] ?? ''
  const end = word.length - tail.length
  // Nothing left between the separators, e.g. a bare `//`.
  if (end <= cut + 1) return word
  return head + word.slice(cut + 1, end) + tail
}

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
  const plainText = formatNoticePlain(n, machine)

  if (!config.enabled) return { sent: false, reason: 'disabled', machine, repo }
  if (!config.token || !config.chatId) {
    return {
      sent: false,
      reason: `not configured (set token + chatId in ${NOTIFY_CONFIG_FILE})`,
      machine,
      repo,
    }
  }

  const useMarkdown = n.markdown !== false
  const base: Record<string, unknown> = {
    chat_id: config.chatId,
    text,
    disable_web_page_preview: true,
  }
  if (config.topicId) base.message_thread_id = Number(config.topicId)
  if (useMarkdown) base.parse_mode = 'MarkdownV2'

  const fail = (reason: string): NotifyResult => ({
    sent: false,
    // The token is in the request URL, so every failure reason is filtered
    // before it can reach a log line, the ledger, or a chat.
    reason: redactToken(reason, config.token),
    machine,
    repo,
  })

  const post = async (body: Record<string, unknown>) =>
    fetchImpl(`https://api.telegram.org/bot${config.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  try {
    const res = await post(base)
    if (res.ok) return { sent: true, machine, repo }

    // A 400 here is almost always "can't parse entities": an unbalanced `*` or
    // `_` in a title or path. Retry once as plain text so the notice still
    // lands. Only 400 is retried — a 403/401 will fail identically, and a 5xx
    // may have been delivered, so re-sending either risks a duplicate.
    if (useMarkdown && res.status === 400) {
      // Rebuild rather than strip: the markdown text is escaped for MarkdownV2
      // and those escapes would show as literal backslashes in plain text.
      const { parse_mode: _dropped, ...plain } = base
      plain.text = plainText
      const retry = await post(plain)
      if (retry.ok) {
        return {
          sent: true,
          machine,
          repo,
          reason: 'markdown rejected; sent as plain text',
        }
      }
      return fail(`telegram HTTP ${retry.status}`)
    }
    return fail(`telegram HTTP ${res.status}`)
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

/** Re-exported so callers build bodies without importing two modules. */
export { noticeBody } from './format'
