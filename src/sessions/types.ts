/**
 * One row of the session index. Metadata only: a title (the first user line,
 * trimmed) is the most text ever copied out of an agent's own files.
 */
export type SessionRow = {
  agent: AgentName
  id: string
  /** Git root the session ran in, or null when it cannot be resolved. */
  repo: string | null
  /** Raw working directory from the source, before git-root resolution. */
  cwd?: string
  /** Gemini names its project dir by sha256(project path) instead of a cwd. */
  projectHash?: string
  started: string
  ended: string
  title: string
  path: string
}

export type AgentName = 'claude' | 'codex' | 'gemini' | 'grok' | 'desk'

/**
 * A reader lists the source files it owns and turns one file's text into rows.
 * `parse` throws on a file it does not understand; the indexer counts that as
 * skipped and moves on, so one odd file never stops the index.
 */
export type SessionReader = {
  agent: AgentName
  list(home: string, stateDir: string): string[]
  parse(path: string, text: string): SessionRow[]
}

export const TITLE_MAX = 80

/**
 * Obvious secrets a pasted prompt may carry: vendor-prefixed tokens
 * (`sk-…`, `ghp_…`, `github_pat_…`, `xoxb-…`, `AKIA…`) and any hex/base64-ish
 * run longer than 32 chars.
 */
const SECRET_PATTERNS = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{8,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  /[A-Za-z0-9+/_=-]{33,}/g,
]

export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((t, re) => t.replace(re, '[redacted]'), text)
}

/**
 * A title is prompt text, so it is kept to one line, secrets redacted, and
 * capped at `TITLE_MAX`.
 */
export function titleLine(text: string): string {
  const line =
    text
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .find((l) => l.length > 0) ?? ''
  const safe = redactSecrets(line)
  return safe.length > TITLE_MAX ? `${safe.slice(0, TITLE_MAX - 1)}…` : safe
}

/** Parse JSONL, dropping lines that are not JSON objects. */
export function jsonLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const v = JSON.parse(line)
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v)
    } catch {
      // a torn last line while the agent is still writing; skip it
    }
  }
  return out
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

export function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {}
}

/** Earliest and latest valid timestamp in a list; throws when there is none. */
export function span(stamps: (string | undefined)[]): [string, string] {
  const valid = stamps
    .filter((s): s is string => !!s && !Number.isNaN(Date.parse(s)))
    .sort((a, b) => Date.parse(a) - Date.parse(b))
  if (!valid.length) throw new Error('no timestamps')
  return [valid[0], valid[valid.length - 1]]
}
