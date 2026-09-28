import type { IncomingMessage, ServerResponse } from 'node:http'
import { HttpError, clientGone, pathOf, readJson, sendJson } from '../http.js'
import type { ChatMessage } from '../protocol.js'
import { requestLog, type LogLine, type RequestLog } from '../reqlog.js'
import { ChatError, type ChatInput, type TabLink } from '../tab.js'
import { SearchError, duckDuckGo, resultsText, type WebSearch } from '../websearch.js'
import {
  SEARCH_NAME,
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
  type SearchTool,
} from './map.js'
import { EventWriter } from './sse.js'
import { StopMatcher } from './stop.js'
import type {
  ContentBlock,
  ErrorType,
  ServerToolUseBlock,
  StopReason,
  ToolUseBlock,
  Usage,
  WebSearchError,
  WebSearchToolResultBlock,
} from './types.js'

/** The Messages API sends a ping about this often; clients expect something within a minute. */
export const PING_MS = 10_000

export interface MessagesOptions {
  /** How long a request waits for a tab with a ready model. */
  waitMs: number
  pingMs?: number
  /** Request lines; none without it. */
  log?: LogLine
  /** Runs the tab's `web_search` calls; DuckDuckGo from this computer by default. */
  search?: WebSearch
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

interface SearchSink {
  text(text: string): void
  toolUse(block: ToolUseBlock | ServerToolUseBlock): void
  searchResult(block: WebSearchToolResultBlock): void
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
  rlog: RequestLog,
): Promise<Outcome> {
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
          for (const c of e.calls) sink.toolUse(toolUse(c))
        }
      },
    })
    sink.text(matcher.flush())
    return { reason: stopReason(r.stop, r.calls.length), sequence: null, usage: tabUsage(r.usage) }
  } catch (e) {
    if (matcher.matched === null || signal.aborted) throw e
    return { reason: 'stop_sequence', sequence: matcher.matched, usage: usage(estimate, frames) }
  }
}

interface Searched {
  content: WebSearchToolResultBlock['content']
  /** What the tab reads. */
  text: string
}

const failed = (code: WebSearchError['error_code']): Searched => ({
  content: { type: 'web_search_tool_result_error', error_code: code },
  text:
    code === 'max_uses_exceeded'
      ? 'Error: no searches left; answer with what you have.'
      : `Error: the search failed (${code}); answer without it.`,
})

/**
 * Answers with the tab; with a `web_search` server tool, runs each search the tab asks for,
 * gives it the results and chats again, until it answers without searching.
 */
async function respond(
  tab: TabLink,
  parsed: { input: ChatInput; stopSequences: string[]; search?: SearchTool },
  estimate: number,
  signal: AbortSignal,
  sink: SearchSink,
  rlog: RequestLog,
  search: WebSearch,
): Promise<Outcome> {
  const { input, stopSequences: stops, search: web } = parsed
  if (!web) return answer(tab, input, stops, estimate, signal, sink, rlog)
  let messages = input.messages
  let uses = 0
  let searches = 0
  let output = 0
  const total = (o: Outcome): Outcome => ({
    ...o,
    usage: {
      ...o.usage,
      output_tokens: output,
      ...(searches ? { server_tool_use: { web_search_requests: searches } } : {}),
    },
  })
  const run = async (query: unknown): Promise<Searched> => {
    try {
      const found = await search(typeof query === 'string' ? query : '', {
        allowed: web.allowed,
        blocked: web.blocked,
        signal,
      })
      searches++
      rlog.searched(found.length)
      return {
        content: found.map((r) => ({
          type: 'web_search_result',
          url: r.url,
          title: r.title,
          encrypted_content: '',
          page_age: null,
        })),
        text: resultsText(found),
      }
    } catch (e) {
      if (signal.aborted) throw e
      const code = e instanceof SearchError ? e.code : 'unavailable'
      rlog.searched(code)
      return failed(code)
    }
  }
  for (;;) {
    // Out of searches, the tab is no longer offered the tool.
    const offered = uses < web.maxUses
    const tools = offered ? input.tools : input.tools?.filter((t) => t.function.name !== SEARCH_NAME)
    const round: ChatInput = { ...input, messages }
    if (tools?.length) round.tools = tools
    else delete round.tools
    let text = ''
    let clientCalls = 0
    const calls: ToolUseBlock[] = []
    const out = await answer(
      tab,
      round,
      stops,
      estimate,
      signal,
      {
        text: (t) => {
          text += t
          sink.text(t)
        },
        toolUse: (b) => {
          if (b.name === SEARCH_NAME) calls.push(b)
          else {
            clientCalls++
            sink.toolUse(b)
          }
        },
      },
      rlog,
    )
    output += out.usage.output_tokens
    if (out.reason === 'stop_sequence' || !calls.length) return total(out)
    const results: ChatMessage[] = []
    for (const c of calls) {
      const id = `srvtoolu_${newId()}`
      sink.toolUse({ type: 'server_tool_use', id, name: SEARCH_NAME, input: c.input })
      const r = ++uses > web.maxUses ? failed('max_uses_exceeded') : await run(c.input.query)
      sink.searchResult({ type: 'web_search_tool_result', tool_use_id: id, content: r.content })
      results.push({ role: 'tool', name: SEARCH_NAME, content: r.text })
    }
    // Client tool calls end the answer; the client runs them and asks again.
    if (clientCalls) return total({ ...out, reason: 'tool_use' })
    // A tab that searches with no search tool offered would never stop.
    if (!offered) return total({ ...out, reason: 'end_turn' })
    const asked = calls.map((c) => ({ id: c.id, function: { name: c.name, arguments: c.input } }))
    messages = [...messages, { role: 'assistant', content: text, tool_calls: asked }, ...results]
  }
}

/** `POST /v1/messages` and `POST /v1/messages/count_tokens` for Anthropic clients such as Claude Code. */
export function messagesRoutes(tab: TabLink, o: MessagesOptions) {
  const search = o.search ?? duckDuckGo()

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
    const id = `msg_${newId()}`
    const estimate = estimateTokens(parsed.input)
    const rlog = requestLog(o.log, '/v1/messages', id)
    rlog.arrived(estimate, parsed.input.tools?.length ?? 0)
    const refuse = (status: number, type: ErrorType, message: string) => {
      rlog.refused(status, message)
      sendApiError(res, status, type, message)
    }
    const gone = clientGone(res)
    const missing = await tab.waitReady(o.waitMs, gone)
    if (gone.aborted) return rlog.aborted()
    if (missing) return refuse(503, 'api_error', missing.message)
    const context = tab.health().contextTokens
    if (context && estimate >= context) return refuse(400, 'invalid_request_error', tooLong(estimate, context - 1))
    const meta = { id, model: tab.modelName }

    if (parsed.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' })
      res.socket?.setNoDelay(true)
      const w = new EventWriter(res)
      w.start(message(meta, [], { reason: null, sequence: null }, usage(estimate, 0)))
      const beat = setInterval(() => w.ping(), o.pingMs ?? PING_MS)
      try {
        const out = await respond(
          tab,
          parsed,
          estimate,
          gone,
          { text: (t) => w.text(t), toolUse: (b) => w.toolUse(b), searchResult: (b) => w.searchResult(b) },
          rlog,
          search,
        )
        rlog.done(out.reason, out.usage.output_tokens)
        w.finish(out.reason, out.sequence, out.usage)
      } catch (e) {
        if (gone.aborted) rlog.aborted()
        else {
          rlog.error(e)
          w.error(tabError((e as Error).message))
        }
      } finally {
        clearInterval(beat)
      }
      return
    }

    // Text and searches in the order they came, text between searches merged; client calls last.
    const blocks: ContentBlock[] = []
    const calls: ToolUseBlock[] = []
    const collect: SearchSink = {
      text: (t) => {
        const last = blocks.at(-1)
        if (last?.type === 'text') last.text += t
        else if (t) blocks.push({ type: 'text', text: t })
      },
      toolUse: (b) => (b.type === 'tool_use' ? calls.push(b) : blocks.push(b)),
      searchResult: (b) => blocks.push(b),
    }
    // A slow answer gets its headers and a space now and then: some clients drop a silent
    // connection after minutes, and JSON allows leading whitespace.
    const pingMs = o.pingMs ?? PING_MS
    let beat: ReturnType<typeof setInterval> | undefined
    const start = setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.write(' ')
      beat = setInterval(() => res.write(' '), pingMs)
    }, pingMs)
    const finish = (status: number, body: unknown) => {
      if (!res.headersSent) return sendJson(res, status, body)
      res.end(JSON.stringify(body))
    }
    try {
      const out = await respond(tab, parsed, estimate, gone, collect, rlog, search)
      rlog.done(out.reason, out.usage.output_tokens)
      const answered = blocks.length || calls.length ? [...blocks, ...calls] : content('', [])
      finish(200, message(meta, answered, { reason: out.reason, sequence: out.sequence }, out.usage))
    } catch (e) {
      if (gone.aborted) return rlog.aborted()
      const err = e as ChatError
      const api =
        err instanceof ChatError && err.kind === 'no_tab'
          ? { type: 'api_error' as const, message: err.message }
          : tabError(err.message)
      const status =
        err instanceof ChatError && err.kind === 'no_tab' ? 503 : api.type === 'invalid_request_error' ? 400 : 502
      if (status === 503 && !res.headersSent) return refuse(503, 'api_error', err.message)
      if (status === 503) rlog.refused(503, err.message)
      else rlog.error(err)
      finish(status, { type: 'error', error: api })
    } finally {
      clearTimeout(start)
      clearInterval(beat)
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
