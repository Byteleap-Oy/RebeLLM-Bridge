import { describe, expect, it } from 'vitest'
import {
  HEAD_LINES,
  MAX_CHARS,
  MAX_LINES,
  MAX_LINE_CHARS,
  TAIL_LINES,
  compactShellOutput,
  hiddenLine,
} from './compact.js'

const numbered = (n: number, width = 0) => Array.from({ length: n }, (_, i) => `line ${i + 1}`.padEnd(width, 'x'))

describe('compactShellOutput', () => {
  it('leaves short clean text as it is', () => {
    const text = 'added 3 packages\n\nfound 0 vulnerabilities'
    expect(compactShellOutput(text)).toBe(text)
  })

  it('strips colours and keeps the last drawing of a redrawn line', () => {
    const frames = Array.from({ length: 30 }, (_, i) => `\x1b[32m${i + 1}%\x1b[0m [${'='.repeat(i)}>]`).join('\r')
    const text = `\x1b]0;title\x07downloading\n${frames}\r100% [==============================]\ndone\r\n`
    expect(compactShellOutput(text)).toBe('downloading\n100% [==============================]\ndone')
  })

  it('collapses blank runs, trailing whitespace and repeated lines', () => {
    const text = '\n\nnpm warn deprecated x  \nnpm warn deprecated x\nnpm warn deprecated x\n\n\n\nok\n\n'
    expect(compactShellOutput(text)).toBe('npm warn deprecated x (×3)\n\nok')
    expect(compactShellOutput('a\n\na\n\na')).toBe('a\n\na\n\na')
  })

  it('cuts long output to head and tail with the hidden count', () => {
    const lines = numbered(900)
    const out = compactShellOutput(lines.join('\n')).split('\n')
    expect(out).toEqual([...lines.slice(0, HEAD_LINES), hiddenLine(750), ...lines.slice(-TAIL_LINES)])
    expect(compactShellOutput(numbered(MAX_LINES).join('\n')).split('\n')).toHaveLength(MAX_LINES)
    expect(compactShellOutput(numbered(MAX_LINES + 1).join('\n'))).toContain(hiddenLine(1))
  })

  it('drops head lines twice as fast as tail lines when the kept lines exceed the character budget', () => {
    const lines = numbered(140, 200)
    const out = compactShellOutput(lines.join('\n')).split('\n')
    const at = out.findIndex((l) => l.startsWith('(') && l.includes('hidden by the bridge'))
    const head = at
    const tail = out.length - at - 1
    expect(out.join('\n').length).toBeLessThanOrEqual(MAX_CHARS + hiddenLine(1).length)
    expect(head).toBeGreaterThan(tail)
    expect(head + tail).toBeLessThan(140)
    expect(out[at]).toBe(hiddenLine(140 - head - tail))
    expect(out.slice(0, head)).toEqual(lines.slice(0, head))
    expect(out.slice(at + 1)).toEqual(lines.slice(-tail))
  })

  it('clips a very long line and always keeps something', () => {
    const line = 'x'.repeat(50_000)
    const out = compactShellOutput(line)
    expect(out).toBe(`${'x'.repeat(MAX_LINE_CHARS)} (… 49000 more chars)`)
    expect(compactShellOutput(`${line}\n${line}y\nend`).split('\n')).toHaveLength(3)
  })

  it('is deterministic', () => {
    const text = numbered(500).join('\n')
    expect(compactShellOutput(text)).toBe(compactShellOutput(text))
  })
})
