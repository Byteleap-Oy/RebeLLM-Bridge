import { ChatError } from './tab.js'

export type LogLine = (line: string) => void

/** The lifecycle of one chat request as log lines; message content never goes in. */
export interface RequestLog {
  arrived(tokens: number, tools: number): void
  queued(position: number): void
  /** Only the first call writes a line. */
  firstToken(): void
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
    queued: (position) => line(`queued at ${position} ${since()}`),
    firstToken: () => {
      if (first) return
      first = true
      line(`first token ${since()}`)
    },
    done: (why, tokens) => line(`done ${why}, ${count(tokens, 'token')}, ${since()}`),
    aborted: () => line(`client aborted ${since()}`),
    error: (e) => line(`error ${reason(e)} ${since()}`),
    refused: (status, message) => line(`refused ${status} ${message} ${since()}`),
  }
}
