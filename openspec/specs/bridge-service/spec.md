# bridge-service Specification

## Purpose
TBD - created by archiving change bridge-service. Update Purpose after archive.
## Requirements
### Requirement: Local service

`rebellm-bridge` SHALL listen on `127.0.0.1:7343` by default, accept one RebeLLM tab over
WebSocket with the protocol v1 and a token it generated and printed once, and answer a
second tab with `busy`.

#### Scenario: First start

- **WHEN** the bridge starts with no token stored
- **THEN** it prints a new token once, stores it with owner-only permissions, and accepts a tab presenting it

#### Scenario: Wrong token

- **WHEN** a tab says `hello` with another token
- **THEN** the bridge answers `error` with code `auth` and closes the connection

#### Scenario: Second tab

- **WHEN** a tab is connected and another tab says `hello` with the right token
- **THEN** the second tab gets `busy` and the first keeps working

#### Scenario: Silent tab

- **WHEN** a connected tab sends nothing for 50 s
- **THEN** the bridge closes the connection and reports no tab

### Requirement: OpenAI-style endpoint

The bridge SHALL answer `POST /v1/chat/completions` with and without streaming and `GET
/v1/models`, forwarding the request's tools to the tab and returning tool calls in the
OpenAI shape, and SHALL answer 503 with the reason when no tab or model is available after
the wait time. HTTP requests from web pages (an `Origin` header) SHALL be refused.

#### Scenario: Streamed completion

- **WHEN** a client posts a chat with `stream: true`
- **THEN** it receives SSE chunks as the tab streams tokens and a final `[DONE]`

#### Scenario: Tool call

- **WHEN** the tab answers a chat that carried `tools` with `tool_call`
- **THEN** the client receives an assistant message with `tool_calls` and `finish_reason: 'tool_calls'`

#### Scenario: No tab

- **WHEN** a client posts a chat and no tab connects within the wait time
- **THEN** it receives 503 with `no RebeLLM tab connected`

### Requirement: MCP server for Claude Code

Started with `--mcp`, the bridge SHALL be an MCP server over stdio offering a `chat` tool
that returns the model's answer and a `status` tool. When another bridge already serves the
port, the MCP server SHALL use that bridge instead of failing.

#### Scenario: Claude Code asks the local model

- **WHEN** Claude Code calls the bridge's `chat` tool
- **THEN** the answer comes from the RebeLLM tab's model

#### Scenario: Bridge already running

- **WHEN** Claude Code starts `rebellm-bridge --mcp` while a bridge started by hand holds the port
- **THEN** the `chat` tool answers through the running bridge's tab

