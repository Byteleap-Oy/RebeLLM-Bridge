import type { IncomingMessage, ServerResponse } from 'node:http'
import { HttpError, clientGone, pathOf, readJson, sendJson } from '../http.js'
import { ChatError, type ChatInput, type TabLink } from '../tab.js'
import {
  content,
  estimateTokens,
  message,
  newId,
  stopReason,
  tabError,
  tabUsage,
  toChatInput,
  tooLong,
  toolUse,
  usage,
} from './map.js'
import { EventWriter } from './sse.js'
import { StopMatcher } from './stop.js'
import type { ErrorType, StopReason, ToolUseBlock, Usage } from './types.js'

/** The Messages API sends a ping about this often; clients expect something within a minute. */
export const PING_MS = 10_000

export interface MessagesOptions {
  /** How long a request waits for a tab with a ready model. */
  waitMs: number
  pingMs?: number
}

/** Anthropic's error shape, the only one its SDKs (and Claude Code) read. */
export function sendApiError(res: ServerResponse, status: number, type: ErrorType, message: string) {
  sendJson(res, status, { type: 'error', error: { type, message } })
}

export const isMessagesPath = (path: string) => path === '/v1/messages' || path.startsWith('/v1/messages/')

interface Outcome {
  reason: StopReason
  sequence: string | null
  usage: Usage
}

interface Sink {
  text(text: string): void
  toolUse(block: ToolUseBlock): void
}

/**
 * Runs one chat on the tab, passing text through the stop sequences. A match aborts the chat;
 * its usage is then the bridge's own count, since the tab's `done` is not awaited.
 */
async function answer(
  tab: TabLink,
  input: ChatInput,
  stops: string[],
  estimate: number,
  signal: AbortSignal,
  sink: Sink,
): Promise<Outcome> {
  const matcher = new StopMatcher(stops)
  const halt = new AbortController()
  let frames = 0
  try {
    const r = await tab.chat(input, {
      signal: AbortSignal.any([signal, halt.signal]),
      onEvent: (e) => {
        if (e.t === 'token') {
          frames++
          sink.text(matcher.push(e.text))
          if (matcher.matched !== null) halt.abort()
        } else if (e.t === 'tool_call') for (const c of e.calls) sink.toolUse(toolUse(c))
      },
    })
    sink.text(matcher.flush())
    return { reason: stopReason(r.stop, r.calls.length), sequence: null, usage: tabUsage(r.usage) }
  } catch (e) {
    if (matcher.matched === null || signal.aborted) throw e
    return { reason: 'stop_sequence', sequence: matcher.matched, usage: usage(estimate, frames) }
  }
}

/** `POST /v1/messages` and `POST /v1/messages/count_tokens` for Anthropic clients such as Claude Code. */
export function messagesRoutes(tab: TabLink, o: MessagesOptions) {
  async function body(req: IncomingMessage, res: ServerResponse) {
    try {
      return await readJson(req)
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 400
      sendApiError(res, status, status === 413 ? 'request_too_large' : 'invalid_request_error', (e as Error).message)
      return undefined
    }
  }

  async function messages(req: IncomingMessage, res: ServerResponse) {
    const raw = await body(req, res)
    if (raw === undefined) return
    const parsed = toChatInput(raw)
    if ('error' in parsed) return sendApiError(res, 400, 'invalid_request_error', parsed.error)
    const gone = clientGone(res)
    const missing = await tab.waitReady(o.waitMs, gone)
    if (gone.aborted) return
    if (missing) return sendApiError(res, 503, 'api_error', missing.message)
    const estimate = estimateTokens(parsed.input)
    const context = tab.health().contextTokens
    if (context && estimate >= context)
      return sendApiError(res, 400, 'invalid_request_error', tooLong(estimate, context - 1))
    const meta = { id: `msg_${newId()}`, model: tab.modelName }
    const { input, stopSequences } = parsed

    if (parsed.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' })
      res.socket?.setNoDelay(true)
      const w = new EventWriter(res)
      w.start(message(meta, [], { reason: null, sequence: null }, usage(estimate, 0)))
      const beat = setInterval(() => w.ping(), o.pingMs ?? PING_MS)
      try {
        const out = await answer(tab, input, stopSequences, estimate, gone, {
          text: (t) => w.text(t),
          toolUse: (b) => w.toolUse(b),
        })
        w.finish(out.reason, out.sequence, out.usage)
      } catch (e) {
        if (!gone.aborted) w.error(tabError((e as Error).message))
      } finally {
        clearInterval(beat)
      }
      return
    }

    let text = ''
    const calls: ToolUseBlock[] = []
    try {
      const out = await answer(tab, input, stopSequences, estimate, gone, {
        text: (t) => (text += t),
        toolUse: (b) => calls.push(b),
      })
      sendJson(res, 200, message(meta, content(text, calls), { reason: out.reason, sequence: out.sequence }, out.usage))
    } catch (e) {
      if (gone.aborted) return
      const err = e as ChatError
      if (err instanceof ChatError && err.kind === 'no_tab') return sendApiError(res, 503, 'api_error', err.message)
      const api = tabError(err.message)
      sendApiError(res, api.type === 'invalid_request_error' ? 400 : 502, api.type, api.message)
    }
  }

  async function countTokens(req: IncomingMessage, res: ServerResponse) {
    const raw = await body(req, res)
    if (raw === undefined) return
    const parsed = toChatInput(raw)
    if ('error' in parsed) return sendApiError(res, 400, 'invalid_request_error', parsed.error)
    sendJson(res, 200, { input_tokens: estimateTokens(parsed.input) })
  }

  return function route(req: IncomingMessage, res: ServerResponse) {
    const path = pathOf(req)
    const handler = path === '/v1/messages' ? messages : path === '/v1/messages/count_tokens' ? countTokens : undefined
    if (!handler) return sendApiError(res, 404, 'not_found_error', `no route for ${req.method} ${path}`)
    if (req.method !== 'POST') return sendApiError(res, 405, 'invalid_request_error', 'use POST')
    void handler(req, res).catch((e: unknown) => {
      if (!res.headersSent) sendApiError(res, 500, 'api_error', (e as Error).message)
      else res.end()
    })
  }
}
