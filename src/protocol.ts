/**
 * Protocol v1 between the RebeLLM tab (client) and this bridge (server): JSON text frames
 * over one WebSocket. The RebeLLM app's `local-bridge` spec owns it; this is the copy.
 */
export const PROTOCOL_VERSION = 1

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCall {
  id?: string
  function: { name: string; arguments: Record<string, unknown> }
}

export interface ChatMessage {
  role: Role
  content: string
  name?: string
  tool_calls?: ToolCall[]
}

export interface ToolSchema {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export type StopReason = 'eos' | 'length' | 'tool_call' | 'abort'

export type ModelState = 'loading' | 'ready' | 'unavailable'

export interface Usage {
  prompt: number
  completion: number
  tokensPerSec: number
}

/** Tab → bridge. */
export type TabMessage =
  | { t: 'hello'; v: number; token: string; model: string; contextTokens: number; app: string }
  | { t: 'token'; id: string; text: string }
  | { t: 'tool_call'; id: string; calls: ToolCall[] }
  | { t: 'done'; id: string; stop: StopReason; usage: Usage }
  | { t: 'error'; id?: string; message: string }
  | { t: 'queued'; id: string; position: number }
  | { t: 'status'; state: ModelState; model?: string; detail?: string }
  | { t: 'ping' }
  | { t: 'pong' }

export interface ChatRequest {
  t: 'chat'
  id: string
  messages: ChatMessage[]
  tools?: ToolSchema[]
  maxTokens?: number
  temperature?: number
}

/** Bridge → tab. */
export type BridgeMessage =
  | { t: 'ok' }
  | { t: 'error'; code: 'auth' | 'version' | 'busy'; message?: string }
  | ChatRequest
  | { t: 'abort'; id: string }
  | { t: 'ping' }
  | { t: 'pong' }

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const optStr = (v: unknown) => v === undefined || isStr(v)
const STOPS = new Set<unknown>(['eos', 'length', 'tool_call', 'abort'])
const STATES = new Set<unknown>(['loading', 'ready', 'unavailable'])

const isCall = (c: unknown) =>
  isObj(c) && optStr(c.id) && isObj(c.function) && isStr(c.function.name) && isObj(c.function.arguments)

const isUsage = (u: unknown) => isObj(u) && isNum(u.prompt) && isNum(u.completion) && isNum(u.tokensPerSec)

function valid(m: Obj): boolean {
  switch (m.t) {
    // Any numeric version parses, so the bridge can answer `version` instead of dropping it.
    case 'hello':
      return isNum(m.v) && isStr(m.token) && optStr(m.model) && optStr(m.app)
    case 'token':
      return isStr(m.id) && isStr(m.text)
    case 'tool_call':
      return isStr(m.id) && Array.isArray(m.calls) && m.calls.every(isCall)
    case 'done':
      return isStr(m.id) && STOPS.has(m.stop) && isUsage(m.usage)
    case 'error':
      return optStr(m.id) && isStr(m.message)
    case 'queued':
      return isStr(m.id) && isNum(m.position)
    case 'status':
      return STATES.has(m.state) && optStr(m.model) && optStr(m.detail)
    case 'ping':
    case 'pong':
      return true
    default:
      return false
  }
}

/** Parses one frame from the tab; null for anything that is not a v1 message. */
export function parseTabMessage(raw: string): TabMessage | null {
  let o: unknown
  try {
    o = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isObj(o) || !valid(o)) return null
  if (o.t === 'hello') return { model: '', contextTokens: 0, app: '', ...o, t: 'hello' } as TabMessage
  return o as TabMessage
}

export const encode = (m: BridgeMessage): string => JSON.stringify(m)
