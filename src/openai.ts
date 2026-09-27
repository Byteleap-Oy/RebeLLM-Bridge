import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { estimateTokens, tabTooLong } from './anthropic/map.js'
import { StopMatcher } from './anthropic/stop.js'
import { HttpError, clientGone, pathOf, readJson, sendJson } from './http.js'
import type { ChatMessage, ToolCall, ToolSchema, Usage } from './protocol.js'
import { requestLog, type LogLine, type RequestLog } from './reqlog.js'
import { ChatError, type ChatInput, type ChatResult, type TabLink } from './tab.js'

/** Well inside the read timeouts of common clients (Node's fetch: 300 s). */
export const KEEPALIVE_MS = 15_000

export interface RouteOptions {
  /** How long a request waits for a tab with a ready model. */
  waitMs: number
  keepAliveMs?: number
  /** Request lines; none without it. */
  log?: LogLine
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'

/** OpenAI's error shape, which its SDKs turn into readable messages. */
export function sendError(res: ServerResponse, status: number, message: string, type: string, code?: string) {
  sendJson(res, status, { error: { message, type, code: code ?? null } })
}

export type ParsedRequest =
  { input: ChatInput; stream: boolean; includeUsage: boolean; stop: string[] } | { error: string }

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
    // Chat templates take system text only at the start (Qwen's raises otherwise): leading ones
    // merge into one, later ones go as user messages, as on the Anthropic route.
    if (role === 'system') {
      const prev = messages.at(-1)
      if (messages.every((x) => x.role === 'system') && prev) prev.content += `\n\n${content}`
      else messages.push({ role: messages.length ? 'user' : 'system', content })
      continue
    }
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
  let stop: string[] = []
  if (isStr(body.stop)) stop = [body.stop]
  else if (Array.isArray(body.stop) && body.stop.every(isStr)) stop = body.stop
  else if (body.stop !== undefined && body.stop !== null)
    return { error: '`stop` must be a string or an array of strings' }
  const includeUsage = isObj(body.stream_options) && body.stream_options.include_usage === true
  return { input, stream: body.stream === true, includeUsage, stop: stop.filter((x) => x.length > 0) }
}

/** OpenAI's wording and code for a prompt over the model's context. */
export const contextError = (tokens: number, max: number) => ({
  message: `This model's maximum context length is ${max} tokens. However, your messages resulted in ${tokens} tokens. Please reduce the length of the messages.`,
  code: 'context_length_exceeded',
})

interface Answer {
  finish: string
  usage: Usage
}

interface Sink {
  text(text: string): void
  calls(calls: ToolCall[]): void
}

/** Runs one chat, passing text through the stop sequences; a match aborts the chat and finishes with `stop`. */
async function answer(
  tab: TabLink,
  input: ChatInput,
  stops: string[],
  signal: AbortSignal,
  sink: Sink,
  rlog: RequestLog,
): Promise<Answer> {
  const matcher = new StopMatcher(stops)
  const halt = new AbortController()
  let frames = 0
  try {
    const r = await tab.chat(input, {
      signal: AbortSignal.any([signal, halt.signal]),
      onEvent: (e) => {
        if (e.t === 'queued') return rlog.queued(e.position)
        rlog.firstToken()
        if (e.t === 'token') {
          frames++
          sink.text(matcher.push(e.text))
          if (matcher.matched !== null) halt.abort()
        } else {
          // Held text belongs before the call, and no stop sequence spans a tool call.
          sink.text(matcher.flush())
          sink.calls(e.calls)
        }
      },
    })
    sink.text(matcher.flush())
    return { finish: finishReason(r), usage: r.usage }
  } catch (e) {
    if (matcher.matched === null || signal.aborted) throw e
    // The tab's `done` is not awaited after the abort, so the count is the bridge's own.
    return { finish: 'stop', usage: { prompt: estimateTokens(input), completion: frames, tokensPerSec: 0 } }
  }
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
export function completion(
  text: string,
  toolCalls: ToolCall[],
  a: Answer,
  meta: { id: string; created: number; model: string },
) {
  const calls = toolCalls.map(toolCall)
  return {
    ...meta,
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          // OpenAI sends null content beside tool calls when there is no text.
          content: calls.length && !text ? null : text,
          ...(calls.length ? { tool_calls: calls } : {}),
        },
        finish_reason: a.finish,
      },
    ],
    usage: usage(a.usage),
  }
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
    const id = `chatcmpl-${newId()}`
    const rlog = requestLog(o.log, '/v1/chat/completions', id)
    rlog.arrived(estimateTokens(parsed.input), parsed.input.tools?.length ?? 0)
    const gone = clientGone(res)
    const missing = await tab.waitReady(o.waitMs, gone)
    if (gone.aborted) return rlog.aborted()
    if (missing) {
      rlog.refused(503, missing.message)
      return sendError(res, 503, missing.message, 'service_unavailable', missing.code)
    }
    // A prompt that cannot fit is a client error, which SDKs do not retry.
    const estimate = estimateTokens(parsed.input)
    const context = tab.health().contextTokens
    if (context && estimate >= context) {
      const c = contextError(estimate, context)
      rlog.refused(400, c.message)
      return sendError(res, 400, c.message, 'invalid_request_error', c.code)
    }
    const meta = { id, created: Math.floor(Date.now() / 1000), model: tab.modelName }
    if (parsed.stream) return stream(res, parsed, meta, gone, rlog)
    let text = ''
    const calls: ToolCall[] = []
    try {
      const a = await answer(
        tab,
        parsed.input,
        parsed.stop,
        gone,
        { text: (t) => (text += t), calls: (c) => calls.push(...c) },
        rlog,
      )
      rlog.done(a.finish, a.usage.completion)
      sendJson(res, 200, completion(text, calls, a, meta))
    } catch (e) {
      if (gone.aborted) return rlog.aborted()
      const err = e as ChatError
      if (err.kind === 'no_tab') {
        rlog.refused(503, err.message)
        return sendError(res, 503, err.message, 'service_unavailable', 'no_tab')
      }
      rlog.error(err)
      const big = tabTooLong(err.message)
      if (big) {
        const c = contextError(big.tokens, big.max)
        return sendError(res, 400, c.message, 'invalid_request_error', c.code)
      }
      sendError(res, 502, err.message, 'api_error', err.kind === 'disconnected' ? 'tab_disconnected' : 'tab_error')
    }
  }

  async function stream(
    res: ServerResponse,
    parsed: Extract<ParsedRequest, { input: ChatInput }>,
    meta: { id: string; created: number; model: string },
    signal: AbortSignal,
    rlog: RequestLog,
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
      const a = await answer(
        tab,
        parsed.input,
        parsed.stop,
        signal,
        {
          text: (t) => t && chunk({ content: t }),
          calls: (cs) => {
            chunk({ tool_calls: cs.map((c, i) => ({ index: calls + i, ...toolCall(c) })) })
            calls += cs.length
          },
        },
        rlog,
      )
      rlog.done(a.finish, a.usage.completion)
      chunk({}, a.finish)
      if (parsed.includeUsage) write({ ...meta, object: 'chat.completion.chunk', choices: [], usage: usage(a.usage) })
      res.end('data: [DONE]\n\n')
    } catch (e) {
      if (signal.aborted) return rlog.aborted()
      rlog.error(e)
      const message = (e as Error).message
      const big = tabTooLong(message)
      // OpenAI's SDKs raise an error for a data chunk that carries one.
      write({
        error: big
          ? { ...contextError(big.tokens, big.max), type: 'invalid_request_error' }
          : { message, type: 'api_error', code: null },
      })
      res.end()
    } finally {
      clearInterval(beat)
    }
  }

  return function route(req: IncomingMessage, res: ServerResponse) {
    const path = pathOf(req)
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
