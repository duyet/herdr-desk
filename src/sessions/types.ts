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

export const TITLE_MAX = 120

/** First non-empty line, whitespace collapsed, capped at `TITLE_MAX`. */
export function titleLine(text: string): string {
  const line =
    text
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .find((l) => l.length > 0) ?? ''
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line
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
