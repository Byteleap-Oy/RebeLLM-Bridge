import { describe, expect, it } from 'vitest'
import { requestLog } from './reqlog.js'
import { ChatError } from './tab.js'

function setup(route = '/v1/messages', id = 'msg_ab12') {
  const lines: string[] = []
  let t = 1_000_000
  const log = requestLog(
    (l) => lines.push(l),
    route,
    id,
    () => t,
  )
  return { lines, log, advance: (ms: number) => (t += ms) }
}

describe('requestLog', () => {
  it('writes one line per event with the seconds since arrival', () => {
    const { lines, log, advance } = setup()
    log.arrived(11204, 18)
    advance(400)
    log.queued(2)
    advance(411_900)
    log.firstToken()
    advance(1000)
    log.firstToken()
    advance(57_700)
    log.done('end_turn', 96)
    expect(lines).toEqual([
      'chat msg_ab12 /v1/messages: arrived, 11 204 prompt tokens, 18 tools',
      'chat msg_ab12 /v1/messages: queued at 2 +0.4s',
      'chat msg_ab12 /v1/messages: first token +412.3s',
      'chat msg_ab12 /v1/messages: done end_turn, 96 tokens, +471.0s',
    ])
  })

  it('names what the tab did not get, or nothing', () => {
    const { lines, log } = setup()
    log.ignored({
      blocks: { image: 2, document: 1 },
      toolChoice: 'tool Read',
      serverTools: ['web_fetch_20250910', 'code_execution_20250522'],
    })
    log.ignored({ blocks: { image: 1 }, serverTools: [] })
    log.ignored({ blocks: {}, toolChoice: 'any', serverTools: [] })
    log.ignored({ blocks: {}, serverTools: [] })
    expect(lines).toEqual([
      'chat msg_ab12 /v1/messages: ignored 2 image blocks, 1 document block, tool_choice tool Read, ' +
        'server tool web_fetch_20250910, server tool code_execution_20250522',
      'chat msg_ab12 /v1/messages: ignored 1 image block',
      'chat msg_ab12 /v1/messages: ignored tool_choice any',
    ])
  })

  it('logs each search by its result count or error, never the query', () => {
    const { lines, log, advance } = setup()
    advance(2500)
    log.searched(8)
    log.searched(1)
    log.searched('unavailable')
    expect(lines).toEqual([
      'chat msg_ab12 /v1/messages: search 8 results +2.5s',
      'chat msg_ab12 /v1/messages: search 1 result +2.5s',
      'chat msg_ab12 /v1/messages: search error unavailable +2.5s',
    ])
  })

  it('names the shell results it shortened, or nothing', () => {
    const { lines, log } = setup()
    log.compacted({ results: 2, before: 18204, after: 4012 })
    log.compacted({ results: 1, before: 500, after: 499 })
    log.compacted({ results: 0, before: 0, after: 0 })
    expect(lines).toEqual([
      'chat msg_ab12 /v1/messages: compacted 2 tool results, 18 204 chars to 4 012',
      'chat msg_ab12 /v1/messages: compacted 1 tool result, 500 chars to 499',
    ])
  })

  it('says when the client gave up', () => {
    const { lines, log, advance } = setup('/v1/chat/completions', 'chatcmpl-1')
    log.arrived(1, 1)
    log.queued(1)
    advance(600_100)
    log.aborted()
    expect(lines).toEqual([
      'chat chatcmpl-1 /v1/chat/completions: arrived, 1 prompt token, 1 tool',
      'chat chatcmpl-1 /v1/chat/completions: queued at 1 +0.0s',
      'chat chatcmpl-1 /v1/chat/completions: client aborted +600.1s',
    ])
  })

  it('logs refusals and errors, naming the tab when it reported one', () => {
    const { lines, log, advance } = setup('mcp', 'mcp_1')
    log.refused(503, 'model loading')
    advance(5000)
    log.error(new ChatError('out of memory', 'tab'))
    log.error(new ChatError('the RebeLLM tab disconnected', 'disconnected'))
    log.error('odd')
    log.done('eos', 1)
    expect(lines).toEqual([
      'chat mcp_1 mcp: refused 503 model loading +0.0s',
      'chat mcp_1 mcp: error the tab reported: out of memory +5.0s',
      'chat mcp_1 mcp: error the RebeLLM tab disconnected +5.0s',
      'chat mcp_1 mcp: error odd +5.0s',
      'chat mcp_1 mcp: done eos, 1 token, +5.0s',
    ])
  })

  it('writes nothing without a log', () => {
    const log = requestLog(undefined, '/v1/messages', 'msg_1')
    expect(() => {
      log.arrived(1, 0)
      log.firstToken()
      log.done('end_turn', 1)
    }).not.toThrow()
  })
})
