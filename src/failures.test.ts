import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activeFailures, clearFailures, noteFailure } from './failures'

let stateDir: string
let saved: string | undefined

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'herdr-desk-fail-'))
  saved = process.env.HERDR_PLUGIN_STATE_DIR
  process.env.HERDR_PLUGIN_STATE_DIR = stateDir
})

afterEach(() => {
  if (saved === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR
  else process.env.HERDR_PLUGIN_STATE_DIR = saved
  rmSync(stateDir, { recursive: true, force: true })
})

const REPO = '/p/chmonitor'
const TASK = 'local:babysit'
const ERR = 'agent_name_taken: agent name chm-babysit is already used'

describe('noteFailure', () => {
  test('the first sighting of a fault announces', () => {
    expect(noteFailure(REPO, TASK, ERR).announce).toBe(true)
  })

  test('the same fault does not announce again', () => {
    // The live symptom: four identical `agent_name_taken` messages, one per
    // tick, before the first could be read. A fault that cannot fix itself is
    // said once and then counted.
    noteFailure(REPO, TASK, ERR)
    expect(noteFailure(REPO, TASK, ERR).announce).toBe(false)
    expect(noteFailure(REPO, TASK, ERR).announce).toBe(false)
  })

  test('a different fault on the same job does announce', () => {
    // Suppressing by job alone would hide a *new* problem behind an old one.
    noteFailure(REPO, TASK, ERR)
    expect(noteFailure(REPO, TASK, 'socket closed').announce).toBe(true)
  })

  test('the same fault on another job does announce', () => {
    noteFailure(REPO, TASK, ERR)
    expect(noteFailure(REPO, 'local:prod', ERR).announce).toBe(true)
    expect(noteFailure('/p/other', TASK, ERR).announce).toBe(true)
  })

  test('a repeat is still counted, so the hub can report the streak', () => {
    noteFailure(REPO, TASK, ERR)
    noteFailure(REPO, TASK, ERR)
    const v = noteFailure(REPO, TASK, ERR)
    expect(v.count).toBe(3)
    expect(v.repeat).toBe(true)
    expect(activeFailures()).toHaveLength(1)
  })

  test('a job that recovers announces its next failure', () => {
    // Otherwise a fixed desk stays silent about a *new* fault forever, because
    // the old record is still in the ledger.
    noteFailure(REPO, TASK, ERR)
    clearFailures(REPO, TASK)
    expect(noteFailure(REPO, TASK, ERR).announce).toBe(true)
  })

  test("clearing one job leaves another job's record", () => {
    noteFailure(REPO, TASK, ERR)
    noteFailure(REPO, 'local:prod', ERR)
    clearFailures(REPO, TASK)
    expect(noteFailure(REPO, 'local:prod', ERR).announce).toBe(false)
  })
})
