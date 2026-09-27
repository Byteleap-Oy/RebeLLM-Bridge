import { randomBytes } from 'node:crypto'
import type { ChatMessage, StopReason as TabStop, ToolCall, ToolSchema, Usage as TabUsage } from '../protocol.js'
import type { ChatInput } from '../tab.js'
import type { ApiError, ContentBlock, Message, StopReason, ToolUseBlock, Usage } from './types.js'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const absent = (v: unknown) => v === undefined || v === null

export const newId = () => randomBytes(12).toString('hex')

export type ParsedMessages = { input: ChatInput; stream: boolean; stopSequences: string[] } | { error: string }

/** A content block the tab cannot take, as text it can. */
const omitted = (type: string) => `[${type} omitted]`

function blockText(b: unknown, at: string): string | { error: string } {
  if (!isObj(b) || !isStr(b.type)) return { error: `${at} must be a content block with a type` }
  if (b.type !== 'text') return omitted(b.type)
  return isStr(b.text) ? b.text : { error: `${at}.text must be a string` }
}

function blocksText(blocks: unknown[], path: string): string | { error: string } {
  const parts: string[] = []
  for (const [j, b] of blocks.entries()) {
    const text = blockText(b, `${path}.${j}`)
    if (!isStr(text)) return text
    parts.push(text)
  }
  return parts.join('\n\n')
}

function systemText(s: unknown): string | { error: string } {
  if (absent(s)) return ''
  if (isStr(s)) return s
  if (!Array.isArray(s)) return { error: 'system must be a string or an array of text blocks' }
  return blocksText(s, 'system')
}

function toolResult(b: Obj, path: string, names: Map<string, string>): ChatMessage | { error: string } {
  if (!isStr(b.tool_use_id)) return { error: `${path}.tool_use_id must be a string` }
  let text: string | { error: string } = ''
  if (isStr(b.content)) text = b.content
  else if (Array.isArray(b.content)) text = blocksText(b.content, `${path}.content`)
  else if (!absent(b.content)) return { error: `${path}.content must be a string or an array of blocks` }
  if (!isStr(text)) return text
  const name = names.get(b.tool_use_id)
  return { role: 'tool', content: b.is_error === true ? `Error: ${text}` : text, ...(name ? { name } : {}) }
}

/** One user message: text in order, each tool result its own `tool` message. */
function userMessages(content: unknown[], path: string, names: Map<string, string>): ChatMessage[] | { error: string } {
  const out: ChatMessage[] = []
  let texts: string[] | null = null
  const flush = () => {
    if (texts) out.push({ role: 'user', content: texts.join('\n\n') })
    texts = null
  }
  for (const [j, b] of content.entries()) {
    const at = `${path}.${j}`
    if (!isObj(b) || !isStr(b.type)) return { error: `${at} must be a content block with a type` }
    if (b.type === 'tool_result') {
      flush()
      const m = toolResult(b, at, names)
      if ('error' in m) return m
      out.push(m)
      continue
    }
    const text = blockText(b, at)
    if (!isStr(text)) return text
    ;(texts ??= []).push(text)
  }
  flush()
  return out.length ? out : [{ role: 'user', content: '' }]
}

/** An assistant message: its text and tool calls; thinking and server-tool blocks are dropped. */
function assistantMessage(
  content: unknown[],
  path: string,
  names: Map<string, string>,
): ChatMessage | { error: string } {
  const texts: string[] = []
  const calls: ToolCall[] = []
  for (const [j, b] of content.entries()) {
    const at = `${path}.${j}`
    if (!isObj(b) || !isStr(b.type)) return { error: `${at} must be a content block with a type` }
    if (b.type === 'text') {
      if (!isStr(b.text)) return { error: `${at}.text must be a string` }
      if (b.text) texts.push(b.text)
    } else if (b.type === 'tool_use') {
      if (!isStr(b.id) || !isStr(b.name) || !(absent(b.input) || isObj(b.input)))
        return { error: `${at} must be a tool_use block with an id, a name and an object input` }
      names.set(b.id, b.name)
      calls.push({ id: b.id, function: { name: b.name, arguments: isObj(b.input) ? b.input : {} } })
    }
  }
  return { role: 'assistant', content: texts.join('\n\n'), ...(calls.length ? { tool_calls: calls } : {}) }
}

function toolSchemas(tools: unknown): ToolSchema[] | { error: string } {
  if (!Array.isArray(tools)) return { error: 'tools must be an array' }
  const out: ToolSchema[] = []
  for (const [i, t] of tools.entries()) {
    if (!isObj(t)) return { error: `tools.${i} must be an object` }
    // Server tools (web search, code execution, ...) run at Anthropic; the tab has none.
    if (!absent(t.type) && t.type !== 'custom') continue
    if (!isStr(t.name) || !t.name) return { error: `tools.${i}.name must be a non-empty string` }
    if (!absent(t.description) && !isStr(t.description)) return { error: `tools.${i}.description must be a string` }
    if (!absent(t.input_schema) && !isObj(t.input_schema)) return { error: `tools.${i}.input_schema must be an object` }
    out.push({
      type: 'function',
      function: {
        name: t.name,
        description: isStr(t.description) ? t.description : '',
        parameters: isObj(t.input_schema) ? t.input_schema : { type: 'object', properties: {} },
      },
    })
  }
  return out
}

/** A Messages API request as the tab's `chat`; the error names the field that is wrong. */
export function toChatInput(body: unknown): ParsedMessages {
  if (!isObj(body)) return { error: 'the body must be a JSON object' }
  if (!Array.isArray(body.messages) || !body.messages.length) return { error: 'messages must be a non-empty array' }
  const messages: ChatMessage[] = []
  const system = systemText(body.system)
  if (!isStr(system)) return system
  if (system) messages.push({ role: 'system', content: system })
  // A tool result names its call only by id; the tab wants the tool's name.
  const names = new Map<string, string>()
  for (const [i, m] of body.messages.entries()) {
    const path = `messages.${i}`
    if (!isObj(m)) return { error: `${path} must be an object` }
    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'system')
      return { error: `${path}.role must be "user", "assistant" or "system", not ${JSON.stringify(m.role)}` }
    if (!isStr(m.content) && !Array.isArray(m.content))
      return { error: `${path}.content must be a string or an array of content blocks` }
    // Chat templates take a system message only at the start (Qwen's raises otherwise).
    if (m.role === 'system') {
      const text = isStr(m.content) ? m.content : blocksText(m.content, `${path}.content`)
      if (!isStr(text)) return text
      messages.push({ role: 'user', content: text })
      continue
    }
    if (isStr(m.content)) {
      messages.push({ role: m.role, content: m.content })
      continue
    }
    const out =
      m.role === 'user'
        ? userMessages(m.content, `${path}.content`, names)
        : assistantMessage(m.content, `${path}.content`, names)
    if ('error' in out) return out
    messages.push(...(Array.isArray(out) ? out : [out]))
  }
  const input: ChatInput = { messages }
  const choice = body.tool_choice
  if (!absent(body.tools) && !(isObj(choice) && choice.type === 'none')) {
    const tools = toolSchemas(body.tools)
    if ('error' in tools) return tools
    if (tools.length) input.tools = tools
  }
  if (!absent(body.max_tokens)) {
    if (!Number.isInteger(body.max_tokens) || (body.max_tokens as number) < 1)
      return { error: 'max_tokens must be a positive integer' }
    input.maxTokens = body.max_tokens as number
  }
  if (!absent(body.temperature)) {
    const t = body.temperature
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0)
      return { error: 'temperature must be a number of at least 0' }
    input.temperature = t
  }
  let stopSequences: string[] = []
  if (!absent(body.stop_sequences)) {
    if (!Array.isArray(body.stop_sequences) || !body.stop_sequences.every(isStr))
      return { error: 'stop_sequences must be an array of strings' }
    stopSequences = body.stop_sequences.filter((s) => s.length > 0)
  }
  return { input, stream: body.stream === true, stopSequences }
}

/** Rough prompt size without a tokenizer: `ceil(chars / 3.5)` over messages, calls and tools. */
export function estimateTokens(input: ChatInput): number {
  let chars = 0
  for (const m of input.messages) {
    chars += m.content.length + (m.name?.length ?? 0)
    for (const c of m.tool_calls ?? []) chars += c.function.name.length + JSON.stringify(c.function.arguments).length
  }
  for (const { function: f } of input.tools ?? [])
    chars += f.name.length + f.description.length + JSON.stringify(f.parameters).length
  return Math.ceil(chars / 3.5)
}

/** The wording Claude Code reacts to by compacting the conversation. */
export const tooLong = (tokens: number, max: number) => `prompt is too long: ${tokens} tokens > ${max} maximum`

// The RebeLLM tab's wording when a prompt does not fit its context.
const TAB_TOO_LONG = /^The prompt needs (\d+) tokens; the tab's context holds (\d+)/

/** The sizes in the tab's "prompt does not fit" error; null for any other error. */
export function tabTooLong(message: string): { tokens: number; max: number } | null {
  const m = TAB_TOO_LONG.exec(message)
  return m ? { tokens: Number(m[1]), max: Number(m[2]) } : null
}

/** A failed chat as an API error; the tab's "prompt does not fit" becomes Claude Code's "too long". */
export function tabError(message: string): ApiError {
  const t = tabTooLong(message)
  return t ? { type: 'invalid_request_error', message: tooLong(t.tokens, t.max) } : { type: 'api_error', message }
}

export function stopReason(stop: TabStop, calls: number): StopReason {
  if (calls || stop === 'tool_call') return 'tool_use'
  return stop === 'length' ? 'max_tokens' : 'end_turn'
}

export const usage = (input: number, output: number): Usage => ({
  input_tokens: input,
  output_tokens: output,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
})

export const tabUsage = (u: TabUsage) => usage(u.prompt, u.completion)

export const toolUse = (c: ToolCall): ToolUseBlock => ({
  type: 'tool_use',
  id: c.id ?? `toolu_${newId()}`,
  name: c.function.name,
  input: c.function.arguments,
})

/** The content of an answer: its text (always, when there are no calls), then its tool calls. */
export const content = (text: string, calls: ToolUseBlock[]): ContentBlock[] => [
  ...(text || !calls.length ? [{ type: 'text' as const, text }] : []),
  ...calls,
]

export function message(
  meta: { id: string; model: string },
  blocks: ContentBlock[],
  stop: { reason: StopReason | null; sequence: string | null },
  u: Usage,
): Message {
  return {
    id: meta.id,
    type: 'message',
    role: 'assistant',
    model: meta.model,
    content: blocks,
    stop_reason: stop.reason,
    stop_sequence: stop.sequence,
    usage: u,
  }
}
