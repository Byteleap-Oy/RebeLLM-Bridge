import { describe, expect, it } from 'vitest'
import type { FetchedPage } from './protocol.js'
import {
  MAX_QUERY,
  MAX_RESULTS,
  MAX_SNIPPET,
  SEARCH_URL,
  SearchError,
  decodeEntities,
  duckDuckGo,
  inDomains,
  parseResults,
  resultTarget,
  resultsText,
} from './websearch.js'

const wrap = (url: string) => `//duckduckgo.com/l/?uddg=${encodeURIComponent(url)}&amp;rut=abc`

const result = (url: string, title: string, snippet: string, extra = '') => `
<div class="result results_links results_links_deep web-result ${extra}">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="${url}">${title}</a>
    </h2>
    <div class="result__extras"><a class="result__url" href="${url}">host</a></div>
    <a class="result__snippet" href="${url}">${snippet}</a>
  </div>
</div>`

const PAGE = `<html><body><div id="links" class="results">
${result('//duckduckgo.com/y.js?ad_domain=shop.example&amp;u3=x', 'Buy now', 'An ad', 'result--ad')}
${result(wrap('https://www.hs.fi/'), 'Helsingin Sanomat - <b>Uutiset</b>', 'Suomen suurin &amp; luetuin <b>uutis</b>media&#x2E;')}
${result(wrap('https://www.hs.fi/kotimaa/'), 'Kotimaa | HS.fi', 'Kotimaan uutiset')}
${result(wrap('https://www.hs.fi/'), 'Helsingin Sanomat again', 'duplicate')}
${result(wrap('https://yle.fi/uutiset'), 'Yle Uutiset', '')}
${result('https://direct.example/page', 'Direct link', 'Not wrapped')}
${result(wrap('javascript:alert(1)'), 'Bad', 'Not http')}
</div></body></html>`

const page = (text: string, status = 200): FetchedPage => ({
  status,
  type: 'text/html',
  finalUrl: SEARCH_URL,
  text,
  cut: false,
})

describe('parseResults', () => {
  it('reads titles, targets and snippets, skipping ads, repeats and non-web links', () => {
    expect(parseResults(PAGE)).toEqual([
      {
        title: 'Helsingin Sanomat - Uutiset',
        url: 'https://www.hs.fi/',
        snippet: 'Suomen suurin & luetuin uutismedia.',
      },
      { title: 'Kotimaa | HS.fi', url: 'https://www.hs.fi/kotimaa/', snippet: 'Kotimaan uutiset' },
      { title: 'Yle Uutiset', url: 'https://yle.fi/uutiset', snippet: '' },
      { title: 'Direct link', url: 'https://direct.example/page', snippet: 'Not wrapped' },
    ])
  })

  it('clips long snippets', () => {
    const [r] = parseResults(result(wrap('https://a.example/'), 'A', 'word '.repeat(100)))
    expect(r!.snippet).toHaveLength(MAX_SNIPPET)
    expect(r!.snippet.endsWith('d…')).toBe(true)
  })

  it('finds nothing on a page without results', () => {
    expect(parseResults('<div class="no-results">No results.</div>')).toEqual([])
  })
})

describe('helpers', () => {
  it('decodes named and numeric entities, leaving unknown ones', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &#39;d&#x27; &nbsp;&bogus; &#0;')).toBe("a & b <c> 'd'  &bogus; &#0;")
  })

  it('unwraps redirect links and refuses the rest', () => {
    expect(resultTarget(wrap('https://a.example/x?y=1'))).toBe('https://a.example/x?y=1')
    expect(resultTarget('//duckduckgo.com/y.js?u3=x')).toBeNull()
    expect(resultTarget('//duckduckgo.com/l/')).toBeNull()
    expect(resultTarget('ftp://files.example/')).toBeNull()
    expect(resultTarget('http://[bad')).toBeNull()
  })

  it('matches a domain and its subdomains, not look-alikes', () => {
    expect(inDomains('https://www.hs.fi/a', ['hs.fi'])).toBe(true)
    expect(inDomains('https://hs.fi/', ['https://HS.fi/path'])).toBe(true)
    expect(inDomains('https://noths.fi/', ['hs.fi'])).toBe(false)
    expect(inDomains('https://a.example/', ['', 'b.example'])).toBe(false)
  })

  it('lists results for the tab', () => {
    expect(resultsText([])).toBe('No results.')
    expect(
      resultsText([
        { title: 'A', url: 'https://a.example/', snippet: 'about a' },
        { title: 'B', url: 'https://b.example/', snippet: '' },
      ]),
    ).toBe('1. A\nhttps://a.example/\nabout a\n\n2. B\nhttps://b.example/')
  })
})

describe('duckDuckGo', () => {
  it('asks for the query and filters by domain', async () => {
    const urls: string[] = []
    const search = duckDuckGo(async (url) => (urls.push(url), page(PAGE)))
    expect((await search('hs uutiset', { blocked: ['yle.fi', 'direct.example'] })).map((r) => r.url)).toEqual([
      'https://www.hs.fi/',
      'https://www.hs.fi/kotimaa/',
    ])
    expect((await search(' uutiset ', { allowed: ['https://hs.fi'] })).map((r) => r.url)).toEqual([
      'https://www.hs.fi/',
      'https://www.hs.fi/kotimaa/',
    ])
    expect((await search('x', { allowed: ['yle.fi', 'hs.fi'] })).length).toBe(3)
    expect(urls).toEqual([
      `${SEARCH_URL}?q=hs%20uutiset`,
      `${SEARCH_URL}?q=uutiset%20site%3Ahs.fi`,
      `${SEARCH_URL}?q=x`,
    ])
  })

  it('keeps at most five results', async () => {
    const many = Array.from({ length: 12 }, (_, i) => result(wrap(`https://r${i}.example/`), `R${i}`, '')).join('')
    expect(await duckDuckGo(async () => page(many))('many')).toHaveLength(MAX_RESULTS)
  })

  it('fails with the API’s error codes', async () => {
    const code = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: SearchError) => e.code,
      )
    const ok = duckDuckGo(async () => page(PAGE))
    expect(await code(ok('  '))).toBe('invalid_input')
    expect(await code(ok('x'.repeat(MAX_QUERY + 1)))).toBe('query_too_long')
    expect(
      await code(
        duckDuckGo(async () => {
          throw new Error('no answer within 15 s')
        })('q'),
      ),
    ).toBe('unavailable')
    expect(await code(duckDuckGo(async () => page('', 202))('q'))).toBe('too_many_requests')
    expect(await code(duckDuckGo(async () => page('', 429))('q'))).toBe('too_many_requests')
    expect(await code(duckDuckGo(async () => page('', 503))('q'))).toBe('unavailable')
    expect(await code(duckDuckGo(async () => page('<div class="anomaly-modal"></div>'))('q'))).toBe('too_many_requests')
    expect(await duckDuckGo(async () => page('<div class="no-results"></div>'))('q')).toEqual([])
  })

  it('passes the caller’s signal to the fetch', async () => {
    const ac = new AbortController()
    let got: AbortSignal | undefined
    await duckDuckGo(async (_url, signal) => ((got = signal), page(PAGE)))('q', { signal: ac.signal })
    expect(got).toBe(ac.signal)
  })
})
