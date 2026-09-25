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
answers `{ t: 'ok' }` or `{ t: 'error', code: 'auth' | 'version' }` and closes.

Bridge → tab: `{ t: 'chat', id, messages, tools?, maxTokens?, temperature? }` — messages
are `{ role: system|user|assistant|tool, content, name?, tool_calls? }`; `{ t: 'abort', id }`.

Tab → bridge while a chat runs: `{ t: 'token', id, text }` per token; `{ t: 'tool_call', id,
calls }` when the model stops on tool calls declared by the bridge (the bridge executes
them and sends a new `chat` with the results appended); `{ t: 'done', id, stop:
eos|length|tool_call|abort, usage: { prompt, completion, tokensPerSec } }`; `{ t: 'error',
id, message }`; `{ t: 'queued', id, position }` when a chat waits behind the user's own turn.

Either way: `{ t: 'ping' }` / `{ t: 'pong' }` every 20 s. Tab → bridge on model state
changes: `{ t: 'status', state: loading|ready|unavailable, model?, detail? }`.

One chat runs at a time per tab; the user's own turn is never interrupted.

## Development

```
npm install        # also enables the pre-commit gate (.githooks)
npm run check      # typecheck, lint, format, tests
```

All changes go through the OpenSpec flow described in `CLAUDE.md`.

## Licence

Apache-2.0. RebeLLM itself is a separate, proprietary project.
