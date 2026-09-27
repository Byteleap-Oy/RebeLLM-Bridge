import { once } from 'node:events'
import { request } from 'node:http'
import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { hostName, isLoopback, startServer } from './server.js'
import { TOKEN, bridge } from './test/harness.js'

/** GET with headers fetch will not let a caller set. */
function get(url: string, headers: Record<string, string>) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(url, { headers }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('server', () => {
  it('serves the tab and HTTP clients on one port', async () => {
    const b = await bridge()
    expect(await (await fetch(`${b.base}/health`)).json()).toEqual({
      service: 'rebellm-bridge',
      tab: false,
      state: 'none',
    })
    await b.tab('qwen')
    await once(b.server.tab, 'change')
    expect(await (await fetch(`${b.base}/health`)).json()).toMatchObject({ tab: true, state: 'ready', model: 'qwen' })
  })

  it('refuses web pages and foreign hosts', async () => {
    const b = await bridge()
    const fromPage = await fetch(`${b.base}/health`, { headers: { Origin: 'https://example.com' } })
    expect(fromPage.status).toBe(403)
    expect(await fromPage.json()).toMatchObject({ error: { type: 'forbidden' } })
    expect((await get(`${b.base}/health`, { Host: 'rebind.example:7343' })).status).toBe(403)
    expect((await get(`${b.base}/health`, { Host: `localhost:${b.server.port}` })).status).toBe(200)
    expect((await get(`${b.base}/health`, { Host: `[::1]:${b.server.port}` })).status).toBe(200)

    const ws = new WebSocket(b.ws, { headers: { Host: 'rebind.example' } })
    ws.on('error', () => undefined)
    const [, res] = (await once(ws, 'unexpected-response')) as [unknown, { statusCode: number }]
    expect(res.statusCode).toBe(403)
    ws.terminate()
  })

  it('lets the tab connect from its own origin, which the token protects', async () => {
    const b = await bridge()
    const ws = new WebSocket(b.ws, { headers: { Origin: 'https://rebellm.ai' } })
    await once(ws, 'open')
    ws.send(JSON.stringify({ t: 'hello', v: 1, token: TOKEN, model: '', contextTokens: 0, app: 't' }))
    const [data] = (await once(ws, 'message')) as [Buffer]
    expect(JSON.parse(data.toString())).toEqual({ t: 'ok', features: ['fetch'] })
    ws.terminate()
  })

  it("refuses the tab's fetch of a private address without connecting, and logs it as a request line", async () => {
    const requests: string[] = []
    const b = await bridge({ requestLog: (l) => requests.push(l) })
    const fake = await b.tab()
    fake.send({ t: 'fetch', id: 'p1', url: 'http://192.168.1.1/admin?token=x' })
    expect(await fake.next((m) => m.t === 'error')).toEqual({
      t: 'error',
      id: 'p1',
      message: '192.168.1.1 is not a public address',
    })
    expect(requests).toEqual(['fetch 192.168.1.1: error 192.168.1.1 is not a public address'])
    expect(b.lines.some((l) => l.startsWith('fetch '))).toBe(false)
  })

  it('answers unknown routes with 404 in the OpenAI error shape', async () => {
    const b = await bridge()
    const r = await fetch(`${b.base}/v1/embeddings`, { method: 'POST', body: '{}' })
    expect(r.status).toBe(404)
    expect(await r.json()).toEqual({
      error: { message: 'no route for POST /v1/embeddings', type: 'invalid_request_error', code: 'not_found' },
    })
  })

  it('fails to start on a port in use and frees its port on close', async () => {
    const b = await bridge()
    const clash = startServer({ host: '127.0.0.1', port: b.server.port, token: TOKEN, waitMs: 0 })
    await expect(clash).rejects.toMatchObject({ code: 'EADDRINUSE' })
    const other = await startServer({ host: '127.0.0.1', port: 0, token: TOKEN, waitMs: 0 })
    const port = other.port
    await other.close()
    const again = await startServer({ host: '127.0.0.1', port, token: TOKEN, waitMs: 0 })
    await again.close()
  })

  it('knows loopback names and the name in a Host header', () => {
    expect(['127.0.0.1', 'localhost', 'LOCALHOST', '::1', '[::1]'].every(isLoopback)).toBe(true)
    expect(['0.0.0.0', '192.168.1.2', 'example.com'].some(isLoopback)).toBe(false)
    expect(hostName('127.0.0.1:7343')).toBe('127.0.0.1')
    expect(hostName('[::1]:7343')).toBe('::1')
    expect(hostName('localhost')).toBe('localhost')
  })
})
