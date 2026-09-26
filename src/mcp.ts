import type { Readable, Writable } from 'node:stream'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as z from 'zod'
import type { Usage } from './protocol.js'
import type { ChatInput, ChatOptions, ChatResult, Health, TabLink } from './tab.js'

/** How the MCP face reaches a tab: in this process, or through a bridge already running. */
export interface ChatBackend {
  health(): Promise<Health>
  /** Waits for a ready model like the HTTP face does; rejects with the reason when there is none. */
  chat(input: ChatInput, opts: ChatOptions): Promise<ChatResult>
}

export function tabBackend(tab: TabLink, waitMs: number): ChatBackend {
  return {
    health: async () => tab.health(),
    async chat(input, opts) {
      const missing = await tab.waitReady(waitMs, opts.signal)
      if (missing) throw new Error(missing.message)
      return tab.chat(input, opts)
    },
  }
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

async function errorMessage(r: Response) {
  const body: unknown = await r.json().catch(() => null)
  const err = isObj(body) ? body.error : undefined
  return isObj(err) && typeof err.message === 'string' ? err.message : `the bridge answered ${r.status}`
}

/** The `data:` payloads of a server-sent event stream. */
async function* sseData(body: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder()
  let buf = ''
  for await (const bytes of body) {
    buf += decoder.decode(bytes, { stream: true })
    let end: number
    while ((end = buf.indexOf('\n\n')) >= 0) {
      const event = buf.slice(0, end)
      buf = buf.slice(end + 2)
      const data = event
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
      if (data.length) yield data.join('\n')
    }
  }
}

/** A bridge already serving the port, used through its OpenAI endpoint. */
export function httpBackend(base: string): ChatBackend {
  return {
    async health() {
      const r = await fetch(`${base}/health`)
      if (!r.ok) throw new Error(await errorMessage(r))
      return (await r.json()) as Health
    },
    async chat(input, opts) {
      const r = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: input.messages,
          ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
          ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
          stream: true,
          stream_options: { include_usage: true },
        }),
        ...(opts.signal ? { signal: opts.signal } : {}),
      })
      if (!r.ok || !r.body) throw new Error(await errorMessage(r))
      let text = ''
      let stop: ChatResult['stop'] = 'eos'
      let usage: Usage = { prompt: 0, completion: 0, tokensPerSec: 0 }
      for await (const data of sseData(r.body)) {
        if (data === '[DONE]') break
        const o = JSON.parse(data) as Obj
        if (isObj(o.error)) throw new Error(String(o.error.message ?? 'the bridge failed'))
        const choice = Array.isArray(o.choices) && isObj(o.choices[0]) ? o.choices[0] : undefined
        const piece = isObj(choice?.delta) ? choice.delta.content : undefined
        if (typeof piece === 'string' && piece) {
          text += piece
          opts.onEvent?.({ t: 'token', text: piece })
        }
        if (choice?.finish_reason === 'length') stop = 'length'
        if (isObj(o.usage))
          usage = {
            prompt: Number(o.usage.prompt_tokens),
            completion: Number(o.usage.completion_tokens),
            tokensPerSec: 0,
          }
      }
      return { id: '', text, calls: [], stop, usage }
    },
  }
}

/** The `status` tool's text; never the token, which would end up in the client's context. */
export function describeHealth(h: Health): string {
  if (!h.tab)
    return (
      'No RebeLLM tab is connected. In RebeLLM → Settings → Local bridge, paste the bridge token ' +
      '(printed at its first start, stored in ~/.rebellm-bridge/token) and turn the switch on.'
    )
  const tab = `A RebeLLM tab is connected${h.app ? ` (app ${h.app})` : ''}.`
  const model = h.model ? `The model ${h.model}` : 'The model'
  if (h.state === 'ready')
    return `${tab} ${model} is ready${h.contextTokens ? `, with a context of ${h.contextTokens} tokens` : ''}.`
  if (h.state === 'loading') return `${tab} ${model} is loading${h.detail ? ` (${h.detail})` : ''}.`
  return `${tab} ${model} is not available${h.detail ? `: ${h.detail}` : ''}.`
}

const message = z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() })

export function createMcpServer(backend: ChatBackend, version: string): McpServer {
  const server = new McpServer({ name: 'rebellm-bridge', version })
  server.registerTool(
    'chat',
    {
      title: 'Ask the RebeLLM model',
      description:
        "Sends a conversation to the model running in the user's RebeLLM browser tab (a local model on this " +
        "machine's GPU) and returns its answer. Waits for the tab when it is not connected or its model is loading.",
      inputSchema: {
        messages: z.array(message).min(1).describe('The conversation; the last message is usually from the user'),
        max_tokens: z.number().int().positive().optional().describe('Most tokens in the answer'),
        temperature: z.number().min(0).optional(),
      },
    },
    async ({ messages, max_tokens, temperature }, extra) => {
      const token = extra._meta?.progressToken
      let n = 0
      const progress = (message: string) =>
        token !== undefined &&
        void extra
          .sendNotification({
            method: 'notifications/progress',
            params: { progressToken: token, progress: ++n, message },
          })
          .catch(() => undefined)
      try {
        const r = await backend.chat(
          {
            messages,
            ...(max_tokens !== undefined ? { maxTokens: max_tokens } : {}),
            ...(temperature !== undefined ? { temperature } : {}),
          },
          {
            signal: extra.signal,
            onEvent: (e) => {
              if (e.t === 'token') progress(e.text)
              else if (e.t === 'queued') progress(`waiting in the tab's queue, position ${e.position}`)
            },
          },
        )
        return { content: [{ type: 'text', text: r.text }] }
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: `RebeLLM: ${(e as Error).message}` }] }
      }
    },
  )
  server.registerTool(
    'status',
    {
      title: 'RebeLLM tab status',
      description: 'Tells whether a RebeLLM tab is connected to the bridge and whether its model is ready.',
    },
    async () => {
      try {
        return { content: [{ type: 'text', text: describeHealth(await backend.health()) }] }
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: `RebeLLM: ${(e as Error).message}` }] }
      }
    },
  )
  return server
}

/** Serves MCP over stdio until the client closes its end. */
export async function serveStdio(server: McpServer, stdin: Readable, stdout: Writable): Promise<void> {
  const closed = new Promise<void>((resolve) => {
    stdin.once('end', resolve)
    stdin.once('close', resolve)
  })
  await server.connect(new StdioServerTransport(stdin, stdout))
  await closed
  await server.close()
}
