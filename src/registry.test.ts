import { afterEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  approve,
  approvedContent,
  approvedPlaybookPath,
  cachePathFor,
  diffRepo,
  fetchPlaybooks,
  type Gh,
  isAllowed,
  isEligiblePath,
  listRegistryTasks,
  loadRegistryConfig,
  loadRegistryLock,
  MAX_PLAYBOOK_BYTES,
  needsAccept,
  normalizePath,
  parseGhSpec,
  resolveCommit,
  sha256,
  unapprovedPlaybooks,
  writeCache,
} from './registry'

const roots: string[] = []
const saved: Record<string, string | undefined> = {}

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `herdr-desk-reg-${prefix}-`))
  roots.push(dir)
  return dir
}

/** Point config and state at temp dirs so nothing touches the real machine. */
function sandbox(): { configDir: string; stateDir: string } {
  const configDir = tmp('cfg')
  const stateDir = tmp('state')
  for (const [key, value] of [
    ['HERDR_PLUGIN_CONFIG_DIR', configDir],
    ['HERDR_PLUGIN_STATE_DIR', stateDir],
  ]) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
  return { configDir, stateDir }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2))
}

afterEach(() => {
  while (roots.length)
    rmSync(roots.pop() as string, { recursive: true, force: true })
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const key of Object.keys(saved)) delete saved[key]
})

describe('isEligiblePath', () => {
  test('accepts only tasks/*.md', () => {
    // The trust boundary: a registry supplies work instructions, never the
    // manager envelope or the identity rules that decide who the agent is.
    expect(isEligiblePath('tasks/triage.md')).toBe(true)
    expect(isEligiblePath('tasks/nested/deep.md')).toBe(true)
    expect(isEligiblePath('run.md')).toBe(false)
    expect(isEligiblePath('prompts/run.md')).toBe(false)
    expect(isEligiblePath('README.md')).toBe(false)
    expect(isEligiblePath('tasks/triage.txt')).toBe(false)
    expect(isEligiblePath('tasks/triage.yaml')).toBe(false)
    expect(isEligiblePath('.github/workflows/ci.yml')).toBe(false)
  })

  test('accepts a registry laid out like this plugin', () => {
    // The obvious way to build a registry is to copy `prompts/`, so
    // `prompts/tasks/` has to work and normalise to the same identity as
    // `tasks/`. Verified against the real repo: the tree is
    // `prompts/tasks/github-issues.md`, and a flat `tasks/` filter finds
    // nothing at all.
    expect(normalizePath('prompts/tasks/triage.md')).toBe('tasks/triage.md')
    expect(normalizePath('tasks/triage.md')).toBe('tasks/triage.md')
    expect(normalizePath('prompts/tasks/nested/deep.md')).toBe(
      'tasks/nested/deep.md',
    )
    // The control plane stays out even under the registry layout.
    expect(normalizePath('prompts/child.md')).toBeNull()
    expect(normalizePath('prompts/identity.md')).toBeNull()
    expect(normalizePath('prompts/tasks')).toBeNull()
  })

  test('rejects traversal and absolute paths', () => {
    // The caller writes what it is handed, so the filter has to be here.
    expect(isEligiblePath('tasks/../../etc/passwd.md')).toBe(false)
    expect(isEligiblePath('prompts/tasks/../../etc/passwd.md')).toBe(false)
    expect(isEligiblePath('/etc/passwd.md')).toBe(false)
    expect(isEligiblePath('tasks\\win.md')).toBe(false)
    expect(isEligiblePath('tasks/./x.md')).toBe(false)
  })
})

describe('unapprovedPlaybooks', () => {
  test('reports only gh: playbooks that resolve to nothing', () => {
    // A repo that has not been approved yet, and a job that uses a local
    // playbook which is fine and must not be flagged.
    expect(
      unapprovedPlaybooks([
        { id: 'desk:a', playbook: 'gh:duyet/prompts/triage' },
        { id: 'local:b', playbook: './playbooks/b.md' },
        { id: 'desk:c', playbook: 'github-issues' },
      ]),
    ).toEqual([
      "desk:a: playbook 'gh:duyet/prompts/triage' is not approved — run: herdr-desk prompts check && herdr-desk prompts apply --accept",
    ])
  })

  test('an approved playbook is not reported', () => {
    const { configDir } = sandbox()
    writeJson(join(configDir, 'registry.json'), {
      allow: ['duyet/prompts'],
      registries: [{ repo: 'duyet/prompts' }],
    })
    const commit = 'a'.repeat(40)
    writeCache('duyet/prompts', commit, { 'tasks/triage.md': '# Triage\n' })
    approve([
      diffRepo({
        repo: 'duyet/prompts',
        ref: 'main',
        fromCommit: null,
        from: null,
        to: { 'tasks/triage.md': '# Triage\n' },
        toCommit: commit,
      }),
    ])
    expect(
      unapprovedPlaybooks([
        { id: 'desk:a', playbook: 'gh:duyet/prompts/triage' },
      ]),
    ).toEqual([])
  })
})

describe('parseGhSpec', () => {
  test('reads both forms', () => {
    expect(parseGhSpec('gh:owner/repo/triage.md')).toEqual({
      repo: 'owner/repo',
      name: 'triage',
    })
    expect(parseGhSpec('gh:triage')).toEqual({ repo: null, name: 'triage' })
    expect(parseGhSpec('gh:owner/repo')).toEqual({
      repo: 'owner/repo',
      name: '',
    })
    expect(parseGhSpec('triage')).toBeNull()
    expect(parseGhSpec('gh:')).toBeNull()
  })
})

describe('loadRegistryConfig', () => {
  test('reads allow and registries, defaulting ref to main', () => {
    const { configDir } = sandbox()
    writeJson(join(configDir, 'registry.json'), {
      allow: ['duyet/prompts'],
      registries: [{ repo: 'duyet/prompts' }, 'team/other'],
    })
    expect(loadRegistryConfig()).toEqual({
      allow: ['duyet/prompts'],
      sources: [
        { repo: 'duyet/prompts', ref: 'main' },
        { repo: 'team/other', ref: 'main' },
      ],
    })
  })

  test('a malformed file is an error, not an empty config', () => {
    // Silently behaving as if no registry existed would make `apply` look like
    // it worked when it did nothing.
    const { configDir } = sandbox()
    writeFileSync(join(configDir, 'registry.json'), '{ not json')
    expect(() => loadRegistryConfig()).toThrow(/invalid JSON/)
  })

  test('an absent file means no registries, and nothing is allowed', () => {
    sandbox()
    expect(loadRegistryConfig()).toEqual({ allow: [], sources: [] })
  })
})

describe('isAllowed', () => {
  test('fails closed when there is no allowlist', () => {
    // The layer that stops a typo or a hijacked config pointing anywhere.
    sandbox()
    expect(isAllowed(loadRegistryConfig(), 'duyet/prompts')).toBe(false)
  })
})

describe('diffRepo', () => {
  const base = { 'tasks/a.md': 'one' }
  const toCommit = 'b'.repeat(40)

  test('classifies added, changed, removed, and unchanged', () => {
    const diff = diffRepo({
      repo: 'duyet/prompts',
      ref: 'main',
      fromCommit: 'a'.repeat(40),
      from: base,
      to: { 'tasks/a.md': 'two', 'tasks/b.md': 'new' },
      toCommit,
    })
    const byPath = Object.fromEntries(
      diff.changes.map((c) => [c.path, c.change]),
    )
    expect(byPath).toEqual({
      'tasks/a.md': 'changed',
      'tasks/b.md': 'added',
    })
    expect(diff.changes.find((c) => c.path === 'tasks/a.md')?.from).toBe(
      sha256('one'),
    )
    expect(diff.changes.find((c) => c.path === 'tasks/a.md')?.to).toBe(
      sha256('two'),
    )
  })

  test('a removal is reported, not silently dropped', () => {
    const diff = diffRepo({
      repo: 'r',
      ref: 'main',
      fromCommit: null,
      from: base,
      to: {},
      toCommit,
    })
    expect(diff.changes[0].change).toBe('removed')
  })

  test('needsAccept is false only when nothing moved', () => {
    const same = diffRepo({
      repo: 'r',
      ref: 'main',
      fromCommit: 'a'.repeat(40),
      from: base,
      to: base,
      toCommit,
    })
    expect(needsAccept(same)).toBe(false)
    expect(
      needsAccept(
        diffRepo({
          repo: 'r',
          ref: 'main',
          fromCommit: null,
          from: base,
          to: { 'tasks/a.md': 'moved' },
          toCommit,
        }),
      ),
    ).toBe(true)
  })
})

describe('resolveCommit', () => {
  test('returns the immutable sha behind a ref', async () => {
    const sha = 'c'.repeat(40)
    const gh: Gh = async (args) => {
      expect(args[1]).toBe('repos/duyet/prompts/commits/main')
      return `${sha}\n`
    }
    expect(await resolveCommit(gh, 'duyet/prompts', 'main')).toBe(sha)
  })

  test('a non-sha answer is an error, not a commit', async () => {
    // Trusting this would put a branch name into the lock, and the lock is
    // supposed to be what makes a commit immutable.
    const gh: Gh = async () => 'main\n'
    await expect(resolveCommit(gh, 'duyet/prompts', 'main')).rejects.toThrow(
      /no commit sha/,
    )
  })
})

describe('fetchPlaybooks', () => {
  /** A `gh` double over a fixed tree, recording the paths it was asked for. */
  function fakeGh(files: Record<string, string>, asked: string[] = []): Gh {
    return async (args) => {
      const spec = args[1]
      if (spec.includes('/git/trees/')) {
        return Object.keys(files).join('\n')
      }
      const path = decodeURIComponent(
        (spec.split('/contents/')[1] ?? '').split('?')[0],
      )
      asked.push(path)
      return Buffer.from(files[path] ?? '', 'utf8').toString('base64')
    }
  }

  test('fetches only eligible paths and decodes base64', async () => {
    const asked: string[] = []
    const gh = fakeGh(
      {
        'tasks/triage.md': '# Triage\n',
        'run.md': 'not eligible',
        '.github/workflows/ci.yml': 'name: ci',
        'tasks/nested/deep.md': '# Deep\n',
      },
      asked,
    )
    const out = await fetchPlaybooks(gh, 'duyet/prompts', 'd'.repeat(40))
    expect(Object.keys(out).sort()).toEqual([
      'tasks/nested/deep.md',
      'tasks/triage.md',
    ])
    expect(out['tasks/triage.md']).toBe('# Triage\n')
    // Nothing ineligible was even requested.
    expect(asked).toEqual(['tasks/triage.md', 'tasks/nested/deep.md'])
  })

  test('fetches a playbook whose name has URL-special characters', async () => {
    // The path goes into a URL. Unencoded, `?` starts the query (so the file is
    // requested as `tasks/why` from whatever `ref` follows) and `#` drops the
    // rest, so the bytes approved would not be the file that was listed.
    const gh = fakeGh({
      'tasks/why?.md': '# Why\n',
      'tasks/a#b.md': '# Hash\n',
    })
    const out = await fetchPlaybooks(gh, 'duyet/prompts', 'f'.repeat(40))
    expect(out['tasks/why?.md']).toBe('# Why\n')
    expect(out['tasks/a#b.md']).toBe('# Hash\n')
  })

  test('refuses a file over the size cap', async () => {
    // A playbook is a page. A 10 MB "playbook" is not a prompt, and writing it
    // into a cache that gets interpolated into every run is how a disk fills.
    const gh = fakeGh({ 'tasks/huge.md': 'x'.repeat(MAX_PLAYBOOK_BYTES + 1) })
    await expect(
      fetchPlaybooks(gh, 'duyet/prompts', 'e'.repeat(40)),
    ).rejects.toThrow(/over the .* cap/)
  })
})

describe('approve and the lock', () => {
  function configured(): void {
    const { configDir } = sandbox()
    writeJson(join(configDir, 'registry.json'), {
      allow: ['duyet/prompts'],
      registries: [{ repo: 'duyet/prompts', ref: 'main' }],
    })
  }

  test('a first approval records the commit and every hash', () => {
    configured()
    const commit = 'f'.repeat(40)
    writeCache('duyet/prompts', commit, { 'tasks/triage.md': '# Triage\n' })
    approve([
      diffRepo({
        repo: 'duyet/prompts',
        ref: 'main',
        fromCommit: null,
        from: null,
        to: { 'tasks/triage.md': '# Triage\n' },
        toCommit: commit,
      }),
    ])

    const lock = loadRegistryLock()
    expect(lock.repos['duyet/prompts'].commit).toBe(commit)
    expect(lock.repos['duyet/prompts'].files).toEqual({
      'tasks/triage.md': sha256('# Triage\n'),
    })
    expect(
      approvedContent('duyet/prompts', lock.repos['duyet/prompts']),
    ).toEqual({
      'tasks/triage.md': '# Triage\n',
    })
  })

  test('a cache that no longer matches its lock is not approved content', () => {
    // Someone edited the cache by hand, or a partial write happened. The safe
    // reading is "not approved", which forces a review rather than a silent
    // run of unverified instructions.
    configured()
    const commit = 'a'.repeat(40)
    writeCache('duyet/prompts', commit, { 'tasks/triage.md': '# Triage\n' })
    approve([
      diffRepo({
        repo: 'duyet/prompts',
        ref: 'main',
        fromCommit: null,
        from: null,
        to: { 'tasks/triage.md': '# Triage\n' },
        toCommit: commit,
      }),
    ])
    writeFileSync(
      cachePathFor('duyet/prompts', commit, 'tasks/triage.md'),
      'tampered',
    )
    expect(
      approvedContent(
        'duyet/prompts',
        loadRegistryLock().repos['duyet/prompts'],
      ),
    ).toBeNull()
    expect(approvedPlaybookPath('gh:duyet/prompts/triage')).toBeNull()
  })

  test('an unapproved playbook resolves to nothing, with a usable error', () => {
    configured()
    expect(approvedPlaybookPath('gh:duyet/prompts/triage')).toBeNull()
  })

  test('a repo removed from the allowlist stops being referenceable', () => {
    // Taking a repo out of `allow` has to actually take it out of service.
    const { configDir } = sandbox()
    writeJson(join(configDir, 'registry.json'), {
      allow: ['duyet/prompts'],
      registries: [{ repo: 'duyet/prompts' }],
    })
    const commit = 'b'.repeat(40)
    writeCache('duyet/prompts', commit, { 'tasks/triage.md': '# Triage\n' })
    approve([
      diffRepo({
        repo: 'duyet/prompts',
        ref: 'main',
        fromCommit: null,
        from: null,
        to: { 'tasks/triage.md': '# Triage\n' },
        toCommit: commit,
      }),
    ])
    expect(approvedPlaybookPath('gh:duyet/prompts/triage')).toBe(
      cachePathFor('duyet/prompts', commit, 'tasks/triage.md'),
    )

    writeJson(join(configDir, 'registry.json'), { allow: [], registries: [] })
    expect(approvedPlaybookPath('gh:duyet/prompts/triage')).toBeNull()
    expect(listRegistryTasks()).toEqual([])
  })

  test('an approved playbook resolves to the cached bytes', () => {
    configured()
    const commit = 'c'.repeat(40)
    writeCache('duyet/prompts', commit, { 'tasks/triage.md': '# Triage\n' })
    approve([
      diffRepo({
        repo: 'duyet/prompts',
        ref: 'main',
        fromCommit: null,
        from: null,
        to: { 'tasks/triage.md': '# Triage\n' },
        toCommit: commit,
      }),
    ])
    const file = approvedPlaybookPath('gh:duyet/prompts/triage')
    expect(file).toBe(cachePathFor('duyet/prompts', commit, 'tasks/triage.md'))
    expect(readFileSync(file as string, 'utf8')).toBe('# Triage\n')
    expect(listRegistryTasks()).toEqual(['gh:duyet/prompts/triage'])
  })

  test('a nested playbook is listed under a spec that resolves', () => {
    // `tasks/ops/deploy.md` is eligible and resolves as `gh:repo/ops/deploy`.
    // Listing it by basename alone printed a spec nothing could resolve.
    configured()
    const commit = 'e'.repeat(40)
    writeCache('duyet/prompts', commit, { 'tasks/ops/deploy.md': '# Deploy\n' })
    approve([
      diffRepo({
        repo: 'duyet/prompts',
        ref: 'main',
        fromCommit: null,
        from: null,
        to: { 'tasks/ops/deploy.md': '# Deploy\n' },
        toCommit: commit,
      }),
    ])
    const specs = listRegistryTasks()
    expect(specs).toEqual(['gh:duyet/prompts/ops/deploy'])
    expect(approvedPlaybookPath(specs[0])).not.toBeNull()
  })

  test('the short form finds the playbook in an allowed registry', () => {
    configured()
    const commit = 'd'.repeat(40)
    writeCache('duyet/prompts', commit, { 'tasks/triage.md': '# Triage\n' })
    approve([
      diffRepo({
        repo: 'duyet/prompts',
        ref: 'main',
        fromCommit: null,
        from: null,
        to: { 'tasks/triage.md': '# Triage\n' },
        toCommit: commit,
      }),
    ])
    expect(approvedPlaybookPath('gh:triage')).toBe(
      cachePathFor('duyet/prompts', commit, 'tasks/triage.md'),
    )
  })

  test('a corrupt lock reads as nothing approved', () => {
    const { configDir } = sandbox()
    writeFileSync(join(configDir, 'registry.lock.json'), 'garbage')
    expect(loadRegistryLock()).toEqual({ version: 1, repos: {} })
  })
})
