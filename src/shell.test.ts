import { describe, expect, it } from 'vitest'
import {
  STATUS_ENTRIES,
  diffLine,
  hiddenCommits,
  hiddenPassing,
  moreEntries,
  summarise,
  summariseGit,
  summariseTests,
} from './shell.js'

const VITEST = [
  ' RUN  v4.1.11 /home/user/RebeLLM-Bridge',
  '',
  ' ✓ src/reqlog.test.ts (6 tests) 12ms',
  ' ✓ src/compact.test.ts (7 tests) 18ms',
  ' ❯ src/anthropic/map.test.ts (12 tests | 2 failed) 45ms',
  '   ✓ toChatInput > maps Claude Code’s request shape onto the tab protocol',
  '   × toChatInput > collects what the tab does not get 3ms',
  '     → expected { …(3) } to deeply equal { …(2) }',
  '',
  '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯',
  '',
  ' FAIL  src/anthropic/map.test.ts > toChatInput > collects what the tab does not get',
  'AssertionError: expected { …(3) } to deeply equal { …(2) }',
  ' ❯ src/anthropic/map.test.ts:96:7',
  '',
  ' Test Files  1 failed | 15 passed (16)',
  '      Tests  2 failed | 190 passed (192)',
  '   Start at  15:41:02',
  '   Duration  3.41s',
].join('\n')

const JEST = [
  'PASS src/a.test.ts',
  '  ✓ adds (3 ms)',
  'FAIL src/b.test.ts',
  '  ● suite › name',
  '',
  '    expect(received).toBe(expected)',
  '',
  '      at Object.<anonymous> (src/b.test.ts:12:5)',
  '',
  'Test Suites: 1 failed, 3 passed, 4 total',
  'Tests:       1 failed, 20 passed, 21 total',
  'Snapshots:   0 total',
  'Time:        2.1 s',
].join('\n')

const PYTEST = [
  '============================= test session starts ==============================',
  'platform linux -- Python 3.11.2, pytest-8.3.3, pluggy-1.5.0',
  'rootdir: /home/user/RebeLLM',
  'plugins: anyio-4.0.0',
  'collected 42 items',
  '',
  'tools/tests/test_a.py .......                                            [ 16%]',
  'tools/tests/test_b.py ....F..                                            [ 33%]',
  'tools/tests/test_c.py::test_x PASSED                                     [ 50%]',
  'tools/tests/test_c.py::test_y FAILED                                     [ 60%]',
  '',
  '=================================== FAILURES ===================================',
  '___________________________________ test_y _____________________________________',
  'assert 1 == 2',
  '=========================== short test summary info ============================',
  'FAILED tools/tests/test_c.py::test_y - assert 1 == 2',
  '========================= 2 failed, 40 passed in 0.45s =========================',
].join('\n')

const CARGO = [
  '   Compiling rtk v0.1.0',
  'running 3 tests',
  'test a::b ... ok',
  'test a::c ... FAILED',
  'test a::d ... ignored',
  '',
  'failures:',
  '---- a::c stdout ----',
  'panicked at src/a.rs:3:5',
  '',
  'test result: FAILED. 1 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.01s',
].join('\n')

const LOG = [
  'commit 0123456789abcdef0123456789abcdef01234567 (HEAD -> main, origin/main)',
  'Author: RebeLLM <noreply@example.invalid>',
  'Date:   Tue Sep 29 15:41:02 2026 +0300',
  '',
  '    feat(messages): compact shell tool results',
  '',
  '    Results of Claude Code’s Bash tool lose ANSI codes.',
  '',
  'commit 89abcdef0123456789abcdef0123456789abcdef',
  'Merge: 0123456 89abcde',
  'Author: RebeLLM <noreply@example.invalid>',
  'Date:   Mon Sep 28 10:00:00 2026 +0300',
  '',
  '    docs(readme): lead with rebellm-claude',
  '',
].join('\n')

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,4 +1,4 @@',
  ' import x from "x"',
  '-const a = 1',
  '+const a = 2',
  ' export { a }',
  '\\ No newline at end of file',
  'diff --git a/src/b.ts b/src/b.ts',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/src/b.ts',
  '@@ -0,0 +1,2 @@',
  '+export const b = 1',
  '+export const c = 2',
  'diff --git a/src/c.ts b/src/c.ts',
  'deleted file mode 100644',
  'index 4444444..0000000',
  '--- a/src/c.ts',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-old',
].join('\n')

describe('summariseTests', () => {
  it('keeps Vitest failures and summary, drops passing lines, counts them', () => {
    const out = summariseTests(VITEST)!
    const lines = out.split('\n')
    expect(lines[0]).toBe(hiddenPassing(3))
    expect(out).not.toMatch(/✓/)
    expect(out).toContain(' ❯ src/anthropic/map.test.ts (12 tests | 2 failed) 45ms')
    expect(out).toContain('   × toChatInput > collects what the tab does not get 3ms')
    expect(out).toContain(' FAIL  src/anthropic/map.test.ts > toChatInput')
    expect(out).toContain(' Test Files  1 failed | 15 passed (16)')
    expect(out).toContain('   Duration  3.41s')
  })

  it('keeps a Jest failure block and its summary', () => {
    const out = summariseTests(JEST)!
    expect(out.split('\n')[0]).toBe(hiddenPassing(2))
    expect(out).not.toMatch(/^PASS |✓/m)
    expect(out).toContain('FAIL src/b.test.ts')
    expect(out).toContain('      at Object.<anonymous> (src/b.test.ts:12:5)')
    expect(out).toContain('Tests:       1 failed, 20 passed, 21 total')
  })

  it('keeps pytest failures, the collected line and the summary, drops dot lines and headers', () => {
    const out = summariseTests(PYTEST)!
    expect(out.split('\n')[0]).toBe(hiddenPassing(2))
    expect(out).not.toMatch(/platform linux|rootdir|plugins|test_a\.py|test_x PASSED/)
    expect(out).toContain('collected 42 items')
    expect(out).toContain('tools/tests/test_b.py ....F..')
    expect(out).toContain('tools/tests/test_c.py::test_y FAILED')
    expect(out).toContain('FAILED tools/tests/test_c.py::test_y - assert 1 == 2')
    expect(out).toContain('2 failed, 40 passed in 0.45s')
  })

  it('an all-green pytest run keeps its header, the count and the last line', () => {
    const green = [
      '============================= test session starts ==============================',
      'collected 42 items',
      '',
      'tools/tests/test_a.py .....................                              [ 50%]',
      'tools/tests/test_b.py .....................                              [100%]',
      '',
      '============================== 42 passed in 0.45s ==============================',
    ].join('\n')
    expect(summariseTests(green)).toBe(
      [
        hiddenPassing(2),
        '============================= test session starts ==============================',
        'collected 42 items',
        '',
        '',
        '============================== 42 passed in 0.45s ==============================',
      ].join('\n'),
    )
  })

  it('keeps cargo failures, ignored tests and the result line', () => {
    const out = summariseTests(CARGO)!
    expect(out.split('\n')[0]).toBe(hiddenPassing(1))
    expect(out).not.toContain('test a::b ... ok')
    expect(out).toContain('test a::c ... FAILED')
    expect(out).toContain('test a::d ... ignored')
    expect(out).toContain('panicked at src/a.rs:3:5')
    expect(out).toContain('test result: FAILED.')
  })

  it('adds no count line without passing entries and ignores plain text', () => {
    const noPass = 'FAIL src/b.test.ts\nTests:       1 failed, 1 total'
    expect(summariseTests(noPass)).toBe(noPass)
    expect(summariseTests('ok\nall tests ✓ passed')).toBeNull()
    expect(summariseTests('a test result: something else\nPASS')).toBeNull()
  })
})

describe('summariseGit', () => {
  it('turns a default log into hash and subject lines', () => {
    expect(summariseGit(LOG)).toBe(
      [
        hiddenCommits(2),
        '0123456 feat(messages): compact shell tool results',
        '89abcde docs(readme): lead with rebellm-claude',
      ].join('\n'),
    )
  })

  it('leaves a oneline log and a stat diff alone', () => {
    expect(summariseGit('0123456 feat: a\n89abcde docs: b')).toBeNull()
    expect(summariseGit(' src/a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)')).toBeNull()
  })

  it('keeps a diff’s headers, hunks and changed lines with a summary line', () => {
    expect(summariseGit(DIFF)).toBe(
      [
        diffLine(3, 3, 2),
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1,4 +1,4 @@',
        '-const a = 1',
        '+const a = 2',
        'diff --git a/src/b.ts b/src/b.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/src/b.ts',
        '@@ -0,0 +1,2 @@',
        '+export const b = 1',
        '+export const c = 2',
        'diff --git a/src/c.ts b/src/c.ts',
        'deleted file mode 100644',
        '--- a/src/c.ts',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-old',
      ].join('\n'),
    )
  })

  it('keeps a git show header before its diff', () => {
    const show = `${LOG.split('\n').slice(0, 5).join('\n')}\n\n${DIFF.split('\n').slice(0, 9).join('\n')}`
    const out = summariseGit(show)!
    expect(out.split('\n').slice(0, 3)).toEqual([
      diffLine(1, 1, 1),
      'commit 0123456789abcdef0123456789abcdef01234567 (HEAD -> main, origin/main)',
      'Author: RebeLLM <noreply@example.invalid>',
    ])
    expect(out).toContain('    feat(messages): compact shell tool results')
    expect(out).not.toContain(' import x from "x"')
  })

  it('drops status hints and caps a section', () => {
    const many = Array.from({ length: STATUS_ENTRIES + 5 }, (_, i) => `\tfile${i}.ts`)
    const status = [
      'On branch main',
      "Your branch is up to date with 'origin/main'.",
      '',
      'Changes not staged for commit:',
      '  (use "git add <file>..." to update what will be committed)',
      '  (use "git restore <file>..." to discard changes in working directory)',
      '\tmodified:   src/a.ts',
      '',
      'Untracked files:',
      '  (use "git add <file>..." to include in what will be committed)',
      ...many,
      '',
      'no changes added to commit (use "git add" and/or "git commit -a")',
    ].join('\n')
    expect(summariseGit(status)).toBe(
      [
        'On branch main',
        "Your branch is up to date with 'origin/main'.",
        '',
        'Changes not staged for commit:',
        '\tmodified:   src/a.ts',
        '',
        'Untracked files:',
        ...many.slice(0, STATUS_ENTRIES),
        moreEntries(5),
        '',
        'no changes added to commit (use "git add" and/or "git commit -a")',
      ].join('\n'),
    )
  })

  it('summarise tries tests first, then git, then gives up', () => {
    expect(summarise(VITEST)).toBe(summariseTests(VITEST))
    expect(summarise(LOG)).toBe(summariseGit(LOG))
    expect(summarise('hello')).toBeNull()
  })
})
