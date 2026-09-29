import { join } from 'node:path'
import { entries } from './fs'
import { obj, type SessionReader, span, str, titleLine } from './types'

/**
 * Grok: `~/.grok/sessions/<url-encoded cwd>/<session id>/summary.json`. The
 * summary carries id, cwd, git root, timestamps and a generated title. Its
 * `session_summary` / `last_turn_summary` fields are model-written prose about
 * the conversation and are deliberately never read.
 */
export const grokReader: SessionReader = {
  agent: 'grok',
  list(home) {
    const root = join(home, '.grok', 'sessions')
    return entries(root).flatMap((dir) =>
      entries(join(root, dir))
        .filter((s) => entries(join(root, dir, s)).includes('summary.json'))
        .map((s) => join(root, dir, s, 'summary.json')),
    )
  },
  parse(path, text) {
    const s = obj(JSON.parse(text))
    const info = obj(s.info)
    const id = str(info.id)
    if (!id) throw new Error('no info.id')
    const [started, ended] = span([
      str(s.created_at),
      str(s.last_active_at) ?? str(s.updated_at),
    ])
    return [
      {
        agent: 'grok',
        id,
        repo: null,
        cwd: str(s.git_root_dir) ?? str(info.cwd),
        started,
        ended,
        title: titleLine(str(s.generated_title) ?? ''),
        path,
      },
    ]
  },
}
