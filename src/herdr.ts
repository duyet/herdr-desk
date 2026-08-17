import { existsSync } from 'node:fs'
import { homedir } from 'node:os'

export type HerdrClient = {
  bin: string
  socket: string
  json: (args: string[]) => Promise<unknown>
}

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

export function pickPane(createJson: unknown): {
  workspaceId: string
  paneId: string
} {
  const root =
    (createJson as { result?: Record<string, unknown> })?.result ?? {}
  const ws = (root.workspace ?? {}) as Record<string, unknown>
  const pane = (root.root_pane ?? root.pane ?? {}) as Record<string, unknown>
  const workspaceId = String(
    ws.workspace_id ?? ws.id ?? root.workspace_id ?? '',
  )
  const paneId = String(pane.pane_id ?? pane.id ?? root.pane_id ?? '')
  if (!paneId) {
    throw new Error(
      `no pane id in workspace create: ${JSON.stringify(createJson)}`,
    )
  }
  return { workspaceId, paneId }
}

export function agentNames(listJson: unknown): string[] {
  const agents =
    (listJson as { result?: { agents?: Array<{ name?: string }> } })?.result
      ?.agents ?? []
  return agents.map((a) => a.name).filter((n): n is string => Boolean(n))
}
