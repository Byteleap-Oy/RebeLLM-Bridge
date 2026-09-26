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
  QUIET_SETTINGS,
  bridgeEnv,
  childEnv,
  configDir,
  findCommand,
  launch,
  launchSettingsFile,
  logFile,
  managedOverrides,
  managedSettingsFile,
  parseLauncher,
  writeLaunchSettings,
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
  'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'API_TIMEOUT_MS', 'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS', 'CLAUDE_STREAM_IDLE_TIMEOUT_MS',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']
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
  for (const [k, v] of Object.entries(process.env))
    if (!/^(path|anthropic_.*|claude_config_dir|claude_code_use_.*)$/i.test(k)) e[k] = v
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
  it('points claude at the bridge and blanks what a workplace shell would put above it', () => {
    const ours = { ...bridgeEnv('http://127.0.0.1:7343', 32768), CLAUDE_CONFIG_DIR: '/h/.rebellm-bridge/claude' }
    const e = childEnv(
      {
        HOME: '/h',
        ANTHROPIC_API_KEY: 'sk-real',
        ANTHROPIC_BASE_URL: 'https://elsewhere',
        CLAUDE_CODE_USE_VERTEX: '1',
        CLAUDE_CONFIG_DIR: '/mine',
      },
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
      API_TIMEOUT_MS: '21600000',
      CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS: '21600000',
      CLAUDE_STREAM_IDLE_TIMEOUT_MS: '1800000',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '32768',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_CUSTOM_HEADERS: '',
      CLAUDE_CODE_USE_BEDROCK: '',
      CLAUDE_CODE_USE_VERTEX: '',
      CLAUDE_CODE_USE_FOUNDRY: '',
    })
    expect(bridgeEnv('http://x', 0)).not.toHaveProperty('CLAUDE_CODE_MAX_CONTEXT_TOKENS')
    // Windows spells variables in any case; the bridge's must still win.
    const w = childEnv(
      { Anthropic_Api_Key: 'sk-real', Claude_Code_Use_Bedrock: '1', Claude_Config_Dir: '/mine' },
      bridgeEnv('http://x'),
      'win32',
    )
    expect(w).not.toHaveProperty('Anthropic_Api_Key')
    expect(w).not.toHaveProperty('Claude_Code_Use_Bedrock')
    expect(w.ANTHROPIC_API_KEY).toBe('')
    expect(w.Claude_Config_Dir).toBe('/mine')
  })

  it('writes the --settings file and reads what managed settings pin', () => {
    const home = temp()
    const file = launchSettingsFile(home)
    writeLaunchSettings(file, { A: '1' })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ...QUIET_SETTINGS, env: { A: '1' } })
    expect(QUIET_SETTINGS).toEqual({
      awaySummaryEnabled: false,
      promptSuggestionEnabled: false,
      showThinkingSummaries: false,
    })
    expect(managedSettingsFile('darwin', {})).toBe('/Library/Application Support/ClaudeCode/managed-settings.json')
    expect(managedSettingsFile('win32', { programfiles: 'D:\\PF' })).toBe(
      join('D:\\PF', 'ClaudeCode', 'managed-settings.json'),
    )
    expect(managedSettingsFile('linux', {})).toBe('/etc/claude-code/managed-settings.json')
    const managed = join(home, 'managed-settings.json')
    expect(managedOverrides(managed)).toEqual([])
    writeFileSync(
      managed,
      JSON.stringify({
        env: { ANTHROPIC_BASE_URL: 'https://corp', CLAUDE_CODE_USE_VERTEX: '1', OTHER: 'x' },
        apiKeyHelper: 'get-key',
        permissions: {},
      }),
    )
    expect(managedOverrides(managed)).toEqual(['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_VERTEX', 'apiKeyHelper'])
    writeFileSync(managed, JSON.stringify({ permissions: {}, env: { OTHER: 'x' } }))
    expect(managedOverrides(managed)).toEqual([])
    writeFileSync(managed, '{ broken')
    expect(managedOverrides(managed)).toEqual([])
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
    const managed = join(home, 'managed-settings.json')
    writeFileSync(managed, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://corp' }, apiKeyHelper: 'x' }))
    const code = await launch(argv, {
      stderr: err.stream,
      env: env(stub.dir, {
        STUB_OUT: stub.out,
        STUB_EXIT: '2',
        ANTHROPIC_API_KEY: 'sk-real',
        CLAUDE_CODE_USE_VERTEX: '1',
      }),
      home,
      pollMs: 20,
      managedFile: managed,
    })
    expect(code).toBe(2)
    const seen = JSON.parse(readFileSync(stub.out, 'utf8')) as Seen
    expect(seen.args).toEqual(['--settings', launchSettingsFile(home), '-p', 'What is 2 + 3?', 'say "hi" & exit'])
    expect(seen.env).toEqual({ ...bridgeEnv(b.base, 32768), CLAUDE_CONFIG_DIR: configDir(home) })
    expect(seen.health).toMatchObject({ tab: true, model: 'qwen' })
    expect(err.text()).toContain(`using the bridge already running on ${b.base}`)
    expect(err.text()).toContain('the RebeLLM tab is connected (model qwen, ready)')
    expect(err.text()).toContain(`settings in ${managed} set ANTHROPIC_BASE_URL, apiKeyHelper; they rank above`)
    expect(existsSync(logFile(home))).toBe(false)
    expect(existsSync(join(configDir(home), 'settings.json'))).toBe(false)
    expect(JSON.parse(readFileSync(launchSettingsFile(home), 'utf8'))).toEqual({
      ...QUIET_SETTINGS,
      env: bridgeEnv(b.base, 32768),
    })
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
      managedFile: join(home, 'none.json'),
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
    expect(seen.args).toEqual(['--settings', launchSettingsFile(home)])
    expect(seen.env.CLAUDE_CONFIG_DIR).toBe('mine')
    expect(existsSync(configDir(home))).toBe(false)
    expect(err.text()).not.toContain('rank above')
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
