/**
 * Ends an answer at the first stop sequence. Text arrives in pieces that may split a
 * sequence, so the end of the text is held back while it could still become one.
 */
export class StopMatcher {
  private readonly stops: string[]
  private held = ''
  /** The sequence that ended the answer, once one has. */
  matched: string | null = null

  constructor(stops: string[]) {
    this.stops = stops.filter((s) => s.length > 0)
  }

  /** The text safe to pass on now; after a match, only what came before it. */
  push(text: string): string {
    if (this.matched !== null) return ''
    const buf = this.held + text
    let at = -1
    for (const s of this.stops) {
      const i = buf.indexOf(s)
      if (i >= 0 && (at < 0 || i < at)) {
        at = i
        this.matched = s
      }
    }
    if (this.matched !== null) {
      this.held = ''
      return buf.slice(0, at)
    }
    const keep = this.partial(buf)
    this.held = buf.slice(buf.length - keep)
    return buf.slice(0, buf.length - keep)
  }

  /** What is still held back when the answer ends without a match. */
  flush(): string {
    const rest = this.held
    this.held = ''
    return rest
  }

  /** Length of the longest end of `buf` that begins some stop sequence. */
  private partial(buf: string) {
    let best = 0
    for (const s of this.stops)
      for (let n = Math.min(s.length - 1, buf.length); n > best; n--)
        if (buf.endsWith(s.slice(0, n))) {
          best = n
          break
        }
    return best
  }
}
