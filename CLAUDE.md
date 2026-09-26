# CLAUDE.md

Project: RebeLLM Bridge, a small local service that lets tools on the user's machine
(Claude Code through MCP, anything else through an OpenAI-style HTTP endpoint) use the
model running in the user's RebeLLM browser tab. The tab connects out to this service over
WebSocket; this service never runs a model itself. Public repository, Apache-2.0 with the Commons Clause (free to use and share, not for sale);
never call it open source.

The protocol between the tab and the bridge is owned by the RebeLLM app (its `local-bridge`
spec); `README.md` here carries the current copy. Change it there first, then here.

## All code changes go through the OpenSpec flow

Never write or modify code before a spec exists. No exceptions for "small" fixes.

The order is fixed:

1. **Propose** with `/opsx:propose "<idea>"`. Creates the change under `openspec/changes/`
   with proposal, design, spec deltas and tasks. Review it before moving on.
2. **Apply** with `/opsx:apply`. Implement only the tasks listed in the change. If
   implementation reveals the spec is wrong, stop and update the spec first.
3. **Archive** with `/opsx:archive`. Marks the change complete.
4. **Sync to main specs** with `openspec archive <change>` so the deltas are merged into
   `openspec/specs/`. Main specs are the source of truth for what the bridge does.

Use `/opsx:explore` to think through an idea before proposing. Exploration produces no
code.

## Commits

Commit only finished work: a change that is applied, archived and synced to main specs,
one commit per completed change. Proposals and half-done tasks stay uncommitted. Never
push unless asked.

## Tests and the pre-commit gate

- Every change ships unit tests for everything it adds or changes (Vitest,
  `src/**/*.test.ts`). Code without tests is not finished.
- `npm install` enables `.githooks/pre-commit`, which runs `npm run check` (typecheck,
  ESLint, Prettier, unit tests) on the staged snapshot. Never bypass it with `--no-verify`;
  fix the cause.

## Comments

Keep comments short. One line where possible. Say why, not what. Do not restate the code.
Do not leave commented-out code.

## Repository notes

- `openspec/changes/archive/` is gitignored; the merged specs in `openspec/specs/` are
  what gets committed.
- Everything is in English: code, comments, README, specs, commit messages.
- Commits use the repo-local author (RebeLLM). No `Co-Authored-By` or other attribution
  trailers.
- Always use Conventional Commits: `<type>(<scope>): <summary>`, e.g.
  `feat(mcp): chat tool`, `fix(ws): reconnect after auth error`. Types: feat, fix, docs,
  refactor, perf, test, build, chore.
- Public repo: no tokens, hosts or personal data in code, tests, fixtures or commits.
