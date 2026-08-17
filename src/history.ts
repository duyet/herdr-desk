import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pluginStateDir } from './paths'

export type RunRecord = {
  at: string
  name: string
  repo: string
  task: string
  mode: string
  ok: boolean
  detail?: string
}

const MAX = 200

export function historyPath(): string {
  return join(pluginStateDir(), 'runs.jsonl')
}

export function appendRun(rec: RunRecord): void {
  mkdirSync(pluginStateDir(), { recursive: true })
  writeFileSync(historyPath(), `${JSON.stringify(rec)}\n`, { flag: 'a' })
}

export function loadRuns(limit = 40): RunRecord[] {
  if (!existsSync(historyPath())) return []
  const lines = readFileSync(historyPath(), 'utf8').trim().split('\n').filter(Boolean)
  const slice = lines.slice(-Math.max(1, Math.min(limit, MAX)))
  const out: RunRecord[] = []
  for (const line of slice) {
    try {
      out.push(JSON.parse(line) as RunRecord)
    } catch {
      /* skip bad line */
    }
  }
  return out
}

export function formatHistory(runs: RunRecord[]): string {
  if (runs.length === 0) return 'no runs yet'
  return runs
    .map((r) => {
      const mark = r.ok ? 'ok' : 'fail'
      const extra = r.detail ? `  ${r.detail}` : ''
      return `${r.at}  ${mark}  ${r.name}/${r.task}  ${r.mode}${extra}`
    })
    .join('\n')
}
