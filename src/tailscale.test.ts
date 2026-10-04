import { describe, expect, test } from 'bun:test'
import { bindHosts, dashboardUrls, detectTailnet, tailnetOf } from './tailscale'

const self = {
  Online: true,
  TailscaleIPs: ['100.1.2.3', 'fd7a:115c:a1e0::1'],
  DNSName: 'desk.tailnet.ts.net.',
}

describe('tailnetOf', () => {
  test('reads this node and drops the trailing dot on the MagicDNS name', () => {
    // The dot is how status prints the name. Left on, the URL does not open.
    expect(
      tailnetOf({ Self: self, Peer: { a: { TailscaleIPs: ['100.9.9.9'] } } }),
    ).toEqual({
      ip4: '100.1.2.3',
      ip6: 'fd7a:115c:a1e0::1',
      dns: 'desk.tailnet.ts.net',
    })
  })

  test('a down node is not a bind address', () => {
    // Online false means the name would not answer. Serve stays on localhost.
    expect(tailnetOf({ Self: { ...self, Online: false } })).toBeNull()
  })

  test('no address is not a tailnet', () => {
    expect(tailnetOf({ Self: { Online: true, TailscaleIPs: [] } })).toBeNull()
    expect(tailnetOf(null)).toBeNull()
    expect(tailnetOf({})).toBeNull()
  })
})

describe('detectTailnet', () => {
  test('a missing CLI or bad JSON leaves the dashboard on localhost', async () => {
    expect(
      await detectTailnet(async () => ({ code: 1, stdout: '' })),
    ).toBeNull()
    expect(
      await detectTailnet(async () => ({ code: 0, stdout: 'not-json' })),
    ).toBeNull()
    expect(
      await detectTailnet(async () => {
        throw new Error('spawn ENOENT')
      }),
    ).toBeNull()
  })

  test('a zero exit uses the status body', async () => {
    const got = await detectTailnet(async () => ({
      code: 0,
      stdout: JSON.stringify({ Self: self }),
    }))
    expect(got?.dns).toBe('desk.tailnet.ts.net')
  })
})

describe('bindHosts', () => {
  test('an explicit host is the only bind, even when a tailnet was detected', () => {
    const tailnet = tailnetOf({ Self: self })
    expect(bindHosts('127.0.0.1', tailnet)).toEqual(['127.0.0.1'])
    expect(bindHosts(undefined, null)).toEqual(['127.0.0.1'])
    expect(bindHosts(undefined, tailnet)).toEqual([
      '127.0.0.1',
      '100.1.2.3',
      'fd7a:115c:a1e0::1',
    ])
  })
})

describe('dashboardUrls', () => {
  test('the printed tailnet URL is the name, and a failed bind is left out', () => {
    const tailnet = tailnetOf({ Self: self })
    expect(dashboardUrls(8787, ['127.0.0.1', '100.1.2.3'], tailnet)).toEqual([
      'http://127.0.0.1:8787',
      'http://desk.tailnet.ts.net:8787',
    ])
    // The v4 listen failed. Do not print a name that reaches nothing.
    expect(dashboardUrls(8787, ['127.0.0.1'], tailnet)).toEqual([
      'http://127.0.0.1:8787',
    ])
  })

  test('an address with a colon is bracketed', () => {
    expect(
      dashboardUrls(8787, ['fd7a::1'], {
        ip6: 'fd7a::1',
      }),
    ).toEqual(['http://[fd7a::1]:8787'])
  })
})
