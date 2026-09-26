import { onTestFinished } from 'vitest'
import { startServer, type ServerOptions } from '../server.js'
import { FakeTab } from './fake-tab.js'

export const TOKEN = 'test-token'

/** A bridge on a free loopback port, stopped when the test ends. */
export async function bridge(o: Partial<ServerOptions> = {}) {
  const lines: string[] = []
  const server = await startServer({
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    waitMs: 200,
    log: (l) => lines.push(l),
    ...o,
  })
  const tabs: FakeTab[] = []
  onTestFinished(async () => {
    for (const t of tabs) t.ws.terminate()
    await server.close()
  })
  const ws = `ws://127.0.0.1:${server.port}`
  return {
    server,
    lines,
    ws,
    base: `http://127.0.0.1:${server.port}`,
    /** A connected tab whose model is ready. */
    tab: async (model: string | null = 'test-model') => {
      const t = await FakeTab.ready(ws, TOKEN, model)
      tabs.push(t)
      return t
    },
  }
}
