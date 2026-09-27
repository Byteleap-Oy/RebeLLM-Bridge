# bridge-service Specification

## Purpose
TBD - created by archiving change bridge-service. Update Purpose after archive.

## Requirements

### Requirement: Local service

`rebellm-bridge` SHALL listen on `127.0.0.1:7343` by default, accept one RebeLLM tab over
WebSocket with the protocol v1 and a token it generated and printed once, and answer a
second tab with `busy`. It SHALL read only the first frame of a connection as its `hello`,
drop a connection that sends none within 10 s, and close one that sends a frame over 8 MiB.
On start it SHALL print the addresses for the tab, OpenAI clients and Anthropic clients.

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

#### Scenario: Startup output

- **WHEN** the bridge starts on port 7343
- **THEN** its output names `ws://127.0.0.1:7343` for the tab, `http://127.0.0.1:7343/v1` for OpenAI clients and `http://127.0.0.1:7343` for Anthropic clients with `rebellm-claude`

#### Scenario: Repeated hello

- **WHEN** a connection sends a `hello` with a wrong token and then more `hello` frames
- **THEN** the bridge answers `auth` once, logs one refusal and closes the connection

#### Scenario: No hello

- **WHEN** a connection opens and sends nothing for 10 s
- **THEN** the bridge drops it

#### Scenario: Oversized frame

- **WHEN** a connection sends a frame over 8 MiB
- **THEN** the bridge closes it with code 1009 without reading the frame

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

### Requirement: Request log
The bridge SHALL write one log line per request event, with the request's id, route and
seconds since arrival: arrival with the estimated prompt tokens and tool count, queue
position, first token, end with the stop reason and output tokens, a client abort, a
refusal, or an error; message content SHALL never be logged; `--quiet` SHALL silence it.

#### Scenario: Client gives up
- **WHEN** an HTTP client closes its connection 600 s into a request that has produced no token
- **THEN** the log reads that the client aborted at +600 s after the arrival and queue lines

#### Scenario: Quiet
- **WHEN** the bridge runs with `--quiet`
- **THEN** no request lines are written

### Requirement: Page fetch for the tab
The bridge SHALL list `fetch` in its `ok` features and, on a tab's `{ t: 'fetch', id, url }`,
SHALL fetch the page from this computer and answer `fetched` with status, type, final URL,
text and whether it was cut, or an `error`; it SHALL accept only `http` and `https`, refuse
any hop whose address is not public or lies in the network of one of this computer's own
network interfaces and dial the checked address, follow at most five redirects, send no
cookies or credentials, pass text types only, stop at 2 MB and 15 s including the name
lookup, allow 30 fetches a minute, and log each fetch by host only.

#### Scenario: Public page
- **WHEN** the tab asks for `https://docs.python.org/3/library/json.html`
- **THEN** the bridge answers `fetched` with status 200, type text/html and the page text

#### Scenario: Private address
- **WHEN** the tab asks for `http://192.168.1.1/` or a page that redirects there
- **THEN** the bridge answers an error without connecting to that address

#### Scenario: This computer's public address
- **WHEN** this computer has the global IPv6 address `2001:db8:1::5` and the tab asks for
  `http://[2001:db8:1::5]:8080/`, a host resolving to it, or a page that redirects there
- **THEN** the bridge answers an error without connecting to that address

#### Scenario: A device on this computer's network
- **WHEN** this computer has `2001:db8:1::5/64` and the tab asks for `http://[2001:db8:1::1]/`
- **THEN** the bridge answers an error without connecting to that address

#### Scenario: Stuck name lookup
- **WHEN** the name lookup for a page does not answer
- **THEN** the bridge answers an error after 15 s

### Requirement: Request body limit
The bridge SHALL refuse a request body over 8 MiB with status 413 in the endpoint's error
shape (`request_too_large` under `/v1/messages`, `invalid_request_error` under
`/v1/chat/completions`), sent as a response the client can read rather than a dropped
connection, and SHALL keep none of the refused body.

#### Scenario: Oversized body
- **WHEN** a client posts a 9 MiB body to `/v1/messages` or `/v1/chat/completions`
- **THEN** it receives status 413 with the error in that endpoint's shape and nothing is sent to the tab
