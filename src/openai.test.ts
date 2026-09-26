import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { completion, toChatInput } from './openai.js'
import type { ChatRequest } from './protocol.js'
import { bridge } from './test/harness.js'

// Response bodies are checked by the assertions that read them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
const json = async (r: Response | Promise<Response>): Promise<Json> => (await r).json()

const post = (base: string, body: unknown) =>
  fetch(`${base}/v1/chat/completions`, { method: 'POST', body: JSON.stringify(body) })

/** The `data:` payloads of an SSE body. */
async function sse(r: Response) {
  return (await r.text())
    .split('\n\n')
    .filter((e) => e.startsWith('data: '))
    .map((e) => e.slice(6))
}

const user = (content: string) => ({ role: 'user', content })

describe('toChatInput', () => {
  it('maps roles, content parts and tool results onto the tab protocol', () => {
    const r = toChatInput({
      model: 'ignored',
      messages: [
        { role: 'developer', content: 'Be brief.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is here?' },
            { type: 'image_url', image_url: {} },
          ],
        },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'look', arguments: '{"at":"desk"}' } }],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'a cup' },
      ],
      max_tokens: 100,
      temperature: 0,
      stream: true,
      stream_options: { include_usage: true },
    })
    expect(r).toEqual({
      input: {
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'What is here?\n[image_url omitted]' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'c1', function: { name: 'look', arguments: { at: 'desk' } } }],
          },
          { role: 'tool', content: 'a cup', name: 'look' },
        ],
        maxTokens: 100,
        temperature: 0,
      },
      stream: true,
      includeUsage: true,
    })
  })

  it('forwards tools with defaults, unless tool_choice is none', () => {
    const tools = [{ type: 'function', function: { name: 'now' } }]
    const r = toChatInput({ messages: [user('time?')], tools, max_completion_tokens: 5 })
    expect(r).toMatchObject({
      input: {
        tools: [
          {
            type: 'function',
            function: { name: 'now', description: '', parameters: { type: 'object', properties: {} } },
          },
        ],
        maxTokens: 5,
      },
      stream: false,
    })
    expect(toChatInput({ messages: [user('x')], tools, tool_choice: 'none' })).not.toHaveProperty('input.tools')
  })

  it('says what is wrong with a bad request', () => {
    const bad: [unknown, string][] = [
      [[], 'JSON object'],
      [{}, '`messages`'],
      [{ messages: [] }, '`messages`'],
      [{ messages: ['hi'] }, 'messages[0] must be an object'],
      [{ messages: [{ role: 'function', content: 'x' }] }, 'is not supported'],
      [{ messages: [{ role: 'user', content: 5 }] }, 'content'],
      [
        { messages: [{ role: 'assistant', content: '', tool_calls: [{ function: { name: 'f', arguments: '{' } }] }] },
        'JSON object',
      ],
      [{ messages: [user('x')], tools: [{ type: 'function' }] }, 'tools[0]'],
      [{ messages: [user('x')], tools: {} }, '`tools`'],
      [{ messages: [user('x')], max_tokens: 0 }, '`max_tokens`'],
      [{ messages: [user('x')], temperature: -1 }, '`temperature`'],
    ]
    for (const [body, part] of bad) expect((toChatInput(body) as { error: string }).error).toContain(part)
  })
})

describe('completion', () => {
  it('shapes an answer with tool calls like OpenAI', () => {
    const r = completion(
      {
        id: 'x',
        text: '',
        calls: [{ id: 'x-call-1', function: { name: 'f', arguments: { a: 1 } } }],
        stop: 'tool_call',
        usage: { prompt: 5, completion: 3, tokensPerSec: 9 },
      },
      { id: 'chatcmpl-1', created: 1, model: 'm' },
    )
    expect(r.choices[0]).toEqual({
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'x-call-1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }],
      },
      finish_reason: 'tool_calls',
    })
    expect(r.usage).toEqual({ prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 })
  })
})

describe('/v1/chat/completions', () => {
  it('answers with one completion and passes max_tokens and temperature', async () => {
    const b = await bridge()
    const tab = await b.tab('qwen')
    let seen: ChatRequest | null = null
    tab.onChat = (c) => {
      seen = c
      tab.answer(c.id, ['Hello', ' there'], 'length')
    }
    const r = await post(b.base, { model: 'gpt-4o', messages: [user('hi')], max_tokens: 2, temperature: 0.5 })
    expect(r.status).toBe(200)
    const body = await json(r)
    expect(body).toMatchObject({
      object: 'chat.completion',
      model: 'qwen',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hello there' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
    })
    expect(body.id).toMatch(/^chatcmpl-/)
    expect(seen).toMatchObject({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 2, temperature: 0.5 })
  })

  it('streams a chunk per token and ends with [DONE]', async () => {
    const b = await bridge()
    const tab = await b.tab()
    tab.onChat = (c) => tab.answer(c.id, ['Hel', 'lo'])
    const r = await post(b.base, { messages: [user('hi')], stream: true, stream_options: { include_usage: true } })
    expect(r.headers.get('content-type')).toContain('text/event-stream')
    const data = await sse(r)
    expect(data.at(-1)).toBe('[DONE]')
    const chunks = data.slice(0, -1).map((d) => JSON.parse(d))
    expect(chunks.map((c) => c.choices[0]?.delta)).toEqual([
      { role: 'assistant', content: '' },
      { content: 'Hel' },
      { content: 'lo' },
      {},
      undefined,
    ])
    expect(chunks[3].choices[0].finish_reason).toBe('stop')
    expect(chunks[4]).toMatchObject({ choices: [], usage: { total_tokens: 9 } })
    expect(chunks.every((c) => c.object === 'chat.completion.chunk' && c.id === chunks[0].id)).toBe(true)
  })

  it('keeps a stream alive with comments while the tab is slow', async () => {
    const b = await bridge({ keepAliveMs: 20 })
    const tab = await b.tab()
    tab.onChat = (c) => setTimeout(() => tab.answer(c.id, ['late']), 120)
    const text = await (await post(b.base, { messages: [user('hi')], stream: true })).text()
    expect(text).toContain('\n\n: keep-alive\n\n')
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true)
  })

  it('round-trips a tool call', async () => {
    const b = await bridge()
    const tab = await b.tab()
    const tools = [{ type: 'function', function: { name: 'weather', parameters: { type: 'object' } } }]
    const chats: ChatRequest[] = []
    tab.onChat = (c) => {
      chats.push(c)
      if (c.messages.length === 1) {
        tab.send({
          t: 'tool_call',
          id: c.id,
          calls: [{ id: `${c.id}-call-1`, function: { name: 'weather', arguments: { city: 'Oulu' } } }],
        })
        tab.send({ t: 'done', id: c.id, stop: 'tool_call', usage: { prompt: 1, completion: 1, tokensPerSec: 1 } })
      } else tab.answer(c.id, ['Cold.'])
    }
    const first = await json(post(b.base, { messages: [user('Weather in Oulu?')], tools }))
    expect(chats[0]?.tools?.[0]?.function.name).toBe('weather')
    const choice = first.choices[0]
    expect(choice.finish_reason).toBe('tool_calls')
    const call = choice.message.tool_calls[0]
    expect(call).toMatchObject({ type: 'function', function: { name: 'weather', arguments: '{"city":"Oulu"}' } })

    const second = await json(
      post(b.base, {
        messages: [
          user('Weather in Oulu?'),
          choice.message,
          { role: 'tool', tool_call_id: call.id, content: '-20 °C' },
        ],
        tools,
      }),
    )
    expect(second.choices[0].message.content).toBe('Cold.')
    expect(chats[1]?.messages.slice(1)).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: call.id, function: { name: 'weather', arguments: { city: 'Oulu' } } }],
      },
      { role: 'tool', content: '-20 °C', name: 'weather' },
    ])
  })

  it('streams tool calls as tool_calls deltas', async () => {
    const b = await bridge()
    const tab = await b.tab()
    tab.onChat = (c) => {
      tab.send({
        t: 'tool_call',
        id: c.id,
        calls: [{ id: `${c.id}-call-1`, function: { name: 'now', arguments: {} } }],
      })
      tab.send({ t: 'done', id: c.id, stop: 'tool_call', usage: { prompt: 1, completion: 1, tokensPerSec: 1 } })
    }
    const tools = [{ type: 'function', function: { name: 'now' } }]
    const chunks = (await sse(await post(b.base, { messages: [user('time?')], tools, stream: true })))
      .slice(0, -1)
      .map((d) => JSON.parse(d))
    expect(chunks[1].choices[0].delta.tool_calls).toEqual([
      { index: 0, id: expect.stringMatching(/-call-1$/), type: 'function', function: { name: 'now', arguments: '{}' } },
    ])
    expect(chunks.at(-1).choices[0].finish_reason).toBe('tool_calls')
  })

  it('answers 503 with the reason when no tab or model is ready after the wait', async () => {
    const b = await bridge({ waitMs: 50 })
    let r = await post(b.base, { messages: [user('hi')] })
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({
      error: { message: 'no RebeLLM tab connected', type: 'service_unavailable', code: 'no_tab' },
    })
    const tab = await b.tab(null)
    tab.send({ t: 'status', state: 'loading' })
    r = await post(b.base, { messages: [user('hi')] })
    expect(await r.json()).toMatchObject({ error: { message: 'model loading', code: 'model_loading' } })
    tab.send({ t: 'status', state: 'unavailable', detail: 'Serve only: this machine loads no model' })
    r = await post(b.base, { messages: [user('hi')], stream: true })
    expect(r.status).toBe(503)
    expect(await r.json()).toMatchObject({
      error: { message: 'model unavailable: Serve only: this machine loads no model', code: 'model_unavailable' },
    })
  })

  it('waits for a tab that connects within the wait', async () => {
    const b = await bridge({ waitMs: 3000 })
    const pending = post(b.base, { messages: [user('hi')] })
    await new Promise((r) => setTimeout(r, 50))
    const tab = await b.tab()
    tab.onChat = (c) => tab.answer(c.id, ['made it'])
    expect((await json(pending)).choices[0].message.content).toBe('made it')
  })

  it('answers 502 when the tab fails the chat or goes away', async () => {
    const b = await bridge()
    const tab = await b.tab()
    tab.onChat = (c) => tab.send({ t: 'error', id: c.id, message: 'The prompt needs 9000 tokens' })
    let r = await post(b.base, { messages: [user('long')] })
    expect(r.status).toBe(502)
    expect(await r.json()).toEqual({
      error: { message: 'The prompt needs 9000 tokens', type: 'api_error', code: 'tab_error' },
    })
    tab.onChat = () => tab.ws.terminate()
    r = await post(b.base, { messages: [user('x')] })
    expect(await r.json()).toMatchObject({
      error: { message: 'the RebeLLM tab disconnected', code: 'tab_disconnected' },
    })
  })

  it('ends a stream with an error chunk when the tab fails', async () => {
    const b = await bridge()
    const tab = await b.tab()
    tab.onChat = (c) => {
      tab.send({ t: 'token', id: c.id, text: 'Par' })
      tab.send({ t: 'error', id: c.id, message: 'out of memory' })
    }
    const data = await sse(await post(b.base, { messages: [user('x')], stream: true }))
    expect(data.at(-1)).not.toBe('[DONE]')
    expect(JSON.parse(data.at(-1)!)).toEqual({ error: { message: 'out of memory', type: 'api_error', code: null } })
  })

  it('aborts the chat when the client goes away', async () => {
    const b = await bridge()
    const tab = await b.tab()
    const ctl = new AbortController()
    const req = fetch(`${b.base}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ messages: [user('long story')], stream: true }),
      signal: ctl.signal,
    }).catch(() => null)
    const chat = await tab.nextChat()
    tab.send({ t: 'token', id: chat.id, text: 'Once' })
    await new Promise((r) => setTimeout(r, 50))
    ctl.abort()
    await req
    expect(await tab.next((m) => m.t === 'abort')).toEqual({ t: 'abort', id: chat.id })
  })

  it('answers 400 for a body that is not a chat request', async () => {
    const b = await bridge()
    let r = await fetch(`${b.base}/v1/chat/completions`, { method: 'POST', body: 'not json' })
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ error: { message: 'the body is not JSON', type: 'invalid_request_error' } })
    r = await post(b.base, { messages: [] })
    expect(r.status).toBe(400)
    r = await fetch(`${b.base}/v1/chat/completions`)
    expect(r.status).toBe(405)
  })
})

describe('/v1/models and /health', () => {
  it("lists the tab's model once there is one", async () => {
    const b = await bridge()
    expect(await (await fetch(`${b.base}/v1/models`)).json()).toEqual({ object: 'list', data: [] })
    const tab = await b.tab(null)
    tab.send({ t: 'status', state: 'ready', model: 'qwen3.6-35b-a3b' })
    await once(b.server.tab, 'change')
    expect(await (await fetch(`${b.base}/v1/models`)).json()).toEqual({
      object: 'list',
      data: [{ id: 'qwen3.6-35b-a3b', object: 'model', created: 0, owned_by: 'rebellm' }],
    })
    expect(await (await fetch(`${b.base}/health`)).json()).toEqual({
      service: 'rebellm-bridge',
      tab: true,
      state: 'ready',
      model: 'qwen3.6-35b-a3b',
      contextTokens: 32768,
      app: 'test',
    })
  })
})
