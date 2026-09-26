# RebeLLM Bridge

Use the model running in your [RebeLLM](https://rebellm.ai) browser tab from tools on the
same machine: Claude Code and other MCP clients, and anything that speaks the OpenAI chat
API. The bridge is a small local service; the tab connects to it and does the work. The
bridge never runs a model and never sees your RebeLLM identity.

## How it fits

```
Claude Code ──MCP (stdio)──▶ rebellm-bridge ◀──WebSocket (ws://127.0.0.1:7343)── RebeLLM tab
curl / any OpenAI client ──HTTP /v1/chat/completions──▶      (model runs here, in the browser)
```

1. `npx rebellm-bridge` prints a token and listens on `127.0.0.1:7343`.
2. In RebeLLM → Settings → Local bridge: paste the token, turn the switch on.
3. Add the bridge to Claude Code as an MCP server, or point an OpenAI client at
   `http://127.0.0.1:7343/v1`.

## Install and first start

Node 22 or later. Run it without installing:

```
npx rebellm-bridge
```

or install it once with `npm install -g rebellm-bridge` and run `rebellm-bridge`. From a
clone: `npm install && npm run build && node dist/cli.js`.

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

## Claude Code

```
claude mcp add rebellm -- npx rebellm-bridge --mcp
```

Claude Code then starts the bridge itself, and it offers two tools:

- `chat`: `messages` (`system`/`user`/`assistant`), optional `max_tokens` and
  `temperature`; returns the model's answer. While the answer streams, Claude Code gets
  progress notifications with the new text.
- `status`: whether a tab is connected and its model is ready, or how to connect one.

If a bridge already runs on the port (one you started by hand, or another Claude Code
session's), `--mcp` uses that one instead of failing, so every client shares the one tab. In
`--mcp` mode everything the bridge prints goes to stderr, so if Claude Code started it
first, read the token from `~/.rebellm-bridge/token`. A local model can take minutes on a
long answer; if Claude Code gives up first, raise `MCP_TOOL_TIMEOUT` (milliseconds).

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

The HTTP API has no token: it listens on loopback only, so it is open to every program on
this machine but not to the network. Requests from web pages (with an `Origin` header) and
with a `Host` other than `127.0.0.1`, `localhost` or `[::1]` get 403, so a site in your
browser cannot use your model. The tab's WebSocket needs the token.

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

## Development

```
npm install        # also enables the pre-commit gate (.githooks)
npm run check      # typecheck, lint, format, tests
```

All changes go through the OpenSpec flow described in `CLAUDE.md`.

## Licence

Apache-2.0. RebeLLM itself is a separate, proprietary project.
