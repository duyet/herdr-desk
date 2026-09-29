import { type Dirent, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Entry names of a dir, or [] when it is missing or unreadable. */
export function entries(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** Every file under `dir` whose name ends in `suffix`, at any depth. */
export function walk(dir: string, suffix: string): string[] {
  let dirents: Dirent[]
  try {
    dirents = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of dirents) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p, suffix))
    else if (e.isFile() && e.name.endsWith(suffix)) out.push(p)
  }
  return out
}
