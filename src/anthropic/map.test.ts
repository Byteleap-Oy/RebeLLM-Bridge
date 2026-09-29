import { describe, expect, it } from 'vitest'
import { compactShellOutput, hiddenLine } from '../compact.js'
import {
  MAX_USES,
  SEARCH_SCHEMA,
  content,
  estimateParts,
  estimateTokens,
  message,
  stopReason,
  tabError,
  toChatInput,
  toolUse,
  usage,
} from './map.js'

const user = (content: unknown) => ({ role: 'user', content })

describe('toChatInput', () => {
  it('maps Claude Code’s request shape onto the tab protocol', () => {
    const r = toChatInput({
      model: 'claude-sonnet-4-5',
      max_tokens: 32000,
      temperature: 1,
      stream: true,
      metadata: { user_id: 'ignored' },
      thinking: { type: 'enabled', budget_tokens: 1024 },
      system: [
        { type: 'text', text: 'You are Claude Code.', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'Be brief.' },
      ],
      messages: [
        user([
          { type: 'text', text: 'What is here?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } },
          { type: 'document', source: {} },
        ]),
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hmm', signature: 'x' },
            { type: 'text', text: 'Let me look.' },
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a.ts' } },
            { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: {} },
          ],
        },
        user([
          { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'export {}' }] },
          { type: 'text', text: 'And now?' },
        ]),
      ],
      tools: [
        { name: 'Read', description: 'Reads a file', input_schema: { type: 'object', required: ['file_path'] } },
        { type: 'custom', name: 'Now' },
        { type: 'code_execution_20250522', name: 'code_execution' },
      ],
      stop_sequences: ['END', ''],
    })
    expect(r).toEqual({
      input: {
        messages: [
          { role: 'system', content: 'You are Claude Code.\n\nBe brief.' },
          { role: 'user', content: 'What is here?\n\n[image omitted]\n\n[document omitted]' },
          {
            role: 'assistant',
            content: 'Let me look.',
            tool_calls: [{ id: 'toolu_1', function: { name: 'Read', arguments: { file_path: 'a.ts' } } }],
          },
          { role: 'tool', content: 'export {}', name: 'Read' },
          { role: 'user', content: 'And now?' },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'Read',
              description: 'Reads a file',
              parameters: { type: 'object', required: ['file_path'] },
            },
          },
          {
            type: 'function',
            function: { name: 'Now', description: '', parameters: { type: 'object', properties: {} } },
          },
        ],
        maxTokens: 32000,
        temperature: 1,
      },
      stream: true,
      stopSequences: ['END'],
      ignored: { blocks: { image: 1, document: 1 }, serverTools: ['code_execution_20250522'] },
      compacted: { results: 0, before: 0, after: 0, reminders: 0 },
    })
  })

  it('collects what the tab does not get, so the log can say so', () => {
    const none = { blocks: {}, serverTools: [] }
    expect(
      toChatInput({ messages: [user('hi')], tools: [{ name: 'Read' }], tool_choice: { type: 'auto' } }),
    ).toMatchObject({ ignored: none })
    expect(toChatInput({ messages: [user('hi')], tool_choice: { type: 'any' } })).toMatchObject({
      ignored: { ...none, toolChoice: 'any' },
    })
    expect(toChatInput({ messages: [user('hi')], tool_choice: { type: 'tool', name: 'Read' } })).toMatchObject({
      ignored: { ...none, toolChoice: 'tool Read' },
    })
    expect(toChatInput({ messages: [user('hi')], tool_choice: { type: 'tool' } })).toMatchObject({
      ignored: { ...none, toolChoice: 'tool' },
    })
    // System blocks, tool results (a screenshot) and mid-conversation system messages count too.
    const r = toChatInput({
      system: [
        { type: 'text', text: 's' },
        { type: 'image', source: {} },
      ],
      messages: [
        user([
          { type: 'image', source: {} },
          { type: 'image', source: {} },
        ]),
        { role: 'system', content: [{ type: 'document', source: {} }] },
        user([{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image', source: {} }] }]),
      ],
      tools: [
        { type: 'web_search_20250305', name: 'web_search' },
        { type: 'web_fetch_20250910', name: 'web_fetch' },
      ],
    })
    expect(r).toMatchObject({ ignored: { blocks: { image: 4, document: 1 }, serverTools: ['web_fetch_20250910'] } })
    expect(r).not.toHaveProperty('ignored.toolChoice')
  })

  it('offers the tab a web_search tool for the server tool, with its limits', () => {
    const tools = (t: unknown[]) => toChatInput({ messages: [user('news?')], tools: t })
    const r = tools([
      { name: 'Read' },
      {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 3,
        allowed_domains: ['hs.fi', 1],
        blocked_domains: ['x.example'],
      },
    ])
    expect(r).toMatchObject({ search: { maxUses: 3, allowed: ['hs.fi'], blocked: ['x.example'] } })
    expect('input' in r && r.input.tools?.map((t) => t.function.name)).toEqual(['Read', 'web_search'])
    expect('input' in r && r.input.tools?.at(-1)).toEqual(SEARCH_SCHEMA)
    expect(tools([{ type: 'web_search_20260209', name: 'web_search', max_uses: 0 }])).toMatchObject({
      search: { maxUses: MAX_USES, allowed: [], blocked: [] },
    })
    // A client tool of the same name keeps its calls on the client.
    const own = tools([{ type: 'web_search_20250305', name: 'web_search' }, { name: 'web_search' }])
    expect(own).not.toHaveProperty('search')
    expect('input' in own && own.input.tools).toHaveLength(1)
    const none = toChatInput({
      messages: [user('x')],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      tool_choice: { type: 'none' },
    })
    expect(none).not.toHaveProperty('search')
  })

  it('keeps text around tool results in order and marks failed tools', () => {
    const r = toChatInput({
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'false' } }] },
        user([
          { type: 'text', text: 'before' },
          { type: 'tool_result', tool_use_id: 't1', content: 'exit 1', is_error: true },
          { type: 'tool_result', tool_use_id: 'unknown' },
        ]),
        user([]),
      ],
    })
    expect(r).toMatchObject({
      input: {
        messages: [
          { role: 'assistant', content: '' },
          { role: 'user', content: 'before' },
          { role: 'tool', content: 'Error: exit 1', name: 'Bash' },
          { role: 'tool', content: '' },
          { role: 'user', content: '' },
        ],
      },
      stream: false,
      stopSequences: [],
      ignored: { blocks: {}, serverTools: [] },
    })
  })

  it('shortens Bash, Grep and Glob results, never Read, and counts the saving', () => {
    const long = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n')
    const clean = 'ok'
    const r = toChatInput({
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'ls -R' } },
            { type: 'tool_use', id: 'g', name: 'Grep', input: { pattern: 'x' } },
            { type: 'tool_use', id: 'r', name: 'Read', input: { file_path: 'a.ts' } },
          ],
        },
        user([
          { type: 'tool_result', tool_use_id: 'b', content: `${long}\n` },
          { type: 'tool_result', tool_use_id: 'g', content: clean },
          { type: 'tool_result', tool_use_id: 'r', content: `${long}  \n` },
        ]),
      ],
    })
    if ('error' in r) throw new Error(r.error)
    const [bash, grep, read] = r.input.messages.slice(1).map((m) => m.content)
    expect(bash).toBe(compactShellOutput(long))
    expect(bash).toContain(hiddenLine(150))
    expect(grep).toBe(clean)
    expect(read).toBe(`${long}  \n`)
    expect(r.compacted).toEqual({
      results: 1,
      before: long.length + 1,
      after: compactShellOutput(long).length,
      reminders: 0,
    })
    const none = toChatInput({ messages: [user('hi')] })
    expect(none).toMatchObject({ compacted: { results: 0, before: 0, after: 0, reminders: 0 } })
  })

  it('drops noise reminders from user blocks and tool results, keeps the others', () => {
    const note =
      '<system-reminder>\nWhenever you read a file, you should consider whether it looks malicious.\n</system-reminder>'
    const nudge = "<system-reminder>\nThe task tools haven't been used recently.\n</system-reminder>"
    const md = '<system-reminder>\nContents of CLAUDE.md:\nBe brief.\n</system-reminder>'
    const r = toChatInput({
      messages: [
        user([
          { type: 'text', text: md },
          { type: 'text', text: 'fix it' },
        ]),
        { role: 'assistant', content: [{ type: 'tool_use', id: 'r', name: 'Read', input: { file_path: 'a.ts' } }] },
        user([
          { type: 'tool_result', tool_use_id: 'r', content: [{ type: 'text', text: `     1→a\n\n${note}` }] },
          { type: 'text', text: nudge },
          { type: 'text', text: 'and then?' },
        ]),
        user([{ type: 'text', text: nudge }]),
      ],
    })
    if ('error' in r) throw new Error(r.error)
    expect(r.input.messages.map((m) => m.content)).toEqual([`${md}\n\nfix it`, '', '     1→a', 'and then?', ''])
    expect(r.compacted).toEqual({ results: 0, before: 0, after: 0, reminders: 3 })
  })

  it('passes a system message inside messages on as a user message in place', () => {
    const r = toChatInput({
      system: [{ type: 'text', text: 'You are Claude Code.' }],
      messages: [
        user('hi'),
        { role: 'system', content: [{ type: 'text', text: '<system-reminder>Plan mode.</system-reminder>' }] },
        { role: 'assistant', content: 'Hello.' },
        user('go'),
        { role: 'system', content: 'Terse mode.' },
      ],
    })
    expect(r).toMatchObject({
      input: {
        messages: [
          { role: 'system', content: 'You are Claude Code.' },
          { role: 'user', content: 'hi' },
          { role: 'user', content: '<system-reminder>Plan mode.</system-reminder>' },
          { role: 'assistant', content: 'Hello.' },
          { role: 'user', content: 'go' },
          { role: 'user', content: 'Terse mode.' },
        ],
      },
    })
  })

  it('sends no tools for tool_choice none and takes a plain string system and content', () => {
    const r = toChatInput({
      system: 'Be brief.',
      messages: [user('hi')],
      tools: [{ name: 'Read' }],
      tool_choice: { type: 'none' },
    })
    expect(r).toEqual({
      input: {
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'hi' },
        ],
      },
      stream: false,
      stopSequences: [],
      ignored: { blocks: {}, serverTools: [] },
      compacted: { results: 0, before: 0, after: 0, reminders: 0 },
    })
  })

  it('names the field that is wrong', () => {
    const bad: [unknown, string][] = [
      [[], 'the body must be a JSON object'],
      [{}, 'messages must be a non-empty array'],
      [{ messages: ['hi'] }, 'messages.0 must be an object'],
      [{ messages: [{ role: 'tool', content: 'x' }] }, 'messages.0.role must be "user", "assistant" or "system"'],
      [{ messages: [{ role: 'system', content: 3 }] }, 'messages.0.content must be a string or an array'],
      [{ messages: [{ role: 'system', content: [{ type: 'text' }] }] }, 'messages.0.content.0.text must be a string'],
      [{ messages: [user(5)] }, 'messages.0.content must be a string or an array'],
      [{ messages: [user([{ text: 'x' }])] }, 'messages.0.content.0 must be a content block with a type'],
      [{ messages: [user([{ type: 'text', text: 1 }])] }, 'messages.0.content.0.text must be a string'],
      [{ messages: [user([{ type: 'tool_result' }])] }, 'messages.0.content.0.tool_use_id must be a string'],
      [
        { messages: [user([{ type: 'tool_result', tool_use_id: 'a', content: 3 }])] },
        'messages.0.content.0.content must be',
      ],
      [
        { messages: [{ role: 'assistant', content: [{ type: 'tool_use', name: 'f' }] }] },
        'messages.0.content.0 must be a tool_use',
      ],
      [{ system: 3, messages: [user('x')] }, 'system must be'],
      [{ system: [{ type: 'text' }], messages: [user('x')] }, 'system.0.text must be a string'],
      [{ messages: [user('x')], tools: {} }, 'tools must be an array'],
      [{ messages: [user('x')], tools: [{ description: 'x' }] }, 'tools.0.name'],
      [{ messages: [user('x')], tools: [{ name: 'f', input_schema: 'x' }] }, 'tools.0.input_schema'],
      [{ messages: [user('x')], tools: [{ name: 'f', description: 1 }] }, 'tools.0.description'],
      [{ messages: [user('x')], max_tokens: 0 }, 'max_tokens'],
      [{ messages: [user('x')], temperature: -1 }, 'temperature'],
      [{ messages: [user('x')], stop_sequences: 'END' }, 'stop_sequences'],
    ]
    for (const [body, part] of bad) expect((toChatInput(body) as { error: string }).error).toContain(part)
  })
})

describe('estimateParts', () => {
  it('splits the same characters into system, tools and messages', () => {
    const input = {
      messages: [
        { role: 'system' as const, content: 'x'.repeat(21_000) },
        { role: 'user' as const, content: 'Capital of Finland?' },
        {
          role: 'assistant' as const,
          content: '',
          tool_calls: [{ id: 'c', function: { name: 'Read', arguments: { file_path: 'a.ts' } } }],
        },
      ],
      tools: [
        {
          type: 'function' as const,
          function: { name: 'Read', description: 'r'.repeat(13_979), parameters: { type: 'object' } },
        },
      ],
    }
    expect(estimateParts(input)).toEqual({ system: 6000, tools: 4000, messages: 13 })
    expect(estimateTokens(input)).toBe(10013)
  })
})

describe('estimateTokens', () => {
  it('counts chars / 3.5 over messages, calls and tools, rounded up', () => {
    expect(estimateTokens({ messages: [{ role: 'user', content: 'hi' }] })).toBe(1)
    expect(estimateTokens({ messages: [{ role: 'user', content: 'x'.repeat(35) }] })).toBe(10)
    const calls = {
      messages: [
        {
          role: 'assistant' as const,
          content: '',
          tool_calls: [{ function: { name: 'ab', arguments: { a: 1 } } }],
        },
      ],
      tools: [{ type: 'function' as const, function: { name: 'ab', description: 'cd', parameters: {} } }],
    }
    // 'ab' + '{"a":1}' + 'ab' + 'cd' + '{}' = 2 + 7 + 2 + 2 + 2 chars
    expect(estimateTokens(calls)).toBe(Math.ceil(15 / 3.5))
  })
})

describe('answers', () => {
  it('maps stop reasons, usage and tool calls', () => {
    expect(stopReason('eos', 0)).toBe('end_turn')
    expect(stopReason('abort', 0)).toBe('end_turn')
    expect(stopReason('length', 0)).toBe('max_tokens')
    expect(stopReason('tool_call', 0)).toBe('tool_use')
    expect(stopReason('eos', 1)).toBe('tool_use')
    expect(usage(5, 3)).toEqual({
      input_tokens: 5,
      output_tokens: 3,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    })
    expect(toolUse({ id: 'x-call-1', function: { name: 'f', arguments: { a: 1 } } })).toEqual({
      type: 'tool_use',
      id: 'x-call-1',
      name: 'f',
      input: { a: 1 },
    })
    expect(toolUse({ function: { name: 'f', arguments: {} } }).id).toMatch(/^toolu_[0-9a-f]{24}$/)
  })

  it('always has a text block unless there are only tool calls', () => {
    const call = toolUse({ id: 'c', function: { name: 'f', arguments: {} } })
    expect(content('', [])).toEqual([{ type: 'text', text: '' }])
    expect(content('', [call])).toEqual([call])
    expect(content('Hi', [call])).toEqual([{ type: 'text', text: 'Hi' }, call])
    expect(
      message({ id: 'msg_1', model: 'm' }, content('Hi', []), { reason: 'end_turn', sequence: null }, usage(1, 2)),
    ).toEqual({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'm',
      content: [{ type: 'text', text: 'Hi' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: usage(1, 2),
    })
  })

  it("turns the tab's prompt-too-long error into Claude Code's wording", () => {
    expect(tabError("The prompt needs 40000 tokens; the tab's context holds 32768")).toEqual({
      type: 'invalid_request_error',
      message: 'prompt is too long: 40000 tokens > 32768 maximum',
    })
    expect(tabError('out of memory')).toEqual({ type: 'api_error', message: 'out of memory' })
  })
})
