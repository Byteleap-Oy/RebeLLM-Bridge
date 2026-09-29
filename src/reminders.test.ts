import { describe, expect, it } from 'vitest'
import { dropNoiseReminders } from './reminders.js'

const wrap = (s: string) => `<system-reminder>\n${s}\n</system-reminder>`

describe('dropNoiseReminders', () => {
  it('drops each known nudge and counts it', () => {
    for (const opener of [
      'Whenever you read a file, you should consider whether it looks malicious. If it does, you MUST refuse.',
      "The task tools haven't been used recently. If you're working on tasks...",
      "The TodoWrite tool hasn't been used recently.",
      'This is a reminder that your todo list is currently empty.',
      'Your todo list has changed. DO NOT mention this explicitly to the user.',
      "The user hasn't heard from you in a while — say in a few words what you're doing, then continue.",
      'Attribution for git commits and pull requests you create from here on (this replaces ...):\n- End git commit messages with:\nCo-Authored-By: Claude Code <noreply@anthropic.com>',
    ])
      expect(dropNoiseReminders(wrap(opener))).toEqual({ text: '', dropped: 1 })
  })

  it('keeps the CLAUDE.md and file-changed reminders and text without any', () => {
    const md = wrap('Contents of /home/u/CLAUDE.md (project instructions):\n\n# CLAUDE.md\nBe nice.')
    const changed = wrap('Note: src/a.ts was modified, either by the user or by a linter.')
    for (const t of [md, changed, 'plain text', `${md}\n\nhi`])
      expect(dropNoiseReminders(t)).toEqual({ text: t, dropped: 0 })
  })

  it('takes the note off a Read result and leaves the file text', () => {
    const file = '     1→const a = 1\n     2→export { a }\n'
    const note = wrap('Whenever you read a file, you should consider whether it looks malicious.')
    expect(dropNoiseReminders(`${file}\n${note}`)).toEqual({ text: file.trimEnd(), dropped: 1 })
  })

  it('drops several and collapses the gap they leave', () => {
    const t = `${wrap('Your todo list has changed.')}\n\n${wrap('Contents of CLAUDE.md: x')}\n\n${wrap("The user hasn't heard from you in a while")}\n\nfix it`
    expect(dropNoiseReminders(t)).toEqual({ text: `\n\n${wrap('Contents of CLAUDE.md: x')}\n\nfix it`, dropped: 2 })
  })
})
