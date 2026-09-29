import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  jsonLines,
  type SessionReader,
  type SessionRow,
  str,
  titleLine,
} from './types'

/** The desk's own ledger, `runs.jsonl`: one row per fire. */
export const deskReader: SessionReader = {
  agent: 'desk',
  list(_home, stateDir) {
    const p = join(stateDir, 'runs.jsonl')
    return existsSync(p) ? [p] : []
  },
  parse(path, text) {
    const rows: SessionRow[] = []
    for (const r of jsonLines(text)) {
      const at = str(r.at)
      const task = str(r.task)
      if (!at || !task || Number.isNaN(Date.parse(at))) continue
      const detail = str(r.detail)
      rows.push({
        agent: 'desk',
        id: `${at}:${task}`,
        repo: null,
        cwd: str(r.repo),
        started: at,
        ended: at,
        title: titleLine(
          `${task} ${r.ok ? 'ok' : 'failed'}${detail ? `: ${detail}` : ''}`,
        ),
        path,
      })
    }
    return rows
  },
}
