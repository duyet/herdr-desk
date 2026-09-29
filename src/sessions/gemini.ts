import { basename, dirname, join } from 'node:path'
import { entries } from './fs'
import {
  obj,
  type SessionReader,
  type SessionRow,
  span,
  str,
  titleLine,
} from './types'

/**
 * Gemini CLI: `~/.gemini/tmp/<sha256(project path)>/logs.json`, a JSON array
 * of `{sessionId, messageId, type, message, timestamp}` user-prompt records
 * for every session of that project. There is no cwd, only the hash; the
 * indexer matches it against paths the other agents report.
 */
export const geminiReader: SessionReader = {
  agent: 'gemini',
  list(home) {
    const root = join(home, '.gemini', 'tmp')
    return entries(root)
      .filter((h) => entries(join(root, h)).includes('logs.json'))
      .map((h) => join(root, h, 'logs.json'))
  },
  parse(path, text) {
    const data: unknown = JSON.parse(text)
    if (!Array.isArray(data)) throw new Error('logs.json is not an array')
    const bySession = new Map<string, Record<string, unknown>[]>()
    for (const item of data) {
      const r = obj(item)
      const id = str(r.sessionId)
      if (id) bySession.set(id, [...(bySession.get(id) ?? []), r])
    }
    const projectHash = basename(dirname(path))
    const rows: SessionRow[] = []
    for (const [id, recs] of bySession) {
      const [started, ended] = span(recs.map((r) => str(r.timestamp)))
      const first = recs.find((r) => r.type === 'user' && str(r.message))
      rows.push({
        agent: 'gemini',
        id,
        repo: null,
        projectHash,
        started,
        ended,
        title: titleLine(str(first?.message) ?? ''),
        path,
      })
    }
    if (!rows.length) throw new Error('no sessions')
    return rows
  },
}
