import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isStaleClaim, tryClaim } from './claim'

const dirs: string[] = []
function lockPath(): string {
  const d = mkdtempSync(join(tmpdir(), 'desk-claim-'))
  dirs.push(d)
  return join(d, 'runs', 'spawn.lock')
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const MAX = 60_000
const alive = () => true
const dead = () => false

describe('tryClaim', () => {
  test('two contenders: exactly one wins', () => {
    const p = lockPath()
    const first = tryClaim(p, MAX, 1000, alive)
    const second = tryClaim(p, MAX, 1001, alive)
    expect(first).not.toBeNull()
    expect(second).toBeNull()
  })

  test('released claims can be taken again', () => {
    const p = lockPath()
    tryClaim(p, MAX, 1000, alive)?.release()
    expect(existsSync(p)).toBe(false)
    expect(tryClaim(p, MAX, 2000, alive)).not.toBeNull()
  })

  test('a claim whose process died is taken over', () => {
    const p = lockPath()
    expect(tryClaim(p, MAX, 1000, alive)).not.toBeNull()
    expect(tryClaim(p, MAX, 1001, dead)).not.toBeNull()
    expect(JSON.parse(readFileSync(p, 'utf8')).at).toBe(1001)
  })

  test('a claim older than its max age is taken over', () => {
    const p = lockPath()
    tryClaim(p, MAX, 1000, alive)
    expect(tryClaim(p, MAX, 1000 + MAX + 1, alive)).not.toBeNull()
  })

  test('release after a takeover leaves the new holder alone', () => {
    const p = lockPath()
    const old = tryClaim(p, MAX, 1000, alive)
    tryClaim(p, MAX, 1000 + MAX + 1, alive)
    old?.release()
    expect(JSON.parse(readFileSync(p, 'utf8')).at).toBe(1000 + MAX + 1)
  })
})

describe('isStaleClaim', () => {
  test('missing is not stale, garbage is', () => {
    const p = lockPath()
    expect(isStaleClaim(p, MAX)).toBe(false)
    tryClaim(p, MAX, 1000, alive)?.release()
    writeFileSync(p, 'not json')
    expect(isStaleClaim(p, MAX)).toBe(true)
  })
})
