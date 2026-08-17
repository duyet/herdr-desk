import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dayKey } from './day'
import { discoverDesks } from './discover'
import { runDirFor } from './run'

const NAMES = ['changes.md', 'CHANGES.md', 'SUMMARY.md', 'summary.md']

export async function readLastChanges(): Promise<string> {
  const desks = await discoverDesks()
  const day = dayKey()
  const parts: string[] = []
  for (const d of desks) {
    for (const t of d.config.tasks) {
      const dir = runDirFor(d.repo, t, day)
      const file = NAMES.map((n) => join(dir, n)).find((p) => existsSync(p))
      parts.push(`## ${d.config.name} / ${t.id}  (${day})`)
      parts.push(
        file
          ? readFileSync(file, 'utf8').trim()
          : `_no changes.md yet in ${dir}_`,
      )
      parts.push('')
    }
  }
  return parts.join('\n').trim() || 'no desks'
}
