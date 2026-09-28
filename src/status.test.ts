import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LoadedDesk } from './config'
import type { Discovered } from './discover'
import { historyPath, loadRuns, type RunRecord } from './history'
import { formatSchedule } from './status'

const LAST = 4

function cells(row: string): string[] {
  return row
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim())
}

/** The `Last` cell of the first data row. */
function lastCell(out: string): string {
  const [row = ''] = out.split('\n').slice(2)
  return cells(row)[LAST] ?? ''
}

function withLedger(write: () => void, run: () => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'desk-last-'))
  const prev = process.env.HERDR_PLUGIN_STATE_DIR
  process.env.HERDR_PLUGIN_STATE_DIR = dir
  try {
    write()
    run()
  } finally {
    if (prev === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR
    else process.env.HERDR_PLUGIN_STATE_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  }
}

function desk(repo: string, name: string, task: string): Discovered {
  const config: LoadedDesk = {
    name,
    tasks: [
      {
        id: task,
        playbook: 'github-issues',
        agentName: `${name}-desk`,
        agent: { ladder: ['grok'], permission: 'default' },
        crons: ['0 7 * * *'],
      },
    ],
  }
  return {
    repo,
    configPath: join(repo, '.herdr-desk.json'),
    config,
    source: 'workspace',
  }
}

function rec(
  partial: Partial<RunRecord> & { at: string; ok: boolean },
): RunRecord {
  return {
    name: 'anyrouter',
    repo: '/src/anyrouter',
    task: 'local:prod-health',
    mode: 'run',
    ...partial,
  }
}

describe('formatSchedule Last column', () => {
  test('is the job’s own last run, not one crowded out by other jobs', () => {
    // Regression. The ledger is shared, so a busy desk pushes a quiet job's
    // last fire out of any global tail. `Last` then read `never` for a job that
    // had fired — and because #35 fixed the streak per job, the same row could
    // read `never` next to `Fails 1`. Measured on the real runs.jsonl: 10 of 23
    // jobs fell outside the 200-record window, and two of those had failed
    // last. anyrouter local:prod-health is one of them.
    withLedger(
      () => {
        const lines = [
          JSON.stringify(
            rec({ at: '2026-09-27T17:13:15.602Z', ok: false, detail: 'boom' }),
          ),
        ]
        const base = Date.parse('2026-09-28T09:48:10.555Z')
        for (let i = 0; i < 250; i++) {
          lines.push(
            JSON.stringify(
              rec({
                at: new Date(base + i * 10_000).toISOString(),
                name: 'docker-images',
                repo: '/src/docker-images',
                task: 'local:versions-bump',
                ok: true,
              }),
            ),
          )
        }
        writeFileSync(historyPath(), `${lines.join('\n')}\n`)
      },
      () => {
        // A global read cannot see the record, so the test cannot pass for the
        // wrong reason on this path.
        expect(loadRuns(200).some((r) => r.task === 'local:prod-health')).toBe(
          false,
        )
        expect(
          loadRuns(200, { repo: '/src/anyrouter', task: 'local:prod-health' }),
        ).toHaveLength(1)

        expect(
          lastCell(
            formatSchedule([
              desk('/src/anyrouter', 'anyrouter', 'local:prod-health'),
            ]),
          ),
        ).toBe('fail 2026-09-27 17:13')
      },
    )
  })

  test('reads never only when the job itself has no records', () => {
    withLedger(
      () => {
        writeFileSync(
          historyPath(),
          `${JSON.stringify(rec({ at: '2026-09-28T09:48:10.555Z', name: 'docker-images', repo: '/src/docker-images', task: 'local:versions-bump', ok: true }))}\n`,
        )
      },
      () => {
        expect(
          lastCell(
            formatSchedule([
              desk('/src/anyrouter', 'anyrouter', 'local:prod-health'),
            ]),
          ),
        ).toBe('never')
      },
    )
  })
})
