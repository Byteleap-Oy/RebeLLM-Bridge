import type { IncomingMessage, ServerResponse } from 'node:http'

/** Long conversations are large, but not this large. */
export const MAX_BODY = 8 << 20
const MAX_DISCARD = 8 * MAX_BODY

export class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** The request body as JSON; rejects with an HttpError (413 or 400). */
export function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size <= MAX_BODY) return void chunks.push(c)
      chunks.length = 0
      reject(new HttpError(413, 'the request body is too large'))
      // Reading on lets the client finish sending and see the 413; past this it is not listening.
      if (size > MAX_DISCARD) req.destroy()
    })
    req.on('end', () => {
      if (size > MAX_BODY) return
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new HttpError(400, 'the body is not JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** The path of a request URL, without the query (Claude Code adds `?beta=true`). */
export const pathOf = (req: IncomingMessage) => (req.url ?? '/').split('?')[0] ?? '/'

/** Aborts when the client goes away before the response is finished. */
export function clientGone(res: ServerResponse): AbortSignal {
  const gone = new AbortController()
  res.on('close', () => !res.writableFinished && gone.abort())
  return gone.signal
}
