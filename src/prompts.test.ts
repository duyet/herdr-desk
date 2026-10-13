import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DESK_ROOT,
  type LoadedDesk,
  listBundledTasks,
  PROMPT_NAMES,
  promptPath,
  type TaskConfig,
} from './config'
import { assembleManagerPrompt, taskVars } from './prompt'
import type { WatchEvent } from './watch'

const dir = join(DESK_ROOT, 'prompts')
const VAR = /\{\{\s*[a-zA-Z0-9_]+\s*\}\}/
const rendered = new Set<string>(PROMPT_NAMES)
const guides = readdirSync(dir)
  .filter((f) => f.endsWith('.md'))
  .filter((f) => !rendered.has(f.replace(/\.md$/, '')))

describe('prompts/', () => {
  test('every rendered prompt exists', () => {
    for (const name of PROMPT_NAMES) {
      expect(existsSync(promptPath(name))).toBe(true)
    }
  })

  // A file nobody renders and nobody links is a prompt that drifted out of use
  // while still looking authoritative.
  test('every other prompt file is linked from the README', () => {
    const readme = readFileSync(join(DESK_ROOT, 'README.md'), 'utf8')
    for (const file of guides) expect(readme).toContain(`prompts/${file}`)
  })

  // Guides are pasted by hand and the child prompt is handed over as a path;
  // neither is interpolated, so a `{{var}}` in them arrives as literal braces.
  test('uninterpolated prompts carry no template vars', () => {
    for (const file of [...guides, 'child.md']) {
      expect(readFileSync(join(dir, file), 'utf8')).not.toMatch(VAR)
    }
  })

  // Every var a bundled playbook names must be one taskVars supplies, or the
  // manager reads `{{name}}` instead of a value.
  test.each(listBundledTasks())('%s renders with no unfilled vars', (name) => {
    const task: TaskConfig = {
      id: `desk:${name}`,
      playbook: name,
      agentName: 'desk-a',
      agent: { ladder: ['codex'], permission: 'default' },
      crons: [],
    }
    const config: LoadedDesk = { name: 'repo', tasks: [task] }
    const events = [
      { id: 'e1', type: 'pr.opened', summary: 'PR #1' },
    ] as unknown as WatchEvent[]
    for (const trigger of ['event', 'manual'] as const) {
      const vars = taskVars({
        config,
        task,
        repo: '/tmp/repo',
        day: '2026-10-13',
        runDir: '/tmp/repo/.herdr-desk/runs/x',
        trigger,
        events,
      })
      expect(assembleManagerPrompt(vars)).not.toMatch(VAR)
    }
  })
})
