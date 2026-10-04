/** This node's tailnet addresses. `dns` is the MagicDNS name, without a trailing dot. */
export type Tailnet = {
  ip4?: string
  ip6?: string
  dns?: string
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

/**
 * Read this node out of `tailscale status --json`.
 *
 * Only `Self` counts. A peer's address must not become a bind address.
 * `Online: false` means the interface is down, so the dashboard stays on
 * localhost instead of advertising a name that will not answer.
 */
export function tailnetOf(raw: unknown): Tailnet | null {
  if (!raw || typeof raw !== 'object') return null
  const self = (raw as { Self?: unknown }).Self
  if (!self || typeof self !== 'object') return null
  const node = self as {
    Online?: unknown
    TailscaleIPs?: unknown
    DNSName?: unknown
  }
  if (node.Online === false) return null
  const ips = Array.isArray(node.TailscaleIPs) ? node.TailscaleIPs : []
  const ip4 = ips.find(
    (ip): ip is string => typeof ip === 'string' && IPV4.test(ip),
  )
  const ip6 = ips.find(
    (ip): ip is string => typeof ip === 'string' && ip.includes(':'),
  )
  if (!ip4 && !ip6) return null
  const dns =
    typeof node.DNSName === 'string'
      ? node.DNSName.trim().replace(/\.$/, '')
      : ''
  return { ip4, ip6, dns: dns || undefined }
}

export type StatusRun = () => Promise<{ code: number; stdout: string }>

/** `tailscale status --json`, or null when the CLI is missing, slow, or logged out. */
export async function detectTailnet(
  run: StatusRun = tailscaleStatus,
): Promise<Tailnet | null> {
  try {
    const { code, stdout } = await run()
    if (code !== 0) return null
    return tailnetOf(JSON.parse(stdout))
  } catch {
    return null
  }
}

async function tailscaleStatus(): Promise<{ code: number; stdout: string }> {
  const child = Bun.spawn(['tailscale', 'status', '--json'], {
    stdout: 'pipe',
    stderr: 'ignore',
    stdin: 'ignore',
  })
  const timer = setTimeout(() => child.kill(), 2000)
  try {
    const [stdout, code] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ])
    return { code, stdout }
  } finally {
    clearTimeout(timer)
  }
}

/** Addresses to bind. An explicit `--host` is the only one, and skips detection. */
export function bindHosts(
  explicit: string | undefined,
  tailnet: Tailnet | null,
): string[] {
  if (explicit) return [explicit]
  const hosts = ['127.0.0.1']
  if (tailnet?.ip4) hosts.push(tailnet.ip4)
  if (tailnet?.ip6) hosts.push(tailnet.ip6)
  return hosts
}

function hostForUrl(host: string): string {
  return host.includes(':') ? `[${host}]` : host
}

/**
 * URLs to print. The tailnet line uses the MagicDNS name, which is what another
 * device opens; the bind itself is the address that name resolves to.
 */
export function dashboardUrls(
  port: number,
  bound: string[],
  tailnet: Tailnet | null,
): string[] {
  const urls: string[] = []
  if (bound.includes('127.0.0.1')) urls.push(`http://127.0.0.1:${port}`)
  else if (bound[0]) urls.push(`http://${hostForUrl(bound[0])}:${port}`)
  const tailHost = [tailnet?.ip4, tailnet?.ip6].find(
    (ip): ip is string => typeof ip === 'string' && bound.includes(ip),
  )
  if (tailHost && tailnet) {
    urls.push(`http://${hostForUrl(tailnet.dns ?? tailHost)}:${port}`)
  }
  return [...new Set(urls)]
}
