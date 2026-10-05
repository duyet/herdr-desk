#!/usr/bin/env bun
/**
 * Print NDJSON for pull requests the desk has not seen, and nothing else.
 *
 * The desk runs this with `cwd` = repo root, every 60s, and reads stdout as the
 * event channel: one JSON object per line, no banner, no progress, nothing
 * else. Logs go to stderr. exit 0 means healthy whether or not anything
 * printed — "nothing new" is the common case and must never look like failure,
 * because a non-zero exit backs the poll off and records an error against a
 * watcher that was working fine.
 *
 * The cursor is `.herdr-desk/watch/prs.json`, gitignored. Print first, persist
 * second: the reverse loses every event printed but not yet recorded, and this
 * script owns that risk rather than handing it to the desk.
 *
 * The filters below are what make it safe to leave running unattended. The
 * `desk/*` one is load-bearing, not tidiness: the desk's own children open PRs,
 * so without it the desk reviews its own review commits, and the commit it
 * pushes for that review opens the next PR.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

type Pr = {
  number: number
  state: string
  title: string
  html_url: string
  created_at: string
  user: { login: string; type: string }
  head: { ref: string }
  base: { ref: string }
}

type Cursor = {
  version: 1
  repo: string
  updatedAt: string
  /** PR number -> created_at, so a stale entry is visible to a human reading it. */
  seen: Record<string, string>
}

const PER_PAGE = 30
/** Branch prefixes the desk never reviews: bots maintain those. */
const BOT_BRANCH = /^(release-please--|dependabot\/|renovate\/)/
/** Worktree branches the desk itself creates. */
const DESK_BRANCH = /^desk\//

const log = (line: string): void => {
  process.stderr.write(`${line}\n`)
}

/** `null` on failure: a missing remote is handled by the caller, not thrown. */
function sh(args: string[], cwd: string): string | null {
  const proc = Bun.spawnSync(args, { cwd, stdout: 'pipe', stderr: 'pipe' })
  return proc.exitCode === 0 ? proc.stdout.toString().trim() : null
}

function ghJson<T>(path: string): T {
  const proc = Bun.spawnSync(['gh', 'api', path], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (proc.exitCode !== 0) {
    const err = proc.stderr.toString().trim() || `exit ${proc.exitCode}`
    throw new Error(`gh api ${path}: ${err}`)
  }
  try {
    return JSON.parse(proc.stdout.toString()) as T
  } catch {
    throw new Error(`gh api ${path}: response was not JSON`)
  }
}

/** `owner/name` on its own — no host, no scheme. */
const BARE_SLUG = /^[\w.-]+\/[\w.-]+$/

function slugFromRemote(url: string): string | null {
  const cleaned = url.trim().replace(/\.git$/, '')
  const hit = /[:/]([^/:]+)\/([^/:]+)$/.exec(cleaned)
  return hit ? `${hit[1]}/${hit[2]}` : null
}

/** Either spelling: a remote URL (`git@host:owner/name`, `https://host/owner/name`) or a slug. */
function slugFrom(text: string): string | null {
  const trimmed = text.trim()
  return BARE_SLUG.test(trimmed) ? trimmed : slugFromRemote(trimmed)
}

/**
 * `owner/name` for the repo this checkout tracks. The remote is the source of
 * truth, so the script stays correct when it is copied to another repo or
 * renamed. `HERDR_DESK_REPO` is only a fallback because this plugin passes a
 * path in it, and a path is not a slug — an existing directory is re-read for
 * its own remote, anything else is taken as `owner/name`.
 */
function repoSlug(cwd: string): string {
  const fromRemote = sh(['git', 'remote', 'get-url', 'origin'], cwd)
  const remote = fromRemote ? slugFromRemote(fromRemote) : null
  if (remote) return remote

  const env = process.env.HERDR_DESK_REPO?.trim()
  if (env) {
    if (existsSync(env) && !env.includes(':')) {
      const inner = sh(['git', 'remote', 'get-url', 'origin'], env)
      const innerSlug = inner ? slugFromRemote(inner) : null
      if (innerSlug) return innerSlug
    }
    const asSlug = slugFrom(env)
    // An absolute path that holds no git repo is not a slug to fall back on.
    if (asSlug && !env.startsWith('/') && !env.startsWith('~')) return asSlug
  }

  throw new Error(
    `no owner/name for ${cwd}: "git remote get-url origin" failed and HERDR_DESK_REPO is ${
      env ? `"${env}"` : 'unset'
    }`,
  )
}

/**
 * Why this PR is not the desk's work, or `null` if it is. Order matters only
 * for the stderr line; every match is a skip.
 */
function skipReason(pr: Pr): string | null {
  if (pr.state !== 'open') return `state ${pr.state}`
  if (DESK_BRANCH.test(pr.head.ref)) return `desk branch ${pr.head.ref}`
  if (BOT_BRANCH.test(pr.head.ref)) return `bot branch ${pr.head.ref}`
  if (pr.user.type === 'Bot') return `bot author ${pr.user.login}`
  return null
}

function toEvent(pr: Pr): Record<string, unknown> {
  return {
    id: `pr-${pr.number}`,
    type: 'pull_request.opened',
    at: pr.created_at,
    summary: `#${pr.number} ${pr.title}`,
    url: pr.html_url,
    number: pr.number,
    title: pr.title,
    author: pr.user.login,
    base: pr.base.ref,
    head: pr.head.ref,
  }
}

/** `null` when there is nothing usable, which is also the first-run case. */
function loadCursor(path: string, slug: string): Cursor | null {
  if (!existsSync(path)) return null
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    log('cursor is not readable JSON — seeding from what is open')
    return null
  }
  const cur = raw as Partial<Cursor> | null
  if (cur?.version !== 1 || typeof cur.seen !== 'object' || cur.seen === null) {
    log(
      'cursor has a shape this script does not know — seeding from what is open',
    )
    return null
  }
  // PR numbers only mean something inside one repo, and this checkout's remote
  // can change. A cursor from elsewhere would mute the watcher, silently.
  if (cur.repo !== slug) {
    log(
      `cursor is for ${cur.repo ?? 'an unknown repo'}, this checkout is ${slug} — seeding`,
    )
    return null
  }
  return {
    version: 1,
    repo: slug,
    updatedAt: typeof cur.updatedAt === 'string' ? cur.updatedAt : '',
    seen: cur.seen,
  }
}

/** tmp + rename, so a kill mid-write cannot leave a half-written cursor. */
function saveCursor(path: string, cursor: Cursor): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(cursor, null, 2)}\n`)
  renameSync(tmp, path)
}

function main(): void {
  const cwd = process.cwd()
  const slug = repoSlug(cwd)
  const path = join(cwd, '.herdr-desk', 'watch', 'prs.json')

  // state=all on purpose: a PR opened and closed between two polls is still
  // seen once, and skipReason is what decides it is not work.
  const prs = ghJson<Pr[]>(
    `repos/${slug}/pulls?state=all&sort=created&direction=desc&per_page=${PER_PAGE}`,
  )
  // A full page means the window overflowed, so anything older than the page is
  // invisible to this poll and will never be seen: the next poll asks for the
  // same newest 30. Thirty PRs inside one interval is not a quiet week, but if
  // it happens the right answer is a human reading this line, not a watcher that
  // reports "no new PRs" forever.
  if (prs.length >= PER_PAGE) {
    log(
      `window full: ${PER_PAGE} PRs is all this poll can see — anything older is missed`,
    )
  }

  const cursor = loadCursor(path, slug)
  if (!cursor) {
    // First run. Everything already open is not news, and treating it as news
    // would fire one manager run per open PR the moment the task is armed.
    const seen: Record<string, string> = {}
    for (const pr of prs) {
      if (pr.state === 'open') seen[String(pr.number)] = pr.created_at
    }
    saveCursor(path, {
      version: 1,
      repo: slug,
      updatedAt: new Date().toISOString(),
      seen,
    })
    log(
      `seeded ${Object.keys(seen).length} open PR(s) into ${path} — first run, nothing reported`,
    )
    return
  }

  const seen = { ...cursor.seen }
  const events: string[] = []
  const skipped: string[] = []

  for (const pr of prs) {
    const key = String(pr.number)
    if (Object.hasOwn(seen, key)) continue
    const why = skipReason(pr)
    if (why) skipped.push(`#${pr.number} ${why}`)
    else events.push(JSON.stringify(toEvent(pr)))
    seen[key] = pr.created_at
  }

  for (const line of events) process.stdout.write(`${line}\n`)
  saveCursor(path, {
    version: 1,
    repo: slug,
    updatedAt: new Date().toISOString(),
    seen,
  })

  if (skipped.length) log(`skipped ${skipped.length}: ${skipped.join(', ')}`)
  log(
    events.length
      ? `${events.length} event(s) from ${slug}`
      : `no new PRs on ${slug} (${prs.length} in the last ${PER_PAGE})`,
  )
}

try {
  main()
} catch (err) {
  log(`watch-prs: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
}
