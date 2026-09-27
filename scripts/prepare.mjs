// npm's prepare: the pre-commit gate for this repo's own checkout, then the build.
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)))
const run = (cmd, args, stdio) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio })

let top = null
try {
  top = realpathSync(run('git', ['rev-parse', '--show-toplevel'], ['ignore', 'pipe', 'ignore']).trim())
} catch {
  // No git or no work tree: an archive or a git dependency.
}
// Only our own work tree; inside another repo this would rewire its hooks.
if (top === root) run('git', ['config', 'core.hooksPath', '.githooks'], 'ignore')

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
run(process.execPath, [tsc, '-p', 'tsconfig.build.json'], 'inherit')
