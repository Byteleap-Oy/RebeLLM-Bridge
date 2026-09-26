# messages-api Specification

## Purpose
TBD - created by archiving change anthropic-messages. Update Purpose after archive.
## Requirements
### Requirement: Messages endpoint

The bridge SHALL serve `POST /v1/messages` in the Anthropic Messages API format, answer
with a complete message when `stream` is false and with server-sent events in the
Anthropic event order when `stream` is true, and generate the reply with the connected
tab's model whatever `model` the request names. Like the OpenAI endpoint it SHALL check no
API key and wait for a ready model up to the bridge's wait time.

#### Scenario: Plain answer

- **WHEN** a client posts a user message without `stream`
- **THEN** the response is a `message` with one text block, `stop_reason: 'end_turn'` and usage from the tab's `done`

#### Scenario: Streamed answer

- **WHEN** a client posts with `stream: true`
- **THEN** it receives `message_start`, a text block streamed as `text_delta` events, `message_delta` with the stop reason and usage, and `message_stop`

#### Scenario: Slow tab

- **WHEN** a streamed answer's first token takes longer than 10 s
- **THEN** the client receives a `ping` event every 10 s until it comes

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
placeholder text, thinking blocks and server tools are dropped, a `system` message inside
`messages` becomes a `user` message with its text in the same place (the tab's chat
templates take a system message only at the start), and unsupported parameters are
ignored.

#### Scenario: Image in a user message

- **WHEN** a user message has a text block and an image block
- **THEN** the tab receives the text followed by `[image omitted]`

#### Scenario: Mid-conversation system message

- **WHEN** `messages` holds a user message followed by a `system` message, as Claude Code sends them
- **THEN** the tab's `chat` has the top-level `system` first and that message's text as a `user` message after the user's

### Requirement: Stop sequences

The bridge SHALL end generation at the first match of any `stop_sequences` entry, not
emit the match, abort the tab's chat, and report `stop_reason: 'stop_sequence'` with the
matched sequence.

#### Scenario: Stop sequence split across tokens

- **WHEN** the stop sequence is `END` and the tab streams `ok E` then `ND more`
- **THEN** the client receives text `ok `, `stop_sequence: 'END'`, and the tab receives `abort`

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
the wait, 502 `api_error` when the tab fails or disconnects during a non-streamed answer,
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

### Requirement: Token counting

The bridge SHALL serve `POST /v1/messages/count_tokens` with `{ input_tokens }` estimated as
`ceil(chars / 3.5)` over the request's system prompt, messages and tools, with or without a
connected tab.

#### Scenario: Count tokens

- **WHEN** a client posts a messages body to `/v1/messages/count_tokens`
- **THEN** the response is `{ input_tokens: n }` with n greater than zero

