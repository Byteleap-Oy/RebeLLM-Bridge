import { pageFetch } from './pagefetch.js'
import type { FetchedPage } from './protocol.js'

/**
 * Web search for the Messages API's `web_search` server tool: DuckDuckGo's script-free
 * results page, read through the page fetch, so the same address checks and limits apply.
 */

export const SEARCH_URL = 'https://html.duckduckgo.com/html/'
// Few, short results: the tab reads them, and Claude Code puts them in its own context too.
export const MAX_RESULTS = 5
export const MAX_SNIPPET = 160
export const MAX_QUERY = 400

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

/** The Messages API's error codes for a failed search. */
export type SearchErrorCode = 'unavailable' | 'too_many_requests' | 'invalid_input' | 'query_too_long'

export class SearchError extends Error {
  readonly code: SearchErrorCode
  constructor(code: SearchErrorCode, message: string) {
    super(message)
    this.name = 'SearchError'
    this.code = code
  }
}

export interface SearchOptions {
  allowed?: string[]
  blocked?: string[]
  signal?: AbortSignal
}

export type WebSearch = (query: string, o?: SearchOptions) => Promise<SearchResult[]>

export type FetchPage = (url: string, signal?: AbortSignal) => Promise<FetchedPage>

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m
  })
}

const plain = (html: string) =>
  decodeEntities(html.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim()

const clip = (s: string) => (s.length > MAX_SNIPPET ? `${s.slice(0, MAX_SNIPPET - 1).trimEnd()}…` : s)

/** Where a result link leads; DuckDuckGo wraps it in `/l/?uddg=`, and its ads go through `/y.js`. */
export function resultTarget(href: string): string | null {
  let u: URL
  try {
    u = new URL(decodeEntities(href), 'https://duckduckgo.com')
    if (u.hostname === 'duckduckgo.com' || u.hostname.endsWith('.duckduckgo.com')) {
      const inner = u.pathname === '/l/' ? u.searchParams.get('uddg') : null
      if (!inner) return null
      u = new URL(inner)
    }
  } catch {
    return null
  }
  return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null
}

const ANCHOR = /<a\b([^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*)>([\s\S]*?)<\/a>/g
const SNIPPET = /<(a|div|td)\b[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/

/** The results of a DuckDuckGo HTML page, in order, each URL once. */
export function parseResults(html: string): SearchResult[] {
  const anchors = [...html.matchAll(ANCHOR)]
  const seen = new Set<string>()
  const out: SearchResult[] = []
  for (const [i, m] of anchors.entries()) {
    const href = /\bhref="([^"]*)"/.exec(m[1]!)?.[1]
    const url = href ? resultTarget(href) : null
    if (!url || seen.has(url)) continue
    seen.add(url)
    // A result's snippet sits between its title link and the next one.
    const rest = html.slice(m.index + m[0].length, anchors[i + 1]?.index ?? html.length)
    out.push({ title: plain(m[2]!), url, snippet: clip(plain(SNIPPET.exec(rest)?.[2] ?? '')) })
  }
  return out
}

/** `example.com` for `https://Example.com/path`; domain lists may carry either. */
const domainOf = (d: string) =>
  (
    d
      .trim()
      .replace(/^[a-z]+:\/\//i, '')
      .split('/')[0] ?? ''
  )
    .replace(/^\.+|\.+$/g, '')
    .toLowerCase()

/** True when `url`'s host is one of `domains` or under one. */
export function inDomains(url: string, domains: string[]): boolean {
  const host = new URL(url).hostname.toLowerCase()
  return domains.map(domainOf).some((d) => d && (host === d || host.endsWith(`.${d}`)))
}

/** DuckDuckGo's bot check, sent instead of results. */
const BOT_CHECK = /anomaly-modal|challenge-form/

/** A search from this computer; failures throw a SearchError with the API's error code. */
export function duckDuckGo(
  fetchPage: FetchPage = (url, signal) => pageFetch(url, signal ? { signal } : {}),
): WebSearch {
  return async (query, o = {}) => {
    const allowed = (o.allowed ?? []).map(domainOf).filter(Boolean)
    const blocked = o.blocked ?? []
    let q = query.trim()
    if (!q) throw new SearchError('invalid_input', 'the query is empty')
    if (q.length > MAX_QUERY) throw new SearchError('query_too_long', `the query is over ${MAX_QUERY} characters`)
    // One allowed domain narrows the search itself; more are only filtered.
    if (allowed.length === 1) q += ` site:${allowed[0]}`
    let page: FetchedPage
    try {
      page = await fetchPage(`${SEARCH_URL}?q=${encodeURIComponent(q)}`, o.signal)
    } catch (e) {
      throw new SearchError('unavailable', (e as Error).message)
    }
    // DuckDuckGo answers 202 when it throttles.
    if (page.status === 429 || page.status === 202) throw new SearchError('too_many_requests', `status ${page.status}`)
    if (page.status < 200 || page.status > 299) throw new SearchError('unavailable', `status ${page.status}`)
    const found = parseResults(page.text)
    if (!found.length && BOT_CHECK.test(page.text))
      throw new SearchError('too_many_requests', 'the search engine asked for a bot check')
    return found
      .filter((r) => (!allowed.length || inDomains(r.url, allowed)) && !(blocked.length && inDomains(r.url, blocked)))
      .slice(0, MAX_RESULTS)
  }
}

/** The results as the tab reads them in a `tool` message. */
export function resultsText(results: SearchResult[]): string {
  if (!results.length) return 'No results.'
  return results.map((r, i) => `${i + 1}. ${r.title}\n${r.url}${r.snippet ? `\n${r.snippet}` : ''}`).join('\n\n')
}
