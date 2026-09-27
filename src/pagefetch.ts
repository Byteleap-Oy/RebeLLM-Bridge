import { lookup as dnsLookup } from 'node:dns/promises'
import { createRequire } from 'node:module'
import { isIP, type LookupFunction } from 'node:net'
import { networkInterfaces } from 'node:os'
import { Agent, fetch as undiciFetch } from 'undici'
import type { FetchedPage } from './protocol.js'

/**
 * Page fetch for the tab: a web page read from this computer, with the limits the RebeLLM
 * server's old fetch proxy had. Public http(s) addresses only, every hop checked and the
 * checked address dialled, no credentials, text types only, size, time and rate caps.
 */

export const MAX_BYTES = 2 * 2 ** 20
export const TIMEOUT_MS = 15_000
export const PER_MINUTE = 30
export const MAX_REDIRECTS = 5

const VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version
export const USER_AGENT = `rebellm-bridge/${VERSION}`

const TEXT_TYPES = /^(text\/[\w.+-]+|application\/(json|xml|[\w.-]+\+(json|xml)))$/
const REDIRECTS = new Set([301, 302, 303, 307, 308])
// Nothing of the user's: no cookies, no authorization, no referrer.
const HEADERS: Record<string, string> = {
  'user-agent': USER_AGENT,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/*;q=0.8,application/json;q=0.8,*/*;q=0.1',
}

export class PageFetchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PageFetchError'
  }
}

function v4(s: string): number | null {
  const p = s.split('.')
  if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x) || +x > 255)) return null
  return ((+p[0]! << 24) | (+p[1]! << 16) | (+p[2]! << 8) | +p[3]!) >>> 0
}

// Loopback, private, shared (CGNAT), link-local, documentation, benchmark, multicast, reserved.
const V4_BLOCKED = (
  [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const
).map(([a, bits]) => [v4(a)!, bits] as const)

const blockedV4 = (n: number) => V4_BLOCKED.some(([base, bits]) => n >>> (32 - bits) === base >>> (32 - bits))

/** The eight 16-bit groups of an IPv6 address, or null. */
function v6(s: string): number[] | null {
  let t = s
    .replace(/^\[|\]$/g, '')
    .split('%')[0]!
    .toLowerCase()
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(t)
  if (dotted) {
    const n = v4(dotted[1]!)
    if (n === null) return null
    t = `${t.slice(0, dotted.index)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`
  }
  const halves = t.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = 8 - head.length - tail.length
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...tail]
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null
  return groups.map((g) => parseInt(g, 16))
}

/**
 * False for every address a page fetch must not reach: loopback, private, link-local, CGNAT,
 * multicast, unspecified and reserved ranges, also inside IPv4-mapped, NAT64, 6to4 and Teredo
 * forms. Anything unparsable counts as not public.
 */
export function isPublicAddress(address: string): boolean {
  const a = address.replace(/^\[|\]$/g, '')
  if (isIP(a) === 4) return !blockedV4(v4(a)!)
  const g = v6(a)
  if (!g) return false
  const at = (i: number) => g[i]!
  const low = ((at(6) << 16) | at(7)) >>> 0
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0)
  // ::, ::1 and the old IPv4-compatible form.
  if (zero(0, 6)) return !blockedV4(low)
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-translated ::ffff:0:a.b.c.d.
  if (zero(0, 5) && at(5) === 0xffff) return !blockedV4(low)
  if (zero(0, 4) && at(4) === 0xffff && at(5) === 0) return !blockedV4(low)
  // NAT64: the well-known prefix carries an IPv4 address; the local-use one is private.
  if (at(0) === 0x64 && at(1) === 0xff9b) return zero(2, 6) && !blockedV4(low)
  // 6to4 embeds the IPv4 address after the prefix.
  if (at(0) === 0x2002) return !blockedV4(((at(1) << 16) | at(2)) >>> 0)
  // Teredo: the server address, and the client address stored inverted.
  if (at(0) === 0x2001 && at(1) === 0) return !blockedV4(((at(2) << 16) | at(3)) >>> 0) && !blockedV4(~low >>> 0)
  if (at(0) === 0x2001 && at(1) === 0xdb8) return false
  if (at(0) === 0x100 && zero(1, 4)) return false
  // Unique local, link-local, site-local, multicast.
  return !((at(0) & 0xfe00) === 0xfc00 || (at(0) & 0xffc0) === 0xfe80 || (at(0) & 0xffc0) === 0xfec0 || at(0) >= 0xff00)
}

/** One spelling per address: dotted IPv4 (also for mapped forms) or eight IPv6 groups, no zone. */
export function canonicalAddress(address: string): string | null {
  const a = address.replace(/^\[|\]$/g, '')
  if (isIP(a) === 4) return a
  const g = v6(a)
  if (!g) return null
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0)
  const mapped = zero(0, 6) || (zero(0, 5) && g[5] === 0xffff) || (zero(0, 4) && g[4] === 0xffff && g[5] === 0)
  if (mapped) return [g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff].join('.')
  return g.map((x) => x.toString(16)).join(':')
}

/** An address as eight 16-bit groups, IPv4 in its mapped form; null when unparsable. */
function groupsOf(address: string): number[] | null {
  const c = canonicalAddress(address)
  if (c === null) return null
  const n = v4(c)
  return n === null ? v6(c) : [0, 0, 0, 0, 0, 0xffff, n >>> 16, n & 0xffff]
}

interface Network {
  groups: number[]
  bits: number
}

/**
 * An address or CIDR as a network. Prefixes wider than /16 (IPv4) or /32 (IPv6) shrink to
 * the address itself: no real on-link network is that wide, and they would block the internet.
 */
export function networkOf(entry: string): Network | null {
  const [address = '', prefix] = entry.split('/')
  const groups = groupsOf(address)
  if (!groups) return null
  const isV4 = v4(canonicalAddress(address)!) !== null
  const bits = prefix === undefined ? 128 : Number(prefix) + (isV4 ? 96 : 0)
  const narrow = Number.isInteger(bits) && bits >= (isV4 ? 112 : 32) && bits <= 128
  return { groups, bits: narrow ? bits : 128 }
}

export function inNetwork(address: string, n: Network): boolean {
  const g = groupsOf(address)
  if (!g) return false
  for (let i = 0, left = n.bits; left > 0; i++, left -= 16) {
    const mask = left >= 16 ? 0xffff : (0xffff << (16 - left)) & 0xffff
    if ((g[i]! & mask) !== (n.groups[i]! & mask)) return false
  }
  return true
}

// Read per fetch: IPv6 privacy addresses rotate.
const interfaceNetworks = () =>
  Object.values(networkInterfaces()).flatMap((list) => (list ?? []).map((i) => i.cidr ?? i.address))

/** Settles like `p`, or rejects as soon as `signal` aborts. */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason)
    signal.addEventListener('abort', stop, { once: true })
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop))
  })
}

export interface Resolved {
  address: string
  family: number
}

export type Lookup = (host: string) => Promise<Resolved[]>

/** What a page fetch reads of an answer; undici's and the global Response fit. */
export interface Upstream {
  status: number
  headers: { get(name: string): string | null }
  body: ReadableStream<Uint8Array> | null
}

/** Requests `url` from the given, already checked address. */
export type Dial = (
  url: URL,
  o: { address: string; family: number; headers: Record<string, string>; signal: AbortSignal },
) => Promise<Upstream>

const systemLookup: Lookup = (host) => dnsLookup(host, { all: true, verbatim: true })

/**
 * One undici Agent whose every connection goes to the address checked for its host: the host
 * name stays the Host header and the TLS server name, and no second lookup can swap the address.
 */
export function checkedDialer(): { dial: Dial; close: () => Promise<void> } {
  const checked = new Map<string, Resolved>()
  const lookup: LookupFunction = (host, opts, cb) => {
    const a = checked.get(host)
    if (!a) return cb(Object.assign(new Error(`${host} was not checked`), { code: 'ENOTFOUND' }), '', 0)
    if (opts.all) return cb(null, [a])
    cb(null, a.address, a.family)
  }
  const agent = new Agent({ connect: { lookup } })
  return {
    dial: async (url, { address, family, headers, signal }) => {
      checked.set(url.hostname, { address, family })
      return undiciFetch(url, { headers, signal, redirect: 'manual', credentials: 'omit', dispatcher: agent })
    },
    close: () => agent.destroy(),
  }
}

function target(raw: string, base?: URL): URL {
  let u: URL
  try {
    u = new URL(raw, base)
  } catch {
    throw new PageFetchError('not a URL')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    throw new PageFetchError(`only http and https, not ${u.protocol}`)
  if (u.username || u.password) throw new PageFetchError('URLs with credentials are not fetched')
  u.hash = ''
  return u
}

async function resolve(url: URL, lookup: Lookup, local: Network[], signal: AbortSignal): Promise<Resolved> {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const family = isIP(host)
  const addrs = family
    ? [{ address: host, family }]
    : await untilAborted(
        lookup(host).catch(() => []),
        signal,
      )
  if (!addrs.length) throw new PageFetchError(`${host} does not resolve`)
  // One private answer is enough: the connection could pick it.
  // Public addresses on this computer's own networks reach the user's devices too.
  const refused = (a: string) => !isPublicAddress(a) || local.some((n) => inNetwork(a, n))
  if (addrs.some((a) => refused(a.address))) throw new PageFetchError(`${host} is not a public address`)
  return addrs[0]!
}

const mimeOf = (contentType: string) => (contentType.split(';')[0] ?? '').trim().toLowerCase()

function decode(bytes: Uint8Array, contentType: string) {
  const charset = /charset="?([\w-]+)"?/i.exec(contentType)?.[1] ?? 'utf-8'
  try {
    return new TextDecoder(charset).decode(bytes)
  } catch {
    return new TextDecoder().decode(bytes)
  }
}

async function readCapped(body: Upstream['body'], max: number) {
  const chunks: Uint8Array[] = []
  let size = 0
  let cut = false
  if (body)
    for await (const c of body) {
      if (size + c.length > max) {
        chunks.push(c.subarray(0, max - size))
        size = max
        cut = true
        // Leaving the loop cancels the rest of the body.
        break
      }
      chunks.push(c)
      size += c.length
    }
  return { bytes: Buffer.concat(chunks, size), cut }
}

const discard = (up: Upstream) => up.body?.cancel().catch(() => undefined)

export interface PageFetchOptions {
  lookup?: Lookup
  /** Tests hand in their own; one checkedDialer per fetch by default. */
  dial?: Dial
  /** This computer's addresses or CIDRs; the network interfaces by default. */
  ownAddresses?: () => string[]
  maxBytes?: number
  timeoutMs?: number
  signal?: AbortSignal
}

/** Reads one page for the tab; a non-2xx status comes back without its body, refusals throw a PageFetchError. */
export async function pageFetch(raw: string, o: PageFetchOptions = {}): Promise<FetchedPage> {
  const lookup = o.lookup ?? systemLookup
  const maxBytes = o.maxBytes ?? MAX_BYTES
  const timeoutMs = o.timeoutMs ?? TIMEOUT_MS
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout
  const own = o.dial ? null : checkedDialer()
  const dial = o.dial ?? own!.dial
  try {
    const local = (o.ownAddresses ?? interfaceNetworks)()
      .map(networkOf)
      .filter((n) => n !== null)
    let url = target(raw)
    for (let hop = 0; ; hop++) {
      const { address, family } = await resolve(url, lookup, local, signal)
      signal.throwIfAborted()
      const up = await dial(url, { address, family, headers: { ...HEADERS }, signal })
      const location = up.headers.get('location')
      if (REDIRECTS.has(up.status) && location) {
        await discard(up)
        if (hop === MAX_REDIRECTS) throw new PageFetchError(`more than ${MAX_REDIRECTS} redirects`)
        url = target(location, url)
        continue
      }
      const contentType = up.headers.get('content-type') ?? ''
      const type = mimeOf(contentType)
      if (up.status < 200 || up.status > 299) {
        await discard(up)
        return { status: up.status, type, finalUrl: url.href, text: '', cut: false }
      }
      if (!TEXT_TYPES.test(type)) {
        await discard(up)
        throw new PageFetchError(`${type || 'no content type'} is not a text type`)
      }
      const { bytes, cut } = await readCapped(up.body, maxBytes)
      return { status: up.status, type, finalUrl: url.href, text: decode(bytes, contentType), cut }
    }
  } catch (e) {
    if (timeout.aborted) throw new PageFetchError(`no answer within ${timeoutMs / 1000} s`)
    if (o.signal?.aborted) throw new PageFetchError('cancelled')
    if (e instanceof PageFetchError) throw e
    const cause = (e as Error & { cause?: unknown }).cause
    throw new PageFetchError(`could not fetch: ${cause instanceof Error ? cause.message : (e as Error).message}`)
  } finally {
    await own?.close()
  }
}

/** A token bucket: true while the tab stays within `perMinute` fetches, on average. */
export function rateLimit(perMinute = PER_MINUTE, now = Date.now) {
  let tokens = perMinute
  let at = now()
  return () => {
    const t = now()
    tokens = Math.min(perMinute, tokens + ((t - at) * perMinute) / 60_000)
    at = t
    if (tokens < 1) return false
    tokens -= 1
    return true
  }
}

const group = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

/** The request log line of one fetch: the host only, never the path, query or content. */
export function fetchLine(url: string, outcome: FetchedPage | string) {
  let host = '?'
  try {
    host = new URL(url).hostname || '?'
  } catch {
    // Not a URL; the outcome says so.
  }
  if (typeof outcome === 'string') return `fetch ${host}: error ${outcome}`
  const bytes = Buffer.byteLength(outcome.text)
  return `fetch ${host}: ${outcome.status}, ${group(bytes)} byte${bytes === 1 ? '' : 's'}${outcome.cut ? ', cut' : ''}`
}
