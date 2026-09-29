import { join } from 'node:path'
import { walk } from './fs'
import {
  jsonLines,
  obj,
  type SessionReader,
  span,
  str,
  titleLine,
} from './types'

/**
 * Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. One line is a
 * `session_meta` record with id and cwd; user prompts are `event_msg` records
 * whose payload type is `user_message`.
 */
export const codexReader: SessionReader = {
  agent: 'codex',
  list(home) {
    return walk(join(home, '.codex', 'sessions'), '.jsonl')
  },
  parse(path, text) {
    const lines = jsonLines(text)
    const meta = obj(lines.find((l) => l.type === 'session_meta')?.payload)
    const id = str(meta.id)
    if (!id) throw new Error('no session_meta')
    let firstPrompt: string | undefined
    for (const l of lines) {
      const p = obj(l.payload)
      if (l.type === 'event_msg' && p.type === 'user_message') {
        firstPrompt = str(p.message)
        if (firstPrompt) break
      }
    }
    const [started, ended] = span([
      str(meta.timestamp),
      ...lines.map((l) => str(l.timestamp)),
    ])
    return [
      {
        agent: 'codex',
        id,
        repo: null,
        cwd: str(meta.cwd),
        started,
        ended,
        title: titleLine(firstPrompt ?? ''),
        path,
      },
    ]
  },
}
