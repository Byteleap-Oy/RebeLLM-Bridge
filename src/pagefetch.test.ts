import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import {
  MAX_REDIRECTS,
  PageFetchError,
  USER_AGENT,
  canonicalAddress,
  checkedDialer,
  inNetwork,
  networkOf,
  fetchLine,
  isPublicAddress,
  pageFetch,
  rateLimit,
  type Dial,
  type Lookup,
} from './pagefetch.js'

const os = vi.hoisted(() => ({ interfaces: {} as Record<string, { address: string; cidr?: string }[]> }))
vi.mock('node:os', async (actual) => ({
  ...(await actual<typeof import('node:os')>()),
  networkInterfaces: () => os.interfaces,
}))

const PUBLIC = '93.184.215.14'
const dns =
  (table: Record<string, string[]>): Lookup =>
  async (host) =>
    (table[host] ?? []).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
const page = (
  body: ConstructorParameters<typeof Response>[0],
  type = 'text/html; charset=utf-8',
  init: ResponseInit = {},
) => new Response(body, { status: 200, ...init, headers: { 'content-type': type, ...init.headers } })
const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } })

/** A dial that answers from a table by URL and records where it connected. */
function dialer(answers: Record<string, () => Response>) {
  const calls: { url: string; address: string; headers: Record<string, string> }[] = []
  const dial = vi.fn<Dial>(async (url, o) => {
    calls.push({ url: url.href, address: o.address, headers: o.headers })
    const a = answers[url.href]
    if (!a) throw new TypeError('fetch failed', { cause: new Error(`connect ECONNREFUSED ${o.address}`) })
    return a()
  })
  return { dial, calls }
}

const refused = (p: Promise<unknown>, message: RegExp) =>
  expect(p).rejects.toMatchObject({ name: 'PageFetchError', message: expect.stringMatching(message) })

describe('isPublicAddress', () => {
  it('passes public IPv4 and IPv6 addresses and their mapped forms', () => {
    for (const a of [PUBLIC, '8.8.8.8', '1.1.1.1', '2606:4700::1111', '[2a00:1450:4001::200e]', '::ffff:8.8.8.8'])
      expect(isPublicAddress(a), a).toBe(true)
  })

  it('refuses loopback, private, link-local, CGNAT, multicast, reserved and unique-local, also mapped', () => {
    for (const a of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '240.0.0.1',
      '255.255.255.255',
      '198.18.0.1',
      '192.0.2.1',
      '::',
      '::1',
      'fe80::1',
      'fe80::1%eth0',
      'fc00::1',
      'fd12:3456::1',
      'ff02::1',
      '2001:db8::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '::ffff:7f00:1',
      '::ffff:0:192.168.0.1',
      '64:ff9b::a00:1',
      '64:ff9b:1::808:808',
      '2002:c0a8:101::',
      '2001:0:4136:e378:8000:63bf:3fff:fdd2',
      'not-an-address',
      '1.2.3',
    ])
      expect(isPublicAddress(a), a).toBe(false)
  })
})

describe('canonicalAddress', () => {
  it('spells one address one way, mapped IPv4 as IPv4, without brackets or zone', () => {
    for (const [a, b] of [
      ['2001:DB8:1::5', '[2001:db8:1:0:0:0:0:5]'],
      ['fe80::1%eth0', 'fe80::1'],
      ['203.0.113.5', '::ffff:203.0.113.5'],
      ['203.0.113.5', '::ffff:cb00:7105'],
      ['203.0.113.5', '::ffff:0:203.0.113.5'],
    ] as const)
      expect(canonicalAddress(a), `${a} = ${b}`).toBe(canonicalAddress(b))
    expect(canonicalAddress('2001:db8:1::5')).not.toBe(canonicalAddress('2001:db8:1::6'))
    expect(canonicalAddress('not-an-address')).toBeNull()
  })
})

describe('networkOf and inNetwork', () => {
  it('matches addresses inside a CIDR in any spelling, and a bare address alone', () => {
    const v6 = networkOf('2606:4700:1:2:a:b:c:d/64')!
    expect(inNetwork('2606:4700:1:2::1', v6)).toBe(true)
    expect(inNetwork('[2606:4700:1:2:FFFF::]', v6)).toBe(true)
    expect(inNetwork('2606:4700:1:3::1', v6)).toBe(false)
    const v4 = networkOf('8.8.4.4/24')!
    expect(inNetwork('8.8.4.200', v4)).toBe(true)
    expect(inNetwork('::ffff:8.8.4.1', v4)).toBe(true)
    expect(inNetwork('8.8.5.1', v4)).toBe(false)
    expect(inNetwork('2606:4700:1:2::1', v4)).toBe(false)
    const odd = networkOf('8.8.4.4/22')!
    expect(inNetwork('8.8.7.255', odd)).toBe(true)
    expect(inNetwork('8.8.8.0', odd)).toBe(false)
    const bare = networkOf('2606:4700:1:2::5')!
    expect(inNetwork('2606:4700:1:2::5', bare)).toBe(true)
    expect(inNetwork('2606:4700:1:2::6', bare)).toBe(false)
    expect(networkOf('nonsense/24')).toBeNull()
  })

  it('shrinks prefixes wider than /16 or /32 to the address itself', () => {
    for (const [cidr, inside, outside] of [
      ['8.8.4.4/8', '8.8.4.4', '8.9.0.1'],
      ['8.8.4.4/0', '8.8.4.4', '1.1.1.1'],
      ['2606:4700::5/16', '2606:4700::5', '2606:1::1'],
      ['8.8.4.4/x', '8.8.4.4', '8.8.4.5'],
    ] as const) {
      const n = networkOf(cidr)!
      expect(inNetwork(inside, n), cidr).toBe(true)
      expect(inNetwork(outside, n), cidr).toBe(false)
    }
    expect(inNetwork('8.8.200.1', networkOf('8.8.4.4/16')!)).toBe(true)
  })
})

describe('pageFetch', () => {
  it('reads a public page from the checked address, without cookies or credentials', async () => {
    const { dial, calls } = dialer({
      'https://docs.example.org/json.html': () => page('<h1>json</h1>'),
    })
    const r = await pageFetch('https://docs.example.org/json.html#top', {
      lookup: dns({ 'docs.example.org': [PUBLIC] }),
      dial,
    })
    expect(r).toEqual({
      status: 200,
      type: 'text/html',
      finalUrl: 'https://docs.example.org/json.html',
      text: '<h1>json</h1>',
      cut: false,
    })
    expect(calls).toEqual([{ url: 'https://docs.example.org/json.html', address: PUBLIC, headers: expect.any(Object) }])
    expect(calls[0]!.headers['user-agent']).toBe(USER_AGENT)
    expect(Object.keys(calls[0]!.headers).sort()).toEqual(['accept', 'user-agent'])
  })

  it('refuses other schemes, credentials in the URL and non-URLs before any lookup', async () => {
    const lookup = vi.fn(dns({}))
    const { dial } = dialer({})
    await refused(pageFetch('file:///etc/passwd', { lookup, dial }), /^only http and https, not file:$/)
    await refused(pageFetch('ftp://example.org/', { lookup, dial }), /only http and https/)
    await refused(pageFetch('https://user:pw@example.org/', { lookup, dial }), /credentials/)
    await refused(pageFetch('not a url', { lookup, dial }), /^not a URL$/)
    expect(lookup).not.toHaveBeenCalled()
    expect(dial).not.toHaveBeenCalled()
  })

  it('refuses private, mixed and unresolvable hosts without connecting', async () => {
    const lookup = dns({
      'router.example': ['192.168.1.1'],
      'mixed.example': [PUBLIC, '10.0.0.5'],
      'v6.example': ['::1'],
    })
    const { dial } = dialer({})
    await refused(pageFetch('http://192.168.1.1/', { lookup, dial }), /^192\.168\.1\.1 is not a public address$/)
    await refused(pageFetch('http://[::ffff:127.0.0.1]/', { lookup, dial }), /not a public address/)
    await refused(pageFetch('http://router.example/', { lookup, dial }), /^router\.example is not a public address$/)
    await refused(pageFetch('http://mixed.example/', { lookup, dial }), /not a public address/)
    await refused(pageFetch('http://v6.example/', { lookup, dial }), /not a public address/)
    await refused(pageFetch('http://nowhere.example/', { lookup, dial }), /^nowhere\.example does not resolve$/)
    expect(dial).not.toHaveBeenCalled()
  })

  it('checks every redirect hop and refuses one to a private address', async () => {
    const { dial, calls } = dialer({
      'https://a.example/': () => redirect('/b'),
      'https://a.example/b': () => redirect('http://intranet.example/admin', 301),
    })
    const lookup = dns({ 'a.example': [PUBLIC], 'intranet.example': ['10.0.0.1'] })
    await refused(pageFetch('https://a.example/', { lookup, dial }), /^intranet\.example is not a public address$/)
    expect(calls.map((c) => c.url)).toEqual(['https://a.example/', 'https://a.example/b'])
  })

  it("refuses this computer's own public addresses, in any spelling and on any hop, without connecting", async () => {
    const MINE_V6 = '2606:4700:1::5'
    const MINE_V4 = '8.8.4.4'
    const ownAddresses = () => ['127.0.0.1', 'fe80::1', MINE_V6.toUpperCase(), MINE_V4]
    const lookup = dns({
      'self.example': [MINE_V6],
      'mixed.example': [PUBLIC, MINE_V4],
      'a.example': [PUBLIC],
    })
    const { dial, calls } = dialer({ 'https://a.example/': () => redirect(`http://[${MINE_V6}]:8080/admin`) })
    const o = { lookup, dial, ownAddresses }
    await refused(pageFetch(`http://[${MINE_V6}]:8080/`, o), /is not a public address$/)
    await refused(pageFetch('http://[2606:4700:1:0::5]/', o), /is not a public address$/)
    await refused(pageFetch(`http://${MINE_V4}/`, o), /^8\.8\.4\.4 is not a public address$/)
    await refused(pageFetch(`http://[::ffff:${MINE_V4}]/`, o), /is not a public address$/)
    await refused(pageFetch('http://self.example/', o), /^self\.example is not a public address$/)
    await refused(pageFetch('http://mixed.example/', o), /^mixed\.example is not a public address$/)
    await refused(pageFetch('https://a.example/', o), /is not a public address$/)
    expect(calls.map((c) => c.url)).toEqual(['https://a.example/'])
  })

  it("refuses other devices on this computer's networks, such as the router", async () => {
    const ownAddresses = () => ['2606:4700:1:2:a1b2:c3d4:e5f6:1234/64', '8.8.4.4/24', '127.0.0.1/8']
    const lookup = dns({ 'router.example': ['2606:4700:1:2::1'], 'far.example': ['2606:4700:1:3::1'] })
    const { dial, calls } = dialer({ 'http://far.example/': () => page('far', 'text/plain') })
    const o = { lookup, dial, ownAddresses }
    await refused(pageFetch('http://[2606:4700:1:2::1]/', o), /is not a public address$/)
    await refused(pageFetch('http://router.example/', o), /^router\.example is not a public address$/)
    await refused(pageFetch('http://8.8.4.1/', o), /is not a public address$/)
    expect(await pageFetch('http://far.example/', o)).toMatchObject({ text: 'far' })
    expect(calls.map((c) => c.url)).toEqual(['http://far.example/'])
  })

  it('reads the network interfaces on every fetch by default', async () => {
    const { dial } = dialer({ 'http://self.example/': () => page('hi', 'text/plain') })
    const o = { lookup: dns({ 'self.example': ['2606:4700:1::7'] }), dial }
    expect(await pageFetch('http://self.example/', o)).toMatchObject({ text: 'hi' })
    os.interfaces = { eth0: [{ address: '2606:4700:1::9', cidr: '2606:4700:1::9/64' }] }
    try {
      await refused(pageFetch('http://self.example/', o), /not a public address/)
    } finally {
      os.interfaces = {}
    }
  })

  it(`follows up to ${MAX_REDIRECTS} redirects and names the final URL`, async () => {
    const hops = (n: number) =>
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [`https://r.example/${i}`, () => redirect(`/${i + 1}`, 307)] as const),
      )
    const lookup = dns({ 'r.example': [PUBLIC] })
    const five = dialer({ ...hops(5), 'https://r.example/5': () => page('done', 'text/plain') })
    expect(await pageFetch('https://r.example/0', { lookup, dial: five.dial })).toMatchObject({
      finalUrl: 'https://r.example/5',
      text: 'done',
    })
    const six = dialer({ ...hops(6), 'https://r.example/6': () => page('done', 'text/plain') })
    await refused(pageFetch('https://r.example/0', { lookup, dial: six.dial }), /^more than 5 redirects$/)
  })

  it('reads at most the byte cap and marks the text cut', async () => {
    const lookup = dns({ 'big.example': [PUBLIC] })
    const { dial } = dialer({ 'https://big.example/': () => page('y'.repeat(5000), 'text/plain') })
    const r = await pageFetch('https://big.example/', { lookup, dial, maxBytes: 1000 })
    expect(r.text).toBe('y'.repeat(1000))
    expect(r.cut).toBe(true)
  })

  it('passes text types only, decodes the charset, and answers other statuses without a body', async () => {
    const lookup = dns({ 'x.example': [PUBLIC] })
    const { dial } = dialer({
      'https://x.example/a.png': () => page('x', 'image/png'),
      'https://x.example/none': () => {
        const res = new Response('x')
        res.headers.delete('content-type')
        return res
      },
      'https://x.example/v.json': () => page('{"v":1}', 'application/json'),
      'https://x.example/feed': () => page('<feed/>', 'application/atom+xml'),
      'https://x.example/a.md': () => page('# Hi', 'text/markdown'),
      'https://x.example/latin': () => page(new Uint8Array([0x70, 0xe4, 0xe4]), 'text/plain; charset=iso-8859-1'),
      'https://x.example/gone': () => page('<h1>Gone</h1>', 'text/html', { status: 404 }),
    })
    await refused(pageFetch('https://x.example/a.png', { lookup, dial }), /^image\/png is not a text type$/)
    await refused(pageFetch('https://x.example/none', { lookup, dial }), /^no content type is not a text type$/)
    expect((await pageFetch('https://x.example/v.json', { lookup, dial })).type).toBe('application/json')
    expect((await pageFetch('https://x.example/feed', { lookup, dial })).type).toBe('application/atom+xml')
    expect((await pageFetch('https://x.example/a.md', { lookup, dial })).text).toBe('# Hi')
    expect((await pageFetch('https://x.example/latin', { lookup, dial })).text).toBe('pää')
    expect(await pageFetch('https://x.example/gone', { lookup, dial })).toEqual({
      status: 404,
      type: 'text/html',
      finalUrl: 'https://x.example/gone',
      text: '',
      cut: false,
    })
  })

  it('gives up after the time cap, stops when cancelled, and names network failures', async () => {
    const lookup = dns({ 'slow.example': [PUBLIC] })
    const hang: Dial = (_u, o) =>
      new Promise((_, reject) => o.signal.addEventListener('abort', () => reject(o.signal.reason)))
    await refused(
      pageFetch('https://slow.example/', { lookup, dial: hang, timeoutMs: 30 }),
      /^no answer within 0\.03 s$/,
    )
    const ctl = new AbortController()
    const pending = pageFetch('https://slow.example/', { lookup, dial: hang, signal: ctl.signal })
    ctl.abort()
    await refused(pending, /^cancelled$/)
    const { dial } = dialer({})
    await refused(pageFetch('https://slow.example/', { lookup, dial }), /^could not fetch: connect ECONNREFUSED/)
  })

  it('counts the name lookup in the time cap and stops it when cancelled', async () => {
    const stuck: Lookup = () => new Promise(() => undefined)
    const { dial } = dialer({})
    await refused(
      pageFetch('https://stuck.example/', { lookup: stuck, dial, timeoutMs: 30 }),
      /^no answer within 0\.03 s$/,
    )
    const ctl = new AbortController()
    const pending = pageFetch('https://stuck.example/', { lookup: stuck, dial, signal: ctl.signal })
    setTimeout(() => ctl.abort(), 10)
    await refused(pending, /^cancelled$/)
    expect(dial).not.toHaveBeenCalled()
  })
})

describe('checkedDialer', () => {
  it('connects to the checked address with the URL host as Host, and hands redirects back unfollowed', async () => {
    const seen: { host?: string; cookie?: string; path?: string }[] = []
    const server = createServer((req, res) => {
      seen.push({ host: req.headers.host, cookie: req.headers.cookie, path: req.url })
      if (req.url === '/moved') {
        res.writeHead(302, { location: '/there' })
        return res.end()
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('hello from the checked address')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const port = (server.address() as AddressInfo).port
    const { dial, close } = checkedDialer()
    try {
      const signal = AbortSignal.timeout(5000)
      // No DNS knows page.invalid: the connection can only go where the check said.
      const res = await dial(new URL(`http://page.invalid:${port}/x`), {
        address: '127.0.0.1',
        family: 4,
        headers: { 'user-agent': USER_AGENT },
        signal,
      })
      expect(res.status).toBe(200)
      expect(await new Response(res.body).text()).toBe('hello from the checked address')
      const moved = await dial(new URL(`http://page.invalid:${port}/moved`), {
        address: '127.0.0.1',
        family: 4,
        headers: {},
        signal,
      })
      expect(moved.status).toBe(302)
      expect(moved.headers.get('location')).toBe('/there')
      await moved.body?.cancel()
      expect(seen).toEqual([
        { host: `page.invalid:${port}`, cookie: undefined, path: '/x' },
        { host: `page.invalid:${port}`, cookie: undefined, path: '/moved' },
      ])
    } finally {
      await close()
      server.close()
    }
  })
})

describe('rateLimit', () => {
  it('allows the burst, then refills over the minute', () => {
    let t = 0
    const take = rateLimit(30, () => t)
    expect(Array.from({ length: 30 }, take).every(Boolean)).toBe(true)
    expect(take()).toBe(false)
    t += 2000
    expect(take()).toBe(true)
    expect(take()).toBe(false)
  })
})

describe('fetchLine', () => {
  it('names the host only', () => {
    const page = { status: 200, type: 'text/html', finalUrl: 'https://a.example/x', text: 'é'.repeat(6000), cut: true }
    expect(fetchLine('https://docs.example.org/secret/path?q=token', page)).toBe(
      'fetch docs.example.org: 200, 12 000 bytes, cut',
    )
    expect(fetchLine('https://a.example/p?q=1', { ...page, status: 404, text: '', cut: false })).toBe(
      'fetch a.example: 404, 0 bytes',
    )
    expect(fetchLine('http://192.168.1.1/admin', '192.168.1.1 is not a public address')).toBe(
      'fetch 192.168.1.1: error 192.168.1.1 is not a public address',
    )
    expect(fetchLine('nonsense', 'not a URL')).toBe('fetch ?: error not a URL')
    expect(new PageFetchError('x').name).toBe('PageFetchError')
  })
})
