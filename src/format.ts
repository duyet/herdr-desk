/**
 * Telegram message formatting.
 *
 * Telegram has no colour in message text. `Markdown`, `MarkdownV2`, and `HTML`
 * cover weight, underline, strike, spoiler, code, pre, links, and quotes — that
 * is the whole list. Emoji are the only marks that render in colour.
 *
 * MarkdownV2 is used rather than the legacy `Markdown` mode because legacy
 * silently renders `__underline__`, `~strike~`, and `||spoiler||` as literal
 * characters instead of rejecting them. A 200 from the API therefore does not
 * mean the formatting worked; only MarkdownV2 actually applies all of them.
 *
 * The cost of MarkdownV2 is that it reserves 18 characters, so every piece of
 * untrusted text must go through {@link esc}. Unescaped input is how a notice
 * gets rejected outright with a 400 and silently lost.
 */

/** Characters MarkdownV2 treats as markup. Escape these in untrusted text. */
const MDV2_SPECIAL = /([_*[\]()~`>#+\-=|{}.!\\])/g

/** Escape text that came from outside this module. */
export function esc(text: string): string {
  return text.replace(MDV2_SPECIAL, '\\$1')
}

/** `*bold*` */
export const bold = (t: string): string => `*${esc(t)}*`
/** `_italic_` */
export const italic = (t: string): string => `_${esc(t)}_`
/** `__underline__` — MarkdownV2 only. */
export const underline = (t: string): string => `__${esc(t)}__`
/** `~strike~` — MarkdownV2 only. */
export const strike = (t: string): string => `~${esc(t)}~`
/** `||spoiler||` — MarkdownV2 only. */
export const spoiler = (t: string): string => `||${esc(t)}||`
/** `` `code` `` — a backtick is escaped, the content is not. */
export function code(t: string): string {
  return `\`${t.replace(/`/g, '\\`')}\``
}

/** Fenced block, optionally with a language for highlighting. */
export function pre(body: string, lang = ''): string {
  return `\`\`\`${lang}\n${body.replace(/`/g, '\\`')}\n\`\`\``
}

/** `[label](url)`. A bad URL is downgraded to plain text rather than 400ing. */
export function link(label: string, url: string): string {
  if (!/^https?:\/\/\S+$/.test(url)) return esc(label)
  return `[${esc(label)}](${url.replace(/[()]/g, '\\$&')})`
}

/** `> quoted` */
export const quote = (t: string): string =>
  t
    .split('\n')
    .map((l) => `> ${esc(l)}`)
    .join('\n')

/** `**> collapsed` — a quote the reader expands on tap. MarkdownV2 only. */
export const expandableQuote = (t: string): string =>
  t
    .split('\n')
    .map((l) => `**> ${esc(l)}`)
    .join('\n')

/** A `#tag`. Telegram only permits word characters after the hash. */
export function tag(t: string): string {
  return `#${t.replace(/[^\w]/g, '')}`
}

export type NoticeLevel = 'ok' | 'fail' | 'blocked' | 'skip' | 'info'

const LEVEL_TAG: Record<NoticeLevel, string> = {
  ok: '#ok',
  fail: '#fail',
  blocked: '#blocked',
  skip: '#skip',
  info: '#info',
}

/** Emoji are the only colour available in message text. */
const LEVEL_DOT: Record<NoticeLevel, string> = {
  ok: '🟢',
  fail: '🔴',
  blocked: '🟠',
  skip: '⚪',
  info: '🔵',
}

export type NoticeBody = {
  level: NoticeLevel
  headline: string
  /** Bulleted detail lines. Escaped. */
  items?: string[]
  /** `label -> url` pairs, rendered as a compact link list. */
  links?: Array<[string, string]>
  /** Command or snippet shown as a highlighted block. */
  snippet?: { body: string; lang?: string }
  /** Extra searchable tags. */
  tags?: string[]
  /** Set false to omit the coloured dot. */
  dot?: boolean
}

/**
 * A notice body: verdict, detail, links, snippet, tags.
 *
 * The tag is the load-bearing part, not the dot. A screen reader announces
 * "green circle" rather than "succeeded", so colour is an aid for scanning and
 * `#fail` is what you actually search on.
 */
export function noticeBody(parts: NoticeBody): string {
  const dot = parts.dot === false ? '' : `${LEVEL_DOT[parts.level]} `
  const out: string[] = [`${dot}${bold(parts.level)} ${esc(parts.headline)}`]
  for (const item of parts.items ?? []) {
    if (item.trim()) out.push(`• ${esc(item.trim())}`)
  }
  for (const [label, url] of parts.links ?? []) {
    out.push(`• ${link(label, url)}`)
  }
  if (parts.snippet) {
    out.push('', pre(parts.snippet.body, parts.snippet.lang))
  }
  out.push([LEVEL_TAG[parts.level], ...(parts.tags ?? []).map(tag)].join(' '))
  return out.join('\n')
}
