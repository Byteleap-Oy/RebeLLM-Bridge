import { request } from 'node:http'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { compactShellOutput } from '../compact.js'
import type { ChatRequest } from '../protocol.js'
import { FakeTab } from '../test/fake-tab.js'
import { TOKEN, bridge } from '../test/harness.js'
import { SearchError } from '../websearch.js'

// Response bodies are checked by the assertions that read them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const user = (content: string | unknown[]) => ({ role: 'user', content })

const post = (base: string, body: unknown, path = '/v1/messages') =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'anything' },
    body: JSON.stringify(body),
  })

/** The events of an SSE body, checking each `event:` line names its data's type. */
async function events(r: Response): Promise<Json[]> {
  return (await r.text())
    .split('\n\n')
    .filter(Boolean)
    .map((e) => {
      const [name, data] = e.split('\n')
      const body = JSON.parse(data!.slice(6))
      expect(name).toBe(`event: ${body.type}`)
      return body
    })
}

const done = (tab: FakeTab, id: string, stop: 'eos' | 'tool_call' = 'eos') =>
  tab.send({ t: 'done', id, stop, usage: { prompt: 11, completion: 2, tokensPerSec: 1 } })

/** A ready tab whose context holds only `contextTokens`. */
async function smallTab(ws: string, contextTokens: number) {
  const tab = await FakeTab.open(ws, { token: TOKEN, contextTokens })
  onTestFinished(() => void tab.ws.terminate())
  await tab.next()
  tab.send({ t: 'status', state: 'ready', model: 'small' })
  return tab
}

describe('POST /v1/messages', () => {
  it('answers with one message from the tab’s model, whatever model was asked for', async () => {
    const b = await bridge()
    const tab = await b.tab('qwen')
    let seen: ChatRequest | null = null
    tab.onChat = (c) => {
      seen = c
      tab.answer(c.id, ['Hel', 'sinki'])
    }
    const r = await post(`${b.base}`, {
      model: 'claude-opus-5',
      max_tokens: 50,
      temperature: 0.2,
      system: 'One word.',
      messages: [user('Capital of Finland?')],
    })
    expect(r.status).toBe(200)
    const body: Json = await r.json()
    expect(body).toEqual({
      id: expect.stringMatching(/^msg_[0-9a-f]{24}$/),
      type: 'message',
      role: 'assistant',
      model: 'qwen',
      content: [{ type: 'text', text: 'Helsinki' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 7, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    })
    expect(seen).toMatchObject({
      messages: [
        { role: 'system', content: 'One word.' },
        { role: 'user', content: 'Capital of Finland?' },
      ],
      maxTokens: 50,
      temperature: 0.2,
    })
  })

  it('streams the documented events, with pings while the tab is slow', async () => {
    const b = await bridge({ keepAliveMs: 20 })
    const tab = await b.tab('qwen')
    tab.onChat = (c) => setTimeout(() => tab.answer(c.id, ['Hel', 'lo'], 'length'), 120)
    // Claude Code adds ?beta=true.
    const r = await post(b.base, { max_tokens: 2, stream: true, messages: [user('hi')] }, '/v1/messages?beta=true')
    expect(r.headers.get('content-type')).toContain('text/event-stream')
    const all = await events(r)
    expect(all.filter((e) => e.type === 'ping').length).toBeGreaterThan(0)
    const rest = all.filter((e) => e.type !== 'ping')
    expect(rest).toEqual([
      {
        type: 'message_start',
        message: {
          id: expect.stringMatching(/^msg_/),
          type: 'message',
          role: 'assistant',
          model: 'qwen',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'max_tokens', stop_sequence: null },
        usage: { input_tokens: 7, output_tokens: 2 },
      },
      { type: 'message_stop' },
    ])
  })

  it('returns tool calls as tool_use blocks and maps the result back', async () => {
    const b = await bridge()
    const tab = await b.tab()
    const chats: ChatRequest[] = []
    tab.onChat = (c) => {
      chats.push(c)
      if (chats.length === 1) {
        tab.send({
          t: 'tool_call',
          id: c.id,
          calls: [{ id: `${c.id}-call-1`, function: { name: 'Read', arguments: { file_path: 'a.ts' } } }],
        })
        done(tab, c.id, 'tool_call')
      } else tab.answer(c.id, ['It exports nothing.'])
    }
    const tools = [{ name: 'Read', description: 'Reads a file', input_schema: { type: 'object' } }]
    const first: Json = await (
      await post(b.base, { max_tokens: 99, tools, messages: [user('What is in a.ts?')] })
    ).json()
    expect(chats[0]?.tools).toEqual([
      { type: 'function', function: { name: 'Read', description: 'Reads a file', parameters: { type: 'object' } } },
    ])
    expect(first.stop_reason).toBe('tool_use')
    expect(first.content).toEqual([
      { type: 'tool_use', id: expect.stringMatching(/-call-1$/), name: 'Read', input: { file_path: 'a.ts' } },
    ])
    const call = first.content[0]
    const second: Json = await (
      await post(b.base, {
        max_tokens: 99,
        tools,
        messages: [
          user('What is in a.ts?'),
          { role: 'assistant', content: first.content },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'export {}' }] },
        ],
      })
    ).json()
    expect(second.content).toEqual([{ type: 'text', text: 'It exports nothing.' }])
    expect(chats[1]?.messages.slice(1)).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: call.id, function: { name: 'Read', arguments: { file_path: 'a.ts' } } }],
      },
      { role: 'tool', content: 'export {}', name: 'Read' },
    ])
  })

  it('stops at a stop sequence split across tokens and aborts the tab’s chat', async () => {
    const b = await bridge()
    const tab = await b.tab()
    const body = { max_tokens: 99, stop_sequences: ['END'], messages: [user('go')] }
    const streamed = post(b.base, { ...body, stream: true })
    let chat = await tab.nextChat()
    tab.send({ t: 'token', id: chat.id, text: 'ok E' })
    tab.send({ t: 'token', id: chat.id, text: 'ND more' })
    expect(await tab.next((m) => m.t === 'abort')).toEqual({ t: 'abort', id: chat.id })
    const all = await events(await streamed)
    expect(all.filter((e) => e.type === 'content_block_delta').map((e) => e.delta.text)).toEqual(['ok '])
    expect(all.find((e) => e.type === 'message_delta')).toEqual({
      type: 'message_delta',
      delta: { stop_reason: 'stop_sequence', stop_sequence: 'END' },
      usage: { input_tokens: 1, output_tokens: 2 },
    })

    const plain = post(b.base, body)
    chat = await tab.nextChat()
    tab.send({ t: 'token', id: chat.id, text: 'fine END' })
    const msg: Json = await (await plain).json()
    expect(msg).toMatchObject({
      content: [{ type: 'text', text: 'fine ' }],
      stop_reason: 'stop_sequence',
      stop_sequence: 'END',
    })
  })

  it('sends held stop-sequence text before a tool call and matches no sequence across one', async () => {
    const b = await bridge()
    const tab = await b.tab()
    const read = { name: 'Read', input_schema: { type: 'object' } }
    const body = { max_tokens: 99, stop_sequences: ['END'], tools: [read], messages: [user('go')] }
    const call = (id: string) =>
      tab.send({ t: 'tool_call', id, calls: [{ id: `${id}-c`, function: { name: 'Read', arguments: {} } }] })
    tab.onChat = (c) => {
      tab.send({ t: 'token', id: c.id, text: 'Reading E' })
      call(c.id)
      tab.send({ t: 'token', id: c.id, text: 'ND' })
      done(tab, c.id, 'tool_call')
    }
    const all = await events(await post(b.base, { ...body, stream: true }))
    const starts = all.filter((e) => e.type === 'content_block_start').map((e) => e.content_block.type)
    expect(starts).toEqual(['text', 'tool_use', 'text'])
    expect(all.filter((e) => e.delta?.type === 'text_delta').map((e) => e.delta.text)).toEqual(['Reading ', 'E', 'ND'])
    expect(all.find((e) => e.type === 'message_delta').delta).toEqual({ stop_reason: 'tool_use', stop_sequence: null })
    const msg: Json = await (await post(b.base, body)).json()
    expect(msg).toMatchObject({
      content: [{ type: 'text', text: 'Reading END' }, { type: 'tool_use' }],
      stop_reason: 'tool_use',
    })
  })

  it('aborts the chat when the client goes away', async () => {
    const b = await bridge()
    const tab = await b.tab()
    const ctl = new AbortController()
    const req = fetch(`${b.base}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ max_tokens: 9, stream: true, messages: [user('long story')] }),
      signal: ctl.signal,
    }).catch(() => null)
    const chat = await tab.nextChat()
    tab.send({ t: 'token', id: chat.id, text: 'Once' })
    await new Promise((r) => setTimeout(r, 50))
    ctl.abort()
    await req
    expect(await tab.next((m) => m.t === 'abort')).toEqual({ t: 'abort', id: chat.id })
  })

  it('answers 503 in Anthropic’s shape when no tab or model is ready after the wait', async () => {
    const b = await bridge({ waitMs: 50 })
    let r = await post(b.base, { max_tokens: 9, stream: true, messages: [user('hi')] })
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({ type: 'error', error: { type: 'api_error', message: 'no RebeLLM tab connected' } })
    const tab = await b.tab(null)
    tab.send({ t: 'status', state: 'unavailable', detail: 'Serve only: this machine loads no model' })
    r = await post(b.base, { max_tokens: 9, messages: [user('hi')] })
    expect(await r.json()).toEqual({
      type: 'error',
      error: { type: 'api_error', message: 'model unavailable: Serve only: this machine loads no model' },
    })
  })

  it('answers 400 "prompt is too long" by its estimate and when the tab says so', async () => {
    const b = await bridge()
    const tab = await smallTab(b.ws, 20)
    let r = await post(b.base, { max_tokens: 9, messages: [user('x'.repeat(70))] })
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'prompt is too long: 20 tokens > 19 maximum' },
    })
    tab.onChat = (c) =>
      tab.send({ t: 'error', id: c.id, message: "The prompt needs 25 tokens; the tab's context holds 20" })
    expect(b.requests()[1]).toMatch(/: refused 400 prompt is too long: 20 tokens > 19 maximum \+Ns$/)
    r = await post(b.base, { max_tokens: 9, messages: [user('x'.repeat(60))] })
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ error: { message: 'prompt is too long: 25 tokens > 20 maximum' } })
    const all = await events(await post(b.base, { stream: true, messages: [user('x'.repeat(60))] }))
    expect(all.at(-1)).toEqual({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'prompt is too long: 25 tokens > 20 maximum' },
    })
  })

  it('keeps a slow plain answer busy with spaces before its JSON; a quick one has none', async () => {
    const b = await bridge({ keepAliveMs: 20 })
    const tab = await b.tab('qwen')
    let delayMs = 150
    tab.onChat = (c) => setTimeout(() => tab.answer(c.id, ['late']), delayMs)
    const slow = await post(b.base, { max_tokens: 5, messages: [user('hi')] })
    expect(slow.status).toBe(200)
    expect(slow.headers.get('content-type')).toContain('application/json')
    const text = await slow.text()
    expect(text).toMatch(/^ {2,}\{/)
    expect(JSON.parse(text)).toMatchObject({ type: 'message', content: [{ type: 'text', text: 'late' }] })
    delayMs = 0
    const quick = await (await post(b.base, { max_tokens: 5, messages: [user('hi')] })).text()
    expect(quick.startsWith('{')).toBe(true)
  })

  it('a tab failure after the spaces began ends the 200 body with the error object', async () => {
    const b = await bridge({ keepAliveMs: 20 })
    const tab = await b.tab('qwen')
    tab.onChat = (c) => setTimeout(() => tab.send({ t: 'error', id: c.id, message: 'out of memory' }), 150)
    const r = await post(b.base, { max_tokens: 5, messages: [user('hi')] })
    expect(r.status).toBe(200)
    expect(JSON.parse(await r.text())).toEqual({
      type: 'error',
      error: { type: 'api_error', message: 'out of memory' },
    })
  })

  it('answers 502 when the tab fails, and ends a stream with an error event', async () => {
    const b = await bridge()
    const tab = await b.tab()
    tab.onChat = (c) => {
      tab.send({ t: 'token', id: c.id, text: 'Par' })
      tab.send({ t: 'error', id: c.id, message: 'out of memory' })
    }
    const r = await post(b.base, { max_tokens: 9, messages: [user('x')] })
    expect(r.status).toBe(502)
    expect(await r.json()).toEqual({ type: 'error', error: { type: 'api_error', message: 'out of memory' } })
    const all = await events(await post(b.base, { max_tokens: 9, stream: true, messages: [user('x')] }))
    expect(all.at(-1)).toEqual({ type: 'error', error: { type: 'api_error', message: 'out of memory' } })
    tab.onChat = () => tab.ws.terminate()
    const gone = await post(b.base, { max_tokens: 9, messages: [user('x')] })
    expect(await gone.json()).toEqual({
      type: 'error',
      error: { type: 'api_error', message: 'the RebeLLM tab disconnected' },
    })
    expect(b.requests().filter((l) => l.includes(': error '))).toEqual([
      expect.stringMatching(/ \/v1\/messages: error the tab reported: out of memory \+Ns$/),
      expect.stringMatching(/ \/v1\/messages: error the tab reported: out of memory \+Ns$/),
      expect.stringMatching(/ \/v1\/messages: error the RebeLLM tab disconnected \+Ns$/),
    ])
  })

  it('answers bad requests, other methods and unknown routes in Anthropic’s shape', async () => {
    const b = await bridge()
    let r = await fetch(`${b.base}/v1/messages`, { method: 'POST', body: 'not json' })
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'the body is not JSON' },
    })
    r = await post(b.base, { max_tokens: 9, messages: [] })
    expect(await r.json()).toMatchObject({
      error: { type: 'invalid_request_error', message: 'messages must be a non-empty array' },
    })
    r = await fetch(`${b.base}/v1/messages`)
    expect(r.status).toBe(405)
    r = await post(b.base, {}, '/v1/messages/batches')
    expect(r.status).toBe(404)
    expect(await r.json()).toMatchObject({ type: 'error', error: { type: 'not_found_error' } })
  })

  it('refuses web pages and foreign hosts in Anthropic’s shape, before the tab sees anything', async () => {
    const b = await bridge()
    const tab = await b.tab()
    const r = await fetch(`${b.base}/v1/messages`, {
      method: 'POST',
      headers: { Origin: 'https://example.com' },
      body: JSON.stringify({ max_tokens: 9, messages: [user('hi')] }),
    })
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({
      type: 'error',
      error: { type: 'permission_error', message: 'the bridge answers local clients only' },
    })
    const rebound = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        `${b.base}/v1/messages`,
        { method: 'POST', headers: { Host: 'evil.example:7343' } },
        (res) => {
          let body = ''
          res.on('data', (c) => (body += c))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
        },
      )
      req.on('error', reject)
      req.end(JSON.stringify({ max_tokens: 9, messages: [user('hi')] }))
    })
    expect(rebound.status).toBe(403)
    expect(JSON.parse(rebound.body)).toMatchObject({ error: { type: 'permission_error' } })
    await expect(tab.nextChat(100)).rejects.toThrow('no matching frame')
  })
})

describe('web search', () => {
  const WEB = { type: 'web_search_20250305', name: 'web_search' }
  const HS = [{ title: 'HS', url: 'https://www.hs.fi/', snippet: 'Uutiset' }]

  /** A tab that searches with each of `queries` in turn, one call per round, then answers. */
  function searcher(tab: FakeTab, queries: string[][], answer = 'Headlines: ...') {
    const chats: ChatRequest[] = []
    tab.onChat = (c) => {
      const round = queries[chats.push(c) - 1]
      if (!round) return tab.answer(c.id, [answer])
      tab.send({
        t: 'tool_call',
        id: c.id,
        calls: round.map((query, i) => ({
          id: `${c.id}-s${i}`,
          function: { name: 'web_search', arguments: { query } },
        })),
      })
      done(tab, c.id, 'tool_call')
    }
    return chats
  }

  it('runs the tab’s search, gives it the results and returns the blocks Anthropic would', async () => {
    const asked: [string, unknown][] = []
    const b = await bridge({ search: async (q, o) => (asked.push([q, o?.allowed]), HS) })
    const tab = await b.tab()
    const chats = searcher(tab, [['hs.fi uutiset']])
    const tools = [{ ...WEB, allowed_domains: ['hs.fi'] }]
    const msg: Json = await (await post(b.base, { max_tokens: 99, tools, messages: [user('News?')] })).json()
    expect(asked).toEqual([['hs.fi uutiset', ['hs.fi']]])
    expect(msg.content).toEqual([
      {
        type: 'server_tool_use',
        id: expect.stringMatching(/^srvtoolu_/),
        name: 'web_search',
        input: { query: 'hs.fi uutiset' },
      },
      {
        type: 'web_search_tool_result',
        tool_use_id: msg.content[0].id,
        content: [
          { type: 'web_search_result', url: 'https://www.hs.fi/', title: 'HS', encrypted_content: '', page_age: null },
        ],
      },
      { type: 'text', text: 'Headlines: ...' },
    ])
    expect(msg.stop_reason).toBe('end_turn')
    expect(msg.usage).toMatchObject({ output_tokens: 3, server_tool_use: { web_search_requests: 1 } })
    expect(chats[0]?.tools?.map((t) => t.function.name)).toEqual(['web_search'])
    expect(chats[1]?.messages.slice(1)).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: expect.stringMatching(/-s0$/),
            function: { name: 'web_search', arguments: { query: 'hs.fi uutiset' } },
          },
        ],
      },
      { role: 'tool', name: 'web_search', content: '1. HS\nhttps://www.hs.fi/\nUutiset' },
    ])
    const id = msg.id
    expect(b.requests()).toEqual([
      expect.stringMatching(/\/v1\/messages: arrived, 32 prompt tokens \(system 0, tools \d+, messages \d+\), 1 tool$/),
      `chat ${id} /v1/messages: first token +Ns`,
      `chat ${id} /v1/messages: search 1 result +Ns`,
      `chat ${id} /v1/messages: done end_turn, 3 tokens, +Ns`,
    ])
    expect(b.lines.join('\n')).not.toMatch(/uutiset/)
  })

  it('streams the search blocks between the text', async () => {
    const b = await bridge({ search: async () => HS })
    const tab = await b.tab()
    searcher(tab, [['hs']])
    const all = await events(
      await post(b.base, { max_tokens: 99, stream: true, tools: [WEB], messages: [user('News?')] }),
    )
    const starts = all.filter((e) => e.type === 'content_block_start').map((e) => e.content_block.type)
    expect(starts).toEqual(['server_tool_use', 'web_search_tool_result', 'text'])
    expect(all.find((e) => e.type === 'message_delta').usage).toMatchObject({
      server_tool_use: { web_search_requests: 1 },
    })
  })

  it('tells the tab when a search fails, and the client why', async () => {
    const b = await bridge({
      search: async () => {
        throw new SearchError('unavailable', 'no answer within 15 s')
      },
    })
    const tab = await b.tab()
    const chats = searcher(tab, [['hs']], 'Could not search.')
    const msg: Json = await (await post(b.base, { max_tokens: 99, tools: [WEB], messages: [user('News?')] })).json()
    expect(msg.content[1].content).toEqual({ type: 'web_search_tool_result_error', error_code: 'unavailable' })
    expect(msg.content[2]).toEqual({ type: 'text', text: 'Could not search.' })
    expect(msg.usage).not.toHaveProperty('server_tool_use')
    expect(chats[1]?.messages.at(-1)).toEqual({
      role: 'tool',
      name: 'web_search',
      content: 'Error: the search failed (unavailable); answer without it.',
    })
    expect(b.requests()).toContain(`chat ${msg.id} /v1/messages: search error unavailable +Ns`)
  })

  it('stops searching at max_uses and then offers no search tool', async () => {
    let searches = 0
    const b = await bridge({ search: async () => (searches++, HS) })
    const tab = await b.tab()
    const chats = searcher(tab, [['a', 'b']])
    const tools = [{ name: 'Read' }, { ...WEB, max_uses: 1 }]
    const msg: Json = await (await post(b.base, { max_tokens: 99, tools, messages: [user('News?')] })).json()
    expect(searches).toBe(1)
    expect(msg.content.map((c: Json) => c.type)).toEqual([
      'server_tool_use',
      'web_search_tool_result',
      'server_tool_use',
      'web_search_tool_result',
      'text',
    ])
    expect(msg.content[3].content).toEqual({ type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' })
    expect(chats[1]?.tools?.map((t) => t.function.name)).toEqual(['Read'])
    expect(chats[1]?.messages.at(-1)?.content).toBe('Error: no searches left; answer with what you have.')
  })

  it('ends the answer when the tab keeps searching with no search tool offered', async () => {
    const b = await bridge({ search: async () => HS })
    const tab = await b.tab()
    const chats = searcher(tab, [['a'], ['b'], ['c']])
    const tools = [{ ...WEB, max_uses: 1 }]
    const msg: Json = await (await post(b.base, { max_tokens: 99, tools, messages: [user('x')] })).json()
    expect(chats).toHaveLength(2)
    expect(chats[1]).not.toHaveProperty('tools')
    expect(msg.stop_reason).toBe('end_turn')
    expect(msg.content.at(-1).content).toEqual({
      type: 'web_search_tool_result_error',
      error_code: 'max_uses_exceeded',
    })
  })

  it('ends with the client’s tool calls when the tab asks for both', async () => {
    const b = await bridge({ search: async () => HS })
    const tab = await b.tab()
    let chats = 0
    tab.onChat = (c) => {
      chats++
      tab.send({
        t: 'tool_call',
        id: c.id,
        calls: [
          { id: 's', function: { name: 'web_search', arguments: { query: 'hs' } } },
          { id: 'r', function: { name: 'Read', arguments: { file_path: 'a.ts' } } },
        ],
      })
      done(tab, c.id, 'tool_call')
    }
    const tools = [{ name: 'Read' }, WEB]
    const msg: Json = await (await post(b.base, { max_tokens: 99, tools, messages: [user('x')] })).json()
    expect(chats).toBe(1)
    expect(msg.stop_reason).toBe('tool_use')
    expect(msg.content.map((c: Json) => c.type)).toEqual(['server_tool_use', 'web_search_tool_result', 'tool_use'])
  })
})

describe('request log', () => {
  /** The id of the first request line. */
  const idOf = (lines: string[]) => lines[0]?.split(' ')[1]

  it('logs a streamed answer from arrival to end, never its content', async () => {
    const b = await bridge()
    const tab = await b.tab()
    tab.onChat = (c) => {
      tab.send({ t: 'queued', id: c.id, position: 2 })
      tab.answer(c.id, ['Hel', 'sinki'])
    }
    const tools = [{ name: 'Read', input_schema: { type: 'object' } }]
    const all = await events(
      await post(b.base, { max_tokens: 9, stream: true, tools, messages: [user('Capital of Finland?')] }),
    )
    const id = all[0].message.id
    // 19 + 'Read' + '{"type":"object"}' = 40 chars
    expect(b.requests()).toEqual([
      `chat ${id} /v1/messages: arrived, 12 prompt tokens (system 0, tools 6, messages 6), 1 tool`,
      `chat ${id} /v1/messages: queued at 2 +Ns`,
      `chat ${id} /v1/messages: first token +Ns`,
      `chat ${id} /v1/messages: done end_turn, 2 tokens, +Ns`,
    ])
    expect(b.lines.join('\n')).not.toMatch(/Capital|Hel|sinki/)
  })

  it('logs what the tab did not get, never its content', async () => {
    const b = await bridge()
    const tab = await b.tab()
    tab.onChat = (c) => tab.answer(c.id, ['ok'])
    const r = await post(b.base, {
      max_tokens: 9,
      tool_choice: { type: 'tool', name: 'Read' },
      tools: [
        { name: 'Read', input_schema: { type: 'object' } },
        { type: 'web_fetch_20250910', name: 'web_fetch' },
      ],
      messages: [
        user([
          { type: 'text', text: 'Secret text' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'c2VjcmV0' } },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'c2VjcmV0' } },
          { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'secret doc' } },
        ]),
      ],
    })
    expect(r.status).toBe(200)
    const lines = b.requests()
    expect(lines[1]).toBe(
      `chat ${idOf(lines)} /v1/messages: ignored 2 image blocks, 1 document block, tool_choice tool Read, ` +
        'server tool web_fetch_20250910',
    )
    expect(b.lines.join('\n')).not.toMatch(/Secret|c2VjcmV0|secret doc/)
    // Nothing ignored, no line.
    await post(b.base, { max_tokens: 9, messages: [user('hi')] })
    expect(
      b
        .requests()
        .slice(lines.length)
        .filter((l) => l.includes('ignored')),
    ).toEqual([])
  })

  it('logs the shell output it shortened, never the output', async () => {
    const b = await bridge()
    const tab = await b.tab()
    tab.onChat = (c) => tab.answer(c.id, ['ok'])
    const output = Array.from({ length: 400 }, (_, i) => `secret line ${i + 1}`).join('\n')
    const r = await post(b.base, {
      max_tokens: 9,
      tools: [{ name: 'Bash', input_schema: { type: 'object' } }],
      messages: [
        user('list'),
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -R' } }] },
        user([{ type: 'tool_result', tool_use_id: 't1', content: output }]),
      ],
    })
    expect(r.status).toBe(200)
    const lines = b.requests()
    const short = compactShellOutput(output).length
    const group = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
    expect(short).toBeLessThan(output.length / 2)
    expect(lines[1]).toBe(
      `chat ${idOf(lines)} /v1/messages: compacted 1 tool result, ${group(output.length)} chars to ${group(short)}`,
    )
    expect(b.lines.join('\n')).not.toMatch(/secret/)
  })

  it('logs a client that gives up while the tab is still prefilling', async () => {
    const b = await bridge()
    const tab = await b.tab()
    const ctl = new AbortController()
    const req = fetch(`${b.base}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ max_tokens: 9, stream: true, messages: [user('long story')] }),
      signal: ctl.signal,
    }).catch(() => null)
    const chat = await tab.nextChat()
    tab.send({ t: 'queued', id: chat.id, position: 1 })
    await vi.waitFor(() => expect(b.requests()).toHaveLength(2))
    ctl.abort()
    await req
    await vi.waitFor(() => expect(b.requests()).toHaveLength(3))
    const id = idOf(b.requests())
    expect(b.requests()).toEqual([
      `chat ${id} /v1/messages: arrived, 3 prompt tokens (system 0, tools 0, messages 3), 0 tools`,
      `chat ${id} /v1/messages: queued at 1 +Ns`,
      `chat ${id} /v1/messages: client aborted +Ns`,
    ])
  })

  it('logs a refusal when no tab or model is ready after the wait', async () => {
    const b = await bridge({ waitMs: 50 })
    expect((await post(b.base, { max_tokens: 9, messages: [user('hi')] })).status).toBe(503)
    const tab = await b.tab(null)
    tab.send({ t: 'status', state: 'loading' })
    expect((await post(b.base, { max_tokens: 9, stream: true, messages: [user('hi')] })).status).toBe(503)
    const lines = b.requests()
    const [first, second] = [idOf(lines), idOf(lines.slice(2))]
    expect(first).not.toBe(second)
    expect(lines).toEqual([
      `chat ${first} /v1/messages: arrived, 1 prompt token (system 0, tools 0, messages 1), 0 tools`,
      `chat ${first} /v1/messages: refused 503 no RebeLLM tab connected +Ns`,
      `chat ${second} /v1/messages: arrived, 1 prompt token (system 0, tools 0, messages 1), 0 tools`,
      `chat ${second} /v1/messages: refused 503 model loading +Ns`,
    ])
  })
})

describe('POST /v1/messages/count_tokens', () => {
  it('estimates the prompt without a tab', async () => {
    const b = await bridge()
    const r = await post(
      b.base,
      {
        model: 'claude-opus-5',
        system: 'x'.repeat(10),
        messages: [user('y'.repeat(25))],
        tools: [{ name: 'Read', input_schema: { type: 'object' } }],
      },
      '/v1/messages/count_tokens?beta=true',
    )
    expect(r.status).toBe(200)
    // 10 + 25 + 'Read' + '{"type":"object"}' = 56 chars
    expect(await r.json()).toEqual({ input_tokens: 16 })
    const bad = await post(b.base, { messages: 'hi' }, '/v1/messages/count_tokens')
    expect(bad.status).toBe(400)
  })
})
