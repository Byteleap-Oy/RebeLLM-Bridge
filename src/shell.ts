/**
 * Summaries of test-runner and git output, recognised by the output's own shape: `npm test`
 * hides the runner and aliases hide git. Each keeps what is bad or new and says what it hid.
 */

export const hiddenPassing = (n: number) => `(${n} passing entr${n === 1 ? 'y' : 'ies'} hidden by the bridge)`
export const hiddenCommits = (n: number) =>
  `(${n} commit${n === 1 ? '' : 's'}; authors, dates and bodies hidden by the bridge)`
export const diffLine = (files: number, added: number, removed: number) =>
  `(${files} file${files === 1 ? '' : 's'}, +${added} -${removed}; context and index lines hidden by the bridge)`
export const moreEntries = (n: number) => `\t(… ${n} more)`
/** Entries kept per `git status` section. */
export const STATUS_ENTRIES = 20

const has = (lines: string[], re: RegExp) => lines.some((l) => re.test(l))
const firstLine = (lines: string[]) => lines.find((l) => l.trim()) ?? ''

interface Runner {
  match: (lines: string[]) => boolean
  passing: RegExp
  /** Header lines worth nothing to the model. */
  noise?: RegExp
}

const RUNNERS: Runner[] = [
  // Vitest: file lines "✓ path (N tests)", test lines "✓ name", summary "Test Files ...".
  { match: (l) => has(l, /^\s*Test Files\s+\d/) || has(l, /^ RUN {2}v\d/), passing: /^\s*✓ / },
  // Jest: "PASS path" and "✓ name" lines, summary "Tests: ...".
  { match: (l) => has(l, /^Tests:\s+\d/) || has(l, /^Test Suites:\s+\d/), passing: /^(PASS |\s+✓ )/ },
  // pytest: dot-only progress lines, verbose "path::test PASSED" lines.
  {
    match: (l) => has(l, /^=+ test session starts =+$/),
    passing: /^(\S+ \.+\s*(\[\s*\d+%\])?|\S+::\S.* PASSED(\s+\[\s*\d+%\])?)\s*$/,
    noise: /^(platform |rootdir: |plugins: |cachedir: |configfile: |testpaths: )/,
  },
  // cargo test: "test name ... ok".
  { match: (l) => has(l, /^test result: /), passing: /^test \S.* \.\.\. ok\s*$/ },
]

/** Failures, errors, skips and summaries stay; passing entries go, counted in a leading line. */
export function summariseTests(text: string): string | null {
  const lines = text.split('\n')
  const runner = RUNNERS.find((r) => r.match(lines))
  if (!runner) return null
  let passing = 0
  const kept = lines.filter((l) => {
    if (runner.passing.test(l)) {
      passing++
      return false
    }
    return !runner.noise?.test(l)
  })
  return (passing ? [hiddenPassing(passing), ...kept] : kept).join('\n')
}

const COMMIT = /^commit [0-9a-f]{40}\b/

/** A default-format log as `<hash> <subject>` lines. */
function summariseLog(lines: string[]): string {
  const out: string[] = []
  let subject: string | null = null
  let hash = ''
  const flush = () => {
    if (hash) out.push(subject ? `${hash} ${subject}` : hash)
    hash = ''
    subject = null
  }
  for (const l of lines) {
    if (COMMIT.test(l)) {
      flush()
      hash = l.slice(7, 14)
    } else if (hash && subject === null && /^ {4}\S/.test(l)) subject = l.trim()
  }
  flush()
  return [hiddenCommits(out.length), ...out].join('\n')
}

/** Headers, hunk headers and changed lines; a `git show` or `log -p` header before a diff stays. */
function summariseDiff(lines: string[]): string {
  const out: string[] = []
  let files = 0
  let added = 0
  let removed = 0
  let inHunk = false
  for (const l of lines) {
    if (l.startsWith('diff --git ')) {
      files++
      inHunk = false
    } else if (COMMIT.test(l)) inHunk = false
    if (inHunk) {
      if (l.startsWith('@@')) out.push(l)
      else if (l.startsWith('+')) {
        added++
        out.push(l)
      } else if (l.startsWith('-')) {
        removed++
        out.push(l)
      }
      continue
    }
    if (l.startsWith('@@')) {
      inHunk = true
      out.push(l)
    } else if (!l.startsWith('index ')) out.push(l)
  }
  return [diffLine(files, added, removed), ...out].join('\n')
}

const HINT = /^\s+\(use "git .*\)\s*$/

/** No hint lines; a section's entries capped. */
function summariseStatus(lines: string[]): string {
  const out: string[] = []
  let entries = 0
  const endSection = () => {
    if (entries > STATUS_ENTRIES) out.push(moreEntries(entries - STATUS_ENTRIES))
    entries = 0
  }
  for (const l of lines) {
    if (HINT.test(l)) continue
    if (l.startsWith('\t')) {
      if (++entries <= STATUS_ENTRIES) out.push(l)
      continue
    }
    endSection()
    out.push(l)
  }
  endSection()
  return out.join('\n')
}

/** A default log, a unified diff or a status; null for anything else, `--oneline` and `--stat` included. */
export function summariseGit(text: string): string | null {
  const lines = text.split('\n')
  const first = firstLine(lines)
  if (has(lines, /^diff --git /)) return summariseDiff(lines)
  if (COMMIT.test(first)) return summariseLog(lines)
  if (/^(On branch |HEAD detached |Not currently on any branch)/.test(first)) return summariseStatus(lines)
  return null
}

/** The first summary that recognises the text, or null. */
export const summarise = (text: string): string | null => summariseTests(text) ?? summariseGit(text)
