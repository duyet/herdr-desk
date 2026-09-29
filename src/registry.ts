import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pluginConfigDir, pluginStateDir } from './paths'

/**
 * A GitHub repo as a registry of playbooks.
 *
 * The trust model is two independent layers, because either alone leaves a gap:
 *
 * 1. **Allowlist** (`allow` in `registry.json`). A repo that is not listed can
 *    never be fetched, whatever any other file says. This is the layer that
 *    stops a typo or a hijacked config from pulling instructions from
 *    somewhere arbitrary.
 * 2. **Content lock** (`registry.lock.json`). The first apply records the
 *    commit and a sha256 per file. After that, content that changed is refused
 *    until it is explicitly accepted, so an upstream edit cannot silently
 *    rewrite the instructions your agent runs.
 *
 * What a registry may supply is deliberately narrow: `tasks/*.md` only. The
 * manager envelope, the identity rules, and the child prompt stay local,
 * because those decide who the agent is allowed to be. A remote that could
 * change them is a remote code-execution channel, not a prompt library.
 *
 * Nothing here is executed. A playbook is text that is interpolated into a
 * prompt, and the same way a repo's own `.md` already is.
 */

/**
 * Where a registry keeps its playbooks.
 *
 * Both layouts are accepted because the obvious way to build a registry is to
 * copy this plugin's own `prompts/`, and the obvious way to keep one small is
 * to have only `tasks/`. Normalising both to `tasks/<name>.md` means the lock,
 * the cache, and the `gh:` spec have one shape regardless of which was used.
 */
export const REGISTRY_DIR = 'tasks'
export const ELIGIBLE_ROOTS = ['tasks', 'prompts/tasks']

/** Refuse anything larger; a playbook is a page, not a bundle. */
export const MAX_PLAYBOOK_BYTES = 256 * 1024

/** `owner/name`, nothing else. */
const REPO_RE = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/

/** The prefix a `playbook` uses to point at a registry. */
export const GH_PREFIX = 'gh:'

export type RegistrySource = {
  repo: string
  ref: string
}

export type RegistryConfig = {
  /** Repos that may ever be fetched. Fails closed when absent. */
  allow: string[]
  sources: RegistrySource[]
}

export type RepoLock = {
  ref: string
  commit: string
  approvedAt: string
  /** Registry-relative path -> sha256 of the bytes that were approved. */
  files: Record<string, string>
}

export type RegistryLock = {
  version: 1
  repos: Record<string, RepoLock>
}

export function registryConfigPath(): string {
  return join(pluginConfigDir(), 'registry.json')
}

export function registryLockPath(): string {
  return join(pluginConfigDir(), 'registry.lock.json')
}

export function registryCacheDir(): string {
  return join(pluginStateDir(), 'registry')
}

/**
 * Read the host registry config.
 *
 * A malformed file is an error rather than an empty config: silently behaving
 * as though no registry is configured would make `apply` look like it worked.
 */
export function loadRegistryConfig(): RegistryConfig {
  const path = registryConfigPath()
  if (!existsSync(path)) return { allow: [], sources: [] }
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch (err) {
    throw new Error(
      `${path}: invalid JSON (${err instanceof Error ? err.message : 'unparseable'})`,
    )
  }
  const allow = Array.isArray(raw.allow)
    ? raw.allow.filter((r): r is string => typeof r === 'string')
    : []
  const sources: RegistrySource[] = []
  for (const entry of Array.isArray(raw.registries) ? raw.registries : []) {
    if (typeof entry === 'string') {
      sources.push({ repo: entry, ref: 'main' })
      continue
    }
    if (!entry || typeof entry !== 'object') continue
    const o = entry as { repo?: unknown; ref?: unknown }
    if (typeof o.repo !== 'string') continue
    sources.push({
      repo: o.repo,
      ref: typeof o.ref === 'string' ? o.ref : 'main',
    })
  }
  return { allow, sources }
}

export function loadRegistryLock(): RegistryLock {
  const path = registryLockPath()
  if (!existsSync(path)) return { version: 1, repos: {} }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as RegistryLock
    if (!raw || typeof raw !== 'object' || !raw.repos) {
      return { version: 1, repos: {} }
    }
    return { version: 1, repos: raw.repos }
  } catch {
    // A corrupt lock means "nothing is approved yet", which makes `apply`
    // require an explicit accept rather than silently trusting new content.
    return { version: 1, repos: {} }
  }
}

export function saveRegistryLock(lock: RegistryLock): void {
  mkdirSync(pluginConfigDir(), { recursive: true })
  writeFileSync(registryLockPath(), `${JSON.stringify(lock, null, 2)}\n`)
}

export function isAllowed(config: RegistryConfig, repo: string): boolean {
  return config.allow.includes(repo)
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Reject anything that is not a plain `tasks/<name>.md` path.
 *
 * This is the second half of the trust boundary. A tree API happily returns
 * `.github/workflows/deploy.yml` and `../../etc/passwd`, and the caller writes
 * what it is given, so the filter has to be here rather than at the call site.
 */
export function isEligiblePath(path: string): boolean {
  return normalizePath(path) !== null
}

/**
 * `prompts/tasks/x.md` and `tasks/x.md` both normalise to `tasks/x.md`.
 *
 * Returns `null` for anything outside a playbook directory. The traversal and
 * type checks run on the *original* path, before normalisation, so
 * `prompts/tasks/../../etc/passwd.md` cannot normalise its way to eligibility.
 */
export function normalizePath(path: string): string | null {
  if (!path.endsWith('.md')) return null
  if (path.includes('\\') || path.startsWith('/')) return null
  const parts = path.split('/')
  if (parts.some((p) => !p || p === '.' || p === '..')) return null
  const root = ELIGIBLE_ROOTS.find(
    (r) => path === r || path.startsWith(`${r}/`),
  )
  if (!root) return null
  const rest = path.slice(root.length + 1)
  if (!rest) return null
  return `${REGISTRY_DIR}/${rest}`
}

/** Registry-relative `tasks/x.md` -> the bare name a `playbook` refers to. */
export function playbookName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '')
}

/**
 * Every playbook the host has approved, as `gh:` specs a `playbook` field can
 * use directly.
 *
 * Only allowlisted repos appear. A lock entry left behind after a repo is
 * removed from `allow` must stop being referenceable, or taking a repo out of
 * the allowlist would not actually take it out of service.
 */
export function listRegistryTasks(
  lock = loadRegistryLock(),
  config = loadRegistryConfig(),
): string[] {
  const out: string[] = []
  for (const [repo, entry] of Object.entries(lock.repos)) {
    if (!isAllowed(config, repo)) continue
    for (const path of Object.keys(entry.files)) {
      if (!isEligiblePath(path)) continue
      // The spec keeps any subdirectory under `tasks/`: `approvedPlaybookPath`
      // resolves `gh:repo/ops/deploy` to `tasks/ops/deploy.md`, not the
      // basename.
      const name = path.slice(REGISTRY_DIR.length + 1).replace(/\.md$/, '')
      out.push(`${GH_PREFIX}${repo}/${name}`)
    }
  }
  return out.sort()
}

export function cachePathFor(
  repo: string,
  commit: string,
  path: string,
): string {
  const safe = path.split('/').join('__')
  return join(registryCacheDir(), repo.replace('/', '__'), commit, safe)
}

/** Where an approved playbook lives on disk, or `null` if not approved yet. */
export function approvedPlaybookPath(
  spec: string,
  lock = loadRegistryLock(),
  config = loadRegistryConfig(),
): string | null {
  const ref = parseGhSpec(spec)
  if (!ref) return null
  const repos = ref.repo ? [ref.repo] : config.sources.map((s) => s.repo)
  for (const repo of repos) {
    if (!isAllowed(config, repo)) continue
    const entry = lock.repos[repo]
    if (!entry) continue
    const path = join(REGISTRY_DIR, `${ref.name}.md`)
    const sha = entry.files[path]
    if (!sha) continue
    const file = cachePathFor(repo, entry.commit, path)
    if (existsSync(file) && sha256(readFileSync(file, 'utf8')) === sha)
      return file
  }
  return null
}

/**
 * `gh:` playbooks a desk references that are not approved yet.
 *
 * `validate` reports these. Without that check, the first sign of a
 * misconfigured playbook is a job that failed at 07:00 because the cache was
 * empty — which is exactly the failure the lock exists to make loud and early.
 */
export function unapprovedPlaybooks(
  tasks: Array<{ id: string; playbook: string }>,
  lock = loadRegistryLock(),
  config = loadRegistryConfig(),
): string[] {
  const out: string[] = []
  for (const task of tasks) {
    if (!parseGhSpec(task.playbook)) continue
    if (approvedPlaybookPath(task.playbook, lock, config)) continue
    out.push(
      `${task.id}: playbook '${task.playbook}' is not approved — run: herdr-desk prompts check && herdr-desk prompts apply --accept`,
    )
  }
  return out
}

export type GhSpec = { repo: string | null; name: string }

/** `gh:owner/repo/name.md` or `gh:name` (first allowed registry that has it). */
export function parseGhSpec(spec: string): GhSpec | null {
  if (!spec.startsWith(GH_PREFIX)) return null
  const body = spec.slice(GH_PREFIX.length).trim()
  if (!body) return null
  const parts = body.split('/')
  if (parts.length >= 3) {
    const repo = `${parts[0]}/${parts[1]}`
    const name = parts.slice(2).join('/').replace(/\.md$/, '')
    return REPO_RE.test(repo) && name ? { repo, name } : null
  }
  if (parts.length === 2 && REPO_RE.test(body)) return { repo: body, name: '' }
  const name = body.replace(/\.md$/, '')
  return name ? { repo: null, name } : null
}

/**
 * `gh` is the transport, and the only injection point.
 *
 * Using the user's own `gh` means the plugin never holds a GitHub token, works
 * for private registries without configuration, and inherits whatever
 * credentials the host already trusts. Tests pass a fake.
 */
export type Gh = (args: string[]) => Promise<string>

export async function ghCommand(args: string[]): Promise<string> {
  const proc = Bun.spawn(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exit !== 0) {
    throw new Error(
      `gh ${args.join(' ')} failed (${exit}): ${stderr.trim() || stdout.trim()}`,
    )
  }
  return stdout
}

/** Resolve a ref (branch, tag, or sha) to the immutable commit behind it. */
export async function resolveCommit(
  gh: Gh,
  repo: string,
  ref: string,
): Promise<string> {
  const out = await gh(['api', `repos/${repo}/commits/${ref}`, '--jq', '.sha'])
  const sha = out.trim()
  if (!/^[0-9a-f]{7,40}$/.test(sha)) {
    throw new Error(
      `gh: no commit sha for ${repo}@${ref} (got ${sha.slice(0, 40)})`,
    )
  }
  return sha
}

/** Every eligible `tasks/*.md` in a commit, with its bytes. */
export async function fetchPlaybooks(
  gh: Gh,
  repo: string,
  commit: string,
): Promise<Record<string, string>> {
  const listing = await gh([
    'api',
    `repos/${repo}/git/trees/${commit}?recursive=1`,
    '--jq',
    '.tree[] | select(.type=="blob") | .path',
  ])
  const out: Record<string, string> = {}
  for (const raw of listing.split('\n')) {
    const path = raw.trim()
    const key = path ? normalizePath(path) : null
    if (!path || !key) continue
    const body = await fetchOne(gh, repo, path, commit)
    if (Buffer.byteLength(body, 'utf8') > MAX_PLAYBOOK_BYTES) {
      throw new Error(
        `${repo}:${path} is ${Buffer.byteLength(body, 'utf8')} bytes, over the ${MAX_PLAYBOOK_BYTES} cap`,
      )
    }
    out[key] = body
  }
  return out
}

async function fetchOne(
  gh: Gh,
  repo: string,
  path: string,
  commit: string,
): Promise<string> {
  const b64 = await gh([
    'api',
    // Encode each segment: a raw `?` or `#` in a file name would otherwise
    // truncate the path or override `ref`, fetching bytes from another file.
    `repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${commit}`,
    '--jq',
    '.content',
  ])
  // GitHub wraps base64 at 60 columns.
  return Buffer.from(b64.replace(/\s+/g, ''), 'base64').toString('utf8')
}

export type Change = 'added' | 'changed' | 'unchanged' | 'removed'

export type Diff = {
  repo: string
  ref: string
  /** Previously approved commit, or `null` if this repo was never approved. */
  fromCommit: string | null
  toCommit: string
  changes: Array<{
    path: string
    change: Change
    from: string | null
    to: string | null
  }>
}

export function diffRepo(opts: {
  repo: string
  ref: string
  fromCommit: string | null
  /** Approved content, or `null` when the repo was never approved. */
  from: Record<string, string> | null
  to: Record<string, string>
  toCommit: string
}): Diff {
  const changes: Diff['changes'] = []
  const from = opts.from
  const to = opts.to
  const paths = [
    ...new Set([...Object.keys(from ?? {}), ...Object.keys(to)]),
  ].sort()
  for (const path of paths) {
    const before = from?.[path]
    const after = to[path]
    if (before === undefined) {
      changes.push({
        path,
        change: 'added',
        from: null,
        to: sha256(after as string),
      })
    } else if (after === undefined) {
      changes.push({ path, change: 'removed', from: sha256(before), to: null })
    } else if (before !== after) {
      changes.push({
        path,
        change: 'changed',
        from: sha256(before),
        to: sha256(after),
      })
    } else {
      changes.push({
        path,
        change: 'unchanged',
        from: sha256(before),
        to: sha256(after),
      })
    }
  }
  return {
    repo: opts.repo,
    ref: opts.ref,
    fromCommit: opts.fromCommit,
    toCommit: opts.toCommit,
    changes,
  }
}

export function needsAccept(diff: Diff): boolean {
  // Approving a registry for the first time is a decision even when it happens
  // to contain no playbooks: `allow` was just widened to a new source of
  // instructions. Without this, a repo shipping an empty `tasks/` looks
  // identical to "already approved and unchanged", and the very first apply
  // would sail through with no review at all.
  if (diff.fromCommit === null) return true
  return diff.changes.some((c) => c.change !== 'unchanged')
}

/** The already-approved bytes of a repo, read back out of the cache. */
export function approvedContent(
  repo: string,
  entry: RepoLock | undefined,
): Record<string, string> | null {
  if (!entry) return null
  const out: Record<string, string> = {}
  for (const [path, sha] of Object.entries(entry.files)) {
    const file = cachePathFor(repo, entry.commit, path)
    if (!existsSync(file)) return null
    const body = readFileSync(file, 'utf8')
    // A cache that no longer matches its lock is not approved content. Falling
    // through to a re-approval prompt is the safe reading.
    if (sha256(body) !== sha) return null
    out[path] = body
  }
  return out
}

/**
 * Write an approved commit to the cache and record its hashes.
 *
 * The cache is keyed by commit, so approving a new commit never rewrites the
 * bytes an older one was approved from, and pinning back is just re-pointing
 * the lock.
 */
export function approve(diffs: Diff[], at = new Date()): void {
  const lock = loadRegistryLock()
  for (const diff of diffs) {
    const files: Record<string, string> = {}
    for (const change of diff.changes) {
      if (change.change === 'removed' || !change.to) continue
      files[change.path] = change.to
    }
    lock.repos[diff.repo] = {
      ref: diff.ref,
      commit: diff.toCommit,
      approvedAt: at.toISOString(),
      files,
    }
  }
  saveRegistryLock(lock)
}

export function writeCache(
  repo: string,
  commit: string,
  files: Record<string, string>,
): void {
  for (const [path, body] of Object.entries(files)) {
    const file = cachePathFor(repo, commit, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, body)
  }
}
