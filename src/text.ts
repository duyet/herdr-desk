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
