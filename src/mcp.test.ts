import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, onTestFinished } from 'vitest'
import { createMcpServer, describeHealth, httpBackend, serveStdio, tabBackend, type ChatBackend } from './mcp.js'
import { bridge } from './test/harness.js'

async function connect(backend: ChatBackend) {
  const server = createMcpServer(backend, '0.0.0-test')
  const client = new Client({ name: 'test', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  onTestFinished(async () => {
    await client.close()
    await server.close()
  })
  return client
}

type Text = { content: { type: string; text: string }[]; isError?: boolean }
const hi = { messages: [{ role: 'user', content: 'hi' }] }

describe('MCP server', () => {
  it('offers chat and status', async () => {
    const b = await bridge()
    const client = await connect(tabBackend(b.server.tab, 0))
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['chat', 'status'])
    const chat = tools.find((t) => t.name === 'chat')!
    expect(chat.inputSchema.required).toEqual(['messages'])
  })

  it("answers chat with the tab's model and reports progress while it streams", async () => {
    const b = await bridge()
    const tab = await b.tab()
    tab.onChat = (c) => {
      tab.send({ t: 'queued', id: c.id, position: 1 })
      tab.answer(c.id, ['Hi', ' from', ' the tab'])
    }
    const client = await connect(tabBackend(b.server.tab, 1000))
    const progress: { progress: number; message?: string }[] = []
    const r = (await client.callTool(
      { name: 'chat', arguments: { ...hi, max_tokens: 50, temperature: 0.3 } },
      undefined,
      { onprogress: (p) => void progress.push(p) },
    )) as Text
    expect(r.isError).toBeFalsy()
    expect(r.content).toEqual([{ type: 'text', text: 'Hi from the tab' }])
    expect(progress.map((p) => p.message)).toEqual([
      "waiting in the tab's queue, position 1",
      'Hi',
      ' from',
      ' the tab',
    ])
    expect(progress.map((p) => p.progress)).toEqual([1, 2, 3, 4])
  })

  it('passes max_tokens and temperature to the tab', async () => {
    const b = await bridge()
    const tab = await b.tab()
    const client = await connect(tabBackend(b.server.tab, 1000))
    const call = client.callTool({ name: 'chat', arguments: { ...hi, max_tokens: 50, temperature: 0.3 } })
    const chat = await tab.nextChat()
    expect(chat).toMatchObject({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 50, temperature: 0.3 })
    tab.answer(chat.id, ['ok'])
    await call
  })

  it('returns an error result when no tab comes within the wait', async () => {
    const b = await bridge()
    const client = await connect(tabBackend(b.server.tab, 50))
    const r = (await client.callTool({ name: 'chat', arguments: hi })) as Text
    expect(r).toEqual({ isError: true, content: [{ type: 'text', text: 'RebeLLM: no RebeLLM tab connected' }] })
  })

  it('aborts the chat when the client cancels', async () => {
    const b = await bridge()
    const tab = await b.tab()
    const client = await connect(tabBackend(b.server.tab, 1000))
    const ctl = new AbortController()
    const call = client.callTool({ name: 'chat', arguments: hi }, undefined, { signal: ctl.signal })
    const chat = await tab.nextChat()
    ctl.abort()
    await expect(call).rejects.toThrow()
    expect(await tab.next((m) => m.t === 'abort')).toEqual({ t: 'abort', id: chat.id })
  })

  it('describes the tab in status', async () => {
    const b = await bridge()
    const client = await connect(tabBackend(b.server.tab, 0))
    let r = (await client.callTool({ name: 'status', arguments: {} })) as Text
    expect(r.content[0]?.text).toContain('No RebeLLM tab is connected')
    await b.tab('qwen')
    await once(b.server.tab, 'change')
    r = (await client.callTool({ name: 'status', arguments: {} })) as Text
    expect(r.content[0]?.text).toBe(
      'A RebeLLM tab is connected (app test). The model qwen is ready, with a context of 32768 tokens.',
    )
  })

  it('reports a failing backend as an error result', async () => {
    const broken: ChatBackend = {
      health: () => Promise.reject(new Error('no bridge on the port')),
      chat: () => Promise.reject(new Error('no bridge on the port')),
    }
    const client = await connect(broken)
    const r = (await client.callTool({ name: 'status', arguments: {} })) as Text
    expect(r).toEqual({ isError: true, content: [{ type: 'text', text: 'RebeLLM: no bridge on the port' }] })
  })
})

describe('describeHealth', () => {
  it('covers every state, and never the token', () => {
    expect(describeHealth({ tab: false, state: 'none' })).toContain('RebeLLM → Bridge')
    expect(describeHealth({ tab: true, state: 'loading', detail: 'shards 2/9' })).toBe(
      'A RebeLLM tab is connected. The model is loading (shards 2/9).',
    )
    expect(describeHealth({ tab: true, state: 'unavailable', detail: 'Serve only', app: '1' })).toBe(
      'A RebeLLM tab is connected (app 1). The model is not available: Serve only.',
    )
  })
})

describe('httpBackend', () => {
  it('uses a running bridge: health, and a chat streamed through its OpenAI endpoint', async () => {
    const b = await bridge({ keepAliveMs: 10 })
    const tab = await b.tab('qwen')
    // Late enough for keep-alive comments, which the backend must skip.
    tab.onChat = (c) => setTimeout(() => tab.answer(c.id, ['Through', ' HTTP'], 'length'), 60)
    const remote = httpBackend(b.base)
    expect(await remote.health()).toMatchObject({ tab: true, model: 'qwen' })
    const pieces: string[] = []
    const r = await remote.chat(
      { messages: [{ role: 'user', content: 'hi' }], maxTokens: 9 },
      { onEvent: (e) => e.t === 'token' && void pieces.push(e.text) },
    )
    expect(r).toMatchObject({ text: 'Through HTTP', stop: 'length', usage: { prompt: 7, completion: 2 } })
    expect(pieces).toEqual(['Through', ' HTTP'])

    // The MCP face on top of it.
    const client = await connect(remote)
    const answer = (await client.callTool({ name: 'chat', arguments: hi })) as Text
    expect(answer.content[0]?.text).toBe('Through HTTP')
  })

  it("passes on the bridge's errors", async () => {
    const b = await bridge({ waitMs: 20 })
    await expect(httpBackend(b.base).chat({ messages: [{ role: 'user', content: 'x' }] }, {})).rejects.toThrow(
      'no RebeLLM tab connected',
    )
    const tab = await b.tab()
    tab.onChat = (c) => tab.send({ t: 'error', id: c.id, message: 'boom' })
    await expect(httpBackend(b.base).chat({ messages: [{ role: 'user', content: 'x' }] }, {})).rejects.toThrow('boom')
  })
})

describe('serveStdio', () => {
  it('speaks MCP over the streams and ends when stdin closes', async () => {
    const b = await bridge()
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const served = serveStdio(createMcpServer(tabBackend(b.server.tab, 0), '0.0.0-test'), stdin, stdout)
    const reply = once(stdout, 'data')
    stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      })}\n`,
    )
    const [line] = (await reply) as [Buffer]
    expect(JSON.parse(line.toString())).toMatchObject({ id: 1, result: { serverInfo: { name: 'rebellm-bridge' } } })
    stdin.end()
    await served
  })
})
