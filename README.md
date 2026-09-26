# RebeLLM Bridge

Use the model running in your [RebeLLM](https://rebellm.ai) browser tab from the command
line, from any OpenAI or Anthropic client, and from Claude Code. The bridge is a small local
service: the tab connects to it and does the work; the bridge runs no model and holds no
keys.

```
Claude Code / curl / SDKs ──HTTP──▶ rebellm-bridge (127.0.0.1:7343) ◀──WebSocket── RebeLLM tab
```

## Getting started

Node 22+ and a RebeLLM tab.

```
npm install -g rebellm-bridge     # or run it once with: npx rebellm-bridge
```

(From source: clone this repo, `npm install && npm run build && npm install -g .`.)

1. `rebellm-bridge` — the first start prints a token once and keeps it in
   `~/.rebellm-bridge/token` (`cat` it to see it again, delete it for a new one).
2. In RebeLLM: Bridge (top of the page) → paste the token, Save, switch on. The sidebar reads
   "Connected to 127.0.0.1:7343". The model must be loaded in that tab.
3. Check: `curl http://127.0.0.1:7343/health` → `{"tab":true,"state":"ready",...}`.

## Use it from the command line

OpenAI-style (streaming recommended — a local model can take minutes for the first token):

```
curl -N http://127.0.0.1:7343/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"rebellm","stream":true,"messages":[{"role":"user","content":"Capital of Finland, one word."}]}'
```

Anthropic-style:

```
curl -N http://127.0.0.1:7343/v1/messages -H 'Content-Type: application/json' -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"rebellm","max_tokens":100,"stream":true,"messages":[{"role":"user","content":"Capital of Finland, one word."}]}'
```

Other routes: `GET /v1/models`, `GET /health`, `POST /v1/messages/count_tokens` (an
estimate, works without a tab). No API key is checked: the bridge listens on loopback only
and refuses requests from web pages (`Origin`) and foreign `Host` names. `model` is
ignored; the tab's model answers. `tools` are forwarded and come back as tool calls for your
client to run.

SDKs: OpenAI with `base_url="http://127.0.0.1:7343/v1"`, Anthropic with
`base_url="http://127.0.0.1:7343"`, any `api_key`.

## Claude Code

As Claude Code's model (its own config directory, your claude.ai login untouched):

```
npx rebellm-bridge claude        # nothing to install; rebellm-claude after npm install -g
rebellm-claude -p "What is 2 + 3?"
```

It reuses a running bridge or starts one, waits for the tab, sets the tab's context size
and a long request timeout, and passes every other argument to `claude`. Options:
`--claude <path>`, `--shared-config` (use your normal Claude Code config), `--port <n>`.
Claude Code's first request is ~11k tokens of system prompt and tools, so it needs a tab
with a 32k context and patience on a slow GPU.

On a work machine Claude Code may be pinned to the company's endpoint or cloud provider.
The launcher blanks `ANTHROPIC_API_KEY`, `ANTHROPIC_CUSTOM_HEADERS` and `CLAUDE_CODE_USE_*`
from your shell and passes its own variables with `--settings`, which ranks above the
project's `.claude/settings.json` and your user settings. Managed settings (MDM,
`managed-settings.json`, the claude.ai admin console) rank above that and only your
organisation can change them: the launcher names the file when it finds one, and `/status`
inside `claude` lists the setting sources in force.

As a tool inside your normal Claude Code (Claude keeps its own model, can ask yours):

```
claude mcp add rebellm -- rebellm-bridge --mcp
```

Tools: `chat` (messages, optional `max_tokens`, `temperature`; streams progress) and
`status`. Raise `MCP_TOOL_TIMEOUT` if Claude Code gives up before a slow answer.

## Options

| Option          | Default                      | Meaning                                            |
| --------------- | ---------------------------- | -------------------------------------------------- |
| `--port <n>`    | `7343`                       | one port for the tab (WebSocket) and HTTP          |
| `--host <addr>` | `127.0.0.1`                  | anything else exposes your model; prints a warning |
| `--token <t>`   | `REBELLM_BRIDGE_TOKEN`, file | the token the tab must present                     |
| `--wait <s>`    | `120`                        | how long a request waits for a ready tab           |
| `--mcp`         | off                          | also serve MCP over stdio                          |

## Test it locally

```
npm run check                      # typecheck, lint, format, unit and end-to-end tests (fake tab)
npm run build && node dist/cli.js  # then connect a real tab and curl as above
```

The tests start bridges on free ports and drive them with a fake tab that speaks the
protocol; nothing needs a GPU.

## Protocol

The tab speaks protocol v1 to the bridge: JSON frames over one WebSocket — `hello` (token,
version, model, context) → `ok`/`error`; the bridge sends `chat`/`abort`, the tab answers
`queued`, `token`, `tool_call`, `done` (stop reason, usage) or `error`, plus `status` on
model state changes and `ping`/`pong`. Types and parser: `src/protocol.ts`; the RebeLLM app
owns the specification.

## Development

All changes go through the OpenSpec flow in `CLAUDE.md`; `npm install` enables the
pre-commit gate.

## Licence

Apache-2.0 with the Commons Clause (see `LICENSE`): free to use, change and share, for
anyone, companies included; not for sale — no selling the software or a hosting or support
service whose value comes substantially from it. Source-available, not open source in the
OSI sense. RebeLLM itself is a separate, proprietary product.
