# RebeLLM Bridge

Use the model running in your [RebeLLM](https://rebellm.ai) browser tab from tools on the
same machine: run Claude Code on it, call it from Claude Code and other MCP clients, or use
it from anything that speaks the Anthropic Messages API or the OpenAI chat API. The bridge
is a small local service; the tab connects to it and does the work. The bridge never runs a
model and never sees your RebeLLM identity.

## How it fits

```
Claude Code (rebellm-claude) ──HTTP /v1/messages────────────▶ rebellm-bridge ◀──WebSocket── RebeLLM tab
Claude Code (MCP tool) ────────MCP (stdio)──────────────────▶ 127.0.0.1:7343               (the model
curl / any OpenAI client ──────HTTP /v1/chat/completions────▶                               runs here)
```

## Getting started

You need Node 22 or later and a RebeLLM tab. Until the npm package is published, install
from this repository:

```
git clone https://github.com/Byteleap-Oy/RebeLLM-Bridge.git
cd RebeLLM-Bridge
npm install
npm run build
npm install -g .
```

That puts `rebellm-bridge` and `rebellm-claude` on your `PATH`.

1. Start the bridge: `rebellm-bridge`. The first start prints a token and stores it in
   `~/.rebellm-bridge/token`.
2. In RebeLLM → Settings → Local bridge, paste the token and turn the switch on. The card
   reads "Connected to 127.0.0.1:7343".
3. Use the model:
   - Claude Code on the tab's model: `rebellm-claude` (it starts the bridge itself when none
     runs, and waits for the tab).
   - Claude Code with the model as a tool: `claude mcp add rebellm -- rebellm-bridge --mcp`.
   - Any Anthropic or OpenAI client: base URL `http://127.0.0.1:7343` (OpenAI clients add
     `/v1`), any API key.

## Running the bridge

The first start creates a random token, stores it in `~/.rebellm-bridge/token` (owner-only
permissions; on Windows the file is protected by your user profile) and prints it once:

```
New bridge token (stored in /home/you/.rebellm-bridge/token):

  <your token>

Paste it into RebeLLM → Settings → Local bridge and turn the switch on. It is printed only this once.
```

Later starts reuse the file and only say where it is; `cat ~/.rebellm-bridge/token` shows it
again. Delete the file to get a new one. The tab connects within 30 s of the switch going on,
and the Settings card reads "Connected to 127.0.0.1:7343".

| Option          | Default                      | Meaning                                                    |
| --------------- | ---------------------------- | ---------------------------------------------------------- |
| `--port <n>`    | `7343`                       | one port for the tab (WebSocket) and the HTTP API          |
| `--host <addr>` | `127.0.0.1`                  | anything else prints a warning: it exposes your model      |
| `--token <t>`   | `REBELLM_BRIDGE_TOKEN`, file | the token the tab must present; the flag wins over the env |
| `--wait <s>`    | `120`                        | how long a request waits for the tab and a ready model     |
| `--mcp`         | off                          | also serve MCP over stdio (Claude Code starts it this way) |

## Claude Code on the tab's model

```
rebellm-claude
rebellm-claude -p "What is 2 + 3?"
```

`rebellm-claude` runs [Claude Code](https://claude.com/claude-code) with the model in your
RebeLLM tab as its model, for its main loop and its small helper requests alike:

- It uses the bridge already running on the port, or starts one in the same process
  (logging to `~/.rebellm-bridge/bridge.log`, since Claude Code owns the terminal) and stops
  it when Claude Code exits.
- Until a tab is connected it waits and says where to connect it (the token too, when this
  start created it). Ctrl+C quits.
- It starts `claude` with the bridge's address, a placeholder API key, the model name
  `rebellm`, the tab's context size (`CLAUDE_CODE_MAX_CONTEXT_TOKENS`, so Claude Code
  compacts in time) and a longer request timeout, and removes any `ANTHROPIC_API_KEY` from
  its environment, so your key never reaches the bridge. Every argument it does not own goes
  to `claude` (after `--`, all of them do), and it exits with `claude`'s exit code. Claude
  Code notes the model name it does not know on stderr
  (`[claude-code:unrecognized_model]`); that is expected.

| Option            | Default            | Meaning                                               |
| ----------------- | ------------------ | ----------------------------------------------------- |
| `--claude <path>` | `claude` on `PATH` | the Claude Code executable                            |
| `--shared-config` | off                | use your normal Claude Code config instead of its own |
| `--port <n>`      | `7343`             | the bridge's port; a bridge already there is reused   |

**Its own config.** Claude Code runs with `CLAUDE_CONFIG_DIR=~/.rebellm-bridge/claude`,
whose `settings.json` the launcher points at the bridge. Your claude.ai login, your
`/resume` history with Claude and your settings stay untouched, and the local model's
sessions stay apart from them. The price: your user-level settings, MCP servers and
`~/.claude/CLAUDE.md` are not loaded there (the project's `.claude/` and `CLAUDE.md` are),
and the first interactive start may ask Claude Code's first-run questions. `--shared-config`
uses your normal config instead, with the same environment on top.

**By hand.** Any Claude Code, or any Anthropic client, works with the bridge running:

```
export ANTHROPIC_BASE_URL=http://127.0.0.1:7343
export ANTHROPIC_AUTH_TOKEN=unused      # the bridge checks no key
export ANTHROPIC_MODEL=rebellm ANTHROPIC_DEFAULT_HAIKU_MODEL=rebellm
export CLAUDE_CODE_MAX_CONTEXT_TOKENS=32768   # the tab's context, as /health reports it
export API_TIMEOUT_MS=600000                  # a local model can take minutes
claude
```

(PowerShell: `$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:7343'` and so on.) Leave
`ANTHROPIC_API_KEY` unset, or your real key goes to the bridge and Claude Code prefers it.

**Context size.** Every Claude Code request carries its whole system prompt and tool
definitions before any conversation: a first `-p` request from Claude Code 2.1.283 was
about 49,000 characters, over half of them its 14 tool definitions: about 14k tokens by the
bridge's estimate, 11,360 by the tab's count. The app's default model has a context of 32768
tokens, so that leaves room for a short session; the tab must also read the whole prompt
before its first
token, which takes a while on a slow GPU. When a request does not fit, the bridge answers
`prompt is too long: N tokens > M maximum`, and `/compact` or `/clear` makes room. How well
Claude Code works depends on how well the tab's model uses tools; the model answers every
model name Claude Code asks for.

## Claude Code with the model as a tool

```
claude mcp add rebellm -- rebellm-bridge --mcp
```

Here Claude keeps its own model and can ask the tab's model through two tools; Claude Code
starts the bridge itself:

- `chat`: `messages` (`system`/`user`/`assistant`), optional `max_tokens` and
  `temperature`; returns the model's answer. While the answer streams, Claude Code gets
  progress notifications with the new text.
- `status`: whether a tab is connected and its model is ready, or how to connect one.

If a bridge already runs on the port (one you started by hand, or another Claude Code
session's), `--mcp` uses that one instead of failing, so every client shares the one tab. In
`--mcp` mode everything the bridge prints goes to stderr, so if Claude Code started it
first, read the token from `~/.rebellm-bridge/token`. A local model can take minutes on a
long answer; if Claude Code gives up first, raise `MCP_TOOL_TIMEOUT` (milliseconds).

## Anthropic Messages API

```
curl http://127.0.0.1:7343/v1/messages \
  -H 'Content-Type: application/json' -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"rebellm","max_tokens":100,"messages":[{"role":"user","content":"Name the capital of Finland in one word."}]}'
```

Anthropic's SDKs work with the base URL `http://127.0.0.1:7343` and any API key:

```python
from anthropic import Anthropic

client = Anthropic(base_url="http://127.0.0.1:7343", api_key="unused")
with client.messages.stream(
    model="rebellm",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Say hello."}],
) as stream:
    print(stream.get_final_message().content[0].text)
```

- `POST /v1/messages`: with and without `stream`. `system` (a string or text blocks), text,
  `tool_use` and `tool_result` blocks, custom `tools` (they come back as `tool_use` blocks
  with `stop_reason: "tool_use"`; `tool_choice: {"type": "none"}` sends none),
  `max_tokens`, `temperature` and `stop_sequences` (matched by the bridge, which then stops
  the tab) are used. `model` is ignored and answered with the tab's model; image and
  document blocks become `[image omitted]` / `[document omitted]`; thinking blocks, server
  tools and other fields are dropped. A stream follows the API's event order and sends a
  `ping` event every 10 s while it waits for the model.
- `POST /v1/messages/count_tokens`: `{ input_tokens }`, an estimate (`ceil(chars / 3.5)` over
  the system prompt, messages and tools; the bridge has no tokenizer). It needs no tab.
- Errors use Anthropic's shape `{ type: "error", error: { type, message } }`: 503
  `api_error` after the wait with the same reasons as below; 400 `invalid_request_error` for
  a body that is not a Messages request, and `prompt is too long: N tokens > M maximum` when
  the prompt does not fit the tab's context (by the estimate, or as the tab reports it);
  502 `api_error` when the tab fails or disconnects; mid-stream, an `error` event ends the
  stream.

## OpenAI-style HTTP API

```
curl http://127.0.0.1:7343/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"rebellm","messages":[{"role":"user","content":"Name the capital of Finland in one word."}]}'
```

Add `"stream": true` for server-sent events. Any OpenAI client works with the base URL; the
API key is not checked:

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:7343/v1", api_key="unused")
reply = client.chat.completions.create(
    model="rebellm",
    messages=[{"role": "user", "content": "Say hello."}],
)
print(reply.choices[0].message.content)
```

- `POST /v1/chat/completions`: with and without `stream` (`stream_options.include_usage`
  adds a usage chunk). `max_tokens` (or `max_completion_tokens`) and `temperature` go to the
  tab; `tools` go to the tab and come back as `tool_calls` with
  `finish_reason: "tool_calls"` for your client to run (`tool_choice: "none"` sends no
  tools). `model` is ignored and answered with the tab's model; image and other non-text
  parts become `[<type> omitted]`; other fields are ignored. While a stream waits for the
  model, an SSE comment every 15 s keeps the connection open. A non-streamed answer comes
  in one piece at the end, and some clients give up before then (Node's `fetch` waits 300 s
  for headers), so prefer `stream: true` when the model is slow.
- `GET /v1/models`: the tab's model, or an empty list without one.
- `GET /health`: `{ service, tab, state, model?, detail?, contextTokens?, app? }`, where
  `state` is `none`, `loading`, `ready` or `unavailable`.
- Errors use OpenAI's shape `{ error: { message, type, code } }`: 503 after the wait with
  `no RebeLLM tab connected` (`no_tab`), `model loading` (`model_loading`) or
  `model unavailable: <why>` (`model_unavailable`); 502 when the tab fails the chat or
  disconnects during it; 400 for a body that is not a chat request.

## Who can use it

Neither HTTP API checks a key: the bridge listens on loopback only, so it is open to every
program on this machine but not to the network. Requests from web pages (with an `Origin`
header) and with a `Host` other than `127.0.0.1`, `localhost` or `[::1]` get 403 (in each
API's own error shape), so a site in your browser cannot use your model. The tab's WebSocket
needs the token.

## Protocol v1 (tab ↔ bridge)

Owned by the RebeLLM app's `local-bridge` spec; this is the current copy. JSON text
frames over one WebSocket; the tab is the client.

Tab → bridge on open: `{ t: 'hello', v: 1, token, model, contextTokens, app }`. The bridge
answers `{ t: 'ok' }`, or `{ t: 'error', code: 'auth' | 'version', message? }` and closes;
the tab does not retry a rejected token or version until its setting changes. `{ t: 'error',
code: 'busy' }` means another tab holds the bridge; the tab retries with its backoff (2, 4,
8, 16, then 30 s, also after a dropped connection).

Bridge → tab: `{ t: 'chat', id, messages, tools?, maxTokens?, temperature? }` — messages
are `{ role: system|user|assistant|tool, content, name?, tool_calls? }`, calls `{ id?,
function: { name, arguments } }` (arguments an object or a JSON string). Without
`maxTokens` the tab uses its own limit, never more than the context leaves after the prompt;
`temperature` applies to that request only. `{ t: 'abort', id }` stops a running or waiting
chat.

Tab → bridge for a chat: `{ t: 'token', id, text }` per streamed piece; `{ t: 'tool_call',
id, calls }` when the model stops on tool calls declared by the bridge, each with an id
`<chat id>-call-<n>` (the bridge executes them and sends a new `chat` with the results
appended; without `tools` the model's text goes out as written); `{ t: 'done', id, stop:
eos|length|tool_call|abort, usage: { prompt, completion, tokensPerSec } }` (an answer cut for
repeating itself ends with `length`); `{ t: 'error', id, message }`, also for a chat the tab
cannot read and for every chat while its model is unavailable; `{ t: 'queued', id, position }`
(1 is next) when a chat cannot start at once. Every chat ends with exactly one `done` or
`error`.

Either way: `{ t: 'ping' }` / `{ t: 'pong' }` every 20 s; the tab drops a connection that
stays silent for 50 s and reconnects. Tab → bridge after `ok` and on every model state
change: `{ t: 'status', state: loading|ready|unavailable, model?, detail? }` (unavailable: not
loaded, failed to load, or Serve only).

One chat runs at a time per tab, and only while none of the user's own turns runs, so a turn
is never interrupted; a chat that arrives while the model loads waits for it. A dropped
connection ends its chats in the tab.

This bridge checks a `hello`'s version, then its token, then whether a tab is already
connected, and closes a refused connection with code 4001, 4000 or 4002 (4003 when the first
frame is not a `hello`). It pings every 20 s and drops a tab silent for 50 s. Until the tab's
first `status` its model counts as loading; requests wait for `ready`.

## Tried on 2026-09-26

Bridge 0.1.0 from a clone (`node dist/cli.js`, fresh home directory) against a RebeLLM
development build (`npm run dev`) in Chrome with WebGPU on one Windows PC, with the app's
default model `qwen3.6-35b-a3b` loaded from local files and no relay.

- The first start printed the token once and created the token file; a restart printed only
  its location.
- Token pasted in Settings → Local bridge, switch on, Save: the bridge logged the tab within a
  second and the card read "Connected to 127.0.0.1:7343". The bridge logged the tab's model
  states in order: unavailable (not loaded yet), loading, ready (about 100 s after connecting).
- `GET /v1/models` listed `qwen3.6-35b-a3b`.
- The curl example above answered `"content":"Helsinki"`, `finish_reason` `stop`, usage 21
  prompt and 3 completion tokens, after 5 min 15 s.
- The same with `"stream": true` (another question): the role chunk at once, the text chunk
  after 5 min 43 s, then the finish chunk, the usage chunk and `[DONE]`.
- `rebellm-bridge --mcp` spawned over stdio the way Claude Code does, while the bridge above
  held the port: it used that bridge; `status` read "The model qwen3.6-35b-a3b is ready, with
  a context of 32768 tokens"; `chat` answered "What is 2 + 3?" with `5` after 319 s, with a
  progress notification for the streamed text. Its first try failed at 300 s, when Node's
  `fetch` gave up on the silent stream; that is why streams now carry keep-alive comments.
- The minutes are the model in the tab on that PC, not the bridge: the app's own chat, with no
  bridge involved, was still thinking about the same question after 10 minutes.

Later the same day, the Messages API and `rebellm-claude`: bridge 0.1.0 from a clone (fresh
home directory), the same app build and PC, Claude Code 2.1.283.

- A streamed `POST /v1/messages` from Anthropic's TypeScript SDK (`messages.stream`, the
  system prompt as a text block with `cache_control`, "Name the capital of Finland.",
  `max_tokens` 64): `message_start` at once, a `ping` every 10 s, `Helsinki` in two deltas
  after 35 s, then `message_delta` with `end_turn` and the tab's usage (28 prompt, 3
  completion tokens) and `message_stop` after 38 s. `count_tokens` for the same body answered
  14 at once; the estimate misses the chat template's own tokens on so short a prompt.
- `rebellm-claude -p "What is 2 + 3?"` with the real `claude` against a scripted tab that
  answers `5`: it reused the running bridge, started `claude` with its own config and printed
  `5` (exit 0) after 3 s. The first try showed that Claude Code sends a `system` message inside
  `messages`, which the bridge now passes on as a user message, and that it assumes 200k tokens
  of context for a model it does not know, which the launcher now sets from the tab.
- The same against the real tab: the tab read Claude Code's prompt, 11,360 tokens, for 21
  minutes and had loaded the experts of 30 of the model's 40 layers when the page reloaded
  (the development server had asked for a reload after another change to the app's files).
  The bridge ended the stream with an `error` event. After the reload the Local bridge switch
  was still on but its token was empty; with the token pasted again, Claude Code's retry
  reached the tab, which then stood still at the first layer's experts with the GPU idle, and
  Claude Code gave up after about 5 minutes with `Request timed out` (exit 1, passed on by the
  launcher). So no answer from the real model through Claude Code yet: on this PC, with a 4 GB
  expert budget, a prompt of Claude Code's size makes the tab load most of the model's experts
  before the first token.

## Development

```
npm install        # also enables the pre-commit gate (.githooks)
npm run check      # typecheck, lint, format, tests
```

All changes go through the OpenSpec flow described in `CLAUDE.md`.

## Licence

Apache-2.0 with the Commons Clause (see `LICENSE`). Free to use, change and share, for
anyone, companies included. Not for sale: you may not sell the software, or a hosting or
support service whose value comes substantially from it. RebeLLM itself is a separate,
proprietary project.
