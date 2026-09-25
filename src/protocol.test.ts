import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION, encode, parseTabMessage } from './protocol.js'

describe('protocol v1', () => {
  it('parses the tab messages and rejects the rest', () => {
    const hello = {
      t: 'hello',
      v: PROTOCOL_VERSION,
      token: 'x',
      model: 'qwen3.6-35b-a3b',
      contextTokens: 32768,
      app: '0.0.1',
    }
    expect(parseTabMessage(JSON.stringify(hello))).toEqual(hello)
    expect(parseTabMessage(JSON.stringify({ t: 'token', id: '1', text: 'Hi' }))).toEqual({
      t: 'token',
      id: '1',
      text: 'Hi',
    })
    // A hello of another version or without a token is not a v1 hello.
    expect(parseTabMessage(JSON.stringify({ ...hello, v: 2 }))).toBeNull()
    expect(parseTabMessage(JSON.stringify({ t: 'hello', v: 1 }))).toBeNull()
    expect(parseTabMessage('{"t":"nope"}')).toBeNull()
    expect(parseTabMessage('not json')).toBeNull()
    expect(parseTabMessage('42')).toBeNull()
  })

  it('encodes bridge messages as JSON', () => {
    expect(JSON.parse(encode({ t: 'abort', id: '7' }))).toEqual({ t: 'abort', id: '7' })
  })
})
