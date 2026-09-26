import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ChatMessage, ToolCall, ToolSchema, Usage } from './protocol.js'
import { ChatError, type ChatInput, type ChatResult, type TabLink } from './tab.js'

/** Long conversations are large, but not this large. */
export const MAX_BODY = 8 << 20

/** Well inside the read timeouts of common clients (Node's fetch: 300 s). */
export const KEEPALIVE_MS = 15_000

export interface RouteOptions {
  /** How long a request waits for a tab with a ready model. */
  waitMs: number
  keepAliveMs?: number
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** OpenAI's error shape, which its SDKs turn into readable messages. */
export function sendError(res: ServerResponse, status: number, message: string, type: string, code?: string) {
  sendJson(res, status, { error: { message, type, code: code ?? null } })
}

export type ParsedRequest = { input: ChatInput; stream: boolean; includeUsage: boolean } | { error: string }

const ROLES: Record<string, ChatMessage['role']> = {
  system: 'system',
  developer: 'system',
  user: 'user',
  assistant: 'assistant',
  tool: 'tool',
}

/** Text of a message's content; parts the tab cannot take become a note. */
function contentText(c: unknown): string | null {
  if (c === undefined || c === null) return ''
  if (isStr(c)) return c
  if (!Array.isArray(c)) return null
  const parts: string[] = []
  for (const p of c) {
    if (!isObj(p) || !isStr(p.type)) return null
    parts.push(p.type === 'text' && isStr(p.text) ? p.text : `[${p.type} omitted]`)
  }
  return parts.join('\n')
}

function toolArgs(a: unknown): Record<string, unknown> | null {
  if (a === undefined || a === null || a === '') return {}
  if (isObj(a)) return a
  if (!isStr(a)) return null
  try {
    const o: unknown = JSON.parse(a)
    return isObj(o) ? o : null
  } catch {
    return null
  }
}

function toolSchemas(tools: unknown): ToolSchema[] | string {
  if (!Array.isArray(tools)) return '`tools` must be an array'
  const out: ToolSchema[] = []
  for (const [i, t] of tools.entries()) {
    const f = isObj(t) ? t.function : undefined
    if (!isObj(t) || t.type !== 'function' || !isObj(f) || !isStr(f.name) || !f.name)
      return `tools[${i}] must be { type: 'function', function: { name, ... } }`
    if (f.description !== undefined && !isStr(f.description)) return `tools[${i}].function.description must be a string`
    if (f.parameters !== undefined && !isObj(f.parameters)) return `tools[${i}].function.parameters must be an object`
    out.push({
      type: 'function',
      function: {
        name: f.name,
        description: (f.description as string | undefined) ?? '',
        parameters: (f.parameters as Obj | undefined) ?? { type: 'object', properties: {} },
      },
    })
  }
  return out
}

/** An OpenAI chat completion request as the tab's `chat`; the error says what is wrong with it. */
export function toChatInput(body: unknown): ParsedRequest {
  if (!isObj(body)) return { error: 'the body must be a JSON object' }
  if (!Array.isArray(body.messages) || !body.messages.length) return { error: '`messages` must be a non-empty array' }
  // A tool result names the call it answers only by id; the tab wants the tool's name.
  const callNames = new Map<string, string>()
  const messages: ChatMessage[] = []
  for (const [i, m] of body.messages.entries()) {
    if (!isObj(m)) return { error: `messages[${i}] must be an object` }
    const role = isStr(m.role) ? ROLES[m.role] : undefined
    if (!role) return { error: `messages[${i}].role ${JSON.stringify(m.role)} is not supported` }
    const content = contentText(m.content)
    if (content === null) return { error: `messages[${i}].content must be a string or an array of parts` }
    const out: ChatMessage = { role, content }
    if (role === 'assistant' && m.tool_calls !== undefined && m.tool_calls !== null) {
      if (!Array.isArray(m.tool_calls)) return { error: `messages[${i}].tool_calls must be an array` }
      const calls: ToolCall[] = []
      for (const c of m.tool_calls) {
        const f = isObj(c) ? c.function : undefined
        const args = isObj(f) ? toolArgs(f.arguments) : null
        if (!isObj(c) || !isObj(f) || !isStr(f.name) || !args)
          return { error: `messages[${i}].tool_calls needs a function name and JSON object arguments` }
        if (isStr(c.id)) callNames.set(c.id, f.name)
        calls.push({ ...(isStr(c.id) ? { id: c.id } : {}), function: { name: f.name, arguments: args } })
      }
      if (calls.length) out.tool_calls = calls
    }
    if (role === 'tool') {
      const name = isStr(m.name) ? m.name : isStr(m.tool_call_id) ? callNames.get(m.tool_call_id) : undefined
      if (name) out.name = name
    }
    messages.push(out)
  }
  const input: ChatInput = { messages }
  if (body.tools !== undefined && body.tools !== null && body.tool_choice !== 'none') {
    const tools = toolSchemas(body.tools)
    if (isStr(tools)) return { error: tools }
    if (tools.length) input.tools = tools
  }
  const max = body.max_completion_tokens ?? body.max_tokens
  if (max !== undefined && max !== null) {
    if (!Number.isInteger(max) || (max as number) < 1) return { error: '`max_tokens` must be a positive integer' }
    input.maxTokens = max as number
  }
  const temp = body.temperature
  if (temp !== undefined && temp !== null) {
    if (typeof temp !== 'number' || !Number.isFinite(temp) || temp < 0)
      return { error: '`temperature` must be a number of at least 0' }
    input.temperature = temp
  }
  const includeUsage = isObj(body.stream_options) && body.stream_options.include_usage === true
  return { input, stream: body.stream === true, includeUsage }
}

const finishReason = (r: ChatResult) =>
  r.calls.length || r.stop === 'tool_call' ? 'tool_calls' : r.stop === 'length' ? 'length' : 'stop'

const usage = (u: Usage) => ({
  prompt_tokens: u.prompt,
  completion_tokens: u.completion,
  total_tokens: u.prompt + u.completion,
})

const newId = () => randomBytes(12).toString('hex')

const toolCall = (c: ToolCall) => ({
  id: c.id ?? `call_${newId()}`,
  type: 'function' as const,
  function: { name: c.function.name, arguments: JSON.stringify(c.function.arguments) },
})

/** A non-streamed answer in OpenAI's shape. */
export function completion(r: ChatResult, meta: { id: string; created: number; model: string }) {
  const calls = r.calls.map(toolCall)
  return {
    ...meta,
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          // OpenAI sends null content beside tool calls when there is no text.
          content: calls.length && !r.text ? null : r.text,
          ...(calls.length ? { tool_calls: calls } : {}),
        },
        finish_reason: finishReason(r),
      },
    ],
    usage: usage(r.usage),
  }
}

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'the request body is too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new HttpError(400, 'the body is not JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** The HTTP routes for OpenAI-style clients: completions, models and health. */
export function openaiRoutes(tab: TabLink, o: RouteOptions) {
  async function completions(req: IncomingMessage, res: ServerResponse) {
    let body: unknown
    try {
      body = await readJson(req)
    } catch (e) {
      return sendError(res, e instanceof HttpError ? e.status : 400, (e as Error).message, 'invalid_request_error')
    }
    const parsed = toChatInput(body)
    if ('error' in parsed) return sendError(res, 400, parsed.error, 'invalid_request_error')
    const gone = new AbortController()
    res.on('close', () => !res.writableFinished && gone.abort())
    const missing = await tab.waitReady(o.waitMs, gone.signal)
    if (gone.signal.aborted) return
    if (missing) return sendError(res, 503, missing.message, 'service_unavailable', missing.code)
    const meta = { id: `chatcmpl-${newId()}`, created: Math.floor(Date.now() / 1000), model: tab.modelName }
    if (parsed.stream) return stream(res, parsed.input, parsed.includeUsage, meta, gone.signal)
    try {
      sendJson(res, 200, completion(await tab.chat(parsed.input, { signal: gone.signal }), meta))
    } catch (e) {
      if (gone.signal.aborted) return
      const err = e as ChatError
      if (err.kind === 'no_tab') return sendError(res, 503, err.message, 'service_unavailable', 'no_tab')
      sendError(res, 502, err.message, 'api_error', err.kind === 'disconnected' ? 'tab_disconnected' : 'tab_error')
    }
  }

  async function stream(
    res: ServerResponse,
    input: ChatInput,
    includeUsage: boolean,
    meta: { id: string; created: number; model: string },
    signal: AbortSignal,
  ) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' })
    res.socket?.setNoDelay(true)
    const write = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`)
    const chunk = (delta: Obj, finish: string | null = null) =>
      write({ ...meta, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })
    chunk({ role: 'assistant', content: '' })
    // The tab may take minutes before its first token; a comment keeps clients from giving up.
    const beat = setInterval(() => res.write(': keep-alive\n\n'), o.keepAliveMs ?? KEEPALIVE_MS)
    let calls = 0
    try {
      const r = await tab.chat(input, {
        signal,
        onEvent: (e) => {
          if (e.t === 'token') chunk({ content: e.text })
          else if (e.t === 'tool_call') {
            chunk({ tool_calls: e.calls.map((c, i) => ({ index: calls + i, ...toolCall(c) })) })
            calls += e.calls.length
          }
        },
      })
      chunk({}, finishReason(r))
      if (includeUsage) write({ ...meta, object: 'chat.completion.chunk', choices: [], usage: usage(r.usage) })
      res.end('data: [DONE]\n\n')
    } catch (e) {
      if (signal.aborted) return
      // OpenAI's SDKs raise an error for a data chunk that carries one.
      write({ error: { message: (e as Error).message, type: 'api_error', code: null } })
      res.end()
    } finally {
      clearInterval(beat)
    }
  }

  return function route(req: IncomingMessage, res: ServerResponse) {
    const path = (req.url ?? '/').split('?')[0]
    const get = req.method === 'GET' || req.method === 'HEAD'
    if (path === '/health' && get) return sendJson(res, 200, { service: 'rebellm-bridge', ...tab.health() })
    if (path === '/v1/models' && get) {
      const model = tab.health().model
      return sendJson(res, 200, {
        object: 'list',
        data: model ? [{ id: model, object: 'model', created: 0, owned_by: 'rebellm' }] : [],
      })
    }
    if (path === '/v1/chat/completions') {
      if (req.method !== 'POST') return sendError(res, 405, 'use POST', 'invalid_request_error')
      return void completions(req, res).catch((e: unknown) => {
        if (!res.headersSent) sendError(res, 500, (e as Error).message, 'api_error')
        else res.end()
      })
    }
    sendError(res, 404, `no route for ${req.method} ${path}`, 'invalid_request_error', 'not_found')
  }
}
