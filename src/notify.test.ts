import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  escapeMd,
  formatNotice,
  loadNotifyConfig,
  MAX_BODY,
  machineName,
  mdBold,
  mdCode,
  mdTag,
  type NotifyConfig,
  noticeBody,
  notify,
  redactToken,
  repoName,
  resolveNotify,
} from './notify'

function cfg(over: Partial<NotifyConfig> = {}): NotifyConfig {
  return { enabled: true, token: 't', chatId: 'c', topicId: '', ...over }
}

/** Minimal fetch double that records the request and returns 200. */
/**
 * Fetch double. Pass a list of statuses to script a sequence, e.g. `[400, 200]`
 * to exercise the markdown-then-plain-text retry.
 */
function stubFetch(status: number | number[] = 200) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const queue = Array.isArray(status) ? [...status] : null
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    })
    const code = queue ? (queue.shift() ?? 200) : (status as number)
    return new Response('{}', { status: code })
  }) as unknown as typeof fetch
  return { calls, impl }
}

describe('formatNotice', () => {
  test('always carries machine and repo', () => {
    const text = formatNotice(
      { message: 'desk run finished', repo: '/home/duyet/project/aidr' },
      'duet-ubuntu',
    )
    expect(text).toBe('[duet-ubuntu] [aidr] desk run finished')
  })

  test('optional label sits between repo and message', () => {
    expect(
      formatNotice(
        {
          message: 'merged PR #12',
          repo: '/r/aidr',
          label: 'desk:github-issues',
        },
        'host',
      ),
    ).toBe('[host] [aidr] [desk:github-issues] merged PR #12')
  })

  test('tolerates a missing repo and an empty message', () => {
    expect(formatNotice({ message: 'ping' }, 'host')).toBe(
      '[host] [no-repo] ping',
    )
    expect(formatNotice({ message: '   ' }, 'host')).toBe(
      '[host] [no-repo] (no message)',
    )
  })
})

describe('repoName', () => {
  test('basename, with fallbacks', () => {
    expect(repoName('/home/duyet/project/aidr')).toBe('aidr')
    expect(repoName()).toBe('no-repo')
    expect(repoName('/')).toBe('/')
  })
})

describe('machineName', () => {
  test('includes the hostname', () => {
    // Assert the relationship, not this host's name — CI runners differ.
    expect(machineName()).toContain(hostname())
    expect(machineName().length).toBeGreaterThan(0)
  })
})

describe('loadNotifyConfig', () => {
  test('reads host-level notify.json and lets env win', () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-notify-'))
    writeFileSync(
      join(dir, 'notify.json'),
      JSON.stringify({ token: 'file-token', chatId: 'file-chat' }),
    )
    const previousDir = process.env.HERDR_PLUGIN_CONFIG_DIR
    const previousToken = process.env.HERDR_DESK_TELEGRAM_TOKEN
    process.env.HERDR_PLUGIN_CONFIG_DIR = dir
    try {
      const fromFile = loadNotifyConfig()
      expect(fromFile.token).toBe('file-token')
      expect(fromFile.chatId).toBe('file-chat')
      expect(fromFile.enabled).toBe(true)

      process.env.HERDR_DESK_TELEGRAM_TOKEN = 'env-token'
      expect(loadNotifyConfig().token).toBe('env-token')
    } finally {
      if (previousDir === undefined) delete process.env.HERDR_PLUGIN_CONFIG_DIR
      else process.env.HERDR_PLUGIN_CONFIG_DIR = previousDir
      if (previousToken === undefined)
        delete process.env.HERDR_DESK_TELEGRAM_TOKEN
      else process.env.HERDR_DESK_TELEGRAM_TOKEN = previousToken
    }
  })

  test('a malformed file degrades to unconfigured instead of throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'desk-notify-bad-'))
    writeFileSync(join(dir, 'notify.json'), '{ not json')
    const previous = process.env.HERDR_PLUGIN_CONFIG_DIR
    const token = process.env.HERDR_DESK_TELEGRAM_TOKEN
    const chat = process.env.HERDR_DESK_TELEGRAM_CHAT_ID
    process.env.HERDR_PLUGIN_CONFIG_DIR = dir
    delete process.env.HERDR_DESK_TELEGRAM_TOKEN
    delete process.env.HERDR_DESK_TELEGRAM_CHAT_ID
    try {
      const c = loadNotifyConfig()
      expect(c.token).toBe('')
      expect(c.chatId).toBe('')
    } finally {
      if (previous === undefined) delete process.env.HERDR_PLUGIN_CONFIG_DIR
      else process.env.HERDR_PLUGIN_CONFIG_DIR = previous
      if (token !== undefined) process.env.HERDR_DESK_TELEGRAM_TOKEN = token
      if (chat !== undefined) process.env.HERDR_DESK_TELEGRAM_CHAT_ID = chat
    }
  })
})

describe('notify', () => {
  test('posts machine + repo to telegram', async () => {
    const { calls, impl } = stubFetch(200)
    const result = await notify(
      { message: 'desk run finished', repo: '/home/duyet/project/aidr' },
      cfg(),
      impl,
    )
    expect(result.sent).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain('/bot t/sendMessage'.replace(' ', ''))
    expect(calls[0]?.body.chat_id).toBe('c')
    expect(calls[0]?.body.text).toBe(
      `[${result.machine}] [aidr] desk run finished`,
    )
  })

  test('skips when unconfigured and explains why', async () => {
    const { calls, impl } = stubFetch()
    const result = await notify(
      { message: 'x', repo: '/r/aidr' },
      cfg({ token: '', chatId: '' }),
      impl,
    )
    expect(result.sent).toBe(false)
    expect(result.reason).toContain('not configured')
    expect(calls).toHaveLength(0)
  })

  test('respects enabled:false', async () => {
    const { calls, impl } = stubFetch()
    const result = await notify(
      { message: 'x', repo: '/r/aidr' },
      cfg({ enabled: false }),
      impl,
    )
    expect(result.sent).toBe(false)
    expect(result.reason).toBe('disabled')
    expect(calls).toHaveLength(0)
  })

  test('reports an http failure without throwing', async () => {
    const { impl } = stubFetch(401)
    const result = await notify({ message: 'x', repo: '/r/aidr' }, cfg(), impl)
    expect(result.sent).toBe(false)
    expect(result.reason).toBe('telegram HTTP 401')
  })

  test('reports a network failure without throwing', async () => {
    const impl = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    const result = await notify({ message: 'x', repo: '/r/aidr' }, cfg(), impl)
    expect(result.sent).toBe(false)
    expect(result.reason).toBe('offline')
  })

  test('passes a forum topic id through', async () => {
    const { calls, impl } = stubFetch(200)
    await notify(
      { message: 'x', repo: '/r/aidr' },
      cfg({ topicId: '42' }),
      impl,
    )
    expect(calls[0]?.body.message_thread_id).toBe(42)
  })
})

describe('markdown formatting', () => {
  test('escapes characters telegram would treat as markup', () => {
    // An issue title like this is the whole reason escaping exists: unbalanced
    // `*` or `_` makes Telegram 400 the entire message.
    expect(escapeMd('fix *auth* in `_middleware`')).toBe(
      'fix \\*auth\\* in \\`\\_middleware\\`',
    )
    expect(escapeMd('a [b] c \\ d')).toBe('a \\[b\\] c \\\\ d')
  })

  test('bold and code wrap escaped content', () => {
    expect(mdBold('3 PRs merged')).toBe('*3 PRs merged*')
    expect(mdBold('a*b')).toBe('*a\\*b*')
    expect(mdCode('desk/fix-auth')).toBe('`desk/fix-auth`')
  })

  test('tags are reduced to hashtag-safe characters', () => {
    expect(mdTag('desk')).toBe('#desk')
    expect(mdTag('run-2')).toBe('#run2')
    expect(mdTag('a b/c')).toBe('#abc')
  })

  test('a body carries a coloured dot, a bold verdict, bullets, and tags', () => {
    const out = noticeBody({
      level: 'ok',
      headline: '3 PRs merged',
      items: ['PR #418 merged', '#412 filed'],
      tags: ['desk'],
    })
    expect(out).toBe(
      '🟢 *ok* 3 PRs merged\n• PR #418 merged\n• #412 filed\n#ok #desk',
    )
  })

  test('every level gets a distinct dot and a distinct tag', () => {
    const levels = ['ok', 'fail', 'blocked', 'skip', 'info'] as const
    // An emoji is a surrogate pair, so compare whole lines, not `out[0]`.
    const dots = levels.map((l) =>
      noticeBody({ level: l, headline: 'x' }).split('*')[0].trim(),
    )
    const tags = levels.map((l) =>
      noticeBody({ level: l, headline: 'x' }).split('\n').pop(),
    )
    expect(new Set(dots).size).toBe(5)
    expect(new Set(tags).size).toBe(5)
  })

  test('the dot can be omitted for a plain-text transport', () => {
    const out = noticeBody({ level: 'fail', headline: 'x', dot: false })
    expect(out.startsWith('*fail*')).toBe(true)
  })

  test('a hostile headline cannot break out of the markup', () => {
    const out = noticeBody({ level: 'fail', headline: '*ok* spoofed tag' })
    // The injected `*` is escaped, so the only bold pair is the deliberate one.
    expect(out.split('\n')[0]).toBe('🔴 *fail* \\*ok\\* spoofed tag')
    expect(out.split('\n').pop()).toBe('#fail')
  })

  test('markdown is requested by default and omitted on request', async () => {
    const { calls, impl } = stubFetch(200)
    await notify({ message: 'x', repo: '/r/aidr' }, cfg(), impl)
    expect(calls[0]?.body.parse_mode).toBe('Markdown')

    const plain = stubFetch(200)
    await notify(
      { message: 'x', repo: '/r/aidr', markdown: false },
      cfg(),
      plain.impl,
    )
    expect(plain.calls[0]?.body.parse_mode).toBeUndefined()
  })

  test('a parse failure is retried once as plain text, not lost', async () => {
    const { calls, impl } = stubFetch([400, 200])
    const result = await notify(
      { message: '*unbalanced', repo: '/r/aidr' },
      cfg(),
      impl,
    )
    expect(result.sent).toBe(true)
    expect(result.reason).toContain('plain text')
    expect(calls).toHaveLength(2)
    expect(calls[0]?.body.parse_mode).toBe('Markdown')
    expect(calls[1]?.body.parse_mode).toBeUndefined()
    // The retried text is identical, so the message content never changes.
    expect(calls[1]?.body.text).toBe(calls[0]?.body.text)
  })

  test('a 403 is not retried — it would fail identically', async () => {
    const { calls, impl } = stubFetch(403)
    const result = await notify({ message: 'x', repo: '/r/aidr' }, cfg(), impl)
    expect(result.sent).toBe(false)
    expect(calls).toHaveLength(1)
  })

  test('a failed retry reports the second status, not the first', async () => {
    const { impl } = stubFetch([400, 401])
    const result = await notify({ message: 'x', repo: '/r/aidr' }, cfg(), impl)
    expect(result.sent).toBe(false)
    expect(result.reason).toBe('telegram HTTP 401')
  })
})

describe('redactToken', () => {
  // A real token is `\d+:[A-Za-z0-9_-]{35}`, ~46 chars. The short-token cases
  // below are about not corrupting ordinary text on the way to protecting it.
  const real = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'

  test('a real-length token is removed from a fetch error', () => {
    const msg = `TypeError: fetch failed for https://api.telegram.org/bot${real}/sendMessage`
    const out = redactToken(msg, real)
    expect(out).not.toContain(real)
    expect(out).toContain('<redacted>')
  })

  test('a real token is removed even outside the URL form', () => {
    const out = redactToken(`token=${real} rejected`, real)
    expect(out).not.toContain(real)
  })

  test('the url form is redacted even for a short token', () => {
    const out = redactToken('POST /bott/sendMessage failed', 't')
    expect(out).toBe('POST /bot<redacted>/sendMessage failed')
  })

  test('a short token does not corrupt ordinary words', () => {
    // Regression: redacting every occurrence of a 1-char token rewrote the `t`
    // in "telegram", so the failure reason read "<redacted>elegram HTTP 401".
    expect(redactToken('telegram HTTP 401', 't')).toBe('telegram HTTP 401')
    expect(redactToken('telegram HTTP 401', '')).toBe('telegram HTTP 401')
  })

  test('notify never returns a reason containing a real token', async () => {
    const impl = (async () => {
      throw new TypeError(
        `fetch failed: https://api.telegram.org/bot${real}/sendMessage`,
      )
    }) as unknown as typeof fetch
    const result = await notify(
      { message: 'x', repo: '/r/aidr' },
      cfg({ token: real }),
      impl,
    )
    expect(result.sent).toBe(false)
    expect(result.reason).not.toContain(real)
  })
})

describe('formatNotice body cap', () => {
  test('the machine and repo prefix survives a huge body', () => {
    // The prefix is the reason a host-level channel is usable; capping must
    // never eat it.
    const out = formatNotice(
      {
        message: 'x'.repeat(5000),
        repo: '/r/aidr',
        label: 'desk:github-issues',
      },
      'box',
    )
    expect(out.startsWith('[box] [aidr] [desk:github-issues] ')).toBe(true)
    expect(out).toContain('chars)')
    expect(out.length).toBeLessThan(MAX_BODY + 80)
  })

  test('a short body is untouched', () => {
    expect(formatNotice({ message: 'all good', repo: '/r/aidr' }, 'box')).toBe(
      '[box] [aidr] all good',
    )
  })

  test('a whole notice stays inside the telegram limit', () => {
    const out = formatNotice(
      { message: 'y'.repeat(MAX_BODY * 2), repo: '/r/aidr' },
      'a-very-long-hostname-that-goes-on',
    )
    expect(out.length).toBeLessThan(4096)
  })
})

describe('resolveNotify precedence', () => {
  const REAL_TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'
  let restore: (() => void) | null = null

  /**
   * Point both the host notify file and the machine config at a temp dir, so a
   * test can never read or write the real one.
   */
  function sandbox(): string {
    const dir = mkdtempSync(join(tmpdir(), 'desk-notify-precedence-'))
    const prevConfig = process.env.HERDR_PLUGIN_CONFIG_DIR
    const prevState = process.env.HERDR_PLUGIN_STATE_DIR
    const prevToken = process.env.HERDR_DESK_TELEGRAM_TOKEN
    process.env.HERDR_PLUGIN_CONFIG_DIR = dir
    process.env.HERDR_PLUGIN_STATE_DIR = dir
    delete process.env.HERDR_DESK_TELEGRAM_TOKEN
    restore = () => {
      if (prevConfig === undefined) delete process.env.HERDR_PLUGIN_CONFIG_DIR
      else process.env.HERDR_PLUGIN_CONFIG_DIR = prevConfig
      if (prevState === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR
      else process.env.HERDR_PLUGIN_STATE_DIR = prevState
      if (prevToken === undefined) delete process.env.HERDR_DESK_TELEGRAM_TOKEN
      else process.env.HERDR_DESK_TELEGRAM_TOKEN = prevToken
    }
    return dir
  }

  afterEach(() => {
    restore?.()
    restore = null
  })

  function host(dir: string, over: Record<string, unknown> = {}): void {
    writeFileSync(
      join(dir, 'notify.json'),
      JSON.stringify({
        token: REAL_TOKEN,
        chatId: 'host-chat',
        topicId: 'host-topic',
        ...over,
      }),
    )
  }

  test('host chat id is the default for a repo with no notify block', () => {
    const dir = sandbox()
    host(dir)
    writeFileSync(
      join(dir, '.herdr-desk.json'),
      JSON.stringify({ name: 'aidr' }),
    )
    const { config } = resolveNotify({ repo: dir })
    expect(config.chatId).toBe('host-chat')
    expect(config.topicId).toBe('host-topic')
    expect(config.token).toBe(REAL_TOKEN)
  })

  test('a repo retargets chatId and keeps the host topicId', () => {
    const dir = sandbox()
    host(dir)
    writeFileSync(
      join(dir, '.herdr-desk.json'),
      JSON.stringify({ name: 'aidr', notify: { chatId: 'dedicated-chat' } }),
    )
    const { config, provenance } = resolveNotify({ repo: dir })
    expect(config.chatId).toBe('dedicated-chat')
    // The inherited topic must survive, or a forum topic silently reverts.
    expect(config.topicId).toBe('host-topic')
    expect(provenance.chatId).toBe('repo')
    expect(provenance.topicId).toBeUndefined()
  })

  test('a task override beats the repo', () => {
    const dir = sandbox()
    host(dir)
    writeFileSync(
      join(dir, '.herdr-desk.json'),
      JSON.stringify({ name: 'aidr', notify: { chatId: 'repo-chat' } }),
    )
    const { config, provenance } = resolveNotify({
      repo: dir,
      taskNotify: { chatId: 'task-chat' },
    })
    expect(config.chatId).toBe('task-chat')
    expect(provenance.chatId).toBe('task')
  })

  test('a repo config can never change the token', () => {
    const dir = sandbox()
    host(dir)
    // Even bypassing the validator, the token stays host-owned.
    writeFileSync(
      join(dir, '.herdr-desk.json'),
      JSON.stringify({
        name: 'aidr',
        notify: { chatId: 'x', token: 'leaked-token' },
      }),
    )
    expect(resolveNotify({ repo: dir }).config.token).toBe(REAL_TOKEN)
  })

  test('enabled only ever narrows, never re-enables', () => {
    const dir = sandbox()
    host(dir, { enabled: false })
    writeFileSync(
      join(dir, '.herdr-desk.json'),
      JSON.stringify({ name: 'aidr', notify: { enabled: true } }),
    )
    expect(resolveNotify({ repo: dir }).config.enabled).toBe(false)
  })

  test('a group config sets a destination a repo then overrides', () => {
    const dir = sandbox()
    host(dir)
    const group = join(dir, 'fleet')
    const repo = join(group, 'aidr')
    mkdirSync(repo, { recursive: true })
    writeFileSync(
      join(group, '.herdr-desk.json'),
      JSON.stringify({
        name: 'fleet',
        group: true,
        notify: { chatId: 'group-chat' },
      }),
    )
    writeFileSync(
      join(repo, '.herdr-desk.json'),
      JSON.stringify({ name: 'aidr' }),
    )
    const { config, provenance } = resolveNotify({ repo })
    expect(config.chatId).toBe('group-chat')
    expect(provenance.chatId).toBe('group')
  })
})
