/**
 * Generic shortening of shell output on its way to the tab. A pure function of the text:
 * Claude Code resends the whole history each request, and the tab's KV cache keeps the
 * prompt prefix only while every earlier message shrinks the same way.
 */

export const MAX_LINES = 150
export const MAX_CHARS = 8_000
export const HEAD_LINES = 100
export const TAIL_LINES = 50
/** A minified bundle or a JSON blob on one line would otherwise eat the whole budget. */
export const MAX_LINE_CHARS = 1_000

// CSI sequences, OSC sequences (BEL or ST terminated) and two-character escapes.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

export const hiddenLine = (n: number) =>
  `(${n} line${n === 1 ? '' : 's'} hidden by the bridge; narrow the command or filter its output to see them)`

/** A line redrawn with carriage returns: only its last drawing is what the user saw. */
function lastFrame(raw: string): string {
  const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
  const cr = line.lastIndexOf('\r')
  return cr < 0 ? line : line.slice(cr + 1)
}

const clipLine = (line: string) =>
  line.length > MAX_LINE_CHARS
    ? `${line.slice(0, MAX_LINE_CHARS)} (… ${line.length - MAX_LINE_CHARS} more chars)`
    : line

/** Blank runs collapse to one line and consecutive repeats to one marked `(×N)`. */
function tidy(text: string): string[] {
  const out: string[] = []
  let prev: string | null = null
  let count = 0
  const flush = () => {
    if (prev !== null) out.push(count > 1 ? `${prev} (×${count})` : prev)
    prev = null
    count = 0
  }
  for (const raw of text.replace(ANSI, '').split('\n')) {
    const line = clipLine(lastFrame(raw).trimEnd())
    if (line === prev) {
      count++
      continue
    }
    flush()
    if (!line) {
      if (out.length && out[out.length - 1] !== '') out.push('')
      continue
    }
    prev = line
    count = 1
  }
  flush()
  while (out.length && out[out.length - 1] === '') out.pop()
  return out
}

const chars = (lines: string[]) => lines.reduce((n, l) => n + l.length + 1, 0)

/** Head and tail within the budget; errors and summaries sit at the end, so the tail always stays. */
function cut(lines: string[]): string[] {
  if (lines.length <= MAX_LINES && chars(lines) <= MAX_CHARS) return lines
  let head = Math.min(HEAD_LINES, lines.length)
  let tail = Math.min(TAIL_LINES, lines.length - head)
  const over = () => chars(lines.slice(0, head)) + chars(lines.slice(lines.length - tail)) > MAX_CHARS
  // Drop two head lines per tail line, keeping at least one line at each end that exists.
  for (let step = 0; over() && head + tail > 1; step++) {
    const fromTail = step % 3 === 2 ? tail > 1 : head <= 1
    if (fromTail) tail--
    else head--
  }
  const hidden = lines.length - head - tail
  return hidden > 0 ? [...lines.slice(0, head), hiddenLine(hidden), ...lines.slice(lines.length - tail)] : lines
}

/** The text the tab gets for a shell tool's result. */
export const compactShellOutput = (text: string): string => cut(tidy(text)).join('\n')
