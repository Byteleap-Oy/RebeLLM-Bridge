# launcher Specification

## Purpose
TBD - created by archiving change anthropic-messages. Update Purpose after archive.

## Requirements

### Requirement: Launch Claude Code on the tab model

`rebellm-claude` SHALL run `claude` with inherited stdio, pass through all arguments it
does not own (`--claude <path>`, `--shared-config`, `--port <n>`, `--allow <rule>`), return
`claude`'s exit code, and give the child an environment that sends every model request to
the bridge: `ANTHROPIC_BASE_URL` pointing at the bridge, a dummy `ANTHROPIC_AUTH_TOKEN`,
`ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL` and `ANTHROPIC_DEFAULT_HAIKU_MODEL` set,
`API_TIMEOUT_MS`, `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS` and `CLAUDE_STREAM_IDLE_TIMEOUT_MS`
raised to six hours (the stream watchdog does not count `ping` events, and a long prompt takes
the tab more than half an hour to read), non-essential traffic disabled,
`CLAUDE_CODE_MAX_CONTEXT_TOKENS` set to the tab's context size and `CLAUDE_CODE_MAX_OUTPUT_TOKENS`
to a quarter of it when the tab reports one, and
`ANTHROPIC_API_KEY`, `ANTHROPIC_CUSTOM_HEADERS`, `CLAUDE_CODE_USE_BEDROCK`,
`CLAUDE_CODE_USE_VERTEX` and `CLAUDE_CODE_USE_FOUNDRY` blanked, so nothing from the shell
outranks the bridge. The same variables SHALL reach `claude` as `--settings <file>` from a
file the launcher writes at `~/.rebellm-bridge/claude-settings-<port>.json`, placed before the
user's arguments, so a project's or local `.claude/settings.json` does not outrank them
either.

#### Scenario: Context size

- **WHEN** the connected tab reports a context of 32768 tokens
- **THEN** `claude` gets `CLAUDE_CODE_MAX_CONTEXT_TOKENS=32768`, so it compacts within the tab's context

#### Scenario: Arguments pass through

- **WHEN** the user runs `rebellm-claude -p "What is 2 + 3?"`
- **THEN** `claude` is started with `--settings <file>`, `-p` and `What is 2 + 3?` and the bridge environment

#### Scenario: Allow rules are the launcher's

- **WHEN** the user runs `rebellm-claude --allow Edit -p "Fix the typo"`
- **THEN** `claude` is started with `--settings <file>`, `-p` and `Fix the typo`, and `--allow Edit` is not among its arguments

#### Scenario: Exit code

- **WHEN** `claude` exits with code 2
- **THEN** `rebellm-claude` exits with code 2

#### Scenario: Workplace shell and project

- **WHEN** the shell exports `CLAUDE_CODE_USE_VERTEX=1` and the project's `.claude/settings.json` sets `ANTHROPIC_BASE_URL`
- **THEN** the child sees `CLAUDE_CODE_USE_VERTEX` empty and the `--settings` file sets `ANTHROPIC_BASE_URL` to the bridge, above the project's value

#### Scenario: Slow subagent

- **WHEN** a subagent's first request takes 20 minutes before its first token
- **THEN** `claude` waits, because its stall and request timeouts are hours and the bridge's pings keep the stream alive

#### Scenario: Long prompt

- **WHEN** the tab takes 40 minutes to read a prompt before its first token
- **THEN** `claude` keeps waiting: its stream idle timeout is six hours

#### Scenario: Auto-compact window
- **WHEN** the connected tab reports a context of 32768 tokens
- **THEN** `claude` gets `CLAUDE_CODE_MAX_OUTPUT_TOKENS=8192`, so its auto-compact window is 24576 tokens and a new session does not compact at once

### Requirement: Isolated config

The launcher SHALL set `CLAUDE_CONFIG_DIR` to `~/.rebellm-bridge/claude`, so login, history
and settings stay apart from the user's normal Claude Code, unless `--shared-config` is
given; the bridge variables travel with `--settings` in both cases, and that file SHALL also
turn off Claude Code's extra model calls: the recap on return (`awaySummaryEnabled`), prompt
suggestions (`promptSuggestionEnabled`) and thinking summaries (`showThinkingSummaries`).

#### Scenario: Default

- **WHEN** the user runs `rebellm-claude`
- **THEN** the child's `CLAUDE_CONFIG_DIR` is `~/.rebellm-bridge/claude`

#### Scenario: Shared config

- **WHEN** the user runs `rebellm-claude --shared-config`
- **THEN** the child inherits the parent's `CLAUDE_CONFIG_DIR` or none, and still gets `--settings <file>`

#### Scenario: Quiet

- **WHEN** the launcher writes its settings file
- **THEN** it sets `awaySummaryEnabled`, `promptSuggestionEnabled` and `showThinkingSummaries` to false beside the environment block

### Requirement: Bridge lifecycle

The launcher SHALL reuse a bridge already answering `/health` on the port, otherwise
start one in-process that logs to `~/.rebellm-bridge/bridge.log` and stops when `claude`
exits. A port held by anything else SHALL be an error. While `claude` runs on a reused
bridge, the launcher SHALL start its own bridge on the same port when that one stops. It
SHALL pass SIGTERM and SIGHUP on to `claude`, and give `claude` a `--settings` file of its
own port.

#### Scenario: Bridge already running

- **WHEN** a bridge answers on the port
- **THEN** the launcher starts no server and uses that bridge

#### Scenario: No bridge running

- **WHEN** nothing listens on the port
- **THEN** the launcher starts the bridge, and the port is free again after `claude` exits

#### Scenario: Owner exits first

- **WHEN** two launchers share the bridge the first one started and the first `claude` exits
- **THEN** the second launcher starts a bridge on the same port and its `claude` keeps working once the tab reconnects

#### Scenario: Launcher stopped

- **WHEN** the launcher receives SIGTERM while `claude` runs
- **THEN** `claude` receives SIGTERM, and the launcher exits after it

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

### Requirement: Launcher option values
`rebellm-claude` SHALL refuse a blank `--port`, `--claude` or `--allow` value, and SHALL store
a newly created token only once the bridge it started is listening.

#### Scenario: Blank port
- **WHEN** the launcher is started with `--port ' '`
- **THEN** it exits with the error `--port needs a value`

#### Scenario: Blank allow rule
- **WHEN** the launcher is started with `--allow ''`
- **THEN** it exits with the error `--allow needs a value`

### Requirement: Tools allowed

The `--settings` file the launcher writes SHALL allow Claude Code's read-only tools `Read`,
`Glob` and `Grep` and its `WebFetch` and `WebSearch` tools on every path and domain
(`permissions.allow` holding all five), so none waits on auto mode's classifier, which the
tab model cannot answer in time, nor prompts in the other modes. Each `--allow <rule>` given
to the launcher SHALL add that Claude Code permission rule after them, once, in the order
given; the launcher SHALL add nothing else, so `Bash`, `Edit` and `Write` are allowed only
when the user asks. It SHALL also set `skipWebFetchPreflight` to true, so a fetch does not
fail when Claude Code's hostname check at `api.anthropic.com` cannot answer.

#### Scenario: Settings file

- **WHEN** the launcher writes its settings file with no `--allow`
- **THEN** the file's `permissions.allow` is exactly `["Read", "Glob", "Grep", "WebFetch", "WebSearch"]` and `skipWebFetchPreflight` is true

#### Scenario: User rules

- **WHEN** the launcher runs with `--allow Edit --allow 'Bash(npm test:*)' --allow Edit`
- **THEN** the file's `permissions.allow` is the five defaults followed by `Edit` and `Bash(npm test:*)`

#### Scenario: Fetch in auto mode

- **WHEN** Claude asks to fetch `https://www.hs.fi/` in auto mode under `rebellm-claude`
- **THEN** Claude Code runs the fetch without asking the classifier or `api.anthropic.com`

#### Scenario: Read outside the project in auto mode

- **WHEN** Claude asks to read `~/.rebellm-bridge/bridge.log` in auto mode under `rebellm-claude`
- **THEN** Claude Code reads it without asking the classifier

#### Scenario: Edit stays with Claude Code

- **WHEN** the launcher runs with no `--allow` and Claude asks to edit a file in auto mode
- **THEN** Claude Code decides as it would without the launcher; the settings file allows no `Edit`
