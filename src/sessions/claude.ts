import { join } from 'node:path'
import { entries } from './fs'
import {
  jsonLines,
  obj,
  type SessionReader,
  span,
  str,
  titleLine,
} from './types'

/**
 * Claude Code: `~/.claude/projects/<slug>/<session>.jsonl`, one JSON event per
 * line. The dirs beside those files hold subagent transcripts; they belong to
 * their parent session and are not indexed on their own.
 */
export const claudeReader: SessionReader = {
  agent: 'claude',
  list(home) {
    const root = join(home, '.claude', 'projects')
    return entries(root).flatMap((slug) =>
      entries(join(root, slug))
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => join(root, slug, f)),
    )
  },
  parse(path, text) {
    let id: string | undefined
    let cwd: string | undefined
    let aiTitle: string | undefined
    let firstPrompt: string | undefined
    const stamps: (string | undefined)[] = []
    for (const l of jsonLines(text)) {
      id ??= str(l.sessionId)
      cwd ??= str(l.cwd)
      stamps.push(str(l.timestamp))
      if (l.type === 'ai-title') aiTitle = str(l.aiTitle) ?? aiTitle
      if (!firstPrompt && l.type === 'user' && !l.isMeta && !l.toolUseResult) {
        const t = promptText(obj(l.message).content)
        // `<command-name>`, `<local-command-stdout>`, … are harness echoes.
        if (t && !t.trimStart().startsWith('<')) firstPrompt = t
      }
    }
    if (!id) throw new Error('no sessionId')
    const [started, ended] = span(stamps)
    return [
      {
        agent: 'claude',
        id,
        repo: null,
        cwd,
        started,
        ended,
        title: titleLine(aiTitle ?? firstPrompt ?? ''),
        path,
      },
    ]
  },
}

function promptText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  for (const part of content) {
    const p = obj(part)
    if (p.type === 'text' && typeof p.text === 'string') return p.text
  }
  return undefined
}
