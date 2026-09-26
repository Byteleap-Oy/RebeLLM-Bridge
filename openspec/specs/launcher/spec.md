# launcher Specification

## Purpose
TBD - created by archiving change anthropic-messages. Update Purpose after archive.
## Requirements
### Requirement: Launch Claude Code on the tab model

`rebellm-claude` SHALL run `claude` with inherited stdio, pass through all arguments it
does not own (`--claude <path>`, `--shared-config`, `--port <n>`), return `claude`'s exit
code, and give the child an environment that sends every model request to the bridge:
`ANTHROPIC_BASE_URL` pointing at the bridge, a dummy `ANTHROPIC_AUTH_TOKEN`,
`ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL` and `ANTHROPIC_DEFAULT_HAIKU_MODEL` set,
`API_TIMEOUT_MS` and `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS` raised to six hours and
`CLAUDE_STREAM_IDLE_TIMEOUT_MS` to thirty minutes, non-essential traffic disabled,
`CLAUDE_CODE_MAX_CONTEXT_TOKENS` set to the tab's context size when the tab reports one, and
`ANTHROPIC_API_KEY`, `ANTHROPIC_CUSTOM_HEADERS`, `CLAUDE_CODE_USE_BEDROCK`,
`CLAUDE_CODE_USE_VERTEX` and `CLAUDE_CODE_USE_FOUNDRY` blanked, so nothing from the shell
outranks the bridge. The same variables SHALL reach `claude` as `--settings <file>` from a
file the launcher writes at `~/.rebellm-bridge/claude-settings.json`, placed before the
user's arguments, so a project's or local `.claude/settings.json` does not outrank them
either.

#### Scenario: Context size

- **WHEN** the connected tab reports a context of 32768 tokens
- **THEN** `claude` gets `CLAUDE_CODE_MAX_CONTEXT_TOKENS=32768`, so it compacts within the tab's context

#### Scenario: Arguments pass through

- **WHEN** the user runs `rebellm-claude -p "What is 2 + 3?"`
- **THEN** `claude` is started with `--settings <file>`, `-p` and `What is 2 + 3?` and the bridge environment

#### Scenario: Exit code

- **WHEN** `claude` exits with code 2
- **THEN** `rebellm-claude` exits with code 2

#### Scenario: Workplace shell and project

- **WHEN** the shell exports `CLAUDE_CODE_USE_VERTEX=1` and the project's `.claude/settings.json` sets `ANTHROPIC_BASE_URL`
- **THEN** the child sees `CLAUDE_CODE_USE_VERTEX` empty and the `--settings` file sets `ANTHROPIC_BASE_URL` to the bridge, above the project's value

#### Scenario: Slow subagent

- **WHEN** a subagent's first request takes 20 minutes before its first token
- **THEN** `claude` waits, because its stall and request timeouts are hours and the bridge's pings keep the stream alive

### Requirement: Isolated config

The launcher SHALL set `CLAUDE_CONFIG_DIR` to `~/.rebellm-bridge/claude`, so login, history
and settings stay apart from the user's normal Claude Code, unless `--shared-config` is
given; the bridge variables travel with `--settings` in both cases.

#### Scenario: Default

- **WHEN** the user runs `rebellm-claude`
- **THEN** the child's `CLAUDE_CONFIG_DIR` is `~/.rebellm-bridge/claude`

#### Scenario: Shared config

- **WHEN** the user runs `rebellm-claude --shared-config`
- **THEN** the child inherits the parent's `CLAUDE_CONFIG_DIR` or none, and still gets `--settings <file>`

### Requirement: Bridge lifecycle

The launcher SHALL reuse a bridge already answering `/health` on the port, otherwise
start one in-process that logs to `~/.rebellm-bridge/bridge.log` and stops when `claude`
exits. A port held by anything else SHALL be an error.

#### Scenario: Bridge already running

- **WHEN** a bridge answers on the port
- **THEN** the launcher starts no server and uses that bridge

#### Scenario: No bridge running

- **WHEN** nothing listens on the port
- **THEN** the launcher starts the bridge, and the port is free again after `claude` exits

### Requirement: Wait for the tab

Before starting `claude`, the launcher SHALL wait until a tab is connected, showing the
WebSocket URL and where the token is (the token itself when this start created it) while
it waits.

#### Scenario: Tab connects late

- **WHEN** no tab is connected at launch and one connects later
- **THEN** the launcher shows the waiting message, then starts `claude` after the tab connects

### Requirement: Missing claude

The launcher SHALL exit with a clear message and code 1 before starting anything when
`claude` is not on `PATH` and no `--claude <path>` is given, or the given path does not
exist.

#### Scenario: Not installed

- **WHEN** `claude` cannot be found
- **THEN** the launcher prints how to install Claude Code and exits with code 1

### Requirement: Launcher as a subcommand

`rebellm-bridge claude [arguments]` SHALL do what `rebellm-claude [arguments]` does, so the
launcher runs with `npx rebellm-bridge claude` and nothing installed.

#### Scenario: Through npx

- **WHEN** the user runs `npx rebellm-bridge claude -p "What is 2 + 3?"`
- **THEN** the launcher runs as `rebellm-claude -p "What is 2 + 3?"` would

### Requirement: Managed settings notice

Before starting `claude`, the launcher SHALL read the machine's managed Claude Code settings
file (`/Library/Application Support/ClaudeCode/managed-settings.json` on macOS,
`%ProgramFiles%\ClaudeCode\managed-settings.json` on Windows,
`/etc/claude-code/managed-settings.json` elsewhere) and, when it sets an `env` variable
starting with `ANTHROPIC_` or `CLAUDE_CODE_USE_`, `apiKeyHelper`, `forceLoginMethod` or
`forceLoginGatewayUrl`, SHALL name the file and those keys and say that they rank above
the launcher. A missing or unreadable file SHALL be silent.

#### Scenario: Organisation pins the endpoint

- **WHEN** the managed settings file sets `env.ANTHROPIC_BASE_URL`
- **THEN** the launcher prints the file's path and `ANTHROPIC_BASE_URL` before starting `claude`

#### Scenario: No managed settings

- **WHEN** the file does not exist
- **THEN** the launcher prints nothing about it

