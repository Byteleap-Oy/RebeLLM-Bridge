import { request } from 'node:http'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { ChatRequest } from '../protocol.js'
import { FakeTab } from '../test/fake-tab.js'
import { TOKEN, bridge } from '../test/harness.js'

// Response bodies are checked by the assertions that read them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const user = (content: string) => ({ role: 'user', content })

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
      `chat ${id} /v1/messages: arrived, 12 prompt tokens, 1 tool`,
      `chat ${id} /v1/messages: queued at 2 +Ns`,
      `chat ${id} /v1/messages: first token +Ns`,
      `chat ${id} /v1/messages: done end_turn, 2 tokens, +Ns`,
    ])
    expect(b.lines.join('\n')).not.toMatch(/Capital|Hel|sinki/)
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
      `chat ${id} /v1/messages: arrived, 3 prompt tokens, 0 tools`,
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
      `chat ${first} /v1/messages: arrived, 1 prompt token, 0 tools`,
      `chat ${first} /v1/messages: refused 503 no RebeLLM tab connected +Ns`,
      `chat ${second} /v1/messages: arrived, 1 prompt token, 0 tools`,
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
