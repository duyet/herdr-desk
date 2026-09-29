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
/**
 * Inside code and pre, MarkdownV2 requires exactly `` ` `` and `\` escaped.
 * An unescaped trailing `\` would escape the closing backtick and 400.
 */
const escCode = (t: string): string => t.replace(/[`\\]/g, '\\$&')

/** `` `code` `` — only a backtick or backslash is escaped. */
export function code(t: string): string {
  return `\`${escCode(t)}\``
}

/** Fenced block, optionally with a language for highlighting. */
export function pre(body: string, lang = ''): string {
  return `\`\`\`${lang}\n${escCode(body)}\n\`\`\``
}

/**
 * Cut escaped text to at most `max` UTF-16 units without breaking it.
 *
 * A plain `slice` can end between `\` and the character it escapes, leaving a
 * lone backslash that escapes whatever is appended next, or between the two
 * halves of an emoji. Either makes Telegram reject the message.
 */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  let out = text.slice(0, max)
  if (/[\ud800-\udbff]$/.test(out)) out = out.slice(0, -1)
  const slashes = /\\*$/.exec(out)?.[0].length ?? 0
  if (slashes % 2 === 1) out = out.slice(0, -1)
  return out
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

/** Searchable in a busy channel. Exported so any renderer agrees on the name. */
export const LEVEL_TAG: Record<NoticeLevel, string> = {
  ok: '#ok',
  fail: '#fail',
  blocked: '#blocked',
  skip: '#skip',
  info: '#info',
}

/** Emoji are the only colour available in message text. */
export const LEVEL_DOT: Record<NoticeLevel, string> = {
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

type PlainToken = { mark?: string; text: string }

/** Unescape inside code and pre, where only `` ` `` and `\` are escapes. */
const unescCode = (t: string): string => t.replace(/\\([`\\])/g, '$1')

/** Index of the next unescaped `ch` at or after `from`, or -1. */
function findUnescaped(s: string, ch: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\\') {
      i++
      continue
    }
    if (s[i] === ch) return i
  }
  return -1
}

/**
 * Render MarkdownV2 as the text a reader would have seen, without markup.
 *
 * Used for the plain-text retry after Telegram rejects a message. Sending the
 * MarkdownV2 source as plain text shows every `\-` and `\.` as a literal
 * backslash, and throwing the markup away with a regex eats real `*` and `_`
 * that were escaped on purpose. So this is a single left-to-right scan:
 * an escape is resolved before any markup is recognised, links keep their URL
 * as `label (url)`, and a marker without a partner stays literal.
 *
 * The input is malformed by definition — that is why Telegram rejected it — and
 * may have been cut mid-link, so nothing here throws; anything that does not
 * parse is emitted as it stands.
 */
export function toPlain(md: string): string {
  const tokens: PlainToken[] = []
  const text = (t: string) => tokens.push({ text: t })
  let i = 0
  while (i < md.length) {
    const lineStart = i === 0 || md[i - 1] === '\n'
    if (lineStart && md.startsWith('**>', i)) {
      i += md[i + 3] === ' ' ? 4 : 3
      continue
    }
    if (lineStart && md[i] === '>') {
      i += md[i + 1] === ' ' ? 2 : 1
      continue
    }
    const c = md[i]
    if (c === '\\') {
      text(i + 1 < md.length ? md[i + 1] : '\\')
      i += 2
      continue
    }
    if (md.startsWith('```', i)) {
      const end = md.indexOf('```', i + 3)
      if (end !== -1) {
        let inner = md.slice(i + 3, end)
        const nl = inner.indexOf('\n')
        // The first line of a fence is its language, not content.
        if (nl !== -1) inner = inner.slice(nl + 1)
        text(unescCode(inner.replace(/\n$/, '')))
        i = end + 3
        continue
      }
    }
    if (c === '`') {
      const end = findUnescaped(md, '`', i + 1)
      if (end !== -1) {
        text(unescCode(md.slice(i + 1, end)))
        i = end + 1
        continue
      }
    }
    if (c === '[') {
      const close = findUnescaped(md, ']', i + 1)
      if (close !== -1 && md[close + 1] === '(') {
        const end = findUnescaped(md, ')', close + 2)
        if (end !== -1) {
          const label = toPlain(md.slice(i + 1, close))
          const url = md.slice(close + 2, end).replace(/\\(.)/g, '$1')
          text(label === url ? url : `${label} (${url})`)
          i = end + 1
          continue
        }
      }
    }
    if (md.startsWith('__', i) || md.startsWith('||', i)) {
      tokens.push({ mark: md.slice(i, i + 2), text: md.slice(i, i + 2) })
      i += 2
      continue
    }
    if (c === '*' || c === '_' || c === '~') {
      tokens.push({ mark: c, text: c })
      i += 1
      continue
    }
    text(c)
    i += 1
  }

  // Markers pair up in order; an odd one out was never markup.
  const byKind = new Map<string, PlainToken[]>()
  for (const t of tokens) {
    if (!t.mark) continue
    const list = byKind.get(t.mark) ?? []
    list.push(t)
    byKind.set(t.mark, list)
  }
  for (const list of byKind.values()) {
    const paired = list.length - (list.length % 2)
    for (let k = 0; k < paired; k++) list[k].text = ''
  }
  return tokens.map((t) => t.text).join('')
}
