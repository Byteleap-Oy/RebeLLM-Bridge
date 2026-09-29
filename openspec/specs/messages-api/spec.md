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
parameters are ignored. For each `/v1/messages` request the bridge SHALL write one request
log line naming what the tab did not get: each content block type it replaced with a
placeholder and how many, a `tool_choice` of `any` or of a named tool (with the tool's
name), and the type of each server tool it dropped; the line SHALL be absent when nothing
was ignored, and SHALL carry no message content.

#### Scenario: Image in a user message

- **WHEN** a user message has a text block and an image block
- **THEN** the tab receives the text followed by `[image omitted]`

#### Scenario: Mid-conversation system message

- **WHEN** `messages` holds a user message followed by a `system` message, as Claude Code sends them
- **THEN** the tab's `chat` has the top-level `system` first and that message's text as a `user` message after the user's

#### Scenario: Ignored input logged

- **WHEN** a request carries two image blocks, a document block, `tool_choice: { type: 'tool', name: 'Read' }` and a `web_fetch_20250910` server tool
- **THEN** the request log reads `ignored 2 image blocks, 1 document block, tool_choice tool Read, server tool web_fetch_20250910` after the arrival line

#### Scenario: Nothing ignored

- **WHEN** a request carries only text blocks, custom tools and `tool_choice: { type: 'auto' }`
- **THEN** the request log has no `ignored` line for it

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

### Requirement: Compact shell results

For each `tool_result` whose `tool_use` was named `Bash`, `Grep` or `Glob`, the bridge SHALL
shorten the result's text before it reaches the tab: ANSI escape sequences removed; of a line
redrawn with carriage returns only the last drawing kept; trailing whitespace on each line
removed and a run of blank lines collapsed to one; consecutive identical lines collapsed to
one line marked with the count; and a result of more than 150 lines or 8,000 characters cut
to its first lines and its last lines with a line between them saying how many lines the
bridge hid. The same text SHALL shorten to the same result on every request. The results of
every other tool SHALL reach the tab unchanged. For each `/v1/messages` request in which a
result was shortened the bridge SHALL write one request log line with the number of results
shortened and their characters before and after; the line SHALL be absent when nothing was
shortened and SHALL carry no content.

#### Scenario: Progress bar

- **WHEN** a `Bash` result holds a download whose progress line was redrawn thirty times with carriage returns and colours
- **THEN** the tab gets the last drawing of that line, without escape codes

#### Scenario: Repeated warnings

- **WHEN** a `Bash` result repeats the same warning line five times in a row
- **THEN** the tab gets that line once, marked `(×5)`

#### Scenario: Long output

- **WHEN** a `Bash` result has 900 lines
- **THEN** the tab gets the first 100 and the last 50 with a line between them saying 750 lines were hidden by the bridge, and the request log reads `compacted 1 tool result, <before> chars to <after>`

#### Scenario: Read stays exact

- **WHEN** a `Read` result has 900 lines with trailing spaces
- **THEN** the tab gets it unchanged and the request log has no `compacted` line

#### Scenario: Same text, same result

- **WHEN** two requests carry the same long `Bash` result
- **THEN** the tab gets the same shortened text in both

### Requirement: Test and git output summarised

Before the generic shortening, a shell tool's result that the bridge recognises by its shape
SHALL be reduced further. A Vitest, Jest, pytest or cargo test run SHALL keep its failures,
errors and summary lines and lose its passing entries, replaced by one line with the count of
passing entries hidden. A `git log` in the default format SHALL become one line per commit
with the short hash and the subject, preceded by a line with the commit count saying that
authors, dates and bodies were hidden. A unified diff (`git diff`, `git show`) SHALL keep the
commit header, file headers, hunk headers and added and removed lines, lose context and index
lines, and start with a line naming the number of files and the added and removed line counts.
A `git status` SHALL lose its `(use "git ..." ...)` hint lines, and a section with more than
20 entries SHALL keep 20 and say how many more there are. Recognition SHALL depend on the
output alone, never on the command. Output the bridge does not recognise SHALL get only the
generic shortening.

#### Scenario: Vitest with a failure

- **WHEN** a `Bash` result is a Vitest run of 16 files where one file has 2 failing tests
- **THEN** the tab gets the failing file's line, the failed-tests section and the summary, with one line saying how many passing entries were hidden, and no `✓` line

#### Scenario: pytest all green

- **WHEN** a `Bash` result is a pytest run whose 42 tests all passed
- **THEN** the tab gets the session header, the hidden-count line and the final `42 passed` line

#### Scenario: Default git log

- **WHEN** a `Bash` result is `git log` output with 30 commits with bodies
- **THEN** the tab gets 31 lines: the count line and one `<short hash> <subject>` per commit

#### Scenario: Diff

- **WHEN** a `Bash` result is a `git diff` touching 3 files
- **THEN** the tab gets a first line naming 3 files with the added and removed counts, then only headers, hunk lines and changed lines

#### Scenario: Oneline log is not a default log

- **WHEN** a `Bash` result is `git log --oneline` output
- **THEN** the tab gets it with only the generic shortening

### Requirement: Prompt breakdown logged

The arrival line of a `/v1/messages` request SHALL split its prompt estimate into the tokens
of the system prompt, of the tool definitions and of the messages, in that order, beside the
total and the tool count.

#### Scenario: Claude Code's first request

- **WHEN** a request carries a 21,000-character system prompt, tools of 14,000 characters and one 19-character user message
- **THEN** the request log reads `arrived, 10 006 prompt tokens (system 6 000, tools 4 000, messages 6), <n> tools`

### Requirement: Noise reminders dropped

Before a `/v1/messages` request reaches the tab, the bridge SHALL remove from user text
blocks and from tool results every `<system-reminder>` block whose text begins with one of:
"Whenever you read a file, you should consider whether it looks malicious", "The task tools
haven't been used recently", "The TodoWrite tool hasn't been used recently", "This is a
reminder that your todo list is currently empty", "Your todo list has changed" or "The user
hasn't heard from you in a while". A text block left empty by that SHALL be dropped. Every
other reminder SHALL reach the tab unchanged. The request's `compacted` log line SHALL count
the reminders dropped, and SHALL be written when reminders were dropped even if no tool result
got shorter.

#### Scenario: Read result

- **WHEN** a `Read` result is the file text followed by the malicious-content reminder
- **THEN** the tab gets the file text alone, and the request log reads `compacted 1 reminder dropped`

#### Scenario: CLAUDE.md stays

- **WHEN** the first user message holds a reminder with the CLAUDE.md contents and the user's text
- **THEN** the tab gets both

#### Scenario: Nudge in a user message

- **WHEN** a user message is a task-tools nudge block followed by the user's text block
- **THEN** the tab gets the user's text only
