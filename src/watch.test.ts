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
import type { LoadedDesk, TaskConfig, WatchConfig } from './config'
import { loadDeskConfig } from './config'
import { watchStep } from './daemon'
import type { Discovered } from './discover'
import { emptyPause, pauseKey, withPause } from './pause'
import { assembleManagerPrompt, taskVars } from './prompt'
import { cronsOf, scheduleLabel } from './schedule'
import { validateDeskJson } from './schema'
import {
  backoffMs,
  claimEvents,
  drainPending,
  formatWatchStatus,
  loadWatchState,
  MAX_LINE_BYTES,
  parseWatchOutput,
  pruneSeen,
  queueEvents,
  resetTask,
  resolveWatchArgv,
  runWatchCommand,
  SEEN_MAX,
  SEEN_TTL_MS,
  saveWatchState,
  taskState,
  type WatchEvent,
  type WatchState,
  type WatchTaskState,
  watchKey,
  watchPass,
  watchStateBakPath,
  watchStatePath,
} from './watch'

// Everything the desk reads off the host, so a watch test cannot pick up the
// machine's real state dir, real configs, or a real Telegram token.
const HOST_ENV = [
  'HERDR_PLUGIN_STATE_DIR',
  'HERDR_PLUGIN_CONFIG_DIR',
  'HERDR_BIN_PATH',
  'HERDR_BIN',
  'HERDR_SOCKET_PATH',
  'HERDR_DESK_TELEGRAM_TOKEN',
  'HERDR_DESK_TELEGRAM_CHAT_ID',
] as const
const prevEnv = HOST_ENV.map((k) => [k, process.env[k]] as const)
const tempDirs: string[] = []

afterEach(() => {
  for (const [k, v] of prevEnv) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function stateDir(): string {
  const dir = tempDir('desk-watch-')
  process.env.HERDR_PLUGIN_STATE_DIR = dir
  return dir
}

const watch: WatchConfig = {
  command: ['bun', 'scripts/watch-prs.ts'],
  intervalSec: 60,
  timeoutSec: 30,
  maxPending: 8,
}

const REPO = '/tmp/herdr-desk-watch-repo'
const AT = new Date(2026, 9, 5, 2, 14, 7)

const ev = (id: string, extra: Record<string, unknown> = {}): WatchEvent => ({
  id,
  type: 'pull_request.opened',
  at: '2026-10-05T02:14:07Z',
  ...extra,
})

/** A `Discovered` for a repo, as `tickOnce` would hand it to the watch step. */
function discovered(repo: string): Discovered {
  const config = loadDeskConfig(repo)
  return {
    repo,
    configPath: join(repo, '.herdr-desk.json'),
    config,
    source: 'remembered',
  }
}

/**
 * A runner that prints `lines` and exits 0, or exits `code` if told to.
 *
 * Injected rather than spawning, so the state machine — dedupe, cap, backoff,
 * pause — is testable without a repo, a script, or a clock that has to be
 * waited on. The one thing it cannot fake is whether the command is actually
 * killed on timeout, so that gets a real process below.
 */
function runner(lines: string[], code = 0) {
  return async () => ({
    code,
    stdout: lines.length ? `${lines.join('\n')}\n` : '',
    stderr: '',
    timedOut: false,
    error: null,
    failure: code === 0 ? null : `exit ${code}`,
    durationMs: 0,
  })
}

function oneLine(o: Record<string, unknown>): string {
  return JSON.stringify(o)
}

describe('parseWatchOutput', () => {
  test('keeps every good line, in order', () => {
    const out = parseWatchOutput(
      [
        oneLine(ev('pr-42')),
        oneLine(ev('deploy-7', { type: 'deploy.finished' })),
        oneLine(ev('issue-9', { type: 'issue.commented' })),
      ].join('\n'),
    )
    expect(out.warnings).toEqual([])
    expect(out.events.map((e) => e.id)).toEqual([
      'pr-42',
      'deploy-7',
      'issue-9',
    ])
    // Everything optional passes straight through: the plugin has no business
    // knowing what a repo means, so it forwards the object as printed.
    expect(out.events[1]?.type).toBe('deploy.finished')
  })

  test('a blank line is not a warning, because every NDJSON writer ends with one', () => {
    const out = parseWatchOutput(`\n${oneLine(ev('pr-42'))}\n\n\n`)
    expect(out.warnings).toEqual([])
    expect(out.events).toHaveLength(1)
  })

  test('a line that is not JSON is a warning, and the good lines survive it', () => {
    const out = parseWatchOutput(
      [oneLine(ev('a')), 'not json at all', oneLine(ev('b'))].join('\n'),
    )
    expect(out.events.map((e) => e.id)).toEqual(['a', 'b'])
    expect(out.warnings).toHaveLength(1)
    expect(out.warnings[0]).toContain('not JSON')
  })

  test('a JSON array is a warning, not an event', () => {
    // An array has no `id` of its own, so accepting it would queue something
    // the desk cannot dedupe. One bad shape must not mute the rest either.
    const out = parseWatchOutput(['[{"id":"a"}]', oneLine(ev('b'))].join('\n'))
    expect(out.events.map((e) => e.id)).toEqual(['b'])
    expect(out.warnings[0]).toContain('not a JSON object')
  })

  test('an object with no id is skipped and counted', () => {
    // The whole reason a missing id is a warning and not a fatal: an event with
    // no dedupe key cannot be replayed safely, and one that mutes the watcher is
    // worse than one that is dropped and visible.
    const out = parseWatchOutput(
      [oneLine({ type: 'pull_request.opened' }), oneLine(ev('b'))].join('\n'),
    )
    expect(out.events.map((e) => e.id)).toEqual(['b'])
    expect(out.warnings[0]).toContain('no id')
  })

  test('an empty or non-string id counts as missing', () => {
    const out = parseWatchOutput(
      [oneLine({ id: '' }), oneLine({ id: '   ' }), oneLine({ id: 7 })].join(
        '\n',
      ),
    )
    expect(out.events).toEqual([])
    expect(out.warnings).toHaveLength(3)
  })

  test('a huge line is a warning, not a parse', () => {
    // Events travel to a manager as prompt text, so an unbounded line is an
    // unbounded prompt. Capped and counted rather than truncated: a half-event
    // queued is worse than one that is not.
    const huge = oneLine(ev('big', { summary: 'x'.repeat(MAX_LINE_BYTES) }))
    const out = parseWatchOutput([huge, oneLine(ev('small'))].join('\n'))
    expect(out.events.map((e) => e.id)).toEqual(['small'])
    expect(out.warnings[0]).toContain('over')
  })

  test('a line just under the cap still parses', () => {
    const body = 'y'.repeat(MAX_LINE_BYTES - 200)
    const out = parseWatchOutput(oneLine(ev('big', { summary: body })))
    expect(out.events).toHaveLength(1)
    expect(out.warnings).toEqual([])
  })

  test('empty output is healthy and silent', () => {
    expect(parseWatchOutput('')).toEqual({ events: [], warnings: [] })
    expect(parseWatchOutput('\n')).toEqual({ events: [], warnings: [] })
  })
})

describe('queueEvents', () => {
  const fresh = (): WatchTaskState => taskState({ tasks: {} }, REPO, 't', AT)

  test('queues new events and dedupes one that repeats in the same output', () => {
    const t = fresh()
    const counts = queueEvents(t, [ev('a'), ev('b'), ev('a')], 8, AT)
    expect(counts.queued).toBe(2)
    expect(counts.duplicates).toBe(1)
    expect(t.pending.map((e) => e.id)).toEqual(['a', 'b'])
  })

  test('the 9th event on a cap of 8 is overflow, and its key is still remembered', () => {
    // The remembered key is the load-bearing half. An overflowed event that
    // keeps its key can never be re-queued; one that does not is offered again
    // on every poll forever, so the watcher spends its whole life re-reading
    // events it will never run and never once runs the eight it is holding.
    const t = fresh()
    const nine = Array.from({ length: 9 }, (_, i) => ev(`e${i + 1}`))
    const counts = queueEvents(t, nine, 8, AT)
    expect(counts.queued).toBe(8)
    expect(counts.overflow).toBe(1)
    expect(t.overflow).toBe(1)
    expect(t.pending).toHaveLength(8)
    expect(t.seen.e9).toBeDefined()

    const again = queueEvents(t, [ev('e9')], 8, AT)
    expect(again.queued).toBe(0)
    expect(again.duplicates).toBe(1)
    expect(t.overflow).toBe(1)
  })

  test('a second loud pass overflows too, and the counter only grows', async () => {
    // Pending is NOT drained between passes — nothing drains it but a run — so
    // the second pass finds a full queue and every one of its events is
    // overflow. The count is cumulative and is what `watch status` prints, so a
    // watcher permanently louder than its cap says so instead of looking like a
    // desk quietly holding eight events.
    const state: WatchState = { tasks: {} }
    await watchPass({
      repo: REPO,
      taskId: 't',
      watch,
      state,
      at: AT,
      run: runner(
        Array.from({ length: 10 }, (_, i) => oneLine(ev(`e${i + 1}`))),
      ),
    })
    await watchPass({
      repo: REPO,
      taskId: 't',
      watch,
      state,
      at: new Date(AT.getTime() + 60_000),
      run: runner(
        Array.from({ length: 10 }, (_, i) => oneLine(ev(`f${i + 1}`))),
      ),
    })
    const t = state.tasks[watchKey(REPO, 't')] as WatchTaskState
    expect(t.pending).toHaveLength(8)
    expect(t.overflow).toBe(12)
    expect(drainPending(state, REPO, 't')).toHaveLength(8)
  })

  test('a queue that already holds events is topped up, not replaced', () => {
    const t = fresh()
    queueEvents(t, [ev('a')], 8, AT)
    queueEvents(t, [ev('b')], 8, AT)
    expect(t.pending.map((e) => e.id)).toEqual(['a', 'b'])
  })
})

describe('pruneSeen', () => {
  test('drops a key older than the TTL, and keeps one inside it', () => {
    const at = new Date(AT)
    const old = new Date(at.getTime() - SEEN_TTL_MS - 1000).toISOString()
    const kept = pruneSeen(
      { old: old, recent: at.toISOString(), broken: 'not a date' },
      at,
    )
    expect(Object.keys(kept)).toEqual(['recent'])
  })

  test('caps the ledger, newest kept, so the file cannot grow forever', () => {
    const at = new Date(AT)
    const seen: Record<string, string> = {}
    for (let i = 0; i < SEEN_MAX + 50; i++) {
      seen[`e${i}`] = new Date(
        at.getTime() - (SEEN_MAX + 50 - i) * 1000,
      ).toISOString()
    }
    const kept = pruneSeen(seen, at)
    expect(Object.keys(kept)).toHaveLength(SEEN_MAX)
    expect(kept.e0).toBeUndefined()
    expect(kept[`e${SEEN_MAX + 49}`]).toBeDefined()
  })
})

describe('the state file', () => {
  test('a corrupt watch.json is quarantined to .bak and the desk starts fresh', () => {
    // `loadFires`' recovery idiom rather than a second one: two ways to recover
    // from a bad state file is two ways to get them subtly different.
    stateDir()
    writeFileSync(watchStatePath(), '{not json')
    expect(loadWatchState()).toEqual({ tasks: {} })
    expect(existsSync(watchStatePath())).toBe(false)
    expect(readFileSync(watchStateBakPath(), 'utf8')).toBe('{not json')
  })

  test('a file that parses but has no tasks is treated as corrupt, not trusted', () => {
    stateDir()
    writeFileSync(watchStatePath(), '{"tasks":[]}')
    expect(loadWatchState()).toEqual({ tasks: {} })
    expect(existsSync(watchStateBakPath())).toBe(true)
  })

  test('round-trips through tmp + rename, pruning on the way out', () => {
    const dir = stateDir()
    const state: WatchState = {
      tasks: {
        [watchKey(REPO, 't')]: {
          ...taskState({ tasks: {} }, REPO, 't', AT),
          seen: {
            stale: new Date(AT.getTime() - SEEN_TTL_MS - 1).toISOString(),
          },
        },
      },
    }
    saveWatchState(state, AT)
    const written = JSON.parse(readFileSync(join(dir, 'watch.json'), 'utf8'))
    expect(written.tasks[watchKey(REPO, 't')].seen).toEqual({})
    // The tmp file must not survive a successful write, or a crash leaves a
    // stale one that a reader could pick up as the state.
    expect(existsSync(`${join(dir, 'watch.json')}.tmp`)).toBe(false)
  })

  test('resetTask forgets the queue and the dedupe, and leaves the streak alone', () => {
    const t = taskState({ tasks: {} }, REPO, 't', AT)
    queueEvents(t, [ev('a'), ev('b')], 8, AT)
    t.fails = 2
    t.firstFailAt = AT.toISOString()
    const state: WatchState = { tasks: { [watchKey(REPO, 't')]: t } }
    resetTask(state, REPO, 't', AT)
    const after = state.tasks[watchKey(REPO, 't')]
    expect(after?.pending).toEqual([])
    expect(after?.seen).toEqual({})
    expect(after?.fails).toBe(2)
  })
})

describe('the pass', () => {
  test('dedupes an event id seen on an earlier pass', async () => {
    const state: WatchState = { tasks: {} }
    const first = await watchPass({
      repo: REPO,
      taskId: 't',
      watch,
      state,
      at: AT,
      run: runner([oneLine(ev('pr-42'))]),
    })
    expect(first.queued).toBe(1)

    const later = new Date(AT.getTime() + 60_000)
    const second = await watchPass({
      repo: REPO,
      taskId: 't',
      watch,
      state,
      at: later,
      run: runner([oneLine(ev('pr-42')), oneLine(ev('pr-43'))]),
    })
    // The poll reports it again — the script owns its cursor, and a desk that
    // trusted it to be perfect would drop real events the first time it was not.
    expect(second.events).toHaveLength(2)
    expect(second.duplicates).toBe(1)
    expect(second.queued).toBe(1)
    expect(second.task.pending.map((e) => e.id)).toEqual(['pr-42', 'pr-43'])
  })

  test('a paused task counts its events and drops them', async () => {
    // Resuming must not fire a burst of everything that happened while the job
    // was off, so nothing is queued — and nothing is deduped, because the
    // script's cursor keeps advancing and will not offer them again.
    const state: WatchState = { tasks: {} }
    const pass = await watchPass({
      repo: REPO,
      taskId: 't',
      watch,
      state,
      at: AT,
      paused: true,
      run: runner([oneLine(ev('a')), oneLine(ev('b'))]),
    })
    expect(pass.paused).toBe(true)
    expect(pass.task.paused).toBe(2)
    expect(pass.task.pending).toEqual([])
    expect(pass.task.seen).toEqual({})
    expect(pass.dispatched).toBe(false)
  })

  test('a failed poll queues nothing and backs off', async () => {
    const state: WatchState = { tasks: {} }
    const pass = await watchPass({
      repo: REPO,
      taskId: 't',
      watch,
      state,
      at: AT,
      run: runner([oneLine(ev('a'))], 1),
    })
    expect(pass.ok).toBe(false)
    expect(pass.task.fails).toBe(1)
    expect(pass.task.pending).toEqual([])
    // Output from a poll that failed is discarded rather than parsed: a script
    // that died halfway through writing stdout would contribute a partial line.
    expect(pass.task.nextPollAt).toBe(
      new Date(AT.getTime() + backoffMs(60, 1)).toISOString(),
    )
  })

  test('backoff grows, caps at 8x, and resets on the first success', async () => {
    expect(backoffMs(60, 1)).toBe(120_000)
    expect(backoffMs(60, 2)).toBe(240_000)
    expect(backoffMs(60, 3)).toBe(480_000)
    expect(backoffMs(60, 4)).toBe(480_000)
    expect(backoffMs(60, 99)).toBe(480_000)

    const state: WatchState = { tasks: {} }
    let at = AT
    for (let i = 1; i <= 4; i++) {
      const pass = await watchPass({
        repo: REPO,
        taskId: 't',
        watch,
        state,
        at,
        run: runner([], 7),
      })
      expect(pass.task.fails).toBe(i)
      expect(Date.parse(pass.task.nextPollAt) - at.getTime()).toBe(
        backoffMs(60, i),
      )
      at = new Date(Date.parse(pass.task.nextPollAt))
    }
    // `firstFailAt` stays on the first one, so status can say *since when*.
    expect(state.tasks[watchKey(REPO, 't')]?.firstFailAt).toBe(AT.toISOString())

    const ok = await watchPass({
      repo: REPO,
      taskId: 't',
      watch,
      state,
      at,
      run: runner([oneLine(ev('fresh'))]),
    })
    expect(ok.task.fails).toBe(0)
    expect(ok.task.firstFailAt).toBeNull()
    expect(ok.task.lastOkAt).toBe(at.toISOString())
    // Back to one interval, from now: a watcher that recovered must not wait out
    // a backoff it no longer needs.
    expect(Date.parse(ok.task.nextPollAt) - at.getTime()).toBe(60_000)
  })

  test('isDue lets a never-polled task poll at once', async () => {
    const t = taskState({ tasks: {} }, REPO, 't', AT)
    expect(Date.parse(t.nextPollAt)).toBe(AT.getTime())
    const pass = await watchPass({
      repo: REPO,
      taskId: 't',
      watch,
      state: { tasks: {} },
      at: AT,
      run: runner([oneLine(ev('a'))]),
    })
    expect(Date.parse(pass.task.nextPollAt)).toBeGreaterThan(AT.getTime())
  })

  test('bad lines are counted on the task, so a garbage script is visible', async () => {
    const state: WatchState = { tasks: {} }
    const pass = await watchPass({
      repo: REPO,
      taskId: 't',
      watch,
      state,
      at: AT,
      run: runner([oneLine(ev('a')), 'garbage']),
    })
    expect(pass.task.warnings).toBe(1)
    expect(pass.task.pending.map((e) => e.id)).toEqual(['a'])
  })
})

describe('drainPending', () => {
  test('takes the queue and leaves it empty', () => {
    const state: WatchState = { tasks: {} }
    const t = taskState(state, REPO, 't', AT)
    queueEvents(t, [ev('a'), ev('b')], 8, AT)
    state.tasks[watchKey(REPO, 't')] = t
    expect(drainPending(state, REPO, 't').map((e) => e.id)).toEqual(['a', 'b'])
    expect(drainPending(state, REPO, 't')).toEqual([])
  })

  test('is scoped to one task, so a sibling queue is untouched', () => {
    const state: WatchState = { tasks: {} }
    for (const id of ['a', 'b']) {
      const t = taskState(state, REPO, id, AT)
      queueEvents(t, [ev(`${id}-1`)], 8, AT)
      state.tasks[watchKey(REPO, id)] = t
    }
    expect(drainPending(state, REPO, 'a')).toHaveLength(1)
    expect(drainPending(state, REPO, 'b')).toHaveLength(1)
  })
})

describe('formatWatchStatus', () => {
  test('prints the failure count and the day, never a status word', async () => {
    // A watcher whose script broke on day one looks exactly like a watcher with
    // nothing to report, and the ledger records both as "no events". So the
    // number and the day are what have to be on the line.
    const state: WatchState = { tasks: {} }
    let at = AT
    for (let i = 0; i < 5; i++) {
      const pass = await watchPass({
        repo: REPO,
        taskId: 't',
        watch,
        state,
        at,
        run: runner([], 2),
      })
      at = new Date(Date.parse(pass.task.nextPollAt))
    }
    const text = formatWatchStatus(state, [{ repo: REPO, taskId: 't' }], at)
    expect(text).toContain('fails 5 from 2026-10-05')
    expect(text).toContain('pending 0')
    expect(text).toContain('lastError exit 2')
  })

  test('a healthy watcher says fails 0 and names its last ok', async () => {
    const state: WatchState = { tasks: {} }
    await watchPass({
      repo: REPO,
      taskId: 't',
      watch,
      state,
      at: AT,
      run: runner([oneLine(ev('a'))]),
    })
    const text = formatWatchStatus(state, [{ repo: REPO, taskId: 't' }], AT)
    expect(text).toContain('fails 0')
    expect(text).toContain('pending 1')
    expect(text).toContain('next poll in 60s')
  })

  test('a task that has never polled says so rather than showing zeros', async () => {
    const text = formatWatchStatus({ tasks: {} }, [{ repo: REPO, taskId: 't' }])
    expect(text).toBe('t  never polled')
  })
})

describe('command resolution', () => {
  test('a repo-relative script resolves against the repo root', () => {
    const { argv, error } = resolveWatchArgv(REPO, [
      './scripts/watch-prs.ts',
      '--verbose',
    ])
    expect(error).toBeNull()
    expect(argv).toEqual([`${REPO}/scripts/watch-prs.ts`, '--verbose'])
  })

  test('a path that leaves the repo is refused, at run time too', () => {
    // The validator already rejects it in the repo's own file, but a group
    // layer's tasks are never validated, so the run path has to hold too.
    const { argv, error } = resolveWatchArgv(REPO, ['../escape.sh'])
    expect(argv).toEqual([])
    expect(error).toContain('inside the repo')
  })

  test('an absolute path is refused: a watcher may not reach out of the checkout', () => {
    const { error } = resolveWatchArgv(REPO, ['/bin/echo'])
    expect(error).toContain('inside the repo')
  })

  test('a bare name stays on PATH', () => {
    // `bun` is not a path. Treating it as repo-relative would run the repo's own
    // `bun` if it had one, which is not what anyone means by `["bun", "x.ts"]`.
    const { argv, error } = resolveWatchArgv(REPO, ['bun', 'scripts/x.ts'])
    expect(error).toBeNull()
    expect(argv).toEqual(['bun', 'scripts/x.ts'])
  })
})

describe('validateDeskJson', () => {
  const withWatch = (watch_: unknown, repo?: string) =>
    validateDeskJson(
      { name: 'demo', tasks: [{ id: 't', watch: watch_ }] },
      '.herdr-desk.json',
      repo,
    )

  test('a complete watch block passes', () => {
    expect(
      withWatch({
        command: ['bun', 'scripts/watch-prs.ts'],
        intervalSec: 60,
        timeoutSec: 45,
        maxPending: 8,
      }),
    ).toEqual([])
  })

  test('command is required, and must be a non-empty argv array', () => {
    expect(withWatch({})[0]).toContain('command')
    expect(withWatch({ command: [] })[0]).toContain('command')
    expect(withWatch({ command: 'bun x.ts' })[0]).toContain('command')
    expect(withWatch({ command: [''] })[0]).toContain('command[0]')
  })

  test('an env block is refused, loudly', () => {
    // Same reasoning as notify.token: a committed config cannot carry a secret,
    // and a silent strip leaves the secret already in git history.
    expect(withWatch({ command: ['bun'], env: { TOKEN: 'x' } })[0]).toContain(
      'env',
    )
  })

  test('each field is range-checked against the documented window', () => {
    expect(withWatch({ command: ['bun'], intervalSec: 14 })[0]).toContain(
      'intervalSec: integer 15–3600',
    )
    expect(withWatch({ command: ['bun'], timeoutSec: 301 })[0]).toContain(
      'timeoutSec: integer 5–300',
    )
    expect(withWatch({ command: ['bun'], maxPending: 0 })[0]).toContain(
      'maxPending: integer 1–64',
    )
    expect(withWatch({ command: ['bun'], intervalSec: 60.5 })[0]).toContain(
      'intervalSec',
    )
  })

  test('a path that escapes the repo is refused when the repo is known', () => {
    expect(withWatch({ command: ['../escape'] }, '/tmp/repo')[0]).toContain(
      'inside the repo',
    )
    expect(withWatch({ command: ['./scripts/x.ts'] }, '/tmp/repo')).toEqual([])
  })

  test('an unknown field is an error, not ignored', () => {
    expect(withWatch({ command: ['bun'], retries: 3 })[0]).toContain(
      "unknown field 'retries'",
    )
  })

  test('watch is task-level: a root block is an unknown field', () => {
    // A group config must not be able to point a whole tree at one
    // repo-specific script.
    expect(
      validateDeskJson({
        name: 'fleet',
        group: true,
        watch: { command: ['x'] },
      }),
    ).toEqual([".herdr-desk.json: unknown field 'watch'"])
  })
})

describe('the manager prompt', () => {
  const task: TaskConfig = {
    id: 'local:pr-watch',
    label: 'PRs',
    playbook: 'prompts/tasks/pr-review.md',
    agentName: 'hd-pr-watch',
    agent: { ladder: ['grok'], permission: 'default' },
    maxChildren: 2,
    crons: [],
    watch,
  }
  const config: LoadedDesk = { name: 'herdr-desk', tasks: [task] }
  const base = {
    config,
    task,
    repo: '/tmp/repo',
    day: '2026-10-05',
    runDir: '/tmp/repo/.herdr-desk/runs/pr-watch/2026-10-05',
    workspaceId: 'ws-1',
    paneId: 'pane-1',
  }

  test('a cron run with an empty queue is byte-identical to before', () => {
    // The regression this guards: the event machinery exists on every run, and
    // a section that rendered "no events" instead of nothing would make every
    // cron manager re-derive that there is no work, every slot, forever.
    const text = assembleManagerPrompt(taskVars(base))
    expect(text).not.toContain('# Event')
    expect(text).not.toContain('Woken by an event')
    expect(text).not.toContain('eventCount')
  })

  test('an event run carries the section, with bullets, JSON and a path', () => {
    const events = [
      { id: 'pr-42', type: 'pull_request.opened', summary: '#42 fix retry' },
      { id: 'deploy-7', type: 'deploy.finished', summary: 'prod deploy green' },
    ]
    const text = assembleManagerPrompt(
      taskVars({ ...base, events, trigger: 'event' }),
    )
    expect(text).toContain('# Event')
    expect(text).toContain('- pull_request.opened — #42 fix retry')
    expect(text).toContain('- deploy.finished — prod deploy green')
    expect(text).toContain('"id": "pr-42"')
    expect(text).toContain(
      'Full events: /tmp/repo/.herdr-desk/runs/pr-watch/2026-10-05/events.json',
    )
    // The run.md guidance is authored in the envelope, and only for a run with
    // events — so a cron prompt cannot gain a paragraph about a section it does
    // not have.
    expect(text).toContain('Woken by an event')
    expect(text).not.toContain('<!-- events -->')
  })

  test('event vars are empty or zero when there are no events', () => {
    const vars = taskVars(base)
    expect(vars.eventCount).toBe('0')
    expect(vars.eventSummary).toBe('')
    expect(vars.eventJson).toBe('')
    expect(vars.eventPath).toBe('')
    expect(vars.triggerKind).toBe('cron')
  })

  test('an event with no type or summary still gets a readable bullet', () => {
    const text = assembleManagerPrompt(
      taskVars({ ...base, events: [{ id: 'raw-1' }], trigger: 'event' }),
    )
    expect(text).toContain('- event — raw-1')
  })

  test('an event-only task with no crons still assembles a prompt', () => {
    // `"schedule": []` is how a task says "never on cron"; the prompt path must
    // not care, or the event-only form could not be used at all.
    const text = assembleManagerPrompt(taskVars({ ...base, trigger: 'event' }))
    expect(text).toContain('duyetbot')
  })
})

describe('"schedule": []', () => {
  test('validates as the event-only form', () => {
    expect(
      validateDeskJson({
        name: 'demo',
        tasks: [{ id: 't', schedule: [], watch: { command: ['bun', 'w.ts'] } }],
      }),
    ).toEqual([])
  })

  test('yields no crons, and labels as none', () => {
    expect(cronsOf([])).toEqual([])
    expect(scheduleLabel([])).toBe('-')
  })

  test('absent still means the default, which is what a watched task inherits', () => {
    // The reconciliation sweep. A task with `watch` and no `schedule` of its own
    // takes the root cron, so docs/watch.md has to say so out loud.
    expect(cronsOf(undefined)).toEqual(['0 7 * * *'])
  })
})

describe('the watch step in the tick', () => {
  const TASK = 'local:pr-watch'
  const CRON = '* * * * *'
  const AT = new Date(2026, 8, 30, 9, 15)
  const roomy = () => ({ ok: true, breaches: [], pressure: 0 })
  const busy = () => ({
    ok: false,
    breaches: ['load 2.1/core over 1.5'],
    pressure: 1.4,
  })
  /** A runner that must not be called, for the paths that dispatch nothing. */
  const noRun = async () => {
    throw new Error('watch step dispatched a run it should not have')
  }

  /**
   * A one-task desk with `watch` and a real poll script, on a temp repo.
   *
   * A real script for the poll, because that half genuinely runs repo code and
   * must be exercised; an injected runner for the dispatch, because going
   * through `runTask` would need a Herdr binary to exist — and faking one tests
   * the fake rather than the step. Same split `tickOnce` makes with its gate.
   */
  function watchedDesk(lines: string[] = []) {
    const state = stateDir()
    const repo = tempDir('herdr-desk-watch-repo-')
    const script = join(repo, 'watch.ts')
    writeFileSync(
      script,
      `process.stdout.write(${JSON.stringify(lines.length ? `${lines.join('\n')}\n` : '')})\n`,
    )
    writeFileSync(
      join(repo, '.herdr-desk.json'),
      `${JSON.stringify({
        name: 'watch-test',
        tasks: [
          {
            id: TASK,
            playbook: 'prompts/tasks/pr-review.md',
            agentName: 'hd-pr-watch',
            // No cron at all: this task is event-only, so a tick that touched
            // the cron path would show up as an extra run.
            schedule: [],
            watch: { command: ['bun', 'watch.ts'], intervalSec: 60 },
          },
        ],
      })}\n`,
    )
    writeFileSync(
      join(state, 'known-repos.json'),
      `${JSON.stringify({ repos: [repo] })}\n`,
    )
    process.env.HERDR_BIN_PATH = join(state, 'no-herdr')
    process.env.HERDR_SOCKET_PATH = join(state, 'herdr.sock')
    process.env.HERDR_PLUGIN_CONFIG_DIR = tempDir('herdr-desk-config-')
    delete process.env.HERDR_DESK_TELEGRAM_TOKEN
    delete process.env.HERDR_DESK_TELEGRAM_CHAT_ID
    process.env.HERDR_BIN = join(state, 'no-herdr')
    return repo
  }

  /** The other watched task, for the two-task cases. */
  const SECOND = 'local:second-watch'

  function withSecondTask(repo: string): void {
    const file = join(repo, '.herdr-desk.json')
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      tasks: Array<Record<string, unknown>>
    }
    raw.tasks.push({
      id: SECOND,
      playbook: 'prompts/tasks/pr-review.md',
      agentName: 'hd-second-watch',
      schedule: [],
      watch: { command: ['bun', 'watch.ts'], intervalSec: 60 },
    })
    writeFileSync(file, `${JSON.stringify(raw)}\n`)
  }

  /** One desk holding two watched tasks, loaded the way the daemon loads them. */
  function twoTaskDesk(repo: string): Discovered[] {
    return [{ repo, config: loadDeskConfig(repo) } as Discovered]
  }

  test('an event fires one run, and the queue is empty afterwards', async () => {
    const repo = watchedDesk([
      JSON.stringify({
        id: 'pr-42',
        type: 'pull_request.opened',
        summary: '#42',
      }),
    ])
    const calls: Array<{ repo: string; taskId?: string; trigger?: string }> = []
    const claimed: string[] = []
    // The fake runner has to honour the part of `runTask` this test is about: a
    // fire claims the queue on its way into the run. A fake that records the call
    // and returns would leave the events pending forever, and the assertion below
    // would then be testing the fake rather than the desk.
    const fakeRun = async (o: {
      repo: string
      taskId?: string
      trigger?: string
    }) => {
      calls.push(o)
      for (const e of claimEvents(o.repo, o.taskId ?? '')) claimed.push(e.id)
      return {}
    }

    const { fired } = await watchStep(
      [discovered(repo)],
      AT,
      roomy,
      undefined,
      fakeRun,
    )

    expect(fired).toBe(1)
    expect(calls).toHaveLength(1)
    // Recorded as an event, so `history` can tell it apart from a slot — and so
    // a reader of the ledger can see which fires were event-driven.
    expect(calls[0]).toEqual({ repo, taskId: TASK, trigger: 'event' })
    // The run carried the event, and the queue is empty afterwards, because a
    // run that claimed it owns it now. One run, not one per event: the second
    // event in the unhealthy-host test below rides the same dispatch.
    expect(claimed).toEqual(['pr-42'])
    expect(loadWatchState().tasks[watchKey(repo, TASK)]?.pending).toEqual([])
  })

  test('an unhealthy host holds the events, and a later healthy tick drains them', async () => {
    // The queue IS the hold. Throwing the events away would lose a real PR, and
    // dispatching them anyway would hand a saturated box another manager — which
    // is the whole failure the health gate exists for.
    const repo = watchedDesk([
      JSON.stringify({ id: 'pr-1', type: 'pull_request.opened' }),
      JSON.stringify({ id: 'pr-2', type: 'pull_request.opened' }),
    ])
    const calls: string[] = []
    const fakeRun = async () => {
      calls.push('fired')
      return {}
    }

    const held = await watchStep(
      [discovered(repo)],
      AT,
      busy,
      undefined,
      fakeRun,
    )
    expect(held.fired).toBe(0)
    expect(calls).toEqual([])
    const pending = loadWatchState().tasks[watchKey(repo, TASK)]?.pending
    expect(pending?.map((e) => e.id)).toEqual(['pr-1', 'pr-2'])

    const later = await watchStep(
      [discovered(repo)],
      new Date(AT.getTime() + 120_000),
      roomy,
      undefined,
      fakeRun,
    )
    expect(later.fired).toBe(1)
    expect(calls).toHaveLength(1)
  })

  test("a second watched task cannot resurrect the first one's queue", async () => {
    // The lost update this guards against: `watchStep` holds one snapshot of
    // the state file for the whole tick, and a dispatch makes it stale — the run
    // claims its events and rewrites the file itself. Saving the stale snapshot
    // for the *next* task would put those events back, so task A would re-fire
    // the same event on every poll task B makes, forever.
    const repo = watchedDesk([
      JSON.stringify({ id: 'pr-a', type: 'pull_request.opened' }),
    ])
    withSecondTask(repo)
    const calls: string[] = []
    const fakeRun = async (o: { repo: string; taskId?: string }) => {
      calls.push(o.taskId ?? '')
      // Honour the part of `runTask` the queue depends on.
      claimEvents(o.repo, o.taskId ?? '')
      return {}
    }

    const first = await watchStep(
      twoTaskDesk(repo),
      AT,
      roomy,
      undefined,
      fakeRun,
    )
    expect(calls).toEqual([TASK, SECOND])

    const state = loadWatchState()
    expect(state.tasks[watchKey(repo, TASK)]?.pending).toEqual([])
    expect(state.tasks[watchKey(repo, SECOND)]?.pending).toEqual([])

    // And it stays empty: a later tick must not find the first task's event
    // waiting again, which is what an un-reloaded snapshot produces.
    const later = await watchStep(
      twoTaskDesk(repo),
      new Date(AT.getTime() + 120_000),
      roomy,
      undefined,
      noRun,
    )
    expect(later.fired).toBe(0)
    expect(first.fired).toBe(2)
  })

  test('a task that is not due is not polled', async () => {
    const repo = watchedDesk([])
    await watchStep([discovered(repo)], AT, roomy, undefined, noRun)
    // `intervalSec` is 60 and the second tick is 20s later, so the second step
    // must do nothing at all.
    const again = await watchStep(
      [discovered(repo)],
      new Date(AT.getTime() + 20_000),
      roomy,
      undefined,
      noRun,
    )
    expect(again.fired).toBe(0)
    const t = loadWatchState().tasks[watchKey(repo, TASK)]
    expect(t?.lastPollAt).toBe(AT.toISOString())
  })

  test('a broken script never breaks the tick', async () => {
    // The catch around the whole step is the only thing between one repo's
    // broken watcher and a desk that stops firing every other repo.
    const repo = watchedDesk([])
    writeFileSync(
      join(repo, 'watch.ts'),
      'throw new Error("watcher is broken")\n',
    )
    const { fired } = await watchStep([discovered(repo)], AT, roomy)
    expect(fired).toBe(0)
    const log = readFileSync(
      join(process.env.HERDR_PLUGIN_STATE_DIR as string, 'daemon.log'),
      'utf8',
    )
    expect(log).toContain('watch fail')
  })

  test('a watcher failing five times records the streak, and says so', async () => {
    const repo = watchedDesk([])
    writeFileSync(join(repo, 'watch.ts'), 'process.exit(3)\n')
    let at = AT
    for (let i = 1; i <= 5; i++) {
      await watchStep([discovered(repo)], at, roomy)
      const t = loadWatchState().tasks[watchKey(repo, TASK)]
      expect(t?.fails).toBe(i)
      at = new Date(Date.parse(t?.nextPollAt ?? at.toISOString()))
    }
    const t = loadWatchState().tasks[watchKey(repo, TASK)]
    expect(t?.firstFailAt).toBe(AT.toISOString())
    expect(t?.lastError).toBe('exit 3')
    const text = formatWatchStatus(loadWatchState(), [{ repo, taskId: TASK }])
    // The number and the day, never a status word.
    expect(text).toContain('fails 5 from 2026-09-30')
  })

  test('a paused task drops its events instead of bursting on resume', async () => {
    const repo = watchedDesk([
      JSON.stringify({ id: 'pr-1', type: 'pull_request.opened' }),
    ])
    const { fired } = await watchStep(
      [discovered(repo)],
      AT,
      roomy,
      withPause(emptyPause(), pauseKey(repo, TASK)),
    )
    expect(fired).toBe(0)
    const t = loadWatchState().tasks[watchKey(repo, TASK)]
    expect(t?.paused).toBe(1)
    expect(t?.pending).toEqual([])

    const resumed = await watchStep(
      [discovered(repo)],
      new Date(AT.getTime() + 120_000),
      roomy,
    )
    expect(resumed.fired).toBe(0)
  })

  test('a desk with no watch behaves exactly as before', async () => {
    // The regression net for the other direction: the step must be invisible to a
    // config that never mentions `watch`, including its state file.
    const state = stateDir()
    const repo = tempDir('herdr-desk-watch-repo-')
    writeFileSync(
      join(repo, '.herdr-desk.json'),
      `${JSON.stringify({
        name: 'plain',
        tasks: [{ id: 'local:plain', schedule: CRON }],
      })}\n`,
    )
    writeFileSync(
      join(state, 'known-repos.json'),
      `${JSON.stringify({ repos: [repo] })}\n`,
    )
    const { fired, problem } = await watchStep([discovered(repo)], AT, roomy)
    expect(fired).toBe(0)
    expect(problem).toBe(false)
    expect(existsSync(join(state, 'watch.json'))).toBe(false)
  })
})

describe('runWatchCommand', () => {
  test('runs argv with cwd at the repo root and adds exactly four variables', async () => {
    const dir = stateDir()
    const repo = tempDir('herdr-desk-watch-repo-')
    const result = await runWatchCommand({
      repo,
      taskId: 'local:pr-watch',
      watch: {
        ...watch,
        command: [
          'bun',
          '-e',
          'console.log(JSON.stringify({cwd: process.cwd(), repo: process.env.HERDR_DESK_REPO, task: process.env.HERDR_DESK_TASK, state: process.env.HERDR_DESK_STATE_DIR, at: process.env.HERDR_DESK_POLL_AT, mine: process.env.MY_WATCH_VAR, secret: process.env.SHOULD_NOT_BE_SET}))',
        ],
        timeoutSec: 20,
      },
      env: { MY_WATCH_VAR: 'inherited' },
    })
    expect(result.failure).toBeNull()
    // `process.env.X` is `undefined` for a var that was never set, and
    // `JSON.stringify` drops the key entirely — so the assertion is on the
    // value being empty, not on the key being present.
    const printed = JSON.parse(result.stdout) as Record<
      string,
      string | undefined
    >
    expect(printed.cwd).toBe(repo)
    expect(printed.repo).toBe(repo)
    expect(printed.task).toBe('local:pr-watch')
    expect(printed.state).toBe(dir)
    expect(Date.parse(printed.at ?? '')).not.toBeNaN()
    // The command inherits the environment it was given, and the plugin adds
    // nothing else — which is the whole reason there is no `env` block.
    expect(printed.mine).toBe('inherited')
    expect(printed.secret ?? '').toBe('')
  })

  test('exit 0 with no output is healthy', async () => {
    const repo = tempDir('herdr-desk-watch-repo-')
    const result = await runWatchCommand({
      repo,
      taskId: 't',
      watch: { ...watch, command: ['bun', '-e', ''], timeoutSec: 20 },
    })
    expect(result.code).toBe(0)
    expect(result.failure).toBeNull()
  })

  test('exit non-zero is a failure, with the exit code and stderr', async () => {
    const repo = tempDir('herdr-desk-watch-repo-')
    const result = await runWatchCommand({
      repo,
      taskId: 't',
      watch: {
        ...watch,
        command: [
          'bun',
          '-e',
          'console.error("gh: rate limited"); process.exit(1)',
        ],
        timeoutSec: 20,
      },
    })
    expect(result.failure).toBe('exit 1')
    expect(result.stderr).toContain('rate limited')
  })

  test('a command that hangs is killed and counted as a failure', async () => {
    const repo = tempDir('herdr-desk-watch-repo-')
    const started = Date.now()
    const result = await runWatchCommand({
      repo,
      taskId: 't',
      watch: {
        ...watch,
        command: ['bun', '-e', 'setInterval(() => {}, 1000)'],
        timeoutSec: 1,
      },
    })
    expect(result.timedOut).toBe(true)
    expect(result.failure).toBe('timed out after 1s')
    expect(result.code).toBeNull()
    // Seconds, not minutes — and it really was killed rather than awaited.
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  test('an argv that leaves the repo never runs', async () => {
    const repo = tempDir('herdr-desk-watch-repo-')
    const result = await runWatchCommand({
      repo,
      taskId: 't',
      watch: { ...watch, command: ['/bin/echo', 'hi'] },
    })
    expect(result.error).toContain('inside the repo')
    expect(result.stdout).toBe('')
  })

  test('a binary that does not exist is a failure, not a throw', async () => {
    const repo = tempDir('herdr-desk-watch-repo-')
    const result = await runWatchCommand({
      repo,
      taskId: 't',
      watch: { ...watch, command: ['herdr-desk-nonexistent-binary'] },
    })
    expect(result.failure).not.toBeNull()
    expect(result.timedOut).toBe(false)
  })

  test('an endless print fails the poll, and the read stays bounded', async () => {
    const repo = tempDir('herdr-desk-watch-repo-')
    // Writes well past the cap, then stops and exits, so the test cannot hang on
    // a reader waiting for a process that would print forever.
    const result = await runWatchCommand({
      repo,
      taskId: 't',
      watch: {
        ...watch,
        command: [
          'bun',
          '-e',
          'const line = "x".repeat(1000); for (let i = 0; i < 8000; i++) console.log(line)',
        ],
        timeoutSec: 20,
      },
    })
    // A truncated event list is silently wrong, so an over-long one is a failure
    // rather than a prefix that gets parsed. Which way it fails is not the point
    // — the cap is what has to hold, and a script that outruns it must not take
    // the daemon's memory with it.
    expect(result.failure).not.toBeNull()
    expect(result.stdout.length).toBeLessThanOrEqual(4 * 1024 * 1024)
  })
})
