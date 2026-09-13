import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, resolve } from 'node:path'

export function defaultSocket(): string {
  return (
    process.env.HERDR_SOCKET_PATH ?? `${homedir()}/.config/herdr/herdr.sock`
  )
}

export function defaultHerdrBin(): string {
  return (
    process.env.HERDR_BIN_PATH ??
    process.env.HERDR_BIN ??
    `${homedir()}/.local/bin/herdr`
  )
}

export function herdrReady(
  bin = defaultHerdrBin(),
  socket = defaultSocket(),
): { ok: true; bin: string; socket: string } | { ok: false; reason: string } {
  if (!existsSync(bin))
    return { ok: false, reason: `herdr not found at ${bin}` }
  if (!existsSync(socket)) {
    return { ok: false, reason: `herdr socket missing (${socket})` }
  }
  return { ok: true, bin, socket }
}

/** Call Herdr with the default bin/socket. Throws if Herdr is missing. */
export async function herdrCall(args: string[]): Promise<unknown> {
  const ready = herdrReady()
  if (!ready.ok) throw new Error(ready.reason)
  return herdrJson(ready.bin, ready.socket, args)
}

export async function herdrJson(
  bin: string,
  socket: string,
  args: string[],
): Promise<unknown> {
  const proc = Bun.spawn([bin, ...args], {
    env: { ...process.env, HERDR_SOCKET_PATH: socket },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exit !== 0) {
    throw new Error(
      `herdr ${args.join(' ')} failed (${exit}): ${stderr || stdout}`,
    )
  }
  const text = stdout.trim()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`herdr ${args.join(' ')}: not JSON: ${text.slice(0, 400)}`)
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v) return v
  if (typeof v === 'number') return String(v)
  return undefined
}

export type ListedWorkspace = {
  workspaceId: string
  label?: string
  cwd?: string
  repoRoot?: string
  checkoutPath?: string
  parentWorkspaceId?: string
}

/** Parse `herdr workspace list` JSON. */
export function listedWorkspaces(listJson: unknown): ListedWorkspace[] {
  const root = asRecord(listJson)
  const result = asRecord(root.result)
  const arr = result.workspaces ?? root.workspaces
  if (!Array.isArray(arr)) return []
  const out: ListedWorkspace[] = []
  for (const item of arr) {
    const ws = asRecord(item)
    const wt = asRecord(ws.worktree)
    const workspaceId = str(ws.workspace_id) ?? str(ws.id) ?? ''
    if (!workspaceId) continue
    out.push({
      workspaceId,
      label: str(ws.label) ?? str(ws.name) ?? str(ws.title),
      cwd: str(ws.cwd) ?? str(ws.path),
      repoRoot: str(wt.repo_root) ?? str(wt.repoRoot),
      checkoutPath: str(wt.checkout_path) ?? str(wt.checkoutPath),
      parentWorkspaceId:
        str(wt.parent_workspace_id) ??
        str(wt.parentWorkspaceId) ??
        str(ws.parent_workspace_id) ??
        str(ws.parent_id) ??
        str(wt.primary_workspace_id),
    })
  }
  return out
}

function samePath(a: string | undefined, b: string): boolean {
  return Boolean(a) && resolve(a as string) === resolve(b)
}

function labelMatches(label: string | undefined, token: string): boolean {
  if (!label || !token) return false
  const a = label.trim().toLowerCase()
  const b = token.trim().toLowerCase()
  return a === b || a.startsWith(`${b} `) || a.endsWith(` ${b}`)
}

function byId(
  workspaces: ListedWorkspace[],
  id: string | undefined,
): ListedWorkspace | undefined {
  if (!id) return undefined
  return workspaces.find((w) => w.workspaceId === id)
}

/** Climb from a worktree child to the open project Space. */
export function projectRootOf(
  workspaces: ListedWorkspace[],
  hit: ListedWorkspace,
): ListedWorkspace {
  let cur = hit
  const seen = new Set<string>()
  while (cur.parentWorkspaceId && !seen.has(cur.workspaceId)) {
    seen.add(cur.workspaceId)
    const parent = byId(workspaces, cur.parentWorkspaceId)
    if (!parent) break
    cur = parent
  }
  return cur
}

/**
 * Open Herdr Space for this repo (anyrouter, chmonitor, …) — the parent
 * session, never a worktree child sitting beside it.
 */
export function projectWorkspaceForRepo(
  workspaces: ListedWorkspace[],
  opts: { repo: string; name?: string },
): ListedWorkspace | undefined {
  const want = resolve(opts.repo)
  const folder = basename(want)
  const name = opts.name?.trim() ?? ''

  let best: ListedWorkspace | undefined
  let bestScore = 0
  for (const w of workspaces) {
    let score = 0
    if (samePath(w.cwd, want) || samePath(w.checkoutPath, want)) score = 4
    else if (samePath(w.repoRoot, want)) score = 3
    else if (labelMatches(w.label, name) || labelMatches(w.label, folder))
      score = 2
    if (score > bestScore) {
      best = w
      bestScore = score
    }
  }
  if (!best) return undefined
  return projectRootOf(workspaces, best)
}

/** @deprecated use projectWorkspaceForRepo */
export function primaryWorkspaceForRepo(
  workspaces: ListedWorkspace[],
  repo: string,
): ListedWorkspace | undefined {
  return projectWorkspaceForRepo(workspaces, { repo })
}

export function pickPane(createJson: unknown): {
  workspaceId: string
  paneId: string
} {
  const root =
    (createJson as { result?: Record<string, unknown> })?.result ?? {}
  const ws = asRecord(root.workspace)
  const pane = asRecord(root.root_pane ?? root.pane)
  const tab = asRecord(root.tab)
  const workspaceId = String(
    ws.workspace_id ??
      ws.id ??
      root.workspace_id ??
      pane.workspace_id ??
      tab.workspace_id ??
      '',
  )
  const paneId = String(pane.pane_id ?? pane.id ?? root.pane_id ?? '')
  if (!paneId) {
    throw new Error(`no pane id in create: ${JSON.stringify(createJson)}`)
  }
  return { workspaceId, paneId }
}

export function agentNames(listJson: unknown): string[] {
  const agents =
    (listJson as { result?: { agents?: Array<{ name?: string }> } })?.result
      ?.agents ?? []
  return agents.map((a) => a.name).filter((n): n is string => Boolean(n))
}
