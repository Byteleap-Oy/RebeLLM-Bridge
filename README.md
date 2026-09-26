# RebeLLM Bridge

Use the model running in your [RebeLLM](https://rebellm.ai) browser tab from tools on the
same machine: Claude Code and other MCP clients, and anything that speaks the OpenAI chat
API. The bridge is a small local service; the tab connects to it and does the work. The
bridge never runs a model and never sees your RebeLLM identity.

Status: scaffold. The protocol below is fixed; the MCP server and the HTTP endpoint are
the first changes in `openspec/changes/`.

## How it fits

```
Claude Code ──MCP (stdio)──▶ rebellm-bridge ◀──WebSocket (ws://127.0.0.1:7343)── RebeLLM tab
curl / any OpenAI client ──HTTP /v1/chat/completions──▶      (model runs here, in the browser)
```

1. `npx rebellm-bridge` prints a token and listens on `127.0.0.1:7343`.
2. In RebeLLM → Settings → Local bridge: paste the token, turn the switch on.
3. Add the bridge to Claude Code as an MCP server, or point an OpenAI client at
   `http://127.0.0.1:7343/v1`.

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

## Development

```
npm install        # also enables the pre-commit gate (.githooks)
npm run check      # typecheck, lint, format, tests
```

All changes go through the OpenSpec flow described in `CLAUDE.md`.

## Licence

Apache-2.0. RebeLLM itself is a separate, proprietary project.
