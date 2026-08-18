# Changelog

Versions stay on **0.1.x**. `feat` and `fix` bump the patch. Do not merge a
1.0 or 0.2 release PR.

## [Unreleased]

- Catch up a same-day cron slot if the daemon was down or stale at the minute
- Restart the daemon when `src/daemon.ts` is newer than the live pid
- Record a failed fire so a broken playbook is not retried every 20s

## [0.1.0] - 2026-08-18

Initial standalone Herdr plugin.

- Per-repo `.herdr-desk.json`; daemon picks up open workspaces
- Morning GitHub issue desk (up to 5 worktrees); `changes.md` when done
- `status` table and `history` / `last` actions
- Lint, typecheck, test, and build on GitHub Actions
