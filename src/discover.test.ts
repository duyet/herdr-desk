import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DESK_ROOT, findConfigPath, loadDeskConfig } from './config'
import { logLoadFailures, tickOnce } from './daemon'
import { discoverAll, formatScan } from './discover'

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
            id: 'desk:github-issues',
            playbook: 'github-issues',
            agentName: 'fix-desk',
            schedule: '0 7 * * *',
          },
        ],
      }),
    )
    expect(findConfigPath(dir)?.endsWith('.herdr-desk.json')).toBe(true)
    expect(loadDeskConfig(dir).name).toBe('fixture')
  })
})

// Everything discovery reads off the host, so a test cannot pick up this
// machine's real workspaces, real plugin config, or real known repos.
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
const roots: string[] = []

afterEach(() => {
  for (const [k, v] of prevEnv) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  while (roots.length)
    rmSync(roots.pop() as string, { recursive: true, force: true })
})

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `herdr-desk-${prefix}-`))
  roots.push(dir)
  return dir
}

/** A temp state dir with no Herdr behind it, so discovery reads only known repos. */
function useState(): string {
  const dir = tmp('state')
  process.env.HERDR_PLUGIN_STATE_DIR = dir
  process.env.HERDR_PLUGIN_CONFIG_DIR = tmp('config')
  process.env.HERDR_BIN_PATH = join(dir, 'no-herdr')
  process.env.HERDR_BIN = join(dir, 'no-herdr')
  process.env.HERDR_SOCKET_PATH = join(dir, 'herdr.sock')
  delete process.env.HERDR_DESK_TELEGRAM_TOKEN
  delete process.env.HERDR_DESK_TELEGRAM_CHAT_ID
  return dir
}

function writeConfig(repo: string, value: unknown): void {
  mkdirSync(repo, { recursive: true })
  writeFileSync(
    join(repo, '.herdr-desk.json'),
    `${JSON.stringify(value, null, 2)}\n`,
  )
}

/** A repo the machine remembers, as `discoverDesks` finds one with no Herdr. */
function remember(state: string, ...repos: string[]): void {
  writeFileSync(
    join(state, 'known-repos.json'),
    `${JSON.stringify({ repos }, null, 2)}\n`,
  )
}

const goodConfig = (name: string) => ({
  name,
  tasks: [{ id: 'desk:github-issues', schedule: '0 7 * * *' }],
})

/**
 * A config carrying a field this build does not know.
 *
 * This is the shape #97 was reached with, and the expected one during a rollout:
 * a config is committed in a repo and the plugin is upgraded separately, so "the
 * repo is ahead of the machine" is the normal state. `watch` reproduced it
 * against a 0.1.7 daemon; `retries` is the same thing against this one.
 */
const armAheadConfig = (name: string) => ({
  name,
  tasks: [
    {
      id: 'desk:github-issues',
      schedule: '0 7 * * *',
      retries: 3,
    },
  ],
})

describe('a repo whose config cannot be read', () => {
  test('is reported with its error, not dropped', async () => {
    const state = useState()
    const good = tmp('good')
    const ahead = tmp('ahead')
    writeConfig(good, goodConfig('good'))
    writeConfig(ahead, armAheadConfig('ahead'))
    remember(state, good, ahead)

    // Sanity: the config really is unparseable by the running plugin.
    expect(() => loadDeskConfig(ahead)).toThrow()

    const { desks, failed } = await discoverAll()
    // The other repo is still there. That part was always right and must stay so.
    expect(desks.map((d) => d.config.name)).toEqual(['good'])
    expect(failed).toHaveLength(1)
    expect(failed[0].repo).toBe(ahead)
    expect(failed[0].configPath).toBe(join(ahead, '.herdr-desk.json'))
    // The validator's own message, not a summary of it.
    expect(failed[0].error).toContain("unknown field 'retries'")
  })

  test('scan lists it in the same output as the ones that loaded', async () => {
    // `scan` is the command a person runs to find out what the desk is looking
    // at, and its answer has to include "is this repo even being read".
    const state = useState()
    const good = tmp('good')
    const ahead = tmp('ahead')
    writeConfig(good, goodConfig('good'))
    writeConfig(ahead, armAheadConfig('ahead'))
    remember(state, good, ahead)

    const { desks, failed } = await discoverAll()
    const out = formatScan(desks, failed)
    expect(out).toContain('good')
    expect(out).toContain(ahead)
    // The error, on the line, so the reason travels with the repo.
    expect(out).toContain('error')
    expect(out).toContain("unknown field 'retries'")
    // One line per failure: a multi-line validator error is not a paragraph in
    // a listing. `validate` prints all of it.
    expect(
      out.split('\n').filter((l) => l.startsWith(`error  ${ahead}`)),
    ).toHaveLength(1)
  })

  test('a repo with no config at all is absent, not an error', async () => {
    // The distinction that makes reporting worth anything: a directory that is
    // not a desk is not a broken desk. Reporting those would train a reader to
    // ignore the error lines.
    const state = useState()
    const good = tmp('good')
    const notADesk = tmp('not-a-desk')
    mkdirSync(notADesk, { recursive: true })
    writeConfig(good, goodConfig('good'))
    remember(state, good, notADesk)

    const { desks, failed } = await discoverAll()
    expect(desks.map((d) => d.config.name)).toEqual(['good'])
    expect(failed).toEqual([])
    expect(formatScan(desks, failed)).not.toContain('error')
  })

  test('one bad repo does not stop the others', async () => {
    // Three good, two bad, in one pass — and the good ones are all there. This is
    // the property the whole change had to keep: not fatal, and complete.
    const state = useState()
    const good = [tmp('g1'), tmp('g2'), tmp('g3')]
    const bad = [tmp('b1'), tmp('b2')]
    for (const [i, r] of good.entries()) writeConfig(r, goodConfig(`good${i}`))
    for (const r of bad) writeConfig(r, armAheadConfig('ahead'))
    remember(state, ...good, ...bad)

    const { desks, failed } = await discoverAll()
    expect(desks.map((d) => d.config.name).sort()).toEqual([
      'good0',
      'good1',
      'good2',
    ])
    expect(failed.map((f) => f.repo).sort()).toEqual(bad.sort())
  })

  test('a repo that fails from two sources is one failure, not two', async () => {
    // It is remembered and it is an open workspace, so the same bad config is
    // reached twice per tick. Reporting it twice would make the count a lie.
    const state = useState()
    const ahead = tmp('ahead')
    writeConfig(ahead, armAheadConfig('ahead'))
    remember(state, ahead)
    const global = process.env.HERDR_PLUGIN_CONFIG_DIR as string
    writeFileSync(
      join(global, 'config.json'),
      `${JSON.stringify({ repos: [ahead] }, null, 2)}\n`,
    )

    const { failed } = await discoverAll()
    expect(failed).toHaveLength(1)
  })

  test('fixing the config brings the repo back, with no leftover state', async () => {
    // The round trip. A config edit is the whole remedy, so it has to be enough:
    // no restart, no state file to clear. Discovery re-reads every call, which
    // is what makes this true.
    const state = useState()
    const ahead = tmp('ahead')
    writeConfig(ahead, armAheadConfig('ahead'))
    remember(state, ahead)

    expect((await discoverAll()).failed).toHaveLength(1)
    // The fix: drop the field the machine cannot read.
    writeConfig(ahead, goodConfig('ahead'))
    const after = await discoverAll()
    expect(after.failed).toEqual([])
    expect(after.desks.map((d) => d.config.name)).toEqual(['ahead'])
    // No leftover state: a broken repo leaves nothing behind that a fixed one has
    // to be cleaned out of. The only file written is the remembered-repo list,
    // which is how the repo stays discoverable while its config is broken.
    expect(existsSync(join(state, 'watch.json'))).toBe(false)
    const known = JSON.parse(
      readFileSync(join(state, 'known-repos.json'), 'utf8'),
    ) as { repos: string[] }
    expect(known.repos).toContain(ahead)
  })
})

describe('the commands a person runs', () => {
  const CLI = join(DESK_ROOT, 'src', 'cli.ts')

  /**
   * `bun src/cli.ts …` with the host environment pointed at temp dirs.
   *
   * Spawned, because what #97 broke is a *command's output*: `validate` printed
   * `0 errors` over a desk that was not being read, and `status` printed a
   * healthy machine doing nothing. Asserting on `discoverAll` alone would not
   * have caught either.
   */
  function run(
    args: string[],
    cwd: string,
    state: string,
  ): {
    code: number
    out: string
    err: string
  } {
    const proc = Bun.spawnSync([process.execPath, CLI, ...args], {
      cwd,
      env: {
        ...process.env,
        HERDR_PLUGIN_STATE_DIR: state,
        HERDR_PLUGIN_CONFIG_DIR: tmp('cfg'),
        HERDR_BIN_PATH: join(state, 'no-herdr'),
        HERDR_BIN: join(state, 'no-herdr'),
        HERDR_SOCKET_PATH: join(state, 'herdr.sock'),
        HERDR_DESK_TELEGRAM_TOKEN: '',
        HERDR_DESK_TELEGRAM_CHAT_ID: '',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return {
      code: proc.exitCode,
      out: proc.stdout.toString(),
      err: proc.stderr.toString(),
    }
  }

  function deskWithABadNeighbour(): {
    state: string
    cwd: string
    bad: string
  } {
    const state = useState()
    const good = tmp('good')
    const bad = tmp('bad')
    writeConfig(good, goodConfig('good'))
    writeConfig(bad, armAheadConfig('ahead'))
    remember(state, good, bad)
    const cwd = tmp('cwd')
    return { state, cwd, bad }
  }

  test('scan lists the bad repo with its error', () => {
    const { state, cwd, bad } = deskWithABadNeighbour()
    const r = run(['scan'], cwd, state)
    expect(r.code).toBe(0)
    expect(r.out).toContain('good')
    expect(r.out).toContain(bad)
    expect(r.out).toContain("unknown field 'retries'")
  })

  test('validate reports it and exits non-zero', () => {
    // `validate` is the command a person runs when a desk looks wrong, and it
    // has to be able to answer "is this repo even being read". It said
    // `0 errors` before, because the repo it could not read was not in the list
    // it was checking.
    const { state, cwd, bad } = deskWithABadNeighbour()
    const r = run(['validate'], cwd, state)
    expect(r.code).toBe(1)
    expect(r.err).toContain(bad)
    expect(r.err).toContain("unknown field 'retries'")
    // And the repo that is fine is not reported as a problem.
    expect(r.err).not.toContain('good:')
  })

  test('status counts it, in a form a notice could carry', () => {
    // A machine-level number, next to the desk and daemon lines. The per-repo
    // detail is one command away in `scan`; what has to fit in a push notice is
    // "1 desk is not being read".
    const { state, cwd } = deskWithABadNeighbour()
    const r = run(['status'], cwd, state)
    expect(r.code).toBe(0)
    expect(r.out).toContain('1 desk(s) skipped: unreadable config')
    // The table is still there: one bad repo does not empty the output.
    expect(r.out).toContain('good')
  })

  test('a machine with no bad repo says nothing about skipped desks', () => {
    // The count has to mean something, which means it has to be absent when
    // there is nothing to count.
    const state = useState()
    const good = tmp('good')
    const cwd = tmp('cwd')
    writeConfig(good, goodConfig('good'))
    remember(state, good)
    const r = run(['status'], cwd, state)
    expect(r.out).not.toContain('skipped')
    expect(run(['validate'], cwd, state).code).toBe(0)
  })
})

describe('the daemon reports a load failure', () => {
  test('once per repo per distinct error, and quiet when nothing changed', () => {
    const state = useState()
    const repo = tmp('ahead')
    const failure = (error: string) => [
      {
        repo,
        configPath: join(repo, '.herdr-desk.json'),
        error,
        source: 'remembered' as const,
      },
    ]

    logLoadFailures(failure('tasks[0].watch: unknown field'))
    let log = readFileSync(join(state, 'daemon.log'), 'utf8')
    expect(log).toContain(`load error ${repo}`)
    expect(log).toContain('unknown field')
    const firstCount = log
      .split('\n')
      .filter((l) => l.includes('load error')).length
    expect(firstCount).toBe(1)

    // Not per tick: a config does not change on its own, so the same error on the
    // next tick is not news. Per process would be a line per restart; this is
    // neither.
    logLoadFailures(failure('tasks[0].watch: unknown field'))
    logLoadFailures(failure('tasks[0].watch: unknown field'))
    log = readFileSync(join(state, 'daemon.log'), 'utf8')
    expect(
      log.split('\n').filter((l) => l.includes('load error')),
    ).toHaveLength(1)

    // A *different* error on the same repo is new information and says so.
    logLoadFailures(failure('tasks[0].schedule: 5-field cron'))
    log = readFileSync(join(state, 'daemon.log'), 'utf8')
    expect(
      log.split('\n').filter((l) => l.includes('load error')),
    ).toHaveLength(2)
    expect(log).toContain('5-field cron')
  })

  test('a repo that loads again is dropped, so a later breakage says so', () => {
    const state = useState()
    const repo = tmp('ahead')
    const failure = (error: string) => [
      {
        repo,
        configPath: join(repo, '.herdr-desk.json'),
        error,
        source: 'remembered' as const,
      },
    ]
    logLoadFailures(failure('boom'))
    logLoadFailures([])
    // The same error again after a recovery in between is a new outage, not a
    // repeat of the one that is over.
    logLoadFailures(failure('boom'))
    const log = readFileSync(join(state, 'daemon.log'), 'utf8')
    expect(
      log.split('\n').filter((l) => l.includes('load error')),
    ).toHaveLength(2)
  })

  test('a multi-line validator error is logged as one line', () => {
    // The validator returns a list; `daemon.log` is a line-per-event log, and a
    // wrapped paragraph in it breaks every reader that tails it.
    useState()
    logLoadFailures([
      {
        repo: '/tmp/ahead',
        configPath: '/tmp/ahead/.herdr-desk.json',
        error: 'first problem\nsecond problem',
        source: 'remembered',
      },
    ])
    const log = readFileSync(
      join(process.env.HERDR_PLUGIN_STATE_DIR as string, 'daemon.log'),
      'utf8',
    )
    expect(log).toContain('first problem')
    expect(log).not.toContain('second problem')
  })

  test('an unreadable ledger is not a reason to lose the tick', () => {
    // A state file that cannot be written must not take the cron path with it.
    // The direction of failure is deliberate: log the trouble, lose at most a
    // duplicate line, and never the desk.
    const state = useState()
    writeFileSync(join(state, 'load-errors.json'), '{ not json')
    logLoadFailures([
      {
        repo: '/tmp/ahead',
        configPath: null,
        error: 'boom',
        source: 'remembered',
      },
    ])
    const log = readFileSync(join(state, 'daemon.log'), 'utf8')
    expect(log).toContain('load error /tmp/ahead: boom')
  })

  test('the tick logs it and still fires every other desk', async () => {
    // The end-to-end acceptance case: a repo that failed to load, plus two that
    // are fine. The bad one is in `daemon.log`; the good ones still run.
    const state = useState()
    const good = [tmp('g1'), tmp('g2')]
    const bad = tmp('b1')
    for (const [i, r] of good.entries()) writeConfig(r, goodConfig(`good${i}`))
    writeConfig(bad, armAheadConfig('ahead'))
    remember(state, ...good, bad)
    const roomy = () => ({ ok: true, breaches: [], pressure: 0 })
    // A schedule in the past so the tick has a slot due, and a Herdr that is not
    // running, so each job resolves as a precondition skip rather than hanging.
    const past = new Date(Date.now() - 7 * 86_400_000)

    await tickOnce(past, roomy)
    const log = readFileSync(join(state, 'daemon.log'), 'utf8')
    expect(log).toContain(`load error ${bad}`)
    // Both good desks fired; the bad one has no jobs to fire.
    expect(log).toContain('fire good0')
    expect(log).toContain('fire good1')
    // And it is remembered, so it is still discovered — and still reported — on
    // the next tick, with no restart in between.
    expect(
      JSON.parse(readFileSync(join(state, 'known-repos.json'), 'utf8')),
    ).toMatchObject({
      repos: expect.arrayContaining([bad]),
    })
  })
})
