import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateDeskJson } from './schema'
import {
  maybeTelemetry,
  type Payload,
  SEND_TIMEOUT_MS,
  TELEMETRY_ENDPOINT,
  TELEMETRY_NOTICE,
  type TelemetryDeps,
  telemetryEnabled,
} from './telemetry'

const prevState = process.env.HERDR_PLUGIN_STATE_DIR
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'desk-telemetry-'))
  process.env.HERDR_PLUGIN_STATE_DIR = dir
})

afterEach(() => {
  if (prevState === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR
  else process.env.HERDR_PLUGIN_STATE_DIR = prevState
  rmSync(dir, { recursive: true, force: true })
})

type Call = { url: string; payload: Payload; signal?: AbortSignal | null }

/** A network that records every request and never touches a socket. */
function network(fail = false) {
  const calls: Call[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      payload: JSON.parse(String(init?.body)),
      signal: init?.signal,
    })
    if (fail) throw new Error('offline')
    return new Response(null, { status: 202 })
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

function run(
  net: ReturnType<typeof network>,
  env: Record<string, string | undefined> = {},
  more: TelemetryDeps = {},
) {
  return maybeTelemetry({
    env,
    fetchImpl: net.fetchImpl,
    global: () => ({}),
    version: () => '1.2.3',
    ...more,
  })
}

const day = (d: string) => new Date(`${d}T12:00:00`)

// A user who opted out must be able to count on nothing leaving, and on no
// trace being left either. The state dir stays empty for every one of these.
describe('suppressed: nothing is sent and nothing is written', () => {
  const cases: [string, Record<string, string>][] = [
    ['HERDR_DESK_TELEMETRY_DISABLED=1', { HERDR_DESK_TELEMETRY_DISABLED: '1' }],
    ['DO_NOT_TRACK=1', { DO_NOT_TRACK: '1' }],
    ['CI is set', { CI: 'true' }],
    ['empty endpoint override', { HERDR_DESK_TELEMETRY_ENDPOINT: '' }],
  ]
  for (const [name, env] of cases) {
    test(name, async () => {
      const net = network()
      expect(await run(net, env)).toBe('disabled')
      expect(net.calls).toHaveLength(0)
      expect(existsSync(join(dir, 'telemetry-id'))).toBe(false)
      expect(existsSync(join(dir, 'telemetry-last'))).toBe(false)
    })
  }

  test('telemetry: false in the machine config', async () => {
    const net = network()
    const out = await run(net, {}, { global: () => ({ telemetry: false }) })
    expect(out).toBe('disabled')
    expect(net.calls).toHaveLength(0)
  })

  // The opt-out lives in that file, so a file that will not parse is not a yes.
  test('a machine config that cannot be read', async () => {
    const net = network()
    const out = await run(
      net,
      {},
      {
        global: () => {
          throw new Error('bad json')
        },
      },
    )
    expect(out).toBe('disabled')
    expect(net.calls).toHaveLength(0)
  })

  test('DO_NOT_TRACK=0 and CI=false do not count as set', () => {
    expect(
      telemetryEnabled({ DO_NOT_TRACK: '0', CI: 'false' }, () => ({})),
    ).toBe(true)
  })

  test('HERDR_DESK_TELEMETRY_CI=1 lets a CI run send, marked ci', async () => {
    const net = network()
    const out = await run(net, { CI: '1', HERDR_DESK_TELEMETRY_CI: '1' })
    expect(out).toBe('sent')
    expect(net.calls.every((c) => c.payload.ci)).toBe(true)
  })
})

describe('debug', () => {
  test('prints the payload, sends nothing, leaves no trace', async () => {
    const net = network()
    const printed: string[] = []
    const out = await run(
      net,
      { HERDR_DESK_TELEMETRY_DEBUG: '1' },
      { print: (l) => printed.push(l) },
    )
    expect(out).toBe('debug')
    expect(net.calls).toHaveLength(0)
    expect(printed).toHaveLength(2)
    expect(printed[1]).toContain('"event":"ping"')
    expect(existsSync(join(dir, 'telemetry-id'))).toBe(false)
    // A stamp here would make the real ping wait a day after someone looked.
    expect(existsSync(join(dir, 'telemetry-last'))).toBe(false)
  })

  test('does not print when opted out', async () => {
    const printed: string[] = []
    const out = await run(
      network(),
      { HERDR_DESK_TELEMETRY_DEBUG: '1', DO_NOT_TRACK: '1' },
      { print: (l) => printed.push(l) },
    )
    expect(out).toBe('disabled')
    expect(printed).toHaveLength(0)
  })
})

describe('what is sent', () => {
  test('a POST of event, id, version, os, arch, ci and nothing else', async () => {
    const net = network()
    await run(net)
    const ping = net.calls.find((c) => c.payload.event === 'ping')
    expect(ping?.url).toBe(TELEMETRY_ENDPOINT)
    expect(Object.keys(ping?.payload ?? {}).sort()).toEqual([
      'arch',
      'ci',
      'event',
      'id',
      'os',
      'version',
    ])
    expect(ping?.payload.version).toBe('1.2.3')
    expect(ping?.payload.ci).toBe(false)
    expect(ping?.payload.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  test('the id is persisted and reused', async () => {
    const first = network()
    await run(first, {}, { now: day('2026-10-01') })
    const second = network()
    await run(second, {}, { now: day('2026-10-02') })
    const saved = readFileSync(join(dir, 'telemetry-id'), 'utf8').trim()
    expect(first.calls[0].payload.id).toBe(saved)
    expect(second.calls[0].payload.id).toBe(saved)
  })

  test('the endpoint can be overridden by env', async () => {
    const net = network()
    await run(net, { HERDR_DESK_TELEMETRY_ENDPOINT: 'http://127.0.0.1:9/x' })
    expect(net.calls[0].url).toBe('http://127.0.0.1:9/x')
  })

  test('every request carries a timeout of at most one second', async () => {
    const net = network()
    await run(net)
    expect(SEND_TIMEOUT_MS).toBeLessThanOrEqual(1000)
    expect(net.calls.every((c) => c.signal instanceof AbortSignal)).toBe(true)
  })
})

describe('first run', () => {
  test('sends install then ping, and shows the notice once', async () => {
    const net = network()
    const notices: string[] = []
    const notice = (l: string) => notices.push(l)
    await run(net, {}, { now: day('2026-10-01'), notice })
    expect(net.calls.map((c) => c.payload.event)).toEqual(['install', 'ping'])
    await run(net, {}, { now: day('2026-10-02'), notice })
    expect(net.calls.map((c) => c.payload.event)).toEqual([
      'install',
      'ping',
      'ping',
    ])
    expect(notices).toEqual([TELEMETRY_NOTICE])
  })

  test('a notice that throws does not cost the ping', async () => {
    const net = network()
    const out = await run(
      net,
      {},
      {
        notice: () => {
          throw new Error('no channel')
        },
      },
    )
    expect(out).toBe('sent')
    expect(net.calls).toHaveLength(2)
  })
})

// Sent at most once a day, however many ticks the daemon makes.
describe('daily gate', () => {
  test('one ping per day across many ticks', async () => {
    const net = network()
    await run(net, {}, { now: day('2026-10-01') }) // install + ping
    for (let i = 0; i < 50; i++) {
      expect(await run(net, {}, { now: day('2026-10-01') })).toBe('not-due')
    }
    expect(net.calls).toHaveLength(2)
    expect(await run(net, {}, { now: day('2026-10-02') })).toBe('sent')
    expect(net.calls).toHaveLength(3)
    expect(net.calls[2].payload.event).toBe('ping')
  })

  test('a failed send is not retried the same day', async () => {
    const down = network(true)
    expect(await run(down, {}, { now: day('2026-10-01') })).toBe('failed')
    const up = network()
    expect(await run(up, {}, { now: day('2026-10-01') })).toBe('not-due')
    expect(up.calls).toHaveLength(0)
  })

  // Without a stamp every tick would ping, so no stamp means no ping.
  test('a state dir that cannot be written sends nothing', async () => {
    const blocker = join(dir, 'file')
    writeFileSync(blocker, '')
    process.env.HERDR_PLUGIN_STATE_DIR = join(blocker, 'state')
    const net = network()
    expect(await run(net)).toBe('failed')
    expect(net.calls).toHaveLength(0)
  })
})

describe('telemetry config flag', () => {
  test('the validator and the JSON schema accept a boolean only', () => {
    expect(validateDeskJson({ name: 'd', telemetry: false })).toEqual([])
    expect(validateDeskJson({ name: 'd', telemetry: 'no' })).toHaveLength(1)
    const schema = JSON.parse(
      readFileSync(
        join(import.meta.dir, '..', 'herdr-desk.schema.json'),
        'utf8',
      ),
    )
    expect(schema.properties.telemetry?.type).toBe('boolean')
  })
})
