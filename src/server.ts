import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { isMessagesPath, messagesRoutes, sendApiError } from './anthropic/routes.js'
import { MAX_BODY, pathOf } from './http.js'
import { openaiRoutes, sendError } from './openai.js'
import { TabLink } from './tab.js'
import type { WebSearch } from './websearch.js'

export const DEFAULT_PORT = 7343
export const DEFAULT_HOST = '127.0.0.1'

export interface ServerOptions {
  host: string
  port: number
  token: string
  waitMs: number
  keepAliveMs?: number
  log?: (line: string) => void
  /** Where request lines go; `log` when absent. */
  requestLog?: (line: string) => void
  pingMs?: number
  silenceMs?: number
  /** Runs `web_search` for the Messages API; tests hand in their own. */
  search?: WebSearch
}

export interface BridgeServer {
  tab: TabLink
  host: string
  port: number
  close(): Promise<void>
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

export const isLoopback = (host: string) => LOOPBACK.has(host.replace(/^\[(.*)\]$/, '$1').toLowerCase())

/** The name in a Host header, without the port. */
export function hostName(header: string) {
  if (header.startsWith('[')) return header.slice(1, header.indexOf(']'))
  return header.split(':')[0] ?? ''
}

/** The tab (WebSocket upgrade) and the HTTP clients on one port. */
export async function startServer(o: ServerOptions): Promise<BridgeServer> {
  const log = o.requestLog ?? o.log
  const tab = new TabLink({
    token: o.token,
    ...(o.log ? { log: o.log } : {}),
    ...(log ? { requestLog: log } : {}),
    ...(o.pingMs ? { pingMs: o.pingMs } : {}),
    ...(o.silenceMs ? { silenceMs: o.silenceMs } : {}),
  })
  const routes = openaiRoutes(tab, { waitMs: o.waitMs, ...(o.keepAliveMs ? { keepAliveMs: o.keepAliveMs } : {}), log })
  const messages = messagesRoutes(tab, {
    waitMs: o.waitMs,
    ...(o.keepAliveMs ? { pingMs: o.keepAliveMs } : {}),
    ...(o.search ? { search: o.search } : {}),
    log,
  })
  // On loopback, a foreign Host means a DNS-rebinding page; bound wider, the user chose it.
  const strictHost = isLoopback(o.host)
  const hostOk = (req: IncomingMessage) =>
    !strictHost || req.headers.host === undefined || isLoopback(hostName(req.headers.host))

  const server = createServer((req, res) => {
    // Anthropic clients read only Anthropic's error shape, OpenAI clients only OpenAI's.
    const anthropic = isMessagesPath(pathOf(req))
    // Web pages have no business here; local clients send no Origin.
    if (req.headers.origin !== undefined || !hostOk(req)) {
      const why = 'the bridge answers local clients only'
      return anthropic ? sendApiError(res, 403, 'permission_error', why) : sendError(res, 403, why, 'forbidden')
    }
    if (anthropic) return messages(req, res)
    routes(req, res)
  })
  // Tab frames are small; a tool call bigger than a request body could not be sent back anyway.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY })
  server.on('upgrade', (req, socket, head) => {
    if (!hostOk(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => tab.accept(ws))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(o.port, o.host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  return {
    tab,
    host: o.host,
    port: (server.address() as AddressInfo).port,
    async close() {
      tab.close()
      for (const c of wss.clients) c.terminate()
      wss.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
