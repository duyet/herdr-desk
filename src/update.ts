import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultHerdrBin, defaultSocket, herdrJson } from './herdr'
import { loadGlobalConfig } from './layers'
import { pluginStateDir } from './paths'

/**
 * Self-update: compare the installed version with the latest GitHub release
 * and, when asked, reinstall through Herdr.
 *
 * Reinstall, not `git pull`: Herdr v1 has no `plugin update`, and only a
 * reinstall re-registers the manifest, so a release that adds `[[actions]]`
 * would otherwise leave the registered manifest stale.
 */

const PLUGIN_ID = 'herdr-desk'
const FETCH_TIMEOUT_MS = 10_000
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

export const PLUGIN_ROOT = join(import.meta.dir, '..')

/** `v0.1.6` / `0.1.6` → `[0, 1, 6]`. Throws on anything else. */
export function parseVersion(raw: string): [number, number, number] {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim())
  if (!m) throw new Error(`not a version: '${raw}'`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** Negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}

/** The version in the manifest that release-please bumps. */
export function installedVersion(root = PLUGIN_ROOT): string {
  const text = readFileSync(join(root, 'herdr-plugin.toml'), 'utf8')
  const m = /^version\s*=\s*"([^"]+)"/m.exec(text)
  if (!m) throw new Error(`${root}/herdr-plugin.toml: no version field`)
  return m[1]
}

/** How Herdr says this plugin was installed. */
export type SelfSource = {
  kind: string
  owner?: string
  repo?: string
  requestedRef?: string
  pluginRoot?: string
}

export function parseSelfSource(listJson: unknown): SelfSource | null {
  const plugins = (listJson as { result?: { plugins?: unknown[] } })?.result
    ?.plugins
  if (!Array.isArray(plugins)) return null
  const hit = plugins.find(
    (p) => (p as { plugin_id?: unknown })?.plugin_id === PLUGIN_ID,
  ) as Record<string, unknown> | undefined
  if (!hit) return null
  const src = (hit.source ?? {}) as Record<string, unknown>
  const s = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  return {
    kind: s(src.kind) ?? 'unknown',
    owner: s(src.owner),
    repo: s(src.repo),
    requestedRef: s(src.requested_ref),
    pluginRoot: s(hit.plugin_root),
  }
}

export async function selfSource(): Promise<SelfSource> {
  const list = await herdrJson(defaultHerdrBin(), defaultSocket(), [
    'plugin',
    'list',
    '--json',
  ])
  const src = parseSelfSource(list)
  if (!src) throw new Error(`${PLUGIN_ID} is not in herdr plugin list`)
  return src
}

/** Latest release tag, e.g. `v0.1.7`. Unauthenticated, with a timeout. */
export async function fetchLatestTag(
  owner: string,
  repo: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/latest`
  let res: Response
  try {
    res = await fetchImpl(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': PLUGIN_ID,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (err) {
    throw new Error(
      `${url}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  const body = (await res.json()) as { tag_name?: unknown }
  if (typeof body.tag_name !== 'string') {
    throw new Error(`${url}: no tag_name`)
  }
  return body.tag_name
}

export type UpdateCheck = {
  installed: string
  latest: string
  newer: boolean
  source: SelfSource
  /** Why an apply would not happen, even though a newer version exists. */
  blocked?: string
}

export async function checkForUpdate(
  deps: {
    source?: () => Promise<SelfSource>
    latest?: (owner: string, repo: string) => Promise<string>
    installed?: () => string
  } = {},
): Promise<UpdateCheck> {
  const source = await (deps.source ?? selfSource)()
  const owner = source.owner ?? 'duyet'
  const repo = source.repo ?? PLUGIN_ID
  const latest = await (deps.latest ?? fetchLatestTag)(owner, repo)
  const installed = (deps.installed ?? installedVersion)()
  const newer = compareVersions(latest, installed) > 0
  let blocked: string | undefined
  // A linked tree belongs to whoever linked it; Herdr refuses to install over
  // it anyway. A pin is a choice the user made, so it is never moved silently.
  if (source.kind !== 'github') blocked = `installed as ${source.kind}`
  else if (source.requestedRef) blocked = `pinned to ${source.requestedRef}`
  return { installed, latest, newer, source, blocked }
}

/** `herdr plugin install owner/repo --yes`. Plain output, so not herdrJson. */
export async function reinstall(source: SelfSource): Promise<void> {
  const target = `${source.owner ?? 'duyet'}/${source.repo ?? PLUGIN_ID}`
  const proc = Bun.spawn(
    [defaultHerdrBin(), 'plugin', 'install', target, '--yes'],
    {
      env: { ...process.env, HERDR_SOCKET_PATH: defaultSocket() },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [out, err, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exit !== 0) {
    throw new Error(
      `herdr plugin install ${target} failed (${exit}): ${(err || out).trim().slice(0, 400)}`,
    )
  }
}

/** Machine config only: a committed repo file must not steer the machine. */
export function autoUpdateEnabled(global = loadGlobalConfig()): boolean {
  return global.autoUpdate !== false
}

function checkPath(): string {
  return join(pluginStateDir(), 'update-check.json')
}

export function loadLastCheck(): string | null {
  if (!existsSync(checkPath())) return null
  try {
    const raw = JSON.parse(readFileSync(checkPath(), 'utf8')) as {
      at?: unknown
    }
    return typeof raw.at === 'string' ? raw.at : null
  } catch {
    return null
  }
}

export function saveLastCheck(at: Date, result: string): void {
  mkdirSync(pluginStateDir(), { recursive: true })
  writeFileSync(
    checkPath(),
    `${JSON.stringify({ at: at.toISOString(), result }, null, 2)}\n`,
  )
}

export function checkDue(last: string | null, now: Date): boolean {
  if (!last) return true
  const t = Date.parse(last)
  if (Number.isNaN(t)) return true
  return now.getTime() - t >= CHECK_INTERVAL_MS
}

export type AutoUpdateDeps = {
  now?: Date
  enabled?: boolean
  check?: () => Promise<UpdateCheck>
  apply?: (source: SelfSource) => Promise<void>
  notify?: (message: string) => Promise<void>
  log?: (line: string) => void
}

export type AutoUpdateOutcome =
  | 'not-due'
  | 'current'
  | 'available'
  | 'blocked'
  | 'updated'
  | 'failed'

/**
 * The daemon's once-a-day step. Checking always happens when due; applying
 * happens only when `autoUpdate` is on. The timestamp is written before
 * anything is applied and on failure too, so a network error or a release
 * whose manifest version lags its tag cannot retry (and notify) every tick.
 */
export async function maybeAutoUpdate(
  deps: AutoUpdateDeps = {},
): Promise<AutoUpdateOutcome> {
  const now = deps.now ?? new Date()
  const log = deps.log ?? (() => {})
  if (!checkDue(loadLastCheck(), now)) return 'not-due'
  let check: UpdateCheck
  try {
    check = await (deps.check ?? checkForUpdate)()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    saveLastCheck(now, `fail ${msg}`)
    log(`update check failed: ${msg}`)
    return 'failed'
  }
  if (!check.newer) {
    saveLastCheck(now, `current ${check.installed}`)
    return 'current'
  }
  const what = `${check.installed} -> ${check.latest}`
  if (check.blocked) {
    saveLastCheck(now, `blocked ${what}`)
    log(`update available ${what}, not applied: ${check.blocked}`)
    return 'blocked'
  }
  if (!(deps.enabled ?? autoUpdateEnabled())) {
    saveLastCheck(now, `available ${what}`)
    log(`update available ${what} (autoUpdate off)`)
    return 'available'
  }
  saveLastCheck(now, `applying ${what}`)
  const send = deps.notify ?? (async () => {})
  try {
    await (deps.apply ?? reinstall)(check.source)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    saveLastCheck(now, `fail ${what}: ${msg}`)
    log(`update ${what} failed: ${msg}`)
    await send(`herdr-desk update ${what} failed: ${msg}`).catch(() => {})
    return 'failed'
  }
  saveLastCheck(now, `updated ${what}`)
  log(`updated ${what}`)
  await send(`herdr-desk updated ${what}`).catch(() => {})
  return 'updated'
}
