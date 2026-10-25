import { describe, expect, test } from 'bun:test'
import { launchKind, transcriptReaders } from './agents'

describe('launchKind', () => {
  // `agent start --kind` only accepts Herdr's built-in kinds. anyrouter's
  // `kind: "opencode2"` was passed through verbatim, so every spawn failed
  // inside Herdr. The ladder must skip rungs Herdr cannot start.
  test('skips rungs that are not Herdr agent kinds', () => {
    expect(launchKind(['opencode2', 'anyr claude --yolo', 'claude'])).toBe(
      'claude',
    )
  })

  test('fails loud when no rung is a Herdr agent kind', () => {
    expect(() => launchKind(['opencode2'])).toThrow(/opencode2/)
  })
})

describe('transcriptReaders', () => {
  // The session index reads what the kind table says it can, so a reader added
  // to a row is indexed without a second list to keep in step.
  test('come from the kind table', () => {
    expect(transcriptReaders().map((r) => r.agent)).toEqual([
      'claude',
      'codex',
      'gemini',
      'grok',
    ])
  })
})
