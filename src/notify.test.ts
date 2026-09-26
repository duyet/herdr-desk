import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  formatNotice,
  loadNotifyConfig,
  machineName,
  type NotifyConfig,
  notify,
  repoName,
} from './notify'

function cfg(over: Partial<NotifyConfig> = {}): NotifyConfig {
  return { enabled: true, token: 't', chatId: 'c', topicId: '', ...over }
}

/** Minimal fetch double that records the request and returns 200. */
function stubFetch(status = 200) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    })
    return new Response('{}', { status })
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
    expect(machineName()).toContain('duet-ubuntu')
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
