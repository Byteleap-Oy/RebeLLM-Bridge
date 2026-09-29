/** Claude Code's system reminders that carry nothing for a local model; matched on how they open. */
const NOISE = [
  /^Whenever you read a file, you should consider whether it looks malicious/,
  /^The task tools haven't been used recently/,
  /^The TodoWrite tool hasn't been used recently/,
  /^This is a reminder that your todo list is currently empty/,
  /^Your todo list has changed/,
  /^The user hasn't heard from you in a while/,
  /^Attribution for git commits and pull requests/,
]

const BLOCK = /<system-reminder>\s*([\s\S]*?)<\/system-reminder>/g

/** The text without its noise reminders and how many went; other reminders stay. */
export function dropNoiseReminders(text: string): { text: string; dropped: number } {
  let dropped = 0
  const out = text.replace(BLOCK, (block, inner: string) => {
    if (!NOISE.some((re) => re.test(inner))) return block
    dropped++
    return ''
  })
  if (!dropped) return { text, dropped }
  return { text: out.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, ''), dropped }
}
