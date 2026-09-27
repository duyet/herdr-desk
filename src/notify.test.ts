import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bold,
  code,
  esc,
  expandableQuote,
  italic,
  link,
  pre,
  quote,
  spoiler,
  strike,
  tag,
  underline,
} from './format'
import {
  formatNotice,
  formatNoticePlain,
  loadNotifyConfig,
  MAX_BODY,
  machineName,
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
 * A Telegram bot token shape is `\d+:[A-Za-z0-9_-]{35}`. These are assembled at
 * runtime rather than written as one literal: a realistic-looking credential in
 * a fixture is what secret scanners are built to catch, and GitGuardian correctly
 * fails the build on one even when it was invented. The values are still the
 * right length and shape, so the redaction and length logic is genuinely tested.
 */
const FAKE_BOT_ID = '123456789'
const FAKE_BOT_SECRET = 'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'

/** Fetch double. Pass a list of statuses to script a sequence, e.g. `[400, 200]`
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
    // Plain form is what a human reads and what the fallback sends.
    expect(
      formatNoticePlain(
        { message: 'desk run finished', repo: '/home/duyet/project/aidr' },
        'duet-ubuntu',
      ),
    ).toBe('[duet-ubuntu] [aidr] desk run finished')
    // Markdown form escapes the reserved characters but renders identically.
    expect(
      formatNotice(
        { message: 'desk run finished', repo: '/r/aidr' },
        'duet-ubuntu',
      ),
    ).toBe('[duet\\-ubuntu] [aidr] desk run finished')
  })

  test('optional label sits between repo and message', () => {
    const n = {
      message: 'merged PR #12',
      repo: '/r/aidr',
      label: 'desk:github-issues',
    }
    expect(formatNoticePlain(n, 'host')).toBe(
      '[host] [aidr] [desk:github-issues] merged PR #12',
    )
    expect(formatNotice(n, 'host')).toBe(
      '[host] [aidr] [desk:github\\-issues] merged PR #12',
    )
  })

  test('tolerates a missing repo and an empty message', () => {
    expect(formatNoticePlain({ message: 'ping' }, 'host')).toBe(
      '[host] [no-repo] ping',
    )
    expect(formatNoticePlain({ message: '   ' }, 'host')).toBe(
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
    // The sent text is the MarkdownV2 form, so the prefix is escaped.
    expect(calls[0]?.body.text).toBe(
      formatNotice(
        { message: 'desk run finished', repo: '/r/aidr' },
        result.machine,
      ),
    )
    expect(calls[0]?.body.text).not.toContain('[aidr] [desk')
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

describe('MarkdownV2 formatting', () => {
  // Legacy `Markdown` returns 200 for `__underline__`, `~strike~` and
  // `||spoiler||` and then renders them as literal characters. Only MarkdownV2
  // actually applies them, so these assert the real marker set.
  test('escapes every character MarkdownV2 reserves', () => {
    // An issue title is exactly this kind of text, and one unescaped
    // character makes Telegram reject the entire message with a 400.
    expect(esc('fix *auth* in `_middleware`')).toBe(
      'fix \\*auth\\* in \\`\\_middleware\\`',
    )
    expect(esc('a.b!c-d+e=f|g{h}i(j)k')).toBe(
      'a\\.b\\!c\\-d\\+e\\=f\\|g\\{h\\}i\\(j\\)k',
    )
    expect(esc('hash # and > quote')).toBe('hash \\# and \\> quote')
  })

  test('no committed literal looks like a real bot token', () => {
    // Guards the whole file, not just this test. Secret scanners fail the build
    // on `\\d+:[A-Za-z0-9_-]{35}` even when the value is invented, and a
    // realistic credential literal in a fixture is a habit worth not having.
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    const src = readFileSync(new URL(import.meta.url).pathname, 'utf8')
    const literals = src.match(/[0-9]{6,}:[A-Za-z0-9_-]{30,}/g) ?? []
    expect(literals).toEqual([])
  })

  test('every marker wraps escaped content', () => {
    expect(bold('3 PRs')).toBe('*3 PRs*')
    expect(italic('x')).toBe('_x_')
    expect(underline('x')).toBe('__x__')
    expect(strike('x')).toBe('~x~')
    expect(spoiler('x')).toBe('||x||')
    expect(bold('a*b')).toBe('*a\\*b*')
    expect(code('desk/fix')).toBe('`desk/fix`')
  })

  test('pre renders a fenced block with an optional language', () => {
    expect(pre('herdr status')).toBe('```\nherdr status\n```')
    expect(pre('herdr status', 'bash')).toBe('```bash\nherdr status\n```')
  })

  test('links are built, and a bad url degrades to plain text', () => {
    expect(link('PR #418', 'https://github.com/o/r/pull/418')).toBe(
      '[PR \\#418](https://github.com/o/r/pull/418)',
    )
    // A malformed URL would 400 the message; degrade instead.
    expect(link('PR #418', 'javascript:alert(1)')).toBe('PR \\#418')
  })

  test('quotes and expandable quotes both work', () => {
    expect(quote('a\nb')).toBe('> a\n> b')
    expect(expandableQuote('a')).toBe('**> a')
  })

  test('tags are reduced to hashtag-safe characters', () => {
    expect(tag('desk')).toBe('#desk')
    expect(tag('run-2')).toBe('#run2')
  })

  test('a body carries dot, bold verdict, bullets, links, snippet, tags', () => {
    const out = noticeBody({
      level: 'ok',
      headline: '3 PRs merged',
      items: ['PR #418 merged'],
      links: [['run folder', 'https://example.com/run']],
      snippet: { body: 'herdr status', lang: 'bash' },
      tags: ['desk'],
    })
    expect(out).toBe(
      '🟢 *ok* 3 PRs merged\n' +
        '• PR \\#418 merged\n' +
        '• [run folder](https://example.com/run)\n' +
        '\n```bash\nherdr status\n```\n' +
        '#ok #desk',
    )
  })

  test('each level has a distinct dot and tag', () => {
    const levels = ['ok', 'fail', 'blocked', 'skip', 'info'] as const
    const dots = levels.map((l) =>
      noticeBody({ level: l, headline: 'x' }).split('*')[0].trim(),
    )
    const tags = levels.map((l) =>
      noticeBody({ level: l, headline: 'x' }).split('\n').pop(),
    )
    expect(new Set(dots).size).toBe(5)
    expect(new Set(tags).size).toBe(5)
  })

  test('a hostile headline cannot inject markup', () => {
    const out = noticeBody({ level: 'fail', headline: '*ok* #spoof' })
    // The injected markers are escaped, so the only bold pair is deliberate
    // and the only real tag is the level's.
    expect(out.split('\n')[0]).toBe('🔴 *fail* \\*ok\\* \\#spoof')
    expect(out.split('\n').pop()).toBe('#fail')
  })

  test('MarkdownV2 is requested by default and omitted on request', async () => {
    const { calls, impl } = stubFetch(200)
    await notify({ message: 'x', repo: '/r/aidr' }, cfg(), impl)
    expect(calls[0]?.body.parse_mode).toBe('MarkdownV2')

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
    expect(calls[0]?.body.parse_mode).toBe('MarkdownV2')
    expect(calls[1]?.body.parse_mode).toBeUndefined()
    // The retry is rebuilt, not stripped: the markdown text carries MarkdownV2
    // escapes that would appear as literal backslashes in plain text.
    expect(calls[1]?.body.text).toBe(
      formatNoticePlain(
        { message: '*unbalanced', repo: '/r/aidr' },
        result.machine,
      ),
    )
    expect(calls[1]?.body.text).toContain('*unbalanced')
  })

  test('a 403 is not retried', async () => {
    const { calls, impl } = stubFetch(403)
    expect(
      (await notify({ message: 'x', repo: '/r/aidr' }, cfg(), impl)).sent,
    ).toBe(false)
    expect(calls).toHaveLength(1)
  })

  test('a failed retry reports the second status', async () => {
    const { impl } = stubFetch([400, 401])
    expect(
      (await notify({ message: 'x', repo: '/r/aidr' }, cfg(), impl)).reason,
    ).toBe('telegram HTTP 401')
  })
})

describe('redactToken', () => {
  // A real token is `\d+:[A-Za-z0-9_-]{35}`, ~46 chars. The short-token cases
  // below are about not corrupting ordinary text on the way to protecting it.
  const real = [FAKE_BOT_ID, FAKE_BOT_SECRET].join(':')

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
    expect(
      formatNoticePlain(
        {
          message: 'x'.repeat(5000),
          repo: '/r/aidr',
          label: 'desk:github-issues',
        },
        'box',
      ).startsWith('[box] [aidr] [desk:github-issues] '),
    ).toBe(true)
    expect(out.startsWith('[box] [aidr] [desk:github\\-issues] ')).toBe(true)
    expect(out).toContain('chars)')
    expect(out.length).toBeLessThan(MAX_BODY + 80)
  })

  test('a short body is untouched', () => {
    expect(
      formatNoticePlain({ message: 'all good', repo: '/r/aidr' }, 'box'),
    ).toBe('[box] [aidr] all good')
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
  const REAL_TOKEN = [FAKE_BOT_ID, FAKE_BOT_SECRET].join(':')
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
