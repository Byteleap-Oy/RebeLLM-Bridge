import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { CLOSE, ChatError, TabLink, sameToken, type ChatEvent, type TabLinkOptions } from './tab.js'
import { FakeTab } from './test/fake-tab.js'

const TOKEN = 'test-token'
const cleanups: (() => unknown)[] = []

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

/** A TabLink behind a bare WebSocket server, as server.ts wires it. */
async function link(o: Partial<TabLinkOptions> = {}) {
  const lines: string[] = []
  const tab = new TabLink({ token: TOKEN, log: (l) => lines.push(l), ...o })
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  wss.on('connection', (ws) => tab.accept(ws))
  await once(wss, 'listening')
  const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`
  const tabs: FakeTab[] = []
  cleanups.push(async () => {
    tab.close()
    for (const t of tabs) t.ws.terminate()
    await new Promise((r) => wss.close(r))
  })
  const track = (t: FakeTab) => (tabs.push(t), t)
  return {
    tab,
    lines,
    url,
    ready: async (model?: string | null) => track(await FakeTab.ready(url, TOKEN, model)),
    open: async (hello: Parameters<typeof FakeTab.open>[1]) => track(await FakeTab.open(url, hello)),
  }
}

const changed = (tab: TabLink) => once(tab, 'change')

describe('TabLink', () => {
  it('accepts a tab with the token and tracks its model state', async () => {
    const { tab, open, lines } = await link()
    expect(tab.health()).toEqual({ tab: false, state: 'none' })
    const fake = await open({ token: TOKEN, model: '', contextTokens: 8192, app: '1.2.3' })
    expect(await fake.next()).toEqual({ t: 'ok', features: ['fetch'] })
    expect(tab.connected).toBe(true)
    // Before the first status the model counts as loading.
    expect(tab.health()).toEqual({ tab: true, state: 'loading', contextTokens: 8192, app: '1.2.3' })
    expect(tab.unavailable()).toEqual({ code: 'model_loading', message: 'model loading' })

    fake.send({ t: 'status', state: 'unavailable', detail: 'Serve only' })
    await changed(tab)
    expect(tab.unavailable()).toEqual({ code: 'model_unavailable', message: 'model unavailable: Serve only' })

    fake.send({ t: 'status', state: 'ready', model: 'qwen' })
    await changed(tab)
    expect(tab.health()).toMatchObject({ tab: true, state: 'ready', model: 'qwen' })
    expect(tab.modelName).toBe('qwen')
    expect(tab.unavailable()).toBeNull()
    expect(lines).toContain('RebeLLM tab connected (app 1.2.3)')
    expect(lines).toContain('model ready (qwen)')
  })

  it('refuses a wrong token and another version', async () => {
    const { tab, open } = await link()
    const wrong = await open({ token: 'nope' })
    expect(await wrong.next()).toMatchObject({ t: 'error', code: 'auth' })
    expect((await wrong.closed).code).toBe(CLOSE.auth)

    const future = await open({ token: TOKEN, v: 2 })
    expect(await future.next()).toMatchObject({ t: 'error', code: 'version', message: expect.stringContaining('v2') })
    expect((await future.closed).code).toBe(CLOSE.version)

    expect(tab.connected).toBe(false)
  })

  it('closes a connection whose first frame is not a hello', async () => {
    const { url } = await link()
    const { WebSocket } = await import('ws')
    const ws = new WebSocket(url)
    await once(ws, 'open')
    ws.send(JSON.stringify({ t: 'ping' }))
    const [code] = (await once(ws, 'close')) as [number]
    expect(code).toBe(CLOSE.helloFirst)
  })

  it('checks one hello per connection and drops a connection that does not say hello in time', async () => {
    const { tab, url, lines } = await link({ helloMs: 100 })
    const wrong = await FakeTab.open(url, { token: 'nope' })
    for (let i = 0; i < 5; i++) wrong.send({ t: 'hello', v: 1, token: TOKEN, model: '', contextTokens: 0, app: 't' })
    expect(await wrong.next()).toMatchObject({ t: 'error', code: 'auth' })
    expect((await wrong.closed).code).toBe(CLOSE.auth)
    expect(tab.connected).toBe(false)
    expect(lines.filter((l) => l.startsWith('refused a tab'))).toEqual(['refused a tab: wrong token'])

    const { WebSocket } = await import('ws')
    const mute = new WebSocket(url)
    await once(mute, 'open')
    const [code] = (await once(mute, 'close')) as [number]
    expect(code).toBe(1006)
  })

  it('answers a second tab with busy and keeps the first', async () => {
    const { tab, ready, open } = await link()
    const first = await ready()
    const second = await open({ token: TOKEN })
    expect(await second.next()).toMatchObject({ t: 'error', code: 'busy' })
    expect((await second.closed).code).toBe(CLOSE.busy)
    first.onChat = (c) => first.answer(c.id, ['still here'])
    expect((await tab.chat({ messages: [{ role: 'user', content: 'hi' }] })).text).toBe('still here')
  })

  it('pings, answers pings, and drops a tab that stays silent', async () => {
    const { tab, ready, lines } = await link({ pingMs: 40, silenceMs: 150 })
    const fake = await ready()
    expect(await fake.next((m) => m.t === 'ping')).toEqual({ t: 'ping' })
    fake.send({ t: 'ping' })
    expect(await fake.next((m) => m.t === 'pong')).toEqual({ t: 'pong' })
    // Answering pings keeps it alive past the silence limit.
    await new Promise((r) => setTimeout(r, 250))
    expect(tab.connected).toBe(true)
    fake.autoPong = false
    await changed(tab)
    expect(tab.connected).toBe(false)
    await fake.closed
    expect(lines).toContain('the RebeLLM tab stopped answering; dropped it')
  })

  it('sends a chat and collects tokens, queue position and usage', async () => {
    const { tab, ready } = await link()
    const fake = await ready()
    const events: ChatEvent[] = []
    const answer = tab.chat(
      {
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'f', description: '', parameters: {} } }],
        maxTokens: 64,
        temperature: 0.2,
      },
      { onEvent: (e) => events.push(e) },
    )
    const chat = await fake.nextChat()
    expect(chat).toMatchObject({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 64, temperature: 0.2 })
    expect(chat.tools).toHaveLength(1)
    fake.send({ t: 'queued', id: chat.id, position: 1 })
    fake.answer(chat.id, ['Hel', 'lo'])
    const r = await answer
    expect(r).toMatchObject({ id: chat.id, text: 'Hello', stop: 'eos', calls: [] })
    expect(r.usage).toEqual({ prompt: 7, completion: 2, tokensPerSec: 12.5 })
    expect(events).toEqual([
      { t: 'queued', position: 1 },
      { t: 'token', text: 'Hel' },
      { t: 'token', text: 'lo' },
    ])
  })

  it('leaves out what the caller did not set and gives each chat its own id', async () => {
    const { tab, ready } = await link()
    const fake = await ready()
    void tab.chat({ messages: [{ role: 'user', content: 'a' }] }).catch(() => undefined)
    void tab.chat({ messages: [{ role: 'user', content: 'b' }] }).catch(() => undefined)
    const [a, b] = [await fake.nextChat(), await fake.nextChat()]
    expect(Object.keys(a).sort()).toEqual(['id', 'messages', 't'])
    expect(a.id).not.toBe(b.id)
  })

  it('returns tool calls', async () => {
    const { tab, ready } = await link()
    const fake = await ready()
    const answer = tab.chat({ messages: [{ role: 'user', content: 'weather?' }] })
    const { id } = await fake.nextChat()
    const call = { id: `${id}-call-1`, function: { name: 'weather', arguments: { city: 'Oulu' } } }
    fake.send({ t: 'tool_call', id, calls: [call] })
    fake.send({ t: 'done', id, stop: 'tool_call', usage: { prompt: 1, completion: 1, tokensPerSec: 1 } })
    expect(await answer).toMatchObject({ stop: 'tool_call', calls: [call], text: '' })
  })

  it('fails a chat the tab answers with an error', async () => {
    const { tab, ready } = await link()
    const fake = await ready()
    const answer = tab.chat({ messages: [{ role: 'user', content: 'x' }] })
    const { id } = await fake.nextChat()
    fake.send({ t: 'error', id, message: 'The model in the RebeLLM tab is not available' })
    await expect(answer).rejects.toMatchObject({
      kind: 'tab',
      message: 'The model in the RebeLLM tab is not available',
    })
  })

  it('aborts a chat whose caller gives up', async () => {
    const { tab, ready } = await link()
    const fake = await ready()
    const ctl = new AbortController()
    const answer = tab.chat({ messages: [{ role: 'user', content: 'x' }] }, { signal: ctl.signal })
    const { id } = await fake.nextChat()
    ctl.abort()
    await expect(answer).rejects.toMatchObject({ kind: 'aborted' })
    expect(await fake.next((m) => m.t === 'abort')).toEqual({ t: 'abort', id })
    // The tab's late done goes nowhere.
    fake.answer(id, ['late'])
    await expect(
      tab.chat({ messages: [{ role: 'user', content: 'y' }] }, { signal: ctl.signal }),
    ).rejects.toBeInstanceOf(ChatError)
  })

  it('fails open chats when the tab disconnects, and chats without a tab', async () => {
    const { tab, ready, lines } = await link()
    const fake = await ready()
    const answer = tab.chat({ messages: [{ role: 'user', content: 'x' }] })
    await fake.nextChat()
    // Handle the rejection before closing; it fires during the close.
    const failed = expect(answer).rejects.toMatchObject({
      kind: 'disconnected',
      message: 'the RebeLLM tab disconnected',
    })
    await fake.close()
    await failed
    expect(tab.health().tab).toBe(false)
    expect(lines).toContain('RebeLLM tab disconnected')
    await expect(tab.chat({ messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ kind: 'no_tab' })
  })

  it('waits past a limit too long for a timer instead of returning at once', async () => {
    const { tab } = await link()
    const ctl = new AbortController()
    const waiting = tab.waitReady(3_000_000_000, ctl.signal)
    let settled = false
    void waiting.then(() => (settled = true))
    await new Promise((r) => setTimeout(r, 50))
    expect(settled).toBe(false)
    ctl.abort()
    expect(await waiting).toMatchObject({ code: 'no_tab' })
  })

  it('waits for a ready model, up to a limit', async () => {
    const { tab, ready } = await link()
    expect(await tab.waitReady(50)).toEqual({ code: 'no_tab', message: 'no RebeLLM tab connected' })
    expect(await tab.waitReady(0)).toMatchObject({ code: 'no_tab' })
    const waiting = tab.waitReady(3000)
    const fake = await ready(null)
    fake.send({ t: 'status', state: 'loading', detail: 'shards 3/9' })
    await changed(tab)
    expect(await tab.waitReady(30)).toEqual({ code: 'model_loading', message: 'model loading: shards 3/9' })
    fake.send({ t: 'status', state: 'ready', model: 'm' })
    expect(await waiting).toBeNull()
    const ctl = new AbortController()
    fake.send({ t: 'status', state: 'loading' })
    await changed(tab)
    const aborted = tab.waitReady(3000, ctl.signal)
    ctl.abort()
    expect(await aborted).toMatchObject({ code: 'model_loading' })
  })

  it('logs a tab error without an id and ignores frames it cannot read', async () => {
    const { tab, ready, lines } = await link()
    const fake = await ready()
    fake.send({ t: 'error', message: 'The tab could not read this message (protocol v1)' })
    fake.send({ t: 'weird' })
    fake.send({ t: 'token', id: 'unknown', text: 'x' })
    fake.send({ t: 'ping' })
    await fake.next((m) => m.t === 'pong')
    expect(lines).toContain('the tab reported: The tab could not read this message (protocol v1)')
    expect(lines).toContain('ignored a frame from the tab that is not protocol v1')
    expect(tab.connected).toBe(true)
  })

  it('fails and aborts a chat whose frame it cannot read, and answers an unreadable fetch', async () => {
    const { tab, ready } = await link()
    const fake = await ready()
    const answer = tab.chat({ messages: [{ role: 'user', content: 'x' }] })
    const failed = expect(answer).rejects.toMatchObject({
      kind: 'tab',
      message: 'the tab sent a done frame this bridge cannot read',
    })
    const { id } = await fake.nextChat()
    const badDone: Record<string, unknown> = { t: 'done', id, stop: 'eos', usage: { prompt: 5, completion: 0 } }
    fake.send(badDone)
    await failed
    expect(await fake.next((m) => m.t === 'abort')).toEqual({ t: 'abort', id })
    const badFetch: Record<string, unknown> = { t: 'fetch', id: 'f1', url: 42 }
    fake.send(badFetch)
    expect(await fake.next((m) => m.t === 'error')).toMatchObject({ t: 'error', id: 'f1' })
  })

  it('fails the chats the tab never answered when it reports an error without an id', async () => {
    const { tab, ready } = await link()
    const fake = await ready()
    const heard = tab.chat({ messages: [{ role: 'user', content: 'a' }] })
    const first = await fake.nextChat()
    fake.send({ t: 'queued', id: first.id, position: 1 })
    const unheard = tab.chat({ messages: [{ role: 'user', content: 'b' }] })
    const failed = expect(unheard).rejects.toMatchObject({ kind: 'tab', message: 'could not read' })
    await fake.nextChat()
    fake.send({ t: 'error', message: 'could not read' })
    await failed
    fake.answer(first.id, ['fine'])
    expect((await heard).text).toBe('fine')
  })
})

describe('TabLink: page fetch', () => {
  const PAGE = {
    status: 200,
    type: 'text/html',
    finalUrl: 'https://docs.example.org/v3/',
    text: '<h1>Docs</h1>',
    cut: false,
  }
  const fetched = (id: string) => (m: { t: string; id?: string }) =>
    (m.t === 'fetched' || m.t === 'error') && m.id === id

  it('reads the page the tab asks for and answers with its id; the request log names the host only', async () => {
    const lines: string[] = []
    const fetchPage = vi.fn(async () => PAGE)
    const { ready } = await link({ fetchPage, requestLog: (l) => lines.push(l) })
    const fake = await ready()
    fake.send({ t: 'fetch', id: 'f1', url: 'https://docs.example.org/v3?q=secret' })
    expect(await fake.next(fetched('f1'))).toEqual({ t: 'fetched', id: 'f1', ...PAGE })
    expect(fetchPage).toHaveBeenCalledWith('https://docs.example.org/v3?q=secret', expect.any(AbortSignal))
    expect(lines).toEqual(['fetch docs.example.org: 200, 13 bytes'])
  })

  it("answers a refusal as an error with the fetch's id", async () => {
    const lines: string[] = []
    const fetchPage = vi.fn(async () => Promise.reject(new Error('192.168.1.1 is not a public address')))
    const { ready } = await link({ fetchPage, requestLog: (l) => lines.push(l) })
    const fake = await ready()
    fake.send({ t: 'fetch', id: 'f2', url: 'http://192.168.1.1/' })
    expect(await fake.next(fetched('f2'))).toEqual({
      t: 'error',
      id: 'f2',
      message: '192.168.1.1 is not a public address',
    })
    expect(lines).toEqual(['fetch 192.168.1.1: error 192.168.1.1 is not a public address'])
  })

  it('refuses a second fetch with a live id and more than 30 fetches a minute', async () => {
    let release = () => undefined as void
    const slow = new Promise<typeof PAGE>((r) => (release = () => r(PAGE)))
    const fetchPage = vi.fn(async (url: string) => (url.endsWith('/slow') ? slow : PAGE))
    const { ready } = await link({ fetchPage })
    const fake = await ready()
    fake.send({ t: 'fetch', id: 'same', url: 'https://a.example/slow' })
    fake.send({ t: 'fetch', id: 'same', url: 'https://a.example/other' })
    expect(await fake.next(fetched('same'))).toEqual({
      t: 'error',
      id: 'same',
      message: 'a fetch with this id is already running',
    })
    release()
    expect(await fake.next(fetched('same'))).toMatchObject({ t: 'fetched', id: 'same' })
    for (let i = 0; i < 29; i++) fake.send({ t: 'fetch', id: `n${i}`, url: 'https://a.example/' })
    for (let i = 0; i < 29; i++) expect(await fake.next(fetched(`n${i}`))).toMatchObject({ t: 'fetched' })
    fake.send({ t: 'fetch', id: 'over', url: 'https://a.example/' })
    expect(await fake.next(fetched('over'))).toEqual({
      t: 'error',
      id: 'over',
      message: 'more than 30 page fetches a minute; try again shortly',
    })
    expect(fetchPage).toHaveBeenCalledTimes(30)
  })

  it('cancels a running fetch when the tab disconnects', async () => {
    let signal: AbortSignal | undefined
    const fetchPage = vi.fn(
      (_url: string, s: AbortSignal) =>
        new Promise<typeof PAGE>((_, reject) => {
          signal = s
          s.addEventListener('abort', () => reject(new Error('cancelled')))
        }),
    )
    const { tab, ready } = await link({ fetchPage })
    const fake = await ready()
    fake.send({ t: 'fetch', id: 'f3', url: 'https://a.example/' })
    await vi.waitFor(() => expect(signal).toBeDefined())
    await fake.close()
    await vi.waitFor(() => expect(tab.connected).toBe(false))
    expect(signal!.aborted).toBe(true)
  })
})

describe('sameToken', () => {
  it('compares tokens of any length', () => {
    expect(sameToken('abc', 'abc')).toBe(true)
    expect(sameToken('abc', 'abcd')).toBe(false)
    expect(sameToken('', 'x')).toBe(false)
  })
})
