import { type Dashboard, dashboardJson, renderWeb } from './dashboard'

export type HttpDeps = {
  dashboard: () => Dashboard
  analytics: (since: string) => unknown
}

function text(body: string, status: number, type: string): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': type },
  })
}

function json(body: unknown): Response {
  return text(
    JSON.stringify(body, null, 2),
    200,
    'application/json; charset=utf-8',
  )
}

/** GET `/`, `/api/dashboard`, and `/api/analytics`. Anything else is 404 or 405. */
export function handle(req: Request, deps: HttpDeps): Response {
  if (req.method !== 'GET')
    return text('method not allowed', 405, 'text/plain; charset=utf-8')
  const url = new URL(req.url)
  if (url.pathname === '/') {
    return text(renderWeb(deps.dashboard()), 200, 'text/html; charset=utf-8')
  }
  if (url.pathname === '/api/dashboard')
    return json(dashboardJson(deps.dashboard()))
  if (url.pathname === '/api/analytics') {
    const since = url.searchParams.get('since') ?? '30d'
    try {
      return json(deps.analytics(since))
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return text(message, 400, 'text/plain; charset=utf-8')
    }
  }
  return text('not found', 404, 'text/plain; charset=utf-8')
}

export function serve(opts: {
  port: number
  hostname: string
  deps: HttpDeps
}): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: opts.port,
    hostname: opts.hostname,
    fetch: (req) => handle(req, opts.deps),
  })
}
