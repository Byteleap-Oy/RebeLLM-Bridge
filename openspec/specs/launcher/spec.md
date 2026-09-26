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
`API_TIMEOUT_MS` raised, non-essential traffic disabled, `CLAUDE_CODE_MAX_CONTEXT_TOKENS`
set to the tab's context size when the tab reports one, and `ANTHROPIC_API_KEY` removed.

#### Scenario: Context size

- **WHEN** the connected tab reports a context of 32768 tokens
- **THEN** `claude` gets `CLAUDE_CODE_MAX_CONTEXT_TOKENS=32768`, so it compacts within the tab's context

#### Scenario: Arguments pass through

- **WHEN** the user runs `rebellm-claude -p "What is 2 + 3?"`
- **THEN** `claude` is started with `-p` and `What is 2 + 3?` and the bridge environment

#### Scenario: Exit code

- **WHEN** `claude` exits with code 2
- **THEN** `rebellm-claude` exits with code 2

### Requirement: Isolated config

The launcher SHALL set `CLAUDE_CONFIG_DIR` to `~/.rebellm-bridge/claude` and write the
bridge variables into that directory's `settings.json` under `env`, keeping the file's
other content, so login, history and settings stay apart from the user's normal Claude
Code, unless `--shared-config` is given.

#### Scenario: Default

- **WHEN** the user runs `rebellm-claude`
- **THEN** the child's `CLAUDE_CONFIG_DIR` is `~/.rebellm-bridge/claude` and its `settings.json` sets `ANTHROPIC_BASE_URL` to the bridge

#### Scenario: Shared config

- **WHEN** the user runs `rebellm-claude --shared-config`
- **THEN** the child inherits the parent's `CLAUDE_CONFIG_DIR` or none, and no settings file is written

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

