import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { RawData, WebSocket } from 'ws'
import { PER_MINUTE, fetchLine, pageFetch, rateLimit } from './pagefetch.js'
import {
  FEATURES,
  PROTOCOL_VERSION,
  encode,
  parseTabMessage,
  type BridgeMessage,
  type ChatMessage,
  type FetchedPage,
  type ModelState,
  type StopReason,
  type TabMessage,
  type ToolCall,
  type ToolSchema,
  type Usage,
} from './protocol.js'

export const PING_MS = 20_000
export const SILENCE_MS = 50_000
/** A new connection has this long to say `hello`. */
export const HELLO_MS = 10_000

/** Close codes for a refused `hello`, as the app's stand-in bridge uses them. */
export const CLOSE = { auth: 4000, version: 4001, busy: 4002, helloFirst: 4003 } as const

export interface ChatInput {
  messages: ChatMessage[]
  tools?: ToolSchema[]
  maxTokens?: number
  temperature?: number
}

export type ChatEvent =
  { t: 'token'; text: string } | { t: 'queued'; position: number } | { t: 'tool_call'; calls: ToolCall[] }

export interface ChatResult {
  id: string
  text: string
  calls: ToolCall[]
  stop: StopReason
  usage: Usage
}

export interface ChatOptions {
  onEvent?: (e: ChatEvent) => void
  /** Aborting sends `abort` to the tab and rejects the chat. */
  signal?: AbortSignal
}

export type ChatErrorKind = 'no_tab' | 'tab' | 'disconnected' | 'aborted'

export class ChatError extends Error {
  readonly kind: ChatErrorKind
  constructor(message: string, kind: ChatErrorKind) {
    super(message)
    this.name = 'ChatError'
    this.kind = kind
  }
}

/** What `/health` and the MCP `status` tool report. */
export interface Health {
  tab: boolean
  state: ModelState | 'none'
  model?: string
  detail?: string
  contextTokens?: number
  app?: string
}

export interface Unavailable {
  code: 'no_tab' | 'model_loading' | 'model_unavailable'
  message: string
}

export interface TabLinkOptions {
  token: string
  pingMs?: number
  silenceMs?: number
  helloMs?: number
  log?: (line: string) => void
  /** Where the page fetch lines go; `log` when absent. */
  requestLog?: (line: string) => void
  /** Reads a page for the tab; pagefetch.ts by default. */
  fetchPage?: (url: string, signal: AbortSignal) => Promise<FetchedPage>
}

type Hello = Extract<TabMessage, { t: 'hello' }>
type Status = Omit<Extract<TabMessage, { t: 'status' }>, 't'>

interface Pending {
  /** The tab sent a frame for it, so it read the chat. */
  heard: boolean
  text: string
  calls: ToolCall[]
  onEvent?: (e: ChatEvent) => void
  finish: (r: ChatResult) => void
  fail: (e: ChatError) => void
}

const digest = (s: string) => createHash('sha256').update(s).digest()
/** Constant-time comparison; hashing first makes the lengths equal. */
export const sameToken = (a: string, b: string) => timingSafeEqual(digest(a), digest(b))

const text = (d: RawData) =>
  (Buffer.isBuffer(d) ? d : Array.isArray(d) ? Buffer.concat(d) : Buffer.from(d)).toString('utf8')

/**
 * The one RebeLLM tab connected to this bridge: its `hello`, its model state, and the chats
 * sent to it, each settled by the tab's `done` or `error` or by the connection closing.
 * Emits `change` when a tab connects, disconnects or reports a new status.
 */
export class TabLink extends EventEmitter {
  private readonly token: string
  private readonly pingMs: number
  private readonly silenceMs: number
  private readonly helloMs: number
  private readonly log: (line: string) => void
  private readonly requestLog: (line: string) => void
  private readonly fetchPage: (url: string, signal: AbortSignal) => Promise<FetchedPage>
  // One bucket for the tab, across reconnects.
  private readonly mayFetch = rateLimit()
  private fetches = new Map<string, AbortController>()
  private ws: WebSocket | null = null
  private hello: Hello | null = null
  private status: Status | null = null
  private pinger: ReturnType<typeof setInterval> | null = null
  private pending = new Map<string, Pending>()
  private seq = 0
  // Ids differ across restarts, so tool call ids in a client's history never repeat.
  private readonly prefix = randomBytes(4).toString('hex')

  constructor(o: TabLinkOptions) {
    super()
    this.setMaxListeners(0)
    this.token = o.token
    this.pingMs = o.pingMs ?? PING_MS
    this.silenceMs = o.silenceMs ?? SILENCE_MS
    this.helloMs = o.helloMs ?? HELLO_MS
    this.log = o.log ?? (() => undefined)
    this.requestLog = o.requestLog ?? this.log
    this.fetchPage = o.fetchPage ?? ((url, signal) => pageFetch(url, { signal }))
  }

  get connected() {
    return !!this.ws
  }

  /** Takes a new WebSocket; it becomes the tab after a valid `hello`. */
  accept(ws: WebSocket) {
    let authed = false
    // One `hello` per connection: frames after a refused one are not read or logged.
    let checked = false
    const hello = setTimeout(() => ws.terminate(), this.helloMs)
    const silence = setTimeout(() => {
      if (authed) this.log('the RebeLLM tab stopped answering; dropped it')
      ws.terminate()
    }, this.silenceMs)
    ws.on('message', (data, isBinary) => {
      silence.refresh()
      if (checked && !authed) return
      const m = isBinary ? null : parseTabMessage(text(data))
      if (authed) return m ? this.receive(m) : this.unreadable(ws, text(data))
      checked = true
      clearTimeout(hello)
      if (m?.t !== 'hello') return ws.close(CLOSE.helloFirst, 'hello first')
      const refuse = (code: 'auth' | 'version' | 'busy', message: string) => {
        send(ws, { t: 'error', code, message })
        ws.close(CLOSE[code], code)
        this.log(`refused a tab: ${message}`)
      }
      if (m.v !== PROTOCOL_VERSION)
        return refuse('version', `this bridge speaks protocol v${PROTOCOL_VERSION}, not v${m.v}`)
      if (!sameToken(m.token, this.token)) return refuse('auth', 'wrong token')
      if (this.ws) return refuse('busy', 'another RebeLLM tab is connected')
      authed = true
      this.attach(ws, m)
    })
    ws.on('close', () => {
      clearTimeout(hello)
      clearTimeout(silence)
      if (this.ws === ws) this.detach()
    })
    // A close event follows every error.
    ws.on('error', () => undefined)
  }

  health(): Health {
    if (!this.ws || !this.hello) return { tab: false, state: 'none' }
    const s = this.status
    const model = s?.model || this.hello.model
    return {
      tab: true,
      // The tab sends its status right after `ok`; until then its model counts as loading.
      state: s?.state ?? 'loading',
      ...(model ? { model } : {}),
      ...(s?.detail ? { detail: s.detail } : {}),
      contextTokens: this.hello.contextTokens,
      app: this.hello.app,
    }
  }

  /** The tab's model name for responses. */
  get modelName() {
    return this.health().model ?? 'rebellm'
  }

  /** Why a chat cannot start now, or null when the tab's model is ready. */
  unavailable(): Unavailable | null {
    const h = this.health()
    if (!h.tab) return { code: 'no_tab', message: 'no RebeLLM tab connected' }
    if (h.state === 'ready') return null
    const [code, base] =
      h.state === 'unavailable'
        ? (['model_unavailable', 'model unavailable'] as const)
        : (['model_loading', 'model loading'] as const)
    return { code, message: h.detail ? `${base}: ${h.detail}` : base }
  }

  /** Resolves null once the model is ready, or the reason it is not after `ms` or an abort. */
  waitReady(ms: number, signal?: AbortSignal): Promise<Unavailable | null> {
    const now = this.unavailable()
    if (!now || ms <= 0 || signal?.aborted) return Promise.resolve(now)
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.off('change', check)
        signal?.removeEventListener('abort', done)
        resolve(this.unavailable())
      }
      const check = () => !this.unavailable() && done()
      const timer = setTimeout(done, ms)
      this.on('change', check)
      signal?.addEventListener('abort', done, { once: true })
    })
  }

  /** Sends one chat to the tab; resolves with its answer when the tab says `done`. */
  chat(input: ChatInput, opts: ChatOptions = {}): Promise<ChatResult> {
    const ws = this.ws
    if (!ws) return Promise.reject(new ChatError('no RebeLLM tab connected', 'no_tab'))
    if (opts.signal?.aborted) return Promise.reject(new ChatError('the request was cancelled', 'aborted'))
    const id = `${this.prefix}-${++this.seq}`
    const { signal, onEvent } = opts
    return new Promise<ChatResult>((resolve, reject) => {
      const onAbort = () => {
        if (!this.pending.delete(id)) return
        send(ws, { t: 'abort', id })
        reject(new ChatError('the request was cancelled', 'aborted'))
      }
      const cleanup = () => {
        this.pending.delete(id)
        signal?.removeEventListener('abort', onAbort)
      }
      this.pending.set(id, {
        heard: false,
        text: '',
        calls: [],
        ...(onEvent ? { onEvent } : {}),
        finish: (r) => (cleanup(), resolve(r)),
        fail: (e) => (cleanup(), reject(e)),
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      send(ws, {
        t: 'chat',
        id,
        messages: input.messages,
        ...(input.tools?.length ? { tools: input.tools } : {}),
        ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      })
    })
  }

  /** Drops the tab, failing its open chats. */
  close() {
    const ws = this.ws
    if (!ws) return
    this.detach()
    ws.terminate()
  }

  private attach(ws: WebSocket, hello: Hello) {
    this.ws = ws
    this.hello = hello
    this.status = null
    send(ws, { t: 'ok', features: FEATURES })
    this.pinger = setInterval(() => send(ws, { t: 'ping' }), this.pingMs)
    const model = hello.model ? `, model ${hello.model}` : ''
    this.log(`RebeLLM tab connected (app ${hello.app || 'unknown'}${model})`)
    this.emit('change')
  }

  private detach() {
    if (this.pinger) clearInterval(this.pinger)
    this.pinger = null
    this.ws = null
    this.hello = null
    this.status = null
    for (const f of this.fetches.values()) f.abort()
    this.fetches.clear()
    const open = [...this.pending.values()]
    this.pending.clear()
    for (const p of open) p.fail(new ChatError('the RebeLLM tab disconnected', 'disconnected'))
    this.log('RebeLLM tab disconnected')
    this.emit('change')
  }

  private receive(m: TabMessage) {
    switch (m.t) {
      case 'ping':
        if (this.ws) send(this.ws, { t: 'pong' })
        return
      case 'status': {
        const prev = this.status?.state
        this.status = {
          state: m.state,
          ...(m.model ? { model: m.model } : {}),
          ...(m.detail ? { detail: m.detail } : {}),
        }
        if (prev !== m.state)
          this.log(`model ${m.state}${m.model ? ` (${m.model})` : ''}${m.detail ? `: ${m.detail}` : ''}`)
        this.emit('change')
        return
      }
      case 'fetch':
        return this.fetchFor(m.id, m.url)
      case 'token':
      case 'tool_call':
      case 'queued':
      case 'done':
      case 'error': {
        if (m.id === undefined) return m.t === 'error' && this.unattributed(m.message)
        // Frames of a chat that was aborted or never sent have no one to go to.
        const p = this.pending.get(m.id)
        if (p) route(p, m, m.id)
      }
    }
  }

  /** An `error` without an id: the tab could not read a frame, most likely a chat it never answered. */
  private unattributed(message: string) {
    this.log(`the tab reported: ${message}`)
    for (const p of [...this.pending.values()]) if (!p.heard) p.fail(new ChatError(message, 'tab'))
  }

  /** A frame that fails validation still settles the chat or fetch it names, so nothing waits forever. */
  private unreadable(ws: WebSocket, raw: string) {
    this.log('ignored a frame from the tab that is not protocol v1')
    let o: unknown
    try {
      o = JSON.parse(raw)
    } catch {
      return
    }
    const { t, id } = (o && typeof o === 'object' ? o : {}) as { t?: unknown; id?: unknown }
    if (typeof id !== 'string') return
    const message = `the tab sent a ${typeof t === 'string' ? t : 'malformed'} frame this bridge cannot read`
    const p = this.pending.get(id)
    if (p) {
      send(ws, { t: 'abort', id })
      p.fail(new ChatError(message, 'tab'))
    } else if (t === 'fetch') send(ws, { t: 'error', id, message })
  }

  /** Reads a page the tab asked for and answers `fetched` or `error` with its id. */
  private fetchFor(id: string, url: string) {
    const ws = this.ws
    if (!ws) return
    const answer = (m: BridgeMessage) => this.ws === ws && send(ws, m)
    if (this.fetches.has(id)) return answer({ t: 'error', id, message: 'a fetch with this id is already running' })
    if (!this.mayFetch()) {
      const message = `more than ${PER_MINUTE} page fetches a minute; try again shortly`
      this.requestLog(fetchLine(url, message))
      return answer({ t: 'error', id, message })
    }
    const ctl = new AbortController()
    this.fetches.set(id, ctl)
    this.fetchPage(url, ctl.signal)
      .then(
        (page) => {
          this.requestLog(fetchLine(url, page))
          answer({ t: 'fetched', id, ...page })
        },
        (e: unknown) => {
          const message = e instanceof Error ? e.message : String(e)
          this.requestLog(fetchLine(url, message))
          answer({ t: 'error', id, message })
        },
      )
      .finally(() => this.fetches.get(id) === ctl && this.fetches.delete(id))
  }
}

function route(p: Pending, m: TabMessage, id: string) {
  p.heard = true
  switch (m.t) {
    case 'token':
      p.text += m.text
      return p.onEvent?.({ t: 'token', text: m.text })
    case 'tool_call':
      p.calls.push(...m.calls)
      return p.onEvent?.({ t: 'tool_call', calls: m.calls })
    case 'queued':
      return p.onEvent?.({ t: 'queued', position: m.position })
    case 'done':
      return p.finish({ id, text: p.text, calls: p.calls, stop: m.stop, usage: m.usage })
    case 'error':
      return p.fail(new ChatError(m.message, 'tab'))
  }
}

function send(ws: WebSocket, m: BridgeMessage) {
  if (ws.readyState === ws.OPEN) ws.send(encode(m))
}
