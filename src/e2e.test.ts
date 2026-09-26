import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import type { ChatRequest } from './protocol.js'
import { bridge } from './test/harness.js'

// The Anthropic SDK through the bridge to a fake tab, shaped the way Claude Code talks.
const client = (base: string) => new Anthropic({ baseURL: base, apiKey: 'unused', maxRetries: 0 })

const system: Anthropic.TextBlockParam[] = [
  { type: 'text', text: 'You are Claude Code.', cache_control: { type: 'ephemeral' } },
]

describe('Anthropic SDK end to end', () => {
  it('streams text', async () => {
    const b = await bridge()
    const tab = await b.tab('qwen')
    let seen: ChatRequest | null = null
    tab.onChat = (c) => {
      seen = c
      tab.answer(c.id, ['Hel', 'sinki'])
    }
    const stream = client(b.base).messages.stream({
      model: 'claude-opus-5',
      max_tokens: 32000,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Capital of Finland?' }] }],
    })
    const pieces: string[] = []
    stream.on('text', (t) => pieces.push(t))
    const msg = await stream.finalMessage()
    expect(pieces).toEqual(['Hel', 'sinki'])
    expect(msg).toMatchObject({
      model: 'qwen',
      content: [{ type: 'text', text: 'Helsinki' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 7, output_tokens: 2 },
    })
    expect(seen).toMatchObject({
      messages: [
        { role: 'system', content: 'You are Claude Code.' },
        { role: 'user', content: 'Capital of Finland?' },
      ],
      maxTokens: 32000,
    })
  })

  it('round-trips a tool call on the beta endpoint Claude Code uses', async () => {
    const b = await bridge()
    const tab = await b.tab()
    const chats: ChatRequest[] = []
    tab.onChat = (c) => {
      chats.push(c)
      if (chats.length === 1) {
        tab.send({ t: 'token', id: c.id, text: 'Let me read it.' })
        tab.send({
          t: 'tool_call',
          id: c.id,
          calls: [{ id: `${c.id}-call-1`, function: { name: 'Read', arguments: { file_path: 'a.ts' } } }],
        })
        tab.send({ t: 'done', id: c.id, stop: 'tool_call', usage: { prompt: 30, completion: 9, tokensPerSec: 3 } })
      } else tab.answer(c.id, ['It exports nothing.'])
    }
    const api = client(b.base)
    const tools: Anthropic.Beta.BetaTool[] = [
      {
        name: 'Read',
        description: 'Reads a file',
        input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
      },
    ]
    const question: Anthropic.Beta.BetaMessageParam = { role: 'user', content: 'What is in a.ts?' }
    const first = await api.beta.messages
      .stream({ model: 'claude-sonnet-5', max_tokens: 1024, system, tools, messages: [question], betas: ['x-test'] })
      .finalMessage()
    expect(first.stop_reason).toBe('tool_use')
    expect(first.content).toMatchObject([
      { type: 'text', text: 'Let me read it.' },
      { type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } },
    ])
    const call = first.content[1] as Anthropic.Beta.BetaToolUseBlock

    const second = await api.beta.messages
      .stream({
        model: 'claude-sonnet-5',
        max_tokens: 1024,
        system,
        tools,
        messages: [
          question,
          { role: 'assistant', content: first.content },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'export {}' }] },
        ],
      })
      .finalMessage()
    expect(second.content).toMatchObject([{ type: 'text', text: 'It exports nothing.' }])
    expect(chats[1]?.messages.slice(2)).toEqual([
      {
        role: 'assistant',
        content: 'Let me read it.',
        tool_calls: [{ id: call.id, function: { name: 'Read', arguments: { file_path: 'a.ts' } } }],
      },
      { role: 'tool', content: 'export {}', name: 'Read' },
    ])
  })

  it('counts tokens and surfaces errors as the SDK’s errors', async () => {
    const b = await bridge({ waitMs: 50 })
    const api = client(b.base)
    const count = await api.messages.countTokens({
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: 'x'.repeat(35) }],
    })
    expect(count).toEqual({ input_tokens: 10 })

    const noTab = api.messages.create({ model: 'm', max_tokens: 9, messages: [{ role: 'user', content: 'hi' }] })
    await expect(noTab).rejects.toMatchObject({
      status: 503,
      error: { error: { message: 'no RebeLLM tab connected' } },
    })

    const tab = await b.tab()
    tab.onChat = (c) => {
      tab.send({ t: 'token', id: c.id, text: 'Par' })
      tab.send({ t: 'error', id: c.id, message: 'out of memory' })
    }
    const failed = api.messages.stream({ model: 'm', max_tokens: 9, messages: [{ role: 'user', content: 'hi' }] })
    await expect(failed.finalMessage()).rejects.toThrow('out of memory')
  })
})
