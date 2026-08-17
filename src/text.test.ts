import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deskSlug, looksLikePath, resolveText } from './text'

describe('looksLikePath', () => {
  test('files vs inline', () => {
    expect(looksLikePath('notes.md')).toBe(true)
    expect(looksLikePath('./extra.md')).toBe(true)
    expect(looksLikePath('Children never deploy.')).toBe(false)
    expect(looksLikePath('# Heading\nbody')).toBe(false)
  })
})

describe('resolveText', () => {
  test('reads a file when it exists', () => {
    const dir = join(tmpdir(), `desk-text-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'extra.md'), 'from-file')
    expect(resolveText(dir, 'extra.md')).toEqual({
      kind: 'file',
      text: 'from-file',
      path: join(dir, 'extra.md'),
    })
  })

  test('inline when not a file', () => {
    expect(resolveText('/tmp', 'Children never deploy.')).toEqual({
      kind: 'inline',
      text: 'Children never deploy.',
    })
  })
})

describe('deskSlug', () => {
  test('name to agent', () => {
    expect(deskSlug('chmonitor')).toBe('chmonitor-desk')
  })
})
