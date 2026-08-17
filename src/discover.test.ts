import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findConfigPath, loadDeskConfig } from './config'

describe('repo config', () => {
  test('loads .herdr-desk.json from a repo root', () => {
    const dir = join(tmpdir(), `desk-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, '.herdr-desk.json'),
      JSON.stringify({
        name: 'fixture',
        tasks: [
          {
            id: 'issues',
            task: 'github-issues',
            agentName: 'fix-desk',
            schedule: { morning: '0 7 * * *' },
          },
        ],
      }),
    )
    expect(findConfigPath(dir)?.endsWith('.herdr-desk.json')).toBe(true)
    expect(loadDeskConfig(dir).name).toBe('fixture')
  })
})
