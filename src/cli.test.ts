import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  TOKEN_FLAG_WARNING,
  USAGE,
  VERSION,
  hostWarning,
  keepToken,
  main,
  parseCli,
  resolveToken,
  run,
  tokenFile,
  type Io,
} from './cli.js'
import { FakeTab } from './test/fake-tab.js'
import { bridge } from './test/harness.js'

function home() {
  const dir = mkdtempSync(join(tmpdir(), 'rebellm-bridge-test-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function sink() {
  const stream = new PassThrough()
  let text = ''
  stream.on('data', (c: Buffer) => (text += c.toString()))
  return { stream, text: () => text }
}

function io(env: NodeJS.ProcessEnv = {}) {
  const out = sink()
  const err = sink()
  const stdin = new PassThrough()
  const value: Io = { stdout: out.stream, stderr: err.stream, stdin, env, home: home() }
  return { io: value, out, err, stdin }
}

const defaults = {
  port: 7343,
  host: '127.0.0.1',
  waitSec: 120,
  mcp: false,
  quiet: false,
  help: false,
  version: false,
}

describe('parseCli', () => {
  it('has the documented defaults and reads every flag', () => {
    expect(parseCli([])).toEqual(defaults)
    expect(
      parseCli(['--port', '8000', '--host', '0.0.0.0', '--token', ' t ', '--wait', '5', '--mcp', '--quiet']),
    ).toEqual({
      ...defaults,
      port: 8000,
      host: '0.0.0.0',
      token: 't',
      waitSec: 5,
      mcp: true,
      quiet: true,
    })
    expect(parseCli(['--wait', '0', '--port', '0'])).toMatchObject({ waitSec: 0, port: 0 })
  })

  it('rejects what it cannot use', () => {
    expect(parseCli(['--port', 'x'])).toEqual({ error: '--port x is not a port number' })
    expect(parseCli(['--port', '70000'])).toHaveProperty('error')
    expect(parseCli(['--wait=-1'])).toEqual({ error: '--wait -1 is not a number of seconds' })
    expect(parseCli(['--token', ' '])).toEqual({ error: '--token needs a value' })
    expect(parseCli(['--port='])).toEqual({ error: '--port needs a value' })
    expect(parseCli(['--port', ' '])).toEqual({ error: '--port needs a value' })
    expect(parseCli(['--wait='])).toEqual({ error: '--wait needs a value' })
    expect(parseCli(['--nope'])).toHaveProperty('error')
    expect(parseCli(['stray'])).toHaveProperty('error')
  })

  it('warns about any address but loopback', () => {
    expect(hostWarning('127.0.0.1')).toBeNull()
    expect(hostWarning('localhost')).toBeNull()
    expect(hostWarning('0.0.0.0')).toContain('lets other machines use your model')
  })
})

describe('resolveToken', () => {
  it('creates a token, stores it owner-only only when kept, and reuses it', () => {
    const h = home()
    const first = resolveToken({ home: h })
    expect(first).toMatchObject({ source: 'file', created: true, file: tokenFile(h) })
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(() => statSync(tokenFile(h))).toThrow()
    keepToken(first)
    expect(readFileSync(tokenFile(h), 'utf8').trim()).toBe(first.token)
    // Windows keeps no Unix mode bits.
    if (process.platform !== 'win32') expect(statSync(tokenFile(h)).mode & 0o777).toBe(0o600)
    expect(resolveToken({ home: h })).toEqual({ ...first, created: false })
  })

  it('lets the flag, then the environment, override the file', () => {
    const h = home()
    expect(resolveToken({ home: h, env: 'from-env' })).toMatchObject({ token: 'from-env', source: 'env' })
    expect(resolveToken({ home: h, env: 'from-env', flag: 'from-flag' })).toMatchObject({
      token: 'from-flag',
      source: 'flag',
    })
    expect(() => statSync(tokenFile(h))).toThrow()
  })

  it('replaces an empty token file', () => {
    const h = home()
    mkdirSync(dirname(tokenFile(h)), { recursive: true })
    writeFileSync(tokenFile(h), '\n')
    expect(resolveToken({ home: h })).toMatchObject({ created: true })
  })
})

describe('run', () => {
  it('prints a new token once with where to paste it, and accepts a tab presenting it', async () => {
    const t = io()
    const running = await run({ ...defaults, port: 0 }, t.io)
    onTestFinished(() => running.close())
    const token = readFileSync(tokenFile(t.io.home), 'utf8').trim()
    const port = running.server!.port
    expect(t.out.text()).toContain(`\n  ${token}\n`)
    expect(t.out.text()).toContain('Paste it into RebeLLM → Bridge and turn the switch on.')
    expect(t.out.text()).toContain(`  tab:    ws://127.0.0.1:${port}`)
    expect(t.out.text()).toContain(`  OpenAI: http://127.0.0.1:${port}/v1`)
    expect(t.out.text()).toContain(
      `  Claude: http://127.0.0.1:${port}  (Anthropic API; rebellm-claude runs Claude Code`,
    )
    expect(t.err.text()).toBe('')
    const tab = await FakeTab.ready(`ws://127.0.0.1:${port}`, token)
    onTestFinished(() => void tab.ws.terminate())
    await once(running.server!.tab, 'change')
    expect(running.server!.tab.health()).toMatchObject({ tab: true, state: 'ready' })
    expect(t.out.text()).toContain('rebellm-bridge: RebeLLM tab connected')
  })

  it('logs a line per request event unless --quiet, and the tab either way', async () => {
    for (const quiet of [false, true]) {
      const t = io({ REBELLM_BRIDGE_TOKEN: 'env-token' })
      const running = await run({ ...defaults, port: 0, quiet }, t.io)
      onTestFinished(() => running.close())
      const port = running.server!.port
      const tab = await FakeTab.ready(`ws://127.0.0.1:${port}`, 'env-token')
      onTestFinished(() => void tab.ws.terminate())
      tab.onChat = (c) => tab.answer(c.id, ['ok'])
      const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        body: JSON.stringify({ messages: [{ role: 'user', content: 'private words' }] }),
      })
      const { id } = (await r.json()) as { id: string }
      const out = t.out.text()
      expect(out).toContain('rebellm-bridge: RebeLLM tab connected')
      expect(out).not.toContain('private words')
      if (quiet) expect(out).not.toContain('rebellm-bridge: chat ')
      else {
        expect(out).toContain(`rebellm-bridge: chat ${id} /v1/chat/completions: arrived, 4 prompt tokens, 0 tools\n`)
        expect(out).toMatch(new RegExp(`rebellm-bridge: chat ${id} /v1/chat/completions: done stop, 1 token, \\+`))
      }
    }
  })

  it('does not print a stored token again', async () => {
    const t = io()
    const first = await run({ ...defaults, port: 0 }, t.io)
    await first.close()
    const again = sink()
    const second = await run({ ...defaults, port: 0 }, { ...t.io, stdout: again.stream })
    onTestFinished(() => second.close())
    const token = readFileSync(tokenFile(t.io.home), 'utf8').trim()
    expect(again.text()).not.toContain(token)
    expect(again.text()).toContain(`token:  in ${tokenFile(t.io.home)}`)
  })

  it('takes the token from the environment without touching the file', async () => {
    const t = io({ REBELLM_BRIDGE_TOKEN: 'env-token' })
    const running = await run({ ...defaults, port: 0 }, t.io)
    onTestFinished(() => running.close())
    expect(t.out.text()).toContain('token:  from REBELLM_BRIDGE_TOKEN')
    expect(t.out.text()).not.toContain('env-token')
    expect(() => statSync(tokenFile(t.io.home))).toThrow()
  })

  it('fails with a message when the port is taken', async () => {
    const b = await bridge()
    const t = io()
    await expect(run({ ...defaults, port: b.server.port }, t.io)).rejects.toThrow(
      `port ${b.server.port} on 127.0.0.1 is in use (another rebellm-bridge?)`,
    )
    expect(await main(['--port', String(b.server.port)], t.io)).toBe(1)
    expect(t.err.text()).toContain('is in use')
    // No token is created or printed for a bridge that never ran.
    expect(() => statSync(tokenFile(t.io.home))).toThrow()
    expect(t.out.text()).not.toContain('New bridge token')
  })

  it('warns that --token shows in the process list', async () => {
    const t = io()
    const running = await run({ ...defaults, port: 0, token: 'from-flag' }, t.io)
    onTestFinished(() => running.close())
    expect(t.out.text()).toContain(TOKEN_FLAG_WARNING)
    expect(TOKEN_FLAG_WARNING).toContain('process list')
  })

  it('with --mcp, uses the bridge already on the port and keeps stdout for MCP', async () => {
    const b = await bridge()
    await b.tab('qwen')
    const t = io()
    const running = await run({ ...defaults, port: b.server.port, mcp: true }, t.io)
    expect(running.server).toBeNull()
    expect(await running.backend!.health()).toMatchObject({ tab: true, model: 'qwen' })
    expect(t.err.text()).toContain(`using the bridge already running on http://127.0.0.1:${b.server.port}`)
    expect(t.out.text()).toBe('')
    expect(t.err.text()).not.toContain('New bridge token')
    expect(() => statSync(tokenFile(t.io.home))).toThrow()
    t.stdin.end()
    await running.done
  })

  it('with --mcp, refuses a port held by something else', async () => {
    const other = createServer((_req, res) => res.end('hi'))
    other.listen(0, '127.0.0.1')
    await once(other, 'listening')
    onTestFinished(() => new Promise<void>((r) => other.close(() => r())))
    const port = (other.address() as AddressInfo).port
    await expect(run({ ...defaults, port, mcp: true }, io().io)).rejects.toThrow(`port ${port} on 127.0.0.1 is in use`)
  })
})

describe('main', () => {
  it('prints help, the version, and usage errors', async () => {
    let t = io()
    expect(await main(['--help'], t.io)).toBe(0)
    expect(t.out.text()).toBe(`${USAGE}\n`)
    t = io()
    expect(await main(['--version'], t.io)).toBe(0)
    expect(t.out.text()).toBe(`${VERSION}\n`)
    t = io()
    expect(await main(['--port', 'x'], t.io)).toBe(2)
    expect(t.err.text()).toContain('--port x is not a port number')
  })

  it('hands "claude …" to the launcher', async () => {
    const t = io()
    const missing = join(tmpdir(), 'rebellm-bridge-no-such-claude')
    expect(await main(['claude', '--claude', missing], t.io)).toBe(1)
    expect(t.err.text()).toBe(`rebellm-claude: ${missing} was not found\n`)
  })

  it('with --mcp, serves until the client closes stdin, then stops the bridge', async () => {
    const t = io()
    const code = main(['--mcp', '--port', '0'], t.io)
    await new Promise((r) => setTimeout(r, 100))
    expect(t.err.text()).toContain('listening on 127.0.0.1:')
    const port = Number(/listening on 127\.0\.0\.1:(\d+)/.exec(t.err.text())?.[1])
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200)
    t.stdin.end()
    expect(await code).toBe(0)
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow()
  })
})
