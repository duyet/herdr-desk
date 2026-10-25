import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

export type TextSource = {
  kind: 'none' | 'file' | 'inline'
  text: string
  path?: string
}

/** Path-like (no newlines) vs markdown body. Missing files fall through to inline. */
export function looksLikePath(value: string): boolean {
  if (!value || value.includes('\n') || value.includes('\r')) return false
  const t = value.trim()
  if (!t || t.length > 240) return false
  if (t.startsWith('#') || t.startsWith('- ')) return false
  return (
    t.startsWith('./') ||
    t.startsWith('../') ||
    t.startsWith('/') ||
    /\.(md|txt)$/i.test(t)
  )
}

export function resolveText(
  repo: string,
  value: string | undefined,
): TextSource {
  if (!value?.trim()) return { kind: 'none', text: '' }
  if (looksLikePath(value)) {
    const path = isAbsolute(value.trim())
      ? value.trim()
      : join(repo, value.trim())
    if (existsSync(path)) {
      return { kind: 'file', text: readFileSync(path, 'utf8'), path }
    }
  }
  return { kind: 'inline', text: value }
}

export function deskSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20)
  const agent = `${slug || 'repo'}-desk`.slice(0, 32)
  return /^[a-z]/.test(agent) ? agent : `d-${agent}`.slice(0, 32)
}

/**
 * Default Herdr name for one task's manager: the desk name plus the task id.
 *
 * Every task used to default to `deskSlug(name)`, so two jobs of one desk
 * prompted the same session. A name past 32 characters is cut and gets a hash
 * of the full id, so two long ids that share a prefix still differ. `summary`
 * is reserved for the desk summary session.
 */
export function taskAgentName(deskName: string, taskId: string): string {
  const base = deskSlug(deskName)
  let id = taskId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!id) id = 'task'
  if (id === 'summary') id = 'task-summary'
  const full = `${base}-${id}`
  if (full.length <= 32) return full
  const hash = Bun.hash(taskId).toString(36).slice(0, 6)
  return `${full.slice(0, 32 - hash.length - 1).replace(/-+$/, '')}-${hash}`
}
