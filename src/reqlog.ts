import { ChatError } from './tab.js'

export type LogLine = (line: string) => void

/** What of a request the tab did not get; the log names it, never the content. */
export interface Ignored {
  /** Content block types replaced by a placeholder, with counts. */
  blocks: Record<string, number>
  /** A forced tool choice: `any`, or `tool <name>`. */
  toolChoice?: string
  /** The types of the server tools dropped. */
  serverTools: string[]
}

/** The lifecycle of one chat request as log lines; message content never goes in. */
export interface RequestLog {
  arrived(tokens: number, tools: number): void
  /** Writes nothing when the tab got everything. */
  ignored(i: Ignored): void
  queued(position: number): void
  /** Only the first call writes a line. */
  firstToken(): void
  /** A web search the bridge ran: its result count or error code, never the query. */
  searched(outcome: number | string): void
  done(reason: string, outputTokens: number): void
  aborted(): void
  error(e: unknown): void
  refused(status: number, message: string): void
}

/** 11204 as `11 204`. */
const group = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
const count = (n: number, word: string) => `${group(n)} ${word}${n === 1 ? '' : 's'}`

const reason = (e: unknown) =>
  e instanceof ChatError && e.kind === 'tab'
    ? `the tab reported: ${e.message}`
    : e instanceof Error
      ? e.message
      : String(e)

/** Lines `chat <id> <route>: <event>`, timed from this call; a missing `log` writes nothing. */
export function requestLog(log: LogLine | undefined, route: string, id: string, now = Date.now): RequestLog {
  const start = now()
  const line = (event: string) => log?.(`chat ${id} ${route}: ${event}`)
  const since = () => `+${((now() - start) / 1000).toFixed(1)}s`
  let first = false
  return {
    arrived: (tokens, tools) => line(`arrived, ${count(tokens, 'prompt token')}, ${count(tools, 'tool')}`),
    ignored: (i) => {
      const parts = [
        ...Object.entries(i.blocks).map(([type, n]) => count(n, `${type} block`)),
        ...(i.toolChoice ? [`tool_choice ${i.toolChoice}`] : []),
        ...i.serverTools.map((t) => `server tool ${t}`),
      ]
      if (parts.length) line(`ignored ${parts.join(', ')}`)
    },
    queued: (position) => line(`queued at ${position} ${since()}`),
    firstToken: () => {
      if (first) return
      first = true
      line(`first token ${since()}`)
    },
    searched: (o) => line(`search ${typeof o === 'number' ? count(o, 'result') : `error ${o}`} ${since()}`),
    done: (why, tokens) => line(`done ${why}, ${count(tokens, 'token')}, ${since()}`),
    aborted: () => line(`client aborted ${since()}`),
    error: (e) => line(`error ${reason(e)} ${since()}`),
    refused: (status, message) => line(`refused ${status} ${message} ${since()}`),
  }
}
