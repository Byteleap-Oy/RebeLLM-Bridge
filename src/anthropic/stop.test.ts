import { describe, expect, it } from 'vitest'
import { StopMatcher } from './stop.js'

const run = (stops: string[], pieces: string[]) => {
  const m = new StopMatcher(stops)
  const out = pieces.map((p) => m.push(p))
  return { out, rest: m.flush(), matched: m.matched }
}

describe('StopMatcher', () => {
  it('finds a sequence split across tokens and drops what follows', () => {
    expect(run(['END'], ['ok E', 'ND more', 'and more'])).toEqual({ out: ['ok ', '', ''], rest: '', matched: 'END' })
  })

  it('releases held text that turns out not to be a sequence', () => {
    expect(run(['END'], ['ok E', 'N', 'D?'])).toEqual({ out: ['ok ', '', ''], rest: '', matched: 'END' })
    expect(run(['END'], ['ok E', 'NJOY'])).toEqual({ out: ['ok ', 'ENJOY'], rest: '', matched: null })
    expect(run(['END'], ['the E'])).toEqual({ out: ['the '], rest: 'E', matched: null })
  })

  it('stops at the earliest of several sequences', () => {
    expect(run(['STOP', 'X'], ['aXbSTOP'])).toEqual({ out: ['a'], rest: '', matched: 'X' })
    expect(run(['\n\nHuman:', '###'], ['one\n\n', 'Human: hi'])).toEqual({
      out: ['one', ''],
      rest: '',
      matched: '\n\nHuman:',
    })
  })

  it('passes everything without sequences', () => {
    expect(run([], ['a', 'b'])).toEqual({ out: ['a', 'b'], rest: '', matched: null })
    expect(run([''], ['a'])).toEqual({ out: ['a'], rest: '', matched: null })
  })
})
