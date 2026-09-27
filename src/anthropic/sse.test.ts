import type { ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { message, usage } from './map.js'
import { EventWriter } from './sse.js'

function writer() {
  let raw = ''
  let ended = false
  const res = { write: (s: string) => ((raw += s), true), end: () => void (ended = true) }
  const events = () =>
    raw
      .split('\n\n')
      .filter(Boolean)
      .map((e) => {
        const [name, data] = e.split('\n')
        const body = JSON.parse(data!.slice(6)) as { type: string }
        expect(name).toBe(`event: ${body.type}`)
        return body
      })
  return { w: new EventWriter(res as unknown as ServerResponse), events, ended: () => ended }
}

const start = message({ id: 'msg_1', model: 'm' }, [], { reason: null, sequence: null }, usage(9, 0))

describe('EventWriter', () => {
  it('writes text, then tool calls, then the stop, in the API’s order', () => {
    const t = writer()
    t.w.start(start)
    t.w.ping()
    t.w.text('Let me ')
    t.w.text('')
    t.w.text('check.')
    t.w.toolUse({ type: 'tool_use', id: 'c1', name: 'Read', input: { file_path: 'a.ts' } })
    t.w.finish('tool_use', null, usage(10, 4))
    expect(t.events()).toEqual([
      { type: 'message_start', message: start },
      { type: 'ping' },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'check.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'c1', name: 'Read', input: {} } },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"file_path":"a.ts"}' },
      },
      { type: 'content_block_stop', index: 1 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { input_tokens: 10, output_tokens: 4 },
      },
      { type: 'message_stop' },
    ])
    expect(t.ended()).toBe(true)
  })

  it('writes a search as a server tool use block and its results in one block start', () => {
    const t = writer()
    t.w.text('Searching.')
    t.w.toolUse({ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'hs' } })
    const result = {
      type: 'web_search_tool_result' as const,
      tool_use_id: 's1',
      content: [
        {
          type: 'web_search_result' as const,
          url: 'https://hs.fi/',
          title: 'HS',
          encrypted_content: '',
          page_age: null,
        },
      ],
    }
    t.w.searchResult(result)
    t.w.text('Done.')
    t.w.finish('end_turn', null, { ...usage(10, 4), server_tool_use: { web_search_requests: 1 } })
    expect(t.events().slice(2)).toEqual([
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'server_tool_use', id: 's1', name: 'web_search', input: {} },
      },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":"hs"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: result },
      { type: 'content_block_stop', index: 2 },
      { type: 'content_block_start', index: 3, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: 'Done.' } },
      { type: 'content_block_stop', index: 3 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { input_tokens: 10, output_tokens: 4, server_tool_use: { web_search_requests: 1 } },
      },
      { type: 'message_stop' },
    ])
  })

  it('gives an empty answer one empty text block', () => {
    const t = writer()
    t.w.finish('end_turn', null, usage(1, 0))
    expect(t.events().map((e) => e.type)).toEqual([
      'content_block_start',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
  })

  it('ends with an error event', () => {
    const t = writer()
    t.w.text('Par')
    t.w.error({ type: 'api_error', message: 'out of memory' })
    expect(t.events().at(-1)).toEqual({ type: 'error', error: { type: 'api_error', message: 'out of memory' } })
    expect(t.ended()).toBe(true)
  })
})
