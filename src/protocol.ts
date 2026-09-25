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

/** Tab → bridge. */
export type TabMessage =
  | { t: 'hello'; v: number; token: string; model: string; contextTokens: number; app: string }
  | { t: 'token'; id: string; text: string }
  | { t: 'tool_call'; id: string; calls: ToolCall[] }
  | { t: 'done'; id: string; stop: StopReason; usage: { prompt: number; completion: number; tokensPerSec: number } }
  | { t: 'error'; id?: string; message: string }
  | { t: 'queued'; id: string; position: number }
  | { t: 'status'; state: 'loading' | 'ready' | 'unavailable'; model?: string; detail?: string }
  | { t: 'ping' }
  | { t: 'pong' }

/** Bridge → tab. */
export type BridgeMessage =
  | { t: 'ok' }
  | { t: 'error'; code: 'auth' | 'version' | 'busy'; message?: string }
  | { t: 'chat'; id: string; messages: ChatMessage[]; tools?: ToolSchema[]; maxTokens?: number; temperature?: number }
  | { t: 'abort'; id: string }
  | { t: 'ping' }
  | { t: 'pong' }

const TAB_TYPES = new Set(['hello', 'token', 'tool_call', 'done', 'error', 'queued', 'status', 'ping', 'pong'])

/** Parses one frame from the tab; null for anything that is not a v1 message. */
export function parseTabMessage(raw: string): TabMessage | null {
  let o: unknown
  try {
    o = JSON.parse(raw)
  } catch {
    return null
  }
  if (!o || typeof o !== 'object') return null
  const m = o as Record<string, unknown>
  if (typeof m.t !== 'string' || !TAB_TYPES.has(m.t)) return null
  if (m.t === 'hello' && (m.v !== PROTOCOL_VERSION || typeof m.token !== 'string')) return null
  return m as TabMessage
}

export const encode = (m: BridgeMessage): string => JSON.stringify(m)
