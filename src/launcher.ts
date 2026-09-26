#!/usr/bin/env node
import {
  accessSync,
  constants,
  createWriteStream,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, constants as os } from 'node:os'
import { delimiter, dirname, extname, join } from 'node:path'
import type { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import spawn from 'cross-spawn'
import { TOKEN_ENV, VERSION, bridgeHealth, resolveToken, tokenFile } from './cli.js'
import { DEFAULT_PORT, startServer, type BridgeServer } from './server.js'
import type { Health } from './tab.js'

export const USAGE = `Usage: rebellm-claude [--claude <path>] [--shared-config] [--port <n>] [claude arguments]

Runs Claude Code on the model in your RebeLLM tab, through rebellm-bridge.

  --claude <path>   the claude executable (default: claude on PATH)
  --shared-config   use your normal Claude Code config instead of ~/.rebellm-bridge/claude
  --port <n>        the bridge's port (default ${DEFAULT_PORT}); a bridge already there is reused

Everything else, and everything after --, goes to claude.`

export const MISSING =
  'claude was not found on PATH. Install Claude Code (https://claude.com/claude-code), or pass --claude <path>.'

/** The name Claude Code shows; the bridge answers every model name with the tab's model. */
export const MODEL = 'rebellm'

/** How long a request waits for the tab's model, as the bridge's `--wait` default. */
const WAIT_MS = 120_000

export interface LauncherOptions {
  claude?: string
  sharedConfig: boolean
  port: number
  /** For claude, in order. */
  args: string[]
}

/** Takes the launcher's own flags out of `argv`; everything else passes to claude. */
export function parseLauncher(argv: string[]): LauncherOptions | { error: string } {
  const o: LauncherOptions = { sharedConfig: false, port: DEFAULT_PORT, args: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--') {
      o.args.push(...argv.slice(i + 1))
      break
    }
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1
    const flag = eq > 0 ? arg.slice(0, eq) : arg
    if (flag === '--shared-config' && eq < 0) {
      o.sharedConfig = true
    } else if (flag === '--claude' || flag === '--port') {
      const value = eq > 0 ? arg.slice(eq + 1) : argv[++i]
      if (!value) return { error: `${flag} needs a value` }
      if (flag === '--claude') o.claude = value
      else {
        const port = Number(value)
        if (!Number.isInteger(port) || port < 0 || port > 65535)
          return { error: `--port ${value} is not a port number` }
        o.port = port
      }
    } else o.args.push(arg)
  }
  return o
}

/** The key of `name` in `env`; Windows treats `Path` and `PATH` as one. */
const envKey = (env: NodeJS.ProcessEnv, name: string, win: boolean) =>
  (win ? Object.keys(env).find((k) => k.toUpperCase() === name) : undefined) ?? name

function runnable(file: string, win: boolean) {
  try {
    if (!statSync(file).isFile()) return false
    if (!win) accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** A command as the shell would find it: a path as given, else on PATH (with PATHEXT on Windows). */
export function findCommand(name: string, env: NodeJS.ProcessEnv, platform = process.platform): string | null {
  const win = platform === 'win32'
  // Windows runs only files with an executable extension; npm installs claude as claude.cmd.
  const exts =
    win && !extname(name)
      ? (env[envKey(env, 'PATHEXT', win)] ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter(Boolean)
          .map((e) => e.toLowerCase())
      : ['']
  const withExts = (base: string) => exts.map((e) => base + e)
  if (/[\\/]/.test(name)) return withExts(name).find((f) => runnable(f, win)) ?? null
  const dirs = (env[envKey(env, 'PATH', win)] ?? '').split(win ? ';' : delimiter).filter(Boolean)
  for (const dir of dirs) {
    const hit = withExts(join(dir, name)).find((f) => runnable(f, win))
    if (hit) return hit
  }
  return null
}

/** What Claude Code ranks above `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL`, or would send along. */
const OUTRANKING = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
]

/** What sends every model request of claude to the bridge. */
export function bridgeEnv(base: string, contextTokens?: number): Record<string, string> {
  return {
    // Empty counts as unset; a value from a shell profile or a settings file would outrank the bridge.
    ...Object.fromEntries(OUTRANKING.map((k) => [k, ''])),
    ANTHROPIC_BASE_URL: base,
    // The bridge checks no key; a Bearer token needs no approval prompt in Claude Code.
    ANTHROPIC_AUTH_TOKEN: 'rebellm-bridge-needs-no-key',
    ANTHROPIC_MODEL: MODEL,
    ANTHROPIC_SMALL_FAST_MODEL: MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL,
    // A local model can take minutes before its first token.
    API_TIMEOUT_MS: '600000',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    // Claude Code assumes 200k for a model it does not know; it should compact within the tab's.
    ...(contextTokens ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(contextTokens) } : {}),
  }
}

/** The parent's environment with the bridge's on top; a real key or provider never reaches claude. */
export function childEnv(
  parent: NodeJS.ProcessEnv,
  ours: Record<string, string>,
  platform = process.platform,
): NodeJS.ProcessEnv {
  const win = platform === 'win32'
  const drop = new Set(Object.keys(ours))
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(parent)) if (!drop.has(win ? k.toUpperCase() : k)) env[k] = v
  return { ...env, ...ours }
}

export const configDir = (home: string) => join(home, '.rebellm-bridge', 'claude')
export const logFile = (home: string) => join(home, '.rebellm-bridge', 'bridge.log')
/** Given to claude as `--settings`, which ranks above project, local and user settings. */
export const launchSettingsFile = (home: string) => join(home, '.rebellm-bridge', 'claude-settings.json')

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

export function writeLaunchSettings(file: string, env: Record<string, string>): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, `${JSON.stringify({ env }, null, 2)}\n`, { mode: 0o600 })
}

/** Where an organisation's Claude Code settings live; they rank above everything the launcher can do. */
export function managedSettingsFile(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json'
  if (platform === 'win32')
    return join(env[envKey(env, 'PROGRAMFILES', true)] ?? 'C:\\Program Files', 'ClaudeCode', 'managed-settings.json')
  return '/etc/claude-code/managed-settings.json'
}

const MANAGED_KEYS = ['apiKeyHelper', 'forceLoginMethod', 'forceLoginGatewayUrl']

/** The keys of a managed settings file that decide where claude sends requests; none without such a file. */
export function managedOverrides(file: string): string[] {
  let settings: unknown
  try {
    settings = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
  if (!isObj(settings)) return []
  const env = isObj(settings.env) ? Object.keys(settings.env) : []
  return [
    ...env.filter((k) => /^(ANTHROPIC_|CLAUDE_CODE_USE_)/.test(k)),
    ...MANAGED_KEYS.filter((k) => settings[k] !== undefined),
  ]
}

export interface LaunchIo {
  stderr: Writable
  env: NodeJS.ProcessEnv
  home?: string
  /** The managed settings file to look at, for tests. */
  managedFile?: string
  /** How often to ask the bridge whether the tab is there. */
  pollMs?: number
  platform?: NodeJS.Platform
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true })
  })

/** The launcher; resolves with claude's exit code once claude and any bridge it started have stopped. */
export async function launch(argv: string[], io: LaunchIo): Promise<number> {
  const say = (line: string) => void io.stderr.write(`rebellm-claude: ${line}\n`)
  const o = parseLauncher(argv)
  if ('error' in o) {
    say(o.error)
    io.stderr.write(`\n${USAGE}\n`)
    return 2
  }
  const platform = io.platform ?? process.platform
  const home = io.home ?? homedir()
  const claude = findCommand(o.claude ?? 'claude', io.env, platform)
  if (!claude) {
    say(o.claude ? `${o.claude} was not found` : MISSING)
    return 1
  }

  // Ctrl+C quits the wait; while claude runs, claude handles it.
  const quit = new AbortController()
  const onSigint = () => quit.abort()
  process.on('SIGINT', onSigint)
  let server: BridgeServer | null = null
  let log: ReturnType<typeof createWriteStream> | null = null
  try {
    let base = `http://127.0.0.1:${o.port}`
    let token = `the token in ${tokenFile(home)}`
    let health: Health | null = await bridgeHealth(base)
    if (health) say(`using the bridge already running on ${base}`)
    else {
      const tok = resolveToken({ ...(io.env[TOKEN_ENV] ? { env: io.env[TOKEN_ENV] } : {}), home })
      const file = logFile(home)
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      const stream = createWriteStream(file, { flags: 'a', mode: 0o600 })
      log = stream
      const write = (line: string) => void stream.write(`${new Date().toISOString()} ${line}\n`)
      try {
        server = await startServer({ host: '127.0.0.1', port: o.port, token: tok.token, waitMs: WAIT_MS, log: write })
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e
        // Another launcher may have started one meanwhile.
        health = await bridgeHealth(base)
        if (!health)
          throw new Error(`port ${o.port} on 127.0.0.1 is in use by something that is not a rebellm-bridge`, {
            cause: e,
          })
      }
      if (server) {
        base = `http://127.0.0.1:${server.port}`
        write(`${VERSION} listening on 127.0.0.1:${server.port} for rebellm-claude`)
        say(`started the bridge on ${base} (log: ${file})`)
        if (tok.created) token = `this new token (stored in ${tok.file}):\n\n  ${tok.token}\n`
        else if (tok.source === 'env') token = `the token in ${TOKEN_ENV}`
        health = await bridgeHealth(base)
      }
    }

    if (!health?.tab) {
      say(
        `waiting for the RebeLLM tab. In RebeLLM → Bridge, connect to ` +
          `${base.replace('http:', 'ws:')} with ${token}\nCtrl+C quits.`,
      )
      while (!health?.tab) {
        if (quit.signal.aborted) return 130
        await sleep(io.pollMs ?? 1000, quit.signal)
        health = await bridgeHealth(base)
      }
    }
    const model = health.model ? ` (model ${health.model}, ${health.state})` : ''
    say(`the RebeLLM tab is connected${model}`)

    const dir = o.sharedConfig ? null : configDir(home)
    const ours = bridgeEnv(base, health.contextTokens)
    const settings = launchSettingsFile(home)
    writeLaunchSettings(settings, ours)
    const managed = io.managedFile ?? managedSettingsFile(platform, io.env)
    const overrides = managedOverrides(managed)
    if (overrides.length)
      say(
        `your organisation's Claude Code settings in ${managed} set ${overrides.join(', ')}; they rank above ` +
          `rebellm-claude, so claude may still go to your organisation's endpoint (/status in claude lists the sources)`,
      )
    say(`starting ${claude} with ${dir ? `the config in ${dir}` : 'your own Claude Code config'}`)
    const env = childEnv(io.env, { ...ours, ...(dir ? { CLAUDE_CONFIG_DIR: dir } : {}) }, platform)
    // Ours first: a --settings the user passes comes later and wins, as asked.
    const child = spawn(claude, ['--settings', settings, ...o.args], { stdio: 'inherit', env })
    return await new Promise<number>((resolve) => {
      child.on('error', (e) => {
        say(`could not start ${claude}: ${e.message}`)
        resolve(1)
      })
      child.on('exit', (code, signal) =>
        resolve(code ?? 128 + ((signal && os.signals[signal as keyof typeof os.signals]) || 0)),
      )
    })
  } catch (e) {
    say((e as Error).message)
    return 1
  } finally {
    process.off('SIGINT', onSigint)
    await server?.close()
    const stream = log
    if (stream) await new Promise<void>((resolve) => stream.end(resolve))
  }
}

function invokedDirectly() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  void launch(process.argv.slice(2), { stderr: process.stderr, env: process.env }).then((code) => process.exit(code))
}
