import { existsSync } from 'node:fs'
import { connect } from 'node:net'
import { basename, resolve } from 'node:path'
import { findConfigPath, type LoadedDesk, loadDeskConfig } from './config'
import { cronNext } from './cron'
import { daemonPid } from './daemon'
import { describeJob } from './describe'
import { resolveConfig } from './layers'
import { describePause, loadPaused, pausedNow } from './pause'
import { scheduleLabel } from './schedule'
import { textTable } from './table'

/**
 * The desk card: one repo's scheduled work, on one screen.
 *
 * ## Why this exists
 *
 * The original ask was "add items to the workspace right-click menu". Herdr
 * cannot do that, and it is not a manifest field waiting to be filled in. As of
 * stable 0.9.3 the sidebar context menu (`src/client/shell/context_menu.rs`) is
 * a literal `match` over the target kind returning hardcoded
 * `ClientContextMenuAction` variants, and `PluginActionContext` — the enum
 * behind `contexts` — has no consumer anywhere in `src/`. There is no plugin
 * menu, no plugin palette, and no grouping surface to attach to. Declaring
 * `contexts = ["workspace"]` states intent that Herdr parses, stores in
 * `PluginActionInfo`, and never acts on.
 *
 * So this is the closest surface Herdr actually offers: an action and a popup
 * that resolve the workspace Herdr hands them and print what is true about it.
 * Nothing here is a right-click menu and no output claims to be one.
 */

/** Port `desk serve` binds. One definition; `cli.ts serve` imports it. */
export const DEFAULT_DASHBOARD_PORT = 8787

/** Canonical dashboard URL for a port. Not a promise that anything is there. */
export function dashboardUrl(port = DEFAULT_DASHBOARD_PORT): string {
  return `http://127.0.0.1:${port}/`
}

/**
 * The workspace a plugin command was invoked for.
 *
 * Only the fields this card reads are kept, and each is read by name out of
 * Herdr's context JSON rather than by spreading the object. Two reasons, both
 * load-bearing:
 *
 * - `selected_text` and `clicked_url` are in that JSON and are deliberately not
 *   copied. `selected_text` is whatever the user had selected in the pane;
 *   printing it would push terminal content into a plugin log, a screenshot, or
 *   a bug report.
 * - Any field a future Herdr adds is dropped rather than leaked by accident.
 */
export type Invocation = {
  workspaceId?: string
  workspaceLabel?: string
  workspaceCwd?: string
  /** Git root of the worktree behind this workspace. */
  repoRoot?: string
  /** The directory this workspace was checked out to. */
  checkoutPath?: string
  linkedWorktree?: boolean
  branch?: string
  tabId?: string
  paneId?: string
  paneAgent?: string
  paneStatus?: string
  /** `keybind`, `link_click`, … — how Herdr says this ran. */
  source?: string
}

type Env = Record<string, string | undefined>

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {}
}

function text(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t ? t : undefined
}

/**
 * Read the invoking workspace out of the environment Herdr injects.
 *
 * `HERDR_PLUGIN_CONTEXT_JSON` carries the full context and `HERDR_WORKSPACE_ID`
 * the one id Herdr also exports separately, so it is the fallback when the JSON
 * is missing or unparseable. Malformed JSON is not an error here: it degrades
 * to whatever ids remain, because a card missing a workspace name beats an
 * action that fails with a stack trace.
 *
 * This is the workspace Herdr invoked the command *for*. There is no clicked
 * workspace to read — no plugin hook receives one — so the card reports which
 * invocation it got rather than implying a click.
 */
export function parseInvocation(env: Env): Invocation {
  const out: Invocation = {}
  try {
    const ctx = record(JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON ?? 'null'))
    const wt = record(ctx.worktree)
    out.workspaceId = text(ctx.workspace_id)
    out.workspaceLabel = text(ctx.workspace_label)
    out.workspaceCwd = text(ctx.workspace_cwd)
    out.repoRoot = text(wt.repo_root) ?? text(wt.repoRoot)
    out.checkoutPath = text(wt.checkout_path) ?? text(wt.checkoutPath)
    out.linkedWorktree =
      wt.is_linked_worktree === true || wt.isLinkedWorktree === true
    out.branch = text(ctx.branch)
    out.tabId = text(ctx.tab_id)
    out.paneId = text(ctx.focused_pane_id)
    out.paneAgent = text(ctx.focused_pane_agent)
    out.paneStatus = text(ctx.focused_pane_status)
    out.source = text(ctx.invocation_source)
  } catch {
    // Left empty on purpose; the ids below still apply.
  }
  out.workspaceId = out.workspaceId ?? text(env.HERDR_WORKSPACE_ID)
  return out
}

/** How the repo directory was chosen, printed so the choice is auditable. */
export type RepoVia = 'checkout' | 'repo-root' | 'cwd' | 'cwd-fallback'

export type RepoPick = {
  /** Directory the desk config is looked for in. */
  repo: string
  via: RepoVia
  /** True when this workspace is a linked worktree, whatever it resolves to. */
  linkedWorktree: boolean
}

/**
 * Which directory is this workspace's repo?
 *
 * Candidates are ordered so a worktree answers with the worktree first: a
 * linked worktree carries its own checkout of the repo, config included, and
 * preferring the main checkout would report a config the user is not looking
 * at. The first candidate that actually holds a config wins; failing that, the
 * first that exists on disk, so an unconfigured repo still names the directory
 * that was checked instead of reporting nothing.
 *
 * A workspace carrying no worktree information (a plain directory Space) falls
 * back to the command's cwd, the only thing left to go on.
 */
export function pickRepo(inv: Invocation, cwd = process.cwd()): RepoPick {
  const linkedWorktree = inv.linkedWorktree === true
  const candidates: Array<[RepoVia, string | undefined]> = [
    ['checkout', inv.checkoutPath],
    ['repo-root', inv.repoRoot],
    ['cwd', inv.workspaceCwd],
    ['cwd-fallback', cwd],
  ]
  let firstExisting: { repo: string; via: RepoVia } | null = null
  for (const [via, dir] of candidates) {
    if (!dir) continue
    const repo = resolve(dir)
    if (findConfigPath(repo)) return { repo, via, linkedWorktree }
    if (!firstExisting && existsSync(repo)) firstExisting = { repo, via }
  }
  const fallback = firstExisting ?? {
    repo: resolve(cwd),
    via: 'cwd-fallback' as const,
  }
  return { ...fallback, linkedWorktree }
}

/** Whether a TCP connect to the dashboard port succeeds. */
export type PortProbe = (port: number) => Promise<boolean>

/**
 * Is anything listening on the dashboard port?
 *
 * TCP only, on purpose. A `GET /` would render the whole dashboard, which is
 * precisely the expensive work this card is asking about. The result is
 * reported as "listening", never as "the desk is up": a listener on that port is
 * all a connect proves, and nothing more is claimed about what it is.
 */
export const tcpProbe: PortProbe = (port) =>
  new Promise<boolean>((done) => {
    const socket = connect({ host: '127.0.0.1', port })
    const finish = (ok: boolean) => {
      socket.destroy()
      done(ok)
    }
    socket.setTimeout(1000, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })

/** Everything the card prints. Nothing here is a promise about anything. */
export type DeskCardData = {
  pick: RepoPick
  inv: Invocation
  /** `null` when this repo has no desk config at all. */
  desk: LoadedDesk | null
  /** The file the config was read from, or `null` when there is none. */
  configPath: string | null
  /** Why the config could not be loaded, when there is one and it is broken. */
  configError?: string
  /** Origin path of every layer that contributed, in precedence order. */
  layers: string[]
  daemonPid: number | null
  /** Next fire for one of this repo's jobs. */
  nextFire: (task: string) => Date | null
  /** Set when this repo's job is paused right now, else `undefined`. */
  paused: (task: string) => string | undefined
  port: number
  /** `null` until a probe runs, or when the probe was skipped. */
  dashboardUp: boolean | null
}

export type CardOptions = {
  /** `--repo`. Wins over the invocation context. */
  override?: string
  cwd?: string
  /** Omit to skip the probe entirely; the card then says "not checked". */
  probe?: PortProbe | null
  port?: number
  now?: Date
  /** Test seam for the daemon pid. */
  pid?: number | null
}

/**
 * Assemble everything the card prints.
 *
 * A config that exists but does not load is reported as an error, not as an
 * absent config. Those are different problems — broken versus unscheduled — and
 * a card that said "no config" about a repo holding a malformed
 * `.herdr-desk.json` would be lying about the reason.
 */
export function collectCard(
  inv: Invocation,
  opts: CardOptions = {},
): DeskCardData {
  const pick = opts.override
    ? {
        repo: resolve(opts.override),
        via: 'cwd-fallback' as const,
        linkedWorktree: inv.linkedWorktree === true,
      }
    : pickRepo(inv, opts.cwd ?? process.cwd())
  const now = opts.now ?? new Date()

  let desk: LoadedDesk | null = null
  let configError: string | undefined
  const configPath = findConfigPath(pick.repo)
  if (configPath) {
    try {
      desk = loadDeskConfig(pick.repo)
    } catch (err) {
      configError = err instanceof Error ? err.message : String(err)
    }
  }

  // `resolveConfig` rather than the desk: it reports each layer's origin even
  // when the repo's own file is the one that failed to parse, which is exactly
  // the case where "where did this come from" is the question being asked.
  const layers = resolveConfig(pick.repo).sources.map((s) => s.origin)
  const paused = loadPaused()

  return {
    pick,
    inv,
    desk,
    configPath,
    configError,
    layers,
    daemonPid: opts.pid === undefined ? daemonPid() : opts.pid,
    nextFire: (task) => {
      const t = desk?.tasks.find((x) => x.id === task)
      if (!t) return null
      return (
        t.crons
          .map((expr) => cronNext(expr, now))
          .filter((d): d is Date => d !== null)
          .sort((a, b) => a.getTime() - b.getTime())[0] ?? null
      )
    },
    paused: (task) => {
      if (!desk?.tasks.some((x) => x.id === task)) return undefined
      const hold = pausedNow(paused, pick.repo, task, now)
      // `describePause` is the same wording `status` prints, so a job reads as
      // paused in the card and on the dashboard with one phrase.
      return hold ? describePause(hold) : undefined
    },
    port: opts.port ?? DEFAULT_DASHBOARD_PORT,
    dashboardUp: null,
  }
}

/** Run the probe, keeping a probe failure from taking the card down with it. */
export async function withProbe(
  data: DeskCardData,
  probe: PortProbe,
): Promise<DeskCardData> {
  try {
    return { ...data, dashboardUp: await probe(data.port) }
  } catch {
    return { ...data, dashboardUp: null }
  }
}

function tildify(path: string): string {
  const home = process.env.HOME
  return home && path.startsWith(`${home}/`)
    ? `~${path.slice(home.length)}`
    : path
}

function jobRows(data: DeskCardData): string[][] {
  if (!data.desk) return []
  return data.desk.tasks.map((t) => {
    const hold = data.paused(t.id)
    const next = data.nextFire(t.id)
    return [
      t.id,
      t.agent.ladder.join(' > '),
      t.agent.permission,
      scheduleLabel(t.crons),
      hold
        ? `paused: ${hold}`
        : next
          ? next.toISOString().slice(0, 16).replace('T', ' ')
          : 'no cron',
      String(t.maxChildren ?? 5),
    ]
  })
}

/**
 * Render the card.
 *
 * Three rules the text is built around:
 *
 * - **Nothing is claimed that was not observed.** The dashboard line prints the
 *   canonical URL either way and states plainly whether anything is listening
 *   plus the command that starts it, instead of handing over a link that
 *   answers 404.
 * - **An unconfigured repo says so, naming the directory that was checked.**
 *   Silence, or a guessed path, is the #97 shape: a repo that looks absent for
 *   a reason that is not the real one.
 * - **Commands are printed, not run.** The card reads. It starts nothing and
 *   fires no job, so it is safe to bind to a key.
 */
export function renderCard(data: DeskCardData): string {
  const { pick, inv } = data
  const lines: string[] = []

  const name = data.desk?.name ?? basename(pick.repo)
  lines.push(`desk  ${name}  ${tildify(pick.repo)}`)

  const ws: string[] = []
  if (inv.workspaceLabel) ws.push(inv.workspaceLabel)
  if (pick.linkedWorktree) ws.push('linked worktree')
  if (inv.branch) ws.push(`branch ${inv.branch}`)
  if (inv.paneAgent) ws.push(`agent ${inv.paneAgent}`)
  if (inv.source) ws.push(`via ${inv.source}`)
  lines.push(
    `workspace  ${ws.length ? ws.join('  ') : '(no workspace context)'}`,
  )
  lines.push(`repo from  ${pick.via}`)

  lines.push('')
  if (data.configError) {
    lines.push(`config  ${data.configPath} — unreadable`)
    for (const l of data.configError.split('\n')) lines.push(`  ${l}`)
  } else if (data.desk && data.configPath) {
    lines.push(`config  ${data.configPath}`)
    lines.push(
      textTable(['JOB', 'AGENT', 'PERM', 'CRON', 'NEXT', 'MAX'], jobRows(data)),
    )
    // Below the table, not in it: these sentences are long, and a padded table
    // column would wrap them into something unreadable in an 80-column popup.
    for (const t of data.desk.tasks) {
      lines.push(`  ${t.id}  ${describeJob(pick.repo, t)}`)
    }
    if (data.layers.length > 1) {
      lines.push('layers')
      for (const origin of data.layers) lines.push(`  ${origin}`)
    }
  } else {
    lines.push(`config  none in ${pick.repo}`)
    lines.push('  this repo is not scheduled; add a .herdr-desk.json, then run')
    lines.push('  `desk config explain --repo <dir>` to see what it picked up')
  }

  lines.push('')
  const url = dashboardUrl(data.port)
  if (data.dashboardUp === true) {
    lines.push(`dashboard  ${url}  (listening)`)
  } else if (data.dashboardUp === false) {
    lines.push(`dashboard  ${url}  (nothing listening — start it: desk serve)`)
  } else {
    lines.push(`dashboard  ${url}  (not checked)`)
  }
  lines.push(
    `daemon     ${data.daemonPid ? `running (pid ${data.daemonPid})` : 'stopped'}`,
  )

  lines.push('')
  lines.push('next')
  lines.push(`  desk config explain --repo ${pick.repo}`)
  lines.push('  desk status')
  lines.push('  desk scan')

  return lines.join('\n')
}

/**
 * The card for the workspace Herdr invoked this command for.
 *
 * `--repo` is applied before any path from the invocation context, so an
 * explicit flag always beats ambient state.
 */
export async function deskCard(
  inv: Invocation,
  opts: CardOptions = {},
): Promise<string> {
  const data = collectCard(inv, opts)
  if (opts.probe === null) return renderCard(data)
  return renderCard(await withProbe(data, opts.probe ?? tcpProbe))
}

/**
 * Hold the terminal open until a key is pressed.
 *
 * Only for the popup entrypoint, which Herdr closes the moment its command
 * exits. A non-TTY — the action log, a pipe, a test — returns immediately rather
 * than blocking on a read that would never arrive.
 */
export async function waitForKey(): Promise<void> {
  const stdin = process.stdin
  if (!stdin.isTTY) return
  const wasRaw = stdin.isRaw
  try {
    stdin.setRawMode(true)
    stdin.resume()
    await new Promise<void>((done) => {
      stdin.once('data', () => done())
      stdin.once('error', () => done())
      stdin.once('end', () => done())
    })
  } finally {
    if (!wasRaw) stdin.setRawMode(false)
    stdin.pause()
  }
}
