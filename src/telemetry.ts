import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dayKey } from './day'
import { type GlobalConfig, loadGlobalConfig } from './layers'
import { pluginStateDir } from './paths'
import { installedVersion } from './update'

/**
 * Anonymous usage count: one `ping` per machine per day from the daemon.
 *
 * What leaves the machine is `Payload` and nothing else: no paths, no repo
 * names, no config. The id is random, made once, and never derived from the
 * host. README "Telemetry" says the same; change both together.
 */

/** Where pings go. `HERDR_DESK_TELEMETRY_ENDPOINT` overrides it; empty turns telemetry off. */
export const TELEMETRY_ENDPOINT =
  'https://telemetry.anyr.workers.dev/herdr-desk'
export const SEND_TIMEOUT_MS = 1000

export const TELEMETRY_NOTICE =
  'herdr-desk collects anonymous usage data. Opt out: HERDR_DESK_TELEMETRY_DISABLED=1 or DO_NOT_TRACK=1. Details: https://telemetry.anyr.workers.dev/herdr-desk'

export type Payload = {
  event: string
  id?: string
  version: string
  os: string
  arch: string
  ci: boolean
}

type Env = Record<string, string | undefined>

export type TelemetryDeps = {
  env?: Env
  now?: Date
  fetchImpl?: typeof fetch
  global?: () => GlobalConfig
  version?: () => string
  /** The one-line first-run notice. */
  notice?: (line: string) => void
  /** Where `HERDR_DESK_TELEMETRY_DEBUG=1` prints payloads. */
  print?: (line: string) => void
}

export type TelemetryOutcome =
  | 'disabled'
  | 'not-due'
  | 'debug'
  | 'sent'
  | 'failed'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function idPath(): string {
  return join(pluginStateDir(), 'telemetry-id')
}

function lastPath(): string {
  return join(pluginStateDir(), 'telemetry-last')
}

/** `1`, `true`, anything but empty, `0` and `false`. */
function on(v: string | undefined): boolean {
  if (v === undefined) return false
  const t = v.trim().toLowerCase()
  return t !== '' && t !== '0' && t !== 'false'
}

function endpointOf(env: Env): string {
  return env.HERDR_DESK_TELEMETRY_ENDPOINT ?? TELEMETRY_ENDPOINT
}

/**
 * Whether anything may be sent. Every "no" here is silent and touches no file.
 *
 * A machine config that cannot be read is a "no": the opt-out lives there, so
 * an unreadable file is not evidence the user did not opt out.
 */
export function telemetryEnabled(
  env: Env = process.env,
  global: () => GlobalConfig = loadGlobalConfig,
): boolean {
  if (on(env.DO_NOT_TRACK) || on(env.HERDR_DESK_TELEMETRY_DISABLED)) {
    return false
  }
  if (!endpointOf(env).trim()) return false
  if (on(env.CI) && !on(env.HERDR_DESK_TELEMETRY_CI)) return false
  try {
    return global().telemetry !== false
  } catch {
    return false
  }
}

function readId(): string | null {
  try {
    if (!existsSync(idPath())) return null
    const id = readFileSync(idPath(), 'utf8').trim()
    return UUID.test(id) ? id : null
  } catch {
    return null
  }
}

/** Create the id once. Null when it cannot be written: then none is sent. */
function createId(): string | null {
  const id = randomUUID()
  try {
    mkdirSync(pluginStateDir(), { recursive: true })
    writeFileSync(idPath(), `${id}\n`)
    return id
  } catch {
    return null
  }
}

function lastSentDay(): string | null {
  try {
    return existsSync(lastPath())
      ? readFileSync(lastPath(), 'utf8').trim()
      : null
  } catch {
    return null
  }
}

async function post(
  endpoint: string,
  payload: Payload,
  fetchImpl: typeof fetch,
): Promise<void> {
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  })
  // The answer is ignored; drop the body so the socket is not held open.
  await res.body?.cancel()
}

/**
 * The daemon's once-a-day telemetry step. Never throws and never retries.
 *
 * The day stamp is written before sending, as the update check does, so an
 * unreachable endpoint costs one attempt a day instead of one per tick. A stamp
 * that cannot be written means no send at all: with no gate, every 20 second
 * tick would ping. The first run (no id yet) sends `install` as well as `ping`.
 * Debug mode prints what would be sent and leaves no trace: no id, no stamp,
 * no notice.
 */
export async function maybeTelemetry(
  deps: TelemetryDeps = {},
): Promise<TelemetryOutcome> {
  try {
    const env = deps.env ?? process.env
    if (!telemetryEnabled(env, deps.global)) return 'disabled'

    const now = deps.now ?? new Date()
    const today = dayKey(now)
    if (lastSentDay() === today) return 'not-due'

    const debug = on(env.HERDR_DESK_TELEMETRY_DEBUG)
    const known = readId()
    const id = known ?? (debug ? randomUUID() : createId())
    if (!known && !debug && id) {
      try {
        deps.notice?.(TELEMETRY_NOTICE)
      } catch {
        // A notice that cannot be shown must not cost the ping.
      }
    }

    const base = {
      version: (deps.version ?? installedVersion)(),
      os: process.platform,
      arch: process.arch,
      ci: on(env.CI),
    }
    const payloads: Payload[] = (known ? ['ping'] : ['install', 'ping']).map(
      (event) => ({ event, ...(id ? { id } : {}), ...base }),
    )

    if (debug) {
      const print = deps.print ?? ((line) => console.error(line))
      for (const p of payloads)
        print(`telemetry (not sent): ${JSON.stringify(p)}`)
      return 'debug'
    }

    try {
      mkdirSync(pluginStateDir(), { recursive: true })
      writeFileSync(lastPath(), `${today}\n`)
    } catch {
      return 'failed'
    }
    const endpoint = endpointOf(env).trim()
    const fetchImpl = deps.fetchImpl ?? fetch
    for (const p of payloads) await post(endpoint, p, fetchImpl)
    return 'sent'
  } catch {
    return 'failed'
  }
}
