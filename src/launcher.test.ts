import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, onTestFinished } from 'vitest'
import { tokenFile } from './cli.js'
import {
  MISSING,
  bridgeEnv,
  childEnv,
  configDir,
  findCommand,
  launch,
  logFile,
  parseLauncher,
  writeSettings,
} from './launcher.js'
import { FakeTab } from './test/fake-tab.js'
import { bridge } from './test/harness.js'

const win = process.platform === 'win32'

function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'rebellm-claude-test-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function sink() {
  const stream = new PassThrough()
  let text = ''
  stream.on('data', (c: Buffer) => (text += c.toString()))
  return { stream, text: () => text }
}

// What the stub claude saw: its arguments, the environment the launcher gave it, and the bridge's health.
const STUB = `
import { writeFileSync } from 'node:fs'
const pick = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'API_TIMEOUT_MS',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_MAX_CONTEXT_TOKENS']
const env = Object.fromEntries(pick.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]))
const health = await fetch(process.env.ANTHROPIC_BASE_URL + '/health').then((r) => r.json(), () => null)
writeFileSync(process.env.STUB_OUT, JSON.stringify({ args: process.argv.slice(2), env, health }))
process.exit(Number(process.env.STUB_EXIT ?? 0))
`

/** A directory with a `claude` that records what it got, as npm would install it (`claude.cmd` on Windows). */
function stubClaude() {
  const dir = temp()
  const script = join(dir, 'stub.mjs')
  writeFileSync(script, STUB)
  if (win) writeFileSync(join(dir, 'claude.cmd'), `@"${process.execPath}" "${script}" %*\r\n`)
  else {
    writeFileSync(join(dir, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`)
    chmodSync(join(dir, 'claude'), 0o755)
  }
  return { dir, out: join(dir, 'out.json') }
}

interface Seen {
  args: string[]
  env: Record<string, string>
  health: { tab: boolean } | null
}

/** The parent's environment for a launch: PATH only where the stub is, plus the stub's own settings. */
function env(pathDir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!/^(path|anthropic_.*|claude_config_dir)$/i.test(k)) e[k] = v
  return { ...e, PATH: pathDir, ...extra }
}

describe('parseLauncher', () => {
  it('takes its own flags anywhere and passes the rest in order', () => {
    expect(parseLauncher([])).toEqual({ sharedConfig: false, port: 7343, args: [] })
    expect(
      parseLauncher(['-p', 'What is 2 + 3?', '--port', '8000', '--claude=/opt/claude', '--shared-config', '--verbose']),
    ).toEqual({ claude: '/opt/claude', sharedConfig: true, port: 8000, args: ['-p', 'What is 2 + 3?', '--verbose'] })
    expect(parseLauncher(['--port=0', '--', '--port', '3'])).toEqual({
      sharedConfig: false,
      port: 0,
      args: ['--port', '3'],
    })
  })

  it('rejects flags without a usable value', () => {
    expect(parseLauncher(['--port'])).toEqual({ error: '--port needs a value' })
    expect(parseLauncher(['--claude='])).toEqual({ error: '--claude needs a value' })
    expect(parseLauncher(['--port', 'x'])).toEqual({ error: '--port x is not a port number' })
  })
})

describe('findCommand', () => {
  it('finds a command on PATH, with PATHEXT on Windows', () => {
    const a = temp()
    const b = temp()
    writeFileSync(join(b, 'claude.cmd'), '')
    writeFileSync(join(b, 'claude'), '')
    chmodSync(join(b, 'claude'), 0o755)
    const winEnv = { Path: `${a};${b}`, PATHEXT: '.EXE;.CMD' }
    expect(findCommand('claude', winEnv, 'win32')).toBe(join(b, 'claude.cmd'))
    expect(findCommand('claude', { Path: a }, 'win32')).toBeNull()
    expect(findCommand(join(b, 'claude'), {}, 'win32')).toBe(join(b, 'claude.cmd'))
    if (!win) {
      expect(findCommand('claude', { PATH: `${a}:${b}` }, 'linux')).toBe(join(b, 'claude'))
      chmodSync(join(b, 'claude'), 0o644)
      expect(findCommand('claude', { PATH: b }, 'linux')).toBeNull()
    }
  })
})

describe('environment and settings', () => {
  it('points claude at the bridge and never passes a real API key on', () => {
    const ours = { ...bridgeEnv('http://127.0.0.1:7343', 32768), CLAUDE_CONFIG_DIR: '/h/.rebellm-bridge/claude' }
    const e = childEnv(
      { HOME: '/h', ANTHROPIC_API_KEY: 'sk-real', ANTHROPIC_BASE_URL: 'https://elsewhere', CLAUDE_CONFIG_DIR: '/mine' },
      ours,
      'linux',
    )
    expect(e).toEqual({ HOME: '/h', ...ours })
    expect(bridgeEnv('http://x', 32768)).toEqual({
      ANTHROPIC_BASE_URL: 'http://x',
      ANTHROPIC_AUTH_TOKEN: 'rebellm-bridge-needs-no-key',
      ANTHROPIC_MODEL: 'rebellm',
      ANTHROPIC_SMALL_FAST_MODEL: 'rebellm',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'rebellm',
      API_TIMEOUT_MS: '600000',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '32768',
    })
    expect(bridgeEnv('http://x', 0)).not.toHaveProperty('CLAUDE_CODE_MAX_CONTEXT_TOKENS')
    // Windows spells variables in any case; the bridge's must still win.
    const w = childEnv({ Anthropic_Api_Key: 'sk-real', Claude_Config_Dir: '/mine' }, bridgeEnv('http://x'), 'win32')
    expect(w).not.toHaveProperty('Anthropic_Api_Key')
    expect(w.Claude_Config_Dir).toBe('/mine')
  })

  it('merges the bridge into settings.json and leaves a broken file alone', () => {
    const dir = join(temp(), 'claude')
    expect(writeSettings(dir, { A: '1' })).toBeNull()
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ theme: 'dark', env: { KEEP: 'x', A: 'old' } }))
    expect(writeSettings(dir, { A: '2' })).toBeNull()
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual({
      theme: 'dark',
      env: { KEEP: 'x', A: '2' },
    })
    writeFileSync(join(dir, 'settings.json'), '{ broken')
    expect(writeSettings(dir, { A: '3' })).toContain('could not read')
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe('{ broken')
  })
})

describe('launch', () => {
  it('reuses a running bridge, passes arguments through and returns claude’s exit code', async () => {
    const b = await bridge()
    await b.tab('qwen')
    const stub = stubClaude()
    const home = temp()
    const err = sink()
    const argv = ['-p', 'What is 2 + 3?', '--port', String(b.server.port), 'say "hi" & exit']
    const code = await launch(argv, {
      stderr: err.stream,
      env: env(stub.dir, { STUB_OUT: stub.out, STUB_EXIT: '2', ANTHROPIC_API_KEY: 'sk-real' }),
      home,
      pollMs: 20,
    })
    expect(code).toBe(2)
    const seen = JSON.parse(readFileSync(stub.out, 'utf8')) as Seen
    expect(seen.args).toEqual(['-p', 'What is 2 + 3?', 'say "hi" & exit'])
    expect(seen.env).toEqual({ ...bridgeEnv(b.base, 32768), CLAUDE_CONFIG_DIR: configDir(home) })
    expect(seen.health).toMatchObject({ tab: true, model: 'qwen' })
    expect(err.text()).toContain(`using the bridge already running on ${b.base}`)
    expect(err.text()).toContain('the RebeLLM tab is connected (model qwen, ready)')
    expect(existsSync(logFile(home))).toBe(false)
    const settings = JSON.parse(readFileSync(join(configDir(home), 'settings.json'), 'utf8'))
    expect(settings.env).toMatchObject({ ANTHROPIC_BASE_URL: b.base, CLAUDE_CODE_MAX_CONTEXT_TOKENS: '32768' })
    expect((await fetch(`${b.base}/health`)).status).toBe(200)
  })

  it('starts a bridge, waits for the tab, and stops the bridge when claude exits', async () => {
    const stub = stubClaude()
    const home = temp()
    const err = sink()
    const running = launch(['--port', '0', '--shared-config'], {
      stderr: err.stream,
      env: env(stub.dir, { STUB_OUT: stub.out, CLAUDE_CONFIG_DIR: 'mine' }),
      home,
      pollMs: 20,
    })
    const started = async () => {
      for (let i = 0; i < 200 && !err.text().includes('waiting for the RebeLLM tab'); i++)
        await new Promise((r) => setTimeout(r, 10))
      return err.text()
    }
    const text = await started()
    const base = /started the bridge on (http:\/\/127\.0\.0\.1:\d+)/.exec(text)?.[1]
    expect(base).toBeDefined()
    const token = readFileSync(tokenFile(home), 'utf8').trim()
    expect(text).toContain(`connect to ${base!.replace('http:', 'ws:')} with this new token`)
    expect(text).toContain(`\n  ${token}\n`)
    expect(existsSync(stub.out)).toBe(false)

    const tab = await FakeTab.ready(base!.replace('http:', 'ws:'), token, 'qwen')
    onTestFinished(() => void tab.ws.terminate())
    expect(await running).toBe(0)
    const seen = JSON.parse(readFileSync(stub.out, 'utf8')) as Seen
    expect(seen.health).toMatchObject({ tab: true })
    expect(seen.env.CLAUDE_CONFIG_DIR).toBe('mine')
    expect(existsSync(configDir(home))).toBe(false)
    await expect(fetch(`${base}/health`)).rejects.toThrow()
    const log = readFileSync(logFile(home), 'utf8')
    expect(log).toMatch(/listening on 127\.0\.0\.1:\d+ for rebellm-claude/)
    expect(log).toContain('RebeLLM tab connected')
    expect(log).not.toContain(token)
  })

  it('says how to install Claude Code when claude is missing, before starting anything', async () => {
    const home = temp()
    const err = sink()
    expect(await launch(['--port', '0'], { stderr: err.stream, env: env(temp()), home })).toBe(1)
    expect(err.text()).toBe(`rebellm-claude: ${MISSING}\n`)
    expect(existsSync(join(home, '.rebellm-bridge'))).toBe(false)
    const missing = join(temp(), 'nope')
    expect(await launch(['--claude', missing], { stderr: err.stream, env: env(temp()), home })).toBe(1)
    expect(err.text()).toContain(`${missing} was not found`)
  })

  it('refuses a port held by something that is not a bridge, and bad flags', async () => {
    const stub = stubClaude()
    const server = createServer((_req, res) => res.end('hi'))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    onTestFinished(() => new Promise<void>((r) => server.close(() => r())))
    const port = (server.address() as AddressInfo).port
    const err = sink()
    const home = temp()
    expect(await launch(['--port', String(port)], { stderr: err.stream, env: env(stub.dir), home })).toBe(1)
    expect(err.text()).toContain(`port ${port} on 127.0.0.1 is in use by something that is not a rebellm-bridge`)
    expect(await launch(['--port', 'x'], { stderr: err.stream, env: env(stub.dir), home })).toBe(2)
    expect(err.text()).toContain('Usage: rebellm-claude')
  })
})
