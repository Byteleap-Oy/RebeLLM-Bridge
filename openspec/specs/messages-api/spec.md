# messages-api Specification

## Purpose
TBD - created by archiving change anthropic-messages. Update Purpose after archive.
## Requirements
### Requirement: Messages endpoint

The bridge SHALL serve `POST /v1/messages` in the Anthropic Messages API format, answer
with a complete message when `stream` is false and with server-sent events in the
Anthropic event order when `stream` is true, and generate the reply with the connected
tab's model whatever `model` the request names. Like the OpenAI endpoint it SHALL check no
API key and wait for a ready model up to the bridge's wait time. A non-streamed answer not
ready after 10 s SHALL get its 200 headers and a space every 10 s until the message follows, so
a client that gives up on a silent connection keeps waiting.

#### Scenario: Plain answer

- **WHEN** a client posts a user message without `stream`
- **THEN** the response is a `message` with one text block, `stop_reason: 'end_turn'` and usage from the tab's `done`

#### Scenario: Streamed answer

- **WHEN** a client posts with `stream: true`
- **THEN** it receives `message_start`, a text block streamed as `text_delta` events, `message_delta` with the stop reason and usage, and `message_stop`

#### Scenario: Slow tab

- **WHEN** a streamed answer's first token takes longer than 10 s
- **THEN** the client receives a `ping` event every 10 s until it comes

#### Scenario: Slow plain answer

- **WHEN** a non-streamed answer takes longer than 10 s
- **THEN** the response's 200 headers and a space arrive after 10 s, a space every 10 s after, and then the message, which parses as JSON

### Requirement: Tool use

The bridge SHALL pass the request's custom tools to the tab, return the tab's tool calls
as `tool_use` blocks with `stop_reason: 'tool_use'`, and map earlier `tool_use` and
`tool_result` blocks in the request to protocol assistant tool calls and `tool` messages.

#### Scenario: Model calls a tool

- **WHEN** the tab answers with `tool_call` for `Read` with `{ file_path: 'a.ts' }`
- **THEN** the response holds a `tool_use` block named `Read` with that input and `stop_reason: 'tool_use'`

#### Scenario: Tool result returned

- **WHEN** the next request carries the `tool_use` and a matching `tool_result`
- **THEN** the tab's `chat` holds an assistant message with the tool call followed by a `tool` message named `Read` with the result text

### Requirement: Degraded input

The bridge SHALL accept content it cannot pass on: image and document blocks become
placeholder text, thinking blocks and server tools other than web search are dropped, a
`system` message inside `messages` becomes a `user` message with its text in the same
place (the tab's chat templates take a system message only at the start), and unsupported
parameters are ignored.

#### Scenario: Image in a user message

- **WHEN** a user message has a text block and an image block
- **THEN** the tab receives the text followed by `[image omitted]`

#### Scenario: Mid-conversation system message

- **WHEN** `messages` holds a user message followed by a `system` message, as Claude Code sends them
- **THEN** the tab's `chat` has the top-level `system` first and that message's text as a `user` message after the user's

### Requirement: Stop sequences

The bridge SHALL end generation at the first match of any `stop_sequences` entry, not
emit the match, abort the tab's chat, and report `stop_reason: 'stop_sequence'` with the
matched sequence. Text before a tool call SHALL be emitted before its `tool_use` block, and
no match SHALL span a tool call.

#### Scenario: Stop sequence split across tokens

- **WHEN** the stop sequence is `END` and the tab streams `ok E` then `ND more`
- **THEN** the client receives text `ok `, `stop_sequence: 'END'`, and the tab receives `abort`

#### Scenario: Tool call after a possible match

- **WHEN** the stop sequence is `END` and the tab streams `Reading E`, a tool call, then `ND`
- **THEN** the client receives text `Reading `, `E`, the `tool_use` block, text `ND`, and `stop_reason: 'tool_use'`

### Requirement: Cancellation

The bridge SHALL send `abort` to the tab when the HTTP client disconnects before the
answer is done.

#### Scenario: Client goes away

- **WHEN** a streaming client closes the connection mid-answer
- **THEN** the tab receives `abort` with that chat's id

### Requirement: Errors in the Anthropic shape

Every response under `/v1/messages` that is an error SHALL use Anthropic's shape `{ type:
'error', error: { type, message } }`: 403 `permission_error` for a request from a web page
or with a foreign `Host`, 400 `invalid_request_error` for a malformed body or a prompt over
the tab's context, 503 `api_error` with the reason when no tab or ready model is there after
the wait, 502 `api_error` when the tab fails or disconnects during a non-streamed answer
before its headers went out, the error object as the body of that 200 response after them,
and an `error` event that ends the stream when that happens mid-stream.

#### Scenario: No tab

- **WHEN** a request arrives and no tab connects within the wait time
- **THEN** the response is 503 with type `api_error` and the message `no RebeLLM tab connected`

#### Scenario: Prompt too long

- **WHEN** the estimated prompt exceeds the tab's `contextTokens`, or the tab answers that the prompt does not fit
- **THEN** the response is 400 `invalid_request_error` with a message starting `prompt is too long`

#### Scenario: Web page

- **WHEN** a request to `/v1/messages` carries an `Origin` header or `Host: evil.example:7343`
- **THEN** the response is 403 `permission_error` in Anthropic's shape and nothing is sent to the tab

#### Scenario: Tab fails mid-stream

- **WHEN** the tab answers a streamed chat with `error`
- **THEN** the stream ends with an `error` event of type `api_error` carrying the tab's message

#### Scenario: Tab fails after the headers of a plain answer

- **WHEN** the tab answers a non-streamed chat with `error` after the bridge sent the 200 headers and spaces
- **THEN** the body ends with `{ type: 'error', error: { type: 'api_error', message } }` carrying the tab's message

### Requirement: Token counting

The bridge SHALL serve `POST /v1/messages/count_tokens` with `{ input_tokens }` estimated as
`ceil(chars / 3.5)` over the request's system prompt, messages and tools, with or without a
connected tab.

#### Scenario: Count tokens

- **WHEN** a client posts a messages body to `/v1/messages/count_tokens`
- **THEN** the response is `{ input_tokens: n }` with n greater than zero

### Requirement: Web search

The bridge SHALL offer the tab a function tool `web_search` with a required string `query`
when a request's tools hold a server tool whose `type` starts with `web_search_` and no custom
tool is named `web_search`. Each call the tab makes to it SHALL be run by
the bridge as a search from this computer (DuckDuckGo), answered to the client as a
`server_tool_use` block named `web_search` with the call's input followed by a
`web_search_tool_result` block with at most 5 `web_search_result` items (`url`, `title`,
`encrypted_content`, `page_age`) or a `web_search_tool_result_error`, and handed to the
tab as a `tool` message listing each result's title, URL and snippet cut to 160 characters; the bridge SHALL
then chat again with the tab until it answers without searching. It SHALL keep results
to `allowed_domains` and drop `blocked_domains` (a host matches its domain and
subdomains), allow at most `max_uses` searches per request (5 when absent) and answer
further calls with error code `max_uses_exceeded`, and report the number of searches in
`usage.server_tool_use.web_search_requests`. Each search SHALL write one request log line
with its result count or error, never the query.

#### Scenario: Search then answer

- **WHEN** the request carries a `web_search_20250305` tool, the tab calls `web_search` with `{ query: 'hs.fi uutiset' }`, and then answers `Headlines: ...`
- **THEN** the response holds a `server_tool_use` block with that input, a `web_search_tool_result` block with the results, the text `Headlines: ...`, and `stop_reason: 'end_turn'`, and the tab's second `chat` ends with the call and a `tool` message named `web_search` listing the results

#### Scenario: Search fails

- **WHEN** the search engine cannot be reached
- **THEN** the result block holds a `web_search_tool_result_error` with `error_code: 'unavailable'`, and the tab is told the search failed and answers without it

#### Scenario: Out of searches

- **WHEN** `max_uses` is 1 and the tab calls `web_search` twice in one round
- **THEN** the second result block holds `error_code: 'max_uses_exceeded'` and the next `chat` offers no `web_search` tool

