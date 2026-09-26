import { WebSocket } from 'ws'
import { PROTOCOL_VERSION, type BridgeMessage, type ChatRequest, type TabMessage } from '../protocol.js'

type Hello = Extract<TabMessage, { t: 'hello' }>

/** A RebeLLM tab as the tests need one: the client side of protocol v1, driven by hand. */
export class FakeTab {
  readonly ws: WebSocket
  /** Frames not yet taken by `next`. */
  private inbox: BridgeMessage[] = []
  private waiters: { match: (m: BridgeMessage) => boolean; resolve: (m: BridgeMessage) => void }[] = []
  readonly closed: Promise<{ code: number; reason: string }>
  /** Answers chats as they come; without it they wait in the inbox. */
  onChat: ((chat: ChatRequest) => void) | null = null
  /** Off to test a tab that never answers. */
  autoPong = true

  private constructor(url: string) {
    this.ws = new WebSocket(url)
    this.closed = new Promise((resolve) =>
      this.ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })),
    )
    this.ws.on('error', () => undefined)
    this.ws.on('message', (data) => {
      const m = JSON.parse(data.toString()) as BridgeMessage
      if (m.t === 'ping' && this.autoPong) this.send({ t: 'pong' })
      if (m.t === 'chat' && this.onChat) return this.onChat(m)
      const w = this.waiters.findIndex((x) => x.match(m))
      if (w >= 0) return this.waiters.splice(w, 1)[0]!.resolve(m)
      this.inbox.push(m)
    })
  }

  /** Connects and sends `hello`; does not wait for the answer. */
  static async open(url: string, hello: Partial<Hello> = {}): Promise<FakeTab> {
    const tab = new FakeTab(url)
    await new Promise<void>((resolve, reject) => {
      tab.ws.once('open', () => resolve())
      tab.ws.once('error', reject)
    })
    tab.send({ t: 'hello', v: PROTOCOL_VERSION, token: '', model: '', contextTokens: 32768, app: 'test', ...hello })
    return tab
  }

  /** Connected, authenticated and, unless told otherwise, with a ready model. */
  static async ready(url: string, token: string, model: string | null = 'test-model'): Promise<FakeTab> {
    const tab = await FakeTab.open(url, { token })
    const ok = await tab.next()
    if (ok.t !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(ok)}`)
    if (model) tab.send({ t: 'status', state: 'ready', model })
    return tab
  }

  send(m: TabMessage | Record<string, unknown>) {
    this.ws.send(JSON.stringify(m))
  }

  /** The first frame, buffered or coming, that matches. */
  next(match: (m: BridgeMessage) => boolean = () => true, timeoutMs = 3000): Promise<BridgeMessage> {
    const at = this.inbox.findIndex(match)
    if (at >= 0) return Promise.resolve(this.inbox.splice(at, 1)[0]!)
    return new Promise((resolve, reject) => {
      const waiter = {
        match,
        resolve: (m: BridgeMessage) => {
          clearTimeout(timer)
          resolve(m)
        },
      }
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        reject(new Error('no matching frame from the bridge'))
      }, timeoutMs)
      this.waiters.push(waiter)
    })
  }

  nextChat(timeoutMs?: number) {
    return this.next((m) => m.t === 'chat', timeoutMs) as Promise<ChatRequest>
  }

  /** Streams `pieces` and ends with `done`, as the tab does for a plain answer. */
  answer(id: string, pieces: string[], stop: 'eos' | 'length' = 'eos') {
    for (const text of pieces) this.send({ t: 'token', id, text })
    this.send({ t: 'done', id, stop, usage: { prompt: 7, completion: pieces.length, tokensPerSec: 12.5 } })
  }

  close() {
    this.ws.close()
    return this.closed
  }
}
