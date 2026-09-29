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
import { TOKEN_ENV, VERSION, bridgeHealth, keepToken, resolveToken, tokenFile, type TokenChoice } from './cli.js'
import { SYSTEM_PROMPT } from './prompt.js'
import { DEFAULT_PORT, startServer, type BridgeServer } from './server.js'
import type { Health } from './tab.js'

export const USAGE = `Usage: rebellm-claude [--claude <path>] [--shared-config] [--port <n>] [--allow <rule>]... [--keep <tool>]... [--full-prompt] [claude arguments]

Runs Claude Code on the model in your RebeLLM tab, through rebellm-bridge.

  --claude <path>   the claude executable (default: claude on PATH)
  --shared-config   use your normal Claude Code config instead of ~/.rebellm-bridge/claude
  --port <n>        the bridge's port (default ${DEFAULT_PORT}); a bridge already there is reused
  --allow <rule>    a Claude Code permission rule to allow as well, e.g. Edit or 'Bash(npm test:*)';
                    repeat for more (the launcher allows Read, Glob, Grep, WebFetch and WebSearch)
  --keep <tool>     offer the model a tool the launcher leaves out to save context, e.g. Task;
                    repeat for more (left out: sub-agents, task lists, notebooks, questions,
                    skills, plan mode, background shells)
  --full-prompt     Claude Code's own system prompt instead of the launcher's short one

Everything else, and everything after --, goes to claude.`

export const MISSING =
  'claude was not found on PATH. Install Claude Code (https://claude.com/claude-code), or pass --claude <path>.'

/** The name Claude Code shows; the bridge answers every model name with the tab's model. */
export const MODEL = 'rebellm'

/** Passed on to claude; SIGINT reaches it from the terminal already. */
const FORWARDED = ['SIGTERM', 'SIGHUP'] as const

/** How long a request waits for the tab's model, as the bridge's `--wait` default. */
const WAIT_MS = 120_000

export interface LauncherOptions {
  claude?: string
  sharedConfig: boolean
  port: number
  /** Permission rules to allow beside the launcher's own, in order. */
  allow: string[]
  /** Tools to take out of the launcher's deny list. */
  keep: string[]
  /** Claude Code's own system prompt instead of the launcher's. */
  fullPrompt: boolean
  /** For claude, in order. */
  args: string[]
}

/** Takes the launcher's own flags out of `argv`; everything else passes to claude. */
export function parseLauncher(argv: string[]): LauncherOptions | { error: string } {
  const o: LauncherOptions = {
    sharedConfig: false,
    port: DEFAULT_PORT,
    allow: [],
    keep: [],
    fullPrompt: false,
    args: [],
  }
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
    } else if (flag === '--full-prompt' && eq < 0) {
      o.fullPrompt = true
    } else if (flag === '--claude' || flag === '--port' || flag === '--allow' || flag === '--keep') {
      const value = eq > 0 ? arg.slice(eq + 1) : argv[++i]
      if (!value?.trim()) return { error: `${flag} needs a value` }
      if (flag === '--claude') o.claude = value
      else if (flag === '--allow') o.allow.push(value.trim())
      else if (flag === '--keep') o.keep.push(value.trim())
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
    // A 32k prefill at 26 tok/s is 21 minutes and a long answer at 1.5 tok/s hours. The stream
    // watchdog does not count the bridge's pings, so it gets the same six hours.
    API_TIMEOUT_MS: '21600000',
    CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS: '21600000',
    CLAUDE_STREAM_IDLE_TIMEOUT_MS: '21600000',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    // Claude Code assumes 200k for a model it does not know; it should compact within the tab's.
    // Claude Code keeps its answer's reserve out of the window before it compacts: 20 000 for an
    // unknown model, which left 12 768 of a 32k tab, less than its own system prompt.
    ...(contextTokens
      ? {
          CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(contextTokens),
          CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(Math.floor(contextTokens / 4)),
        }
      : {}),
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
/** Given to claude as `--settings`, which ranks above project, local and user settings; one per port, as the bridge URL differs. */
export const launchSettingsFile = (home: string, port: number) =>
  join(home, '.rebellm-bridge', `claude-settings-${port}.json`)
/** Given to claude as `--system-prompt-file`; rewritten at each launch, so it follows the package. */
export const launchPromptFile = (home: string) => join(home, '.rebellm-bridge', 'claude-system-prompt.md')

const OWN_PROMPT = /^--system-prompt(-file)?(=|$)/

/** The launcher's prompt file, or null when the user keeps Claude Code's own or passes a prompt. */
export function promptArgs(o: Pick<LauncherOptions, 'fullPrompt' | 'args'>, file: string): string[] {
  return o.fullPrompt || o.args.some((a) => OWN_PROMPT.test(a)) ? [] : ['--system-prompt-file', file]
}

/** Writes the short prompt where `--system-prompt-file` will find it. */
export function writeLaunchPrompt(file: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, SYSTEM_PROMPT, { mode: 0o600 })
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

/** Claude Code's extra model calls, minutes each on a slow model: the recap on return, prompt suggestions, thinking summaries. */
export const QUIET_SETTINGS = {
  awaySummaryEnabled: false,
  promptSuggestionEnabled: false,
  showThinkingSummaries: false,
} as const

/**
 * Allow rules skip auto mode's classifier, which the tab model cannot answer before it times out.
 * Only tools that change nothing; the user adds the rest with --allow.
 */
export const DEFAULT_ALLOW = ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'] as const

/**
 * Denied by bare name, which keeps their schemas out of every request: tools a small local
 * model does no good with. ToolSearch stays, as deferred MCP tools need it under --shared-config.
 */
export const DEFAULT_DENY = [
  'Task',
  'Agent',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'TaskStop',
  'NotebookEdit',
  'AskUserQuestion',
  'Skill',
  'SlashCommand',
  'EnterPlanMode',
  'ExitPlanMode',
  'KillShell',
  'BashOutput',
  'TaskOutput',
] as const

/** WebFetch fails whenever its hostname check at api.anthropic.com cannot answer. */
export const SKIP_FETCH_PREFLIGHT = { skipWebFetchPreflight: true } as const

/** `allow` holds the user's rules; they follow the defaults, once each. `keep` takes tools out of the deny list. */
export function writeLaunchSettings(
  file: string,
  env: Record<string, string>,
  allow: string[] = [],
  keep: string[] = [],
): void {
  const kept = new Set(keep)
  const deny = DEFAULT_DENY.filter((t) => !kept.has(t))
  const permissions = { allow: [...new Set([...DEFAULT_ALLOW, ...allow])], ...(deny.length ? { deny } : {}) }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(
    file,
    `${JSON.stringify({ ...QUIET_SETTINGS, ...SKIP_FETCH_PREFLIGHT, permissions, env }, null, 2)}\n`,
    { mode: 0o600 },
  )
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
  // Set inside closures, so declared without a narrowing initial type.
  let server = null as BridgeServer | null
  let log = null as ReturnType<typeof createWriteStream> | null
  const file = logFile(home)
  const write = (line: string) => {
    if (!log) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      log = createWriteStream(file, { flags: 'a', mode: 0o600 })
    }
    log.write(`${new Date().toISOString()} ${line}\n`)
  }
  const pollMs = io.pollMs ?? 1000
  let base = `http://127.0.0.1:${o.port}`
  /** Starts our own bridge on the port; null when another bridge answers there. */
  const startBridge = async (): Promise<TokenChoice | null> => {
    const tok = resolveToken({ ...(io.env[TOKEN_ENV] ? { env: io.env[TOKEN_ENV] } : {}), home })
    try {
      server = await startServer({ host: '127.0.0.1', port: o.port, token: tok.token, waitMs: WAIT_MS, log: write })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e
      // Another launcher may have started one meanwhile.
      if (await bridgeHealth(base)) return null
      throw new Error(`port ${o.port} on 127.0.0.1 is in use by something that is not a rebellm-bridge`, { cause: e })
    }
    keepToken(tok)
    base = `http://127.0.0.1:${server.port}`
    write(`${VERSION} listening on 127.0.0.1:${server.port} for rebellm-claude`)
    return tok
  }

  try {
    let token = `the token in ${tokenFile(home)}`
    let health: Health | null = await bridgeHealth(base)
    if (health) say(`using the bridge already running on ${base}`)
    else {
      const tok = await startBridge()
      if (tok) {
        say(`started the bridge on ${base} (log: ${file})`)
        if (tok.created) token = `this new token (stored in ${tok.file}):\n\n  ${tok.token}\n`
        else if (tok.source === 'env') token = `the token in ${TOKEN_ENV}`
      }
      health = await bridgeHealth(base)
    }

    if (!health?.tab) {
      say(
        `waiting for the RebeLLM tab. In RebeLLM → Bridge, connect to ` +
          `${base.replace('http:', 'ws:')} with ${token}\nCtrl+C quits.`,
      )
      while (!health?.tab) {
        if (quit.signal.aborted) return 130
        await sleep(pollMs, quit.signal)
        health = await bridgeHealth(base)
      }
    }
    const model = health.model ? ` (model ${health.model}, ${health.state})` : ''
    say(`the RebeLLM tab is connected${model}`)

    const dir = o.sharedConfig ? null : configDir(home)
    const ours = bridgeEnv(base, health.contextTokens)
    const settings = launchSettingsFile(home, Number(new URL(base).port))
    writeLaunchSettings(settings, ours, o.allow, o.keep)
    const prompt = promptArgs(o, launchPromptFile(home))
    if (prompt.length) writeLaunchPrompt(launchPromptFile(home))
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
    const child = spawn(claude, ['--settings', settings, ...prompt, ...o.args], { stdio: 'inherit', env })
    // A supervisor or IDE stopping the launcher stops claude too, instead of orphaning it.
    const forward = (signal: NodeJS.Signals) => void child.kill(signal)
    for (const sig of FORWARDED) process.on(sig, forward)
    const exited = new Promise<number>((resolve) => {
      child.on('error', (e) => {
        say(`could not start ${claude}: ${e.message}`)
        resolve(1)
      })
      child.on('exit', (code, signal) =>
        resolve(code ?? 128 + ((signal && os.signals[signal as keyof typeof os.signals]) || 0)),
      )
    })
    // A borrowed bridge stops with the launcher that owns it; then this one takes the port over.
    const done = new AbortController()
    const standby = (async () => {
      while (!server && !done.signal.aborted) {
        await sleep(pollMs, done.signal)
        if (done.signal.aborted || (await bridgeHealth(base))) continue
        try {
          if (await startBridge()) write('took over the port after the bridge there stopped')
        } catch (e) {
          write(`could not take over the port: ${(e as Error).message}`)
        }
      }
    })()
    try {
      return await exited
    } finally {
      done.abort()
      await standby
      for (const sig of FORWARDED) process.off(sig, forward)
    }
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
