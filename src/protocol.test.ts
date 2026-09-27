import { describe, expect, it } from 'vitest'
import { FEATURES, PROTOCOL_VERSION, encode, parseTabMessage } from './protocol.js'

const parse = (o: unknown) => parseTabMessage(JSON.stringify(o))

describe('protocol v1', () => {
  const hello = { t: 'hello', v: PROTOCOL_VERSION, token: 'x', model: 'm', contextTokens: 32768, app: '0.0.1' }

  it('parses the tab messages and rejects the rest', () => {
    expect(parse(hello)).toEqual(hello)
    expect(parse({ t: 'token', id: '1', text: 'Hi' })).toEqual({ t: 'token', id: '1', text: 'Hi' })
    expect(parseTabMessage('{"t":"nope"}')).toBeNull()
    expect(parseTabMessage('not json')).toBeNull()
    expect(parseTabMessage('42')).toBeNull()
    expect(parseTabMessage('[]')).toBeNull()
  })

  it('parses a hello of another version so the bridge can answer it, but not one without a token', () => {
    expect(parse({ ...hello, v: 2 })).toMatchObject({ t: 'hello', v: 2 })
    expect(parse({ t: 'hello', v: 1 })).toBeNull()
    expect(parse({ ...hello, v: '1' })).toBeNull()
    // A tab without a loaded model may leave the model fields out.
    expect(parse({ t: 'hello', v: 1, token: 'x' })).toEqual({
      t: 'hello',
      v: 1,
      token: 'x',
      model: '',
      contextTokens: 0,
      app: '',
    })
  })

  it('reads a contextTokens that is not a positive whole number as unknown', () => {
    for (const bad of [{ a: 1 }, true, '32768', -5, 1.5, null, 2 ** 60])
      expect(parse({ ...hello, contextTokens: bad }), String(bad)).toMatchObject({ t: 'hello', contextTokens: 0 })
  })

  it('checks the fields of each frame type', () => {
    const usage = { prompt: 3, completion: 2, tokensPerSec: 10.5 }
    const call = { id: 'a-call-1', function: { name: 'f', arguments: { x: 1 } } }
    expect(parse({ t: 'done', id: 'a', stop: 'eos', usage })).not.toBeNull()
    expect(parse({ t: 'done', id: 'a', stop: 'weird', usage })).toBeNull()
    expect(parse({ t: 'done', id: 'a', stop: 'eos' })).toBeNull()
    expect(parse({ t: 'tool_call', id: 'a', calls: [call] })).not.toBeNull()
    expect(parse({ t: 'tool_call', id: 'a', calls: [{ function: { name: 'f', arguments: '{}' } }] })).toBeNull()
    expect(parse({ t: 'token', id: 'a', text: 5 })).toBeNull()
    expect(parse({ t: 'token', text: 'x' })).toBeNull()
    expect(parse({ t: 'error', message: 'no id is fine' })).not.toBeNull()
    expect(parse({ t: 'error', id: 'a' })).toBeNull()
    expect(parse({ t: 'queued', id: 'a', position: 1 })).not.toBeNull()
    expect(parse({ t: 'status', state: 'ready', model: 'm' })).not.toBeNull()
    expect(parse({ t: 'status', state: 'asleep' })).toBeNull()
    expect(parse({ t: 'ping' })).toEqual({ t: 'ping' })
    expect(parse({ t: 'fetch', id: 'f1', url: 'https://example.org/' })).toEqual({
      t: 'fetch',
      id: 'f1',
      url: 'https://example.org/',
    })
    expect(parse({ t: 'fetch', id: 'f1' })).toBeNull()
    expect(parse({ t: 'fetch', url: 'https://example.org/' })).toBeNull()
  })

  it('encodes bridge messages as JSON', () => {
    expect(JSON.parse(encode({ t: 'abort', id: '7' }))).toEqual({ t: 'abort', id: '7' })
    expect(JSON.parse(encode({ t: 'ok', features: FEATURES }))).toEqual({ t: 'ok', features: ['fetch'] })
    const page = { status: 200, type: 'text/plain', finalUrl: 'https://e.org/', text: 'hi', cut: false }
    expect(JSON.parse(encode({ t: 'fetched', id: 'f1', ...page }))).toEqual({ t: 'fetched', id: 'f1', ...page })
    expect(JSON.parse(encode({ t: 'error', id: 'f1', message: 'no' }))).toEqual({ t: 'error', id: 'f1', message: 'no' })
  })
})
