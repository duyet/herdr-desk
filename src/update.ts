import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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

const GH_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': PLUGIN_ID,
}

async function ghGet(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  let res: Response
  try {
    res = await fetchImpl(url, {
      headers: GH_HEADERS,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (err) {
    throw new Error(
      `${url}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return res.json()
}

/** Latest release tag, e.g. `v0.1.7`. Unauthenticated, with a timeout. */
export async function fetchLatestTag(
  owner: string,
  repo: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/latest`
  const body = (await ghGet(url, fetchImpl)) as { tag_name?: unknown }
  if (typeof body.tag_name !== 'string') {
    throw new Error(`${url}: no tag_name`)
  }
  return body.tag_name
}

export type ReleaseNote = { tag: string; body: string }

/** Newest releases first. Enough to cover a desk that skipped a few tags. */
export async function fetchReleaseNotes(
  owner: string,
  repo: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReleaseNote[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=15`
  const body = await ghGet(url, fetchImpl)
  if (!Array.isArray(body)) throw new Error(`${url}: not a list`)
  const out: ReleaseNote[] = []
  for (const row of body) {
    const tag = (row as { tag_name?: unknown }).tag_name
    const text = (row as { body?: unknown }).body
    if (typeof tag !== 'string') continue
    out.push({ tag, body: typeof text === 'string' ? text : '' })
  }
  return out
}

/** How many changelog lines an update prints. The rest is a count. */
export const CHANGELOG_LINES = 8

/**
 * One compact line per release-please bullet newer than `installed`.
 * Links, issue numbers, and SHAs are dropped. Empty when the body has
 * no `* ` bullets.
 */
export function changelogLines(
  installed: string,
  releases: ReleaseNote[],
  max = CHANGELOG_LINES,
): string[] {
  const lines: string[] = []
  let extra = 0
  for (const rel of releases) {
    let newer: boolean
    try {
      newer = compareVersions(rel.tag, installed) > 0
    } catch {
      continue
    }
    if (!newer) continue
    const ver = rel.tag.replace(/^v/, '')
    for (const raw of rel.body.split('\n')) {
      const bullet = /^\*\s+(.+)$/.exec(raw.trim())
      if (!bullet) continue
      let text = bullet[1].replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      text = text.replace(/\s*\([0-9a-f]{7,40}\)/gi, '')
      text = text.replace(/\s*\(#\d+\)/g, '')
      text = text.replace(/,?\s*closes\s+#\d+/gi, '')
      text = text.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim()
      if (!text) continue
      if (lines.length < max) lines.push(`${ver} ${text}`)
      else extra++
    }
  }
  if (extra > 0) lines.push(`+${extra} more`)
  return lines
}

export type UpdateCheck = {
  installed: string
  latest: string
  newer: boolean
  source: SelfSource
  /** Why an apply would not happen, even though a newer version exists. */
  blocked?: string
  /** Compact lines newer than `installed`. Empty when nothing parsed. */
  changes?: string[]
}

export async function checkForUpdate(
  deps: {
    source?: () => Promise<SelfSource>
    latest?: (owner: string, repo: string) => Promise<string>
    installed?: () => string
    notes?: (owner: string, repo: string) => Promise<ReleaseNote[]>
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
  let changes: string[] | undefined
  if (newer) {
    try {
      const notes = await (deps.notes ?? fetchReleaseNotes)(owner, repo)
      changes = changelogLines(installed, notes)
    } catch {
      changes = []
    }
  }
  return { installed, latest, newer, source, blocked, changes }
}

/**
 * `herdr plugin install owner/repo --yes`, or `--ref REF` for a rollback.
 * Plain output, so not herdrJson. Without `ref` this also clears a pin.
 */
export async function reinstall(
  source: SelfSource,
  ref?: string,
): Promise<void> {
  const target = `${source.owner ?? 'duyet'}/${source.repo ?? PLUGIN_ID}`
  const args = [defaultHerdrBin(), 'plugin', 'install', target, '--yes']
  if (ref) args.push('--ref', ref)
  const proc = Bun.spawn(args, {
    env: { ...process.env, HERDR_SOCKET_PATH: defaultSocket() },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exit !== 0) {
    throw new Error(
      `herdr plugin install ${target}${ref ? ` --ref ${ref}` : ''} failed (${exit}): ${(err || out).trim().slice(0, 400)}`,
    )
  }
}

const SMOKE_TIMEOUT_MS = 30_000

/**
 * Boot the installed tree's CLI and return the version it reports. This is
 * what "the new version starts" means here: the outgoing daemon cannot watch
 * its successor come up, but a tree whose CLI does not load, or reports the
 * wrong version, is not one to restart onto.
 */
export async function smokeVersion(root: string): Promise<string> {
  const proc = Bun.spawn(
    [process.execPath, join(root, 'src', 'cli.ts'), 'version'],
    { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' },
  )
  const timer = setTimeout(() => proc.kill(), SMOKE_TIMEOUT_MS)
  const [out, err, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  if (exit !== 0) {
    throw new Error(
      `${root}: cli exited ${exit}: ${(err || out).trim().slice(0, 400)}`,
    )
  }
  return out.trim()
}

export type ApplyDeps = {
  install?: (source: SelfSource, ref?: string) => Promise<void>
  source?: () => Promise<SelfSource>
  smoke?: (root: string) => Promise<string>
}

export type ApplyResult =
  | { ok: true }
  | { ok: false; error: string; rolledBack: boolean }

/** `0.1.8` / `v0.1.8` → `v0.1.8`, the release-please tag. */
export function tagOf(version: string): string {
  return `v${version.replace(/^v/, '')}`
}

/**
 * Install `to`, prove the new tree boots and reports `to`, and reinstall
 * `from` (pinned by tag) when it does not. The one upgrade path: the daemon
 * and `desk upgrade` both go through here.
 */
export async function applyUpdate(
  source: SelfSource,
  from: string,
  to: string,
  deps: ApplyDeps = {},
): Promise<ApplyResult> {
  const install = deps.install ?? reinstall
  let error: string
  try {
    await install(source)
    const after = await (deps.source ?? selfSource)()
    const root = after.pluginRoot ?? source.pluginRoot ?? PLUGIN_ROOT
    const got = await (deps.smoke ?? smokeVersion)(root)
    if (compareVersions(got, to) === 0) return { ok: true }
    error = `new tree reports ${got}, expected ${to}`
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  try {
    await install(source, tagOf(from))
    return { ok: false, error, rolledBack: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      error: `${error}; rollback failed: ${msg}`,
      rolledBack: false,
    }
  }
}

/**
 * Machine config only: a committed repo file must not steer the machine.
 * Off by default: an upgrade swaps the scheduler's code under every desk on
 * the machine, so the owner opts in. Off still checks daily and notifies once
 * per new version.
 */
export function autoUpdateEnabled(global = loadGlobalConfig()): boolean {
  return global.autoUpdate === true
}

function checkPath(): string {
  return join(pluginStateDir(), 'update-check.json')
}

/** What `update-check.json` remembers between daily checks. */
export type CheckState = {
  at: string
  result: string
  /** The version a notify-only check last announced. */
  notified?: string
  /** A version whose apply failed; never retried automatically. */
  failedVersion?: string
  /** The tag a failed apply pinned the install back to. */
  rolledBackTo?: string
}

export function loadCheckState(): CheckState | null {
  if (!existsSync(checkPath())) return null
  try {
    const raw = JSON.parse(readFileSync(checkPath(), 'utf8')) as Record<
      string,
      unknown
    >
    if (typeof raw.at !== 'string') return null
    const s = (v: unknown) => (typeof v === 'string' ? v : undefined)
    return {
      at: raw.at,
      result: s(raw.result) ?? '',
      notified: s(raw.notified),
      failedVersion: s(raw.failedVersion),
      rolledBackTo: s(raw.rolledBackTo),
    }
  } catch {
    return null
  }
}

export function loadLastCheck(): string | null {
  return loadCheckState()?.at ?? null
}

/** Stamp a check. Fields in `patch` replace remembered ones; the rest stay. */
export function saveLastCheck(
  at: Date,
  result: string,
  patch: Partial<Omit<CheckState, 'at' | 'result'>> = {},
): void {
  const next: CheckState = {
    ...loadCheckState(),
    ...patch,
    at: at.toISOString(),
    result,
  }
  mkdirSync(pluginStateDir(), { recursive: true })
  writeFileSync(checkPath(), `${JSON.stringify(next, null, 2)}\n`)
}

/** One line for `desk status`. */
export function updateStatusLine(
  state: CheckState | null,
  enabled: boolean,
  now = new Date(),
): string {
  const mode = enabled ? 'auto' : 'notify-only'
  if (!state) return `update: never checked (${mode})`
  const hours = Math.floor((now.getTime() - Date.parse(state.at)) / 3_600_000)
  const when = Number.isNaN(hours) ? state.at : `${hours}h ago`
  return `update: ${state.result} (${mode}), checked ${when}`
}

/** Why not to apply, ignoring a pin left by our own rollback. */
export function blockedBy(
  check: UpdateCheck,
  state: CheckState | null,
): string | undefined {
  const ownPin =
    state?.rolledBackTo !== undefined &&
    check.source.requestedRef === state.rolledBackTo
  return ownPin ? undefined : check.blocked
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
  /** True while a desk run is in flight; an upgrade waits for it. */
  busy?: () => boolean
  check?: () => Promise<UpdateCheck>
  apply?: (source: SelfSource, from: string, to: string) => Promise<ApplyResult>
  notify?: (message: string) => Promise<void>
  log?: (line: string) => void
}

export type AutoUpdateOutcome =
  | 'not-due'
  | 'deferred'
  | 'current'
  | 'available'
  | 'blocked'
  | 'skipped'
  | 'updated'
  | 'failed'

/**
 * The daemon's once-a-day step. Checking always happens when due; applying
 * happens only when `autoUpdate` is on. The timestamp is written before
 * anything is applied and on failure too, so a network error or a release
 * whose manifest version lags its tag cannot retry (and notify) every tick.
 *
 * Busy is tested before the network: a deferred tick writes no stamp so the
 * next tick retries, and must not spend a GitHub request each time.
 */
export async function maybeAutoUpdate(
  deps: AutoUpdateDeps = {},
): Promise<AutoUpdateOutcome> {
  const now = deps.now ?? new Date()
  const log = deps.log ?? (() => {})
  const state = loadCheckState()
  if (!checkDue(state?.at ?? null, now)) return 'not-due'
  const enabled = deps.enabled ?? autoUpdateEnabled()
  if (enabled && deps.busy?.()) return 'deferred'
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
  const send = deps.notify ?? (async () => {})
  if (blockedBy(check, state)) {
    saveLastCheck(now, `blocked ${what}`)
    log(`update available ${what}, not applied: ${check.blocked}`)
    return 'blocked'
  }
  if (!enabled) {
    const first = state?.notified !== check.latest
    saveLastCheck(now, `available ${what}`, { notified: check.latest })
    log(`update available ${what} (autoUpdate off)`)
    if (first) {
      await send(
        `herdr-desk ${what} is available: run \`herdr-desk upgrade\`, or set "autoUpdate": true`,
      ).catch(() => {})
    }
    return 'available'
  }
  if (state?.failedVersion === check.latest) {
    saveLastCheck(now, `skipped ${what}: it failed before`)
    log(`update ${what} skipped: it failed before`)
    return 'skipped'
  }
  saveLastCheck(now, `applying ${what}`)
  const res = await (deps.apply ?? applyUpdate)(
    check.source,
    check.installed,
    check.latest,
  )
  if (!res.ok) {
    const back = res.rolledBack ? `, rolled back to ${check.installed}` : ''
    saveLastCheck(now, `fail ${what}${back}: ${res.error}`, {
      failedVersion: check.latest,
      rolledBackTo: res.rolledBack ? tagOf(check.installed) : undefined,
    })
    log(`update ${what} failed${back}: ${res.error}`)
    await send(`herdr-desk update ${what} failed${back}: ${res.error}`).catch(
      () => {},
    )
    return 'failed'
  }
  saveLastCheck(now, `updated ${what}`, {
    failedVersion: undefined,
    rolledBackTo: undefined,
  })
  log(`updated ${what}`)
  const changes = check.changes?.length
    ? `\n${check.changes.map((l) => `· ${l}`).join('\n')}`
    : ''
  await send(`herdr-desk updated ${what}${changes}`).catch(() => {})
  return 'updated'
}

/** An install older than this is assumed dead; its lock no longer blocks. */
export const UPDATE_LOCK_MS = 10 * 60 * 1000

function lockPath(): string {
  return join(pluginStateDir(), 'updating')
}

/**
 * Held by `desk update` between stopping the daemon and restarting it, so a
 * `workspace.focused` event cannot start the old daemon from a checkout that
 * is being replaced.
 */
export function takeUpdateLock(now = new Date()): void {
  mkdirSync(pluginStateDir(), { recursive: true })
  writeFileSync(lockPath(), `${now.toISOString()}\n`)
}

export function releaseUpdateLock(): void {
  rmSync(lockPath(), { force: true })
}

export function updateLockHeld(now = new Date()): boolean {
  if (!existsSync(lockPath())) return false
  const t = Date.parse(readFileSync(lockPath(), 'utf8').trim())
  if (Number.isNaN(t)) return false
  return now.getTime() - t < UPDATE_LOCK_MS
}
