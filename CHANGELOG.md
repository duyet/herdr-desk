# Changelog

Versions stay on **0.1.x**. `feat` and `fix` bump the patch. Do not merge a
1.0 or 0.2 release PR.

## [0.1.2](https://github.com/duyet/herdr-desk/compare/v0.1.1...v0.1.2) (2026-08-24)


### Bug Fixes

* **cron:** reject invalid field tokens at schema load ([#12](https://github.com/duyet/herdr-desk/issues/12)) ([e9012e3](https://github.com/duyet/herdr-desk/commit/e9012e366acc831d2df1ec8f42feda6b6a2a4800)), closes [#4](https://github.com/duyet/herdr-desk/issues/4)
* **daemon:** prune fires.json and quarantine corrupt state ([#7](https://github.com/duyet/herdr-desk/issues/7)) ([2523122](https://github.com/duyet/herdr-desk/commit/2523122b1c6d5d54f1a8eab114bcdeceeb718514)), closes [#5](https://github.com/duyet/herdr-desk/issues/5)
* **schema:** reject traversal task ids and stateDir ([#8](https://github.com/duyet/herdr-desk/issues/8)) ([47ffc0b](https://github.com/duyet/herdr-desk/commit/47ffc0b4e86134eb24f6031f1597cd2b5ccf26d8)), closes [#6](https://github.com/duyet/herdr-desk/issues/6)

## [0.1.1](https://github.com/duyet/herdr-desk/compare/v0.1.0...v0.1.1) (2026-08-21)


### Features

* default desk from name; extraPrompt is inline or a file ([e67df47](https://github.com/duyet/herdr-desk/commit/e67df476709cf896d17fae9f5938d6de0d19f53a))
* desk this repo daily; CI validates examples ([bcf0082](https://github.com/duyet/herdr-desk/commit/bcf0082971f5bc02f7ff6d793a12f5dad18e8617))
* extract scheduled Herdr manager CLI ([f89a045](https://github.com/duyet/herdr-desk/commit/f89a045989cf403238604cb765cf0849b25557a8))
* JSON Schema for .herdr-desk.json ([3977c91](https://github.com/duyet/herdr-desk/commit/3977c91019dad60cdc5e0f1ea7899bcc99856be2))
* morning writes changes.md; last action shows it ([ee5b246](https://github.com/duyet/herdr-desk/commit/ee5b246de293a5451e085cac3cad657ceacbda6d))
* print job table with a one-line description ([6ba2e88](https://github.com/duyet/herdr-desk/commit/6ba2e883afe8ac044f68e7933499f97702e7dbe1))
* rewrite as a Herdr plugin that auto-picks repo configs ([da31857](https://github.com/duyet/herdr-desk/commit/da318571b2e6c018e1b0f30cf41c5d170a1666cf))
* show cron slots and run history ([5643b25](https://github.com/duyet/herdr-desk/commit/5643b256de9804326c11354e0f5cf06269719fd5))


### Bug Fixes

* **daemon:** catch up missed same-day cron slots and restart stale process ([c819c1e](https://github.com/duyet/herdr-desk/commit/c819c1ea947c6c4a7a81933128f754058d1ec125))


### Documentation

* add paste-ready coding-agent install prompts ([654dd87](https://github.com/duyet/herdr-desk/commit/654dd8792c63ced9e47e057213a9c915dc588fc7))
* rewrite README as a standalone Herdr plugin ([59b2858](https://github.com/duyet/herdr-desk/commit/59b2858c9e606f536506f16744992706e57501b6))


### CI

* add lint, typecheck, test, and build ([1d3fac6](https://github.com/duyet/herdr-desk/commit/1d3fac6627184a9d83aa03bf3312af5b0c181eff))

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
