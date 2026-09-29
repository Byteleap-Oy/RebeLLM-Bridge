import { describe, expect, it } from 'vitest'
import { SYSTEM_PROMPT } from './prompt.js'

describe('SYSTEM_PROMPT', () => {
  it('is short and names the tools that stay', () => {
    expect(SYSTEM_PROMPT.split(/\s+/).filter(Boolean).length).toBeLessThan(600)
    for (const tool of ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash', 'WebFetch', 'WebSearch'])
      expect(SYSTEM_PROMPT).toContain(tool)
    expect(SYSTEM_PROMPT).toContain('CLAUDE.md')
    expect(SYSTEM_PROMPT).toMatch(/Nothing runs in the background/)
    expect(SYSTEM_PROMPT.endsWith('\n')).toBe(true)
  })
})
