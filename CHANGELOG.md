# Changelog

Versions stay on **0.1.x**. `feat` and `fix` bump the patch. Do not merge a
1.0 or 0.2 release PR.

## [0.1.9](https://github.com/duyet/herdr-desk/compare/v0.1.8...v0.1.9) (2026-10-09)


### Features

* **desk:** arm the PR watcher now that 0.1.8 carries it ([#99](https://github.com/duyet/herdr-desk/issues/99)) ([935233f](https://github.com/duyet/herdr-desk/commit/935233f6e2412a5b9cc2c54e6c564bd87003adb5))
* **desk:** sidebar badge for open project workspaces ([c729920](https://github.com/duyet/herdr-desk/commit/c7299205c42f45730cb516200fcec1e374304d82))
* **here:** a workspace desk card, and an honest note on why not a menu ([#105](https://github.com/duyet/herdr-desk/issues/105)) ([3e15224](https://github.com/duyet/herdr-desk/commit/3e1522415a92bc7e92337151e9e3a6731f99c98a))


### Bug Fixes

* **desk:** name the repo in the give-up line, and stop view() deleting ([#103](https://github.com/duyet/herdr-desk/issues/103)) ([fe30b3e](https://github.com/duyet/herdr-desk/commit/fe30b3edfd25d6d9382a1857b179683892928f04))
* **health:** gate on sessions that are still open ([#104](https://github.com/duyet/herdr-desk/issues/104)) ([7ce0c3c](https://github.com/duyet/herdr-desk/commit/7ce0c3c76e8f6e94d936b4448acd16cd89e646f4))
* **watch:** make the watch surface honest, and report a repo that cannot be read ([#98](https://github.com/duyet/herdr-desk/issues/98)) ([ff47894](https://github.com/duyet/herdr-desk/commit/ff478946c64a141ccd2b52381135d1dfb0e09c9c))

## [0.1.8](https://github.com/duyet/herdr-desk/compare/v0.1.7...v0.1.8) (2026-10-05)


### Features

* **desk:** arm the PR watcher on this repo ([#92](https://github.com/duyet/herdr-desk/issues/92)) ([#95](https://github.com/duyet/herdr-desk/issues/95)) ([0b07915](https://github.com/duyet/herdr-desk/commit/0b079156e547c498f6e1428c8698679d247106b5))
* **notify:** shorter notices and one dashboard for the tui and api ([#74](https://github.com/duyet/herdr-desk/issues/74)) ([679c65e](https://github.com/duyet/herdr-desk/commit/679c65ed6a033859b99ab521c817bfb8cfa50e1f))
* **serve:** open the dashboard on the tailnet ([#87](https://github.com/duyet/herdr-desk/issues/87)) ([d49c171](https://github.com/duyet/herdr-desk/commit/d49c17105dfc4fa8541182ef4fdd335dc4cd38f9))
* **update:** print a short changelog before install ([#75](https://github.com/duyet/herdr-desk/issues/75)) ([d8d653f](https://github.com/duyet/herdr-desk/commit/d8d653f6ae8b92bb1fc705e66ac5bb95501412b4))
* **watch:** PR watcher and review playbook for [#92](https://github.com/duyet/herdr-desk/issues/92) ([#93](https://github.com/duyet/herdr-desk/issues/93)) ([f055cef](https://github.com/duyet/herdr-desk/commit/f055cef1195ec64e093e23c22ea7d5ced10b1acc))
* **watch:** wake a desk task on repo events ([#94](https://github.com/duyet/herdr-desk/issues/94)) ([4b95e72](https://github.com/duyet/herdr-desk/commit/4b95e72134f0a40822ea9175cffdb56322d538c9))


### Bug Fixes

* **daemon:** measure downtime from the last tick, not local midnight ([#65](https://github.com/duyet/herdr-desk/issues/65)) ([05ccff0](https://github.com/duyet/herdr-desk/commit/05ccff045f2523b692b219afe041f30c8a495066))
* **desk:** name the app checks that also report on a PR ([#72](https://github.com/duyet/herdr-desk/issues/72)) ([384e368](https://github.com/duyet/herdr-desk/commit/384e368113c08742b4fd5f4bd97861f0a4953cd1))
* **desk:** name the real CI job and drop the --auto gate ([#71](https://github.com/duyet/herdr-desk/issues/71)) ([1eab579](https://github.com/duyet/herdr-desk/commit/1eab57981abeb5df25eb000e1244f681ae65fb7b))
* **desk:** un-arm the watcher until a release carries it ([#96](https://github.com/duyet/herdr-desk/issues/96)) ([2bbfe3f](https://github.com/duyet/herdr-desk/commit/2bbfe3f0b9981dc62d3c060848eef87e3822f297))
* **report:** fingerprint the reports, not the rendered notice ([#70](https://github.com/duyet/herdr-desk/issues/70)) ([0c14b79](https://github.com/duyet/herdr-desk/commit/0c14b79dca6a06c820c19b37f4b39fe50b6c0776)), closes [#69](https://github.com/duyet/herdr-desk/issues/69)
* **run:** announce a fault that cannot fix itself once ([#88](https://github.com/duyet/herdr-desk/issues/88)) ([b4dbd65](https://github.com/duyet/herdr-desk/commit/b4dbd6572026e1250f3bab62436af7996f618888))
* **run:** name the real base-ref git, and pin --short ([#63](https://github.com/duyet/herdr-desk/issues/63)) ([ec36bd6](https://github.com/duyet/herdr-desk/commit/ec36bd6ba403e0be3fec4e1cc04412f5fbb1ea37))


### Documentation

* a merged config fix stays inert until the checkout pulls ([#73](https://github.com/duyet/herdr-desk/issues/73)) ([9b5eb9d](https://github.com/duyet/herdr-desk/commit/9b5eb9db255f88e8099983bc8b854789e8f1058c))
* **ci:** correct release-please CI run counts and approval evidence ([#67](https://github.com/duyet/herdr-desk/issues/67)) ([8d134c3](https://github.com/duyet/herdr-desk/commit/8d134c386b6382c7fd60d1ca63c42873ddedd5c6)), closes [#64](https://github.com/duyet/herdr-desk/issues/64)
* **ci:** date the approvals from run_started_at, not created_at ([#68](https://github.com/duyet/herdr-desk/issues/68)) ([73ad459](https://github.com/duyet/herdr-desk/commit/73ad459337d54cee0102f99d5752988257061160)), closes [#64](https://github.com/duyet/herdr-desk/issues/64)
* **ci:** explain why release-please PRs never run CI ([#66](https://github.com/duyet/herdr-desk/issues/66)) ([2ed085f](https://github.com/duyet/herdr-desk/commit/2ed085f9c2ca3ce30d503030acf3124eee7cd54b))
* **prune:** stop claiming the weekly run deletes branches ([#90](https://github.com/duyet/herdr-desk/issues/90)) ([5d1461d](https://github.com/duyet/herdr-desk/commit/5d1461de88575e31071b2403ebbe587677058cf8))
* refresh the release CI tally and say why it goes red again ([#78](https://github.com/duyet/herdr-desk/issues/78)) ([666b140](https://github.com/duyet/herdr-desk/commit/666b14082d1850cd850b5eedd9b254a60c6a2b87))

## [0.1.7](https://github.com/duyet/herdr-desk/compare/v0.1.6...v0.1.7) (2026-10-03)


### Features

* **agenda:** assistant roadmap + desk agenda ([#48](https://github.com/duyet/herdr-desk/issues/48)) ([616b626](https://github.com/duyet/herdr-desk/commit/616b626f1a6b7322425cc814b69aca86b6652f3c))
* **cleanup:** add desk cleanup with --dry-run ([#51](https://github.com/duyet/herdr-desk/issues/51)) ([e08fb8f](https://github.com/duyet/herdr-desk/commit/e08fb8f0fd2a305c36cf7bee0d520bb43499985f))
* **cli:** add next, trigger, pause and resume ([#52](https://github.com/duyet/herdr-desk/issues/52)) ([750ccb7](https://github.com/duyet/herdr-desk/commit/750ccb7a30fcc66e4dc3db2da45f2f4689417d80))
* **daemon:** a host health gate, a held-job queue, and `dash` ([#39](https://github.com/duyet/herdr-desk/issues/39)) ([919a982](https://github.com/duyet/herdr-desk/commit/919a9827d08f10e67dd211986c70b81d72e57491))
* fixed run-done notice, real plain fallback, desk summary ([#57](https://github.com/duyet/herdr-desk/issues/57)) ([a0bee97](https://github.com/duyet/herdr-desk/commit/a0bee97f562477977117c47a9b62d5949d0280e5))
* **notify:** write telegram notices like a short text ([20c6bff](https://github.com/duyet/herdr-desk/commit/20c6bff20cc16fee8a570405e009f440365e6cab))
* **sessions:** cross-agent session index and per-repo context ([#54](https://github.com/duyet/herdr-desk/issues/54)) ([f05e3e7](https://github.com/duyet/herdr-desk/commit/f05e3e715af5bbb96723c41a302d49335b8fc7db))
* **update:** self-update from GitHub releases ([#50](https://github.com/duyet/herdr-desk/issues/50)) ([be55a7d](https://github.com/duyet/herdr-desk/commit/be55a7dcb86f1e0e3c599c9c135fb3cd6e299fe6))
* **viz:** timeline, heatmap, analytics, calendar and HTML board ([#53](https://github.com/duyet/herdr-desk/issues/53)) ([b289a1f](https://github.com/duyet/herdr-desk/commit/b289a1f43b0db61a3218603dd22509bfc47647d1))


### Bug Fixes

* **child:** teach check-first merge, not arm --auto ([#58](https://github.com/duyet/herdr-desk/issues/58)) ([238d950](https://github.com/duyet/herdr-desk/commit/238d950bb62ff48d8fdbdd0f379ed8bffbd590f2))
* **ci:** repin setup-bun so the weekly branch prune can run ([#59](https://github.com/duyet/herdr-desk/issues/59)) ([2b9444b](https://github.com/duyet/herdr-desk/commit/2b9444b625df0371d6651021fa90c7b6912920d4))
* **config:** agent.default precedence and group schema drift ([#47](https://github.com/duyet/herdr-desk/issues/47)) ([cb418d4](https://github.com/duyet/herdr-desk/commit/cb418d46bcef1b5eea7768a8461ccb3a86c1e49b))
* **daemon:** a late start resumes, it does not replay the day ([#41](https://github.com/duyet/herdr-desk/issues/41)) ([57baa6f](https://github.com/duyet/herdr-desk/commit/57baa6fd85d5cb518c2ee2374c19d5640c955a38))
* **daemon:** a signal-driven stop leaves a line ([#62](https://github.com/duyet/herdr-desk/issues/62)) ([d7a79af](https://github.com/duyet/herdr-desk/commit/d7a79afdd666690a285d3093af0a175f3094dceb))
* **daemon:** discharge the queue when a job runs ([#61](https://github.com/duyet/herdr-desk/issues/61)) ([1ba212c](https://github.com/duyet/herdr-desk/commit/1ba212c88463779ae77528f778d182d6d3cd1c38))
* **history:** count a job's failure streak over its own records, not the global window ([#35](https://github.com/duyet/herdr-desk/issues/35)) ([f2da52f](https://github.com/duyet/herdr-desk/commit/f2da52fcf0a8d6ef32a227deadef20b75a9aba8d))
* **notify:** escape MarkdownV2 markers so long and stuck notices are not rejected ([#49](https://github.com/duyet/herdr-desk/issues/49)) ([d9f05fb](https://github.com/duyet/herdr-desk/commit/d9f05fb77fb23f2440d7cf2bd1d48b9c50805e12))
* **registry:** encode playbook paths and list nested playbooks by full spec ([#46](https://github.com/duyet/herdr-desk/issues/46)) ([d38dcc4](https://github.com/duyet/herdr-desk/commit/d38dcc4cf1dd56db98cfb6218c882d3a212d1145))
* **run:** prompt a registered-but-unlisted manager instead of starting one ([#33](https://github.com/duyet/herdr-desk/issues/33)) ([9593d57](https://github.com/duyet/herdr-desk/commit/9593d570818f84026dd7e6a2b82321770112ba6e)), closes [#32](https://github.com/duyet/herdr-desk/issues/32)
* **run:** start the first Herdr agent kind in the ladder, reject ladders with none ([#55](https://github.com/duyet/herdr-desk/issues/55)) ([340c57d](https://github.com/duyet/herdr-desk/commit/340c57d4306213dd3f9ed6ee9b4deeddd3020958))
* **status:** read the Last column per job, not from a global window ([#42](https://github.com/duyet/herdr-desk/issues/42)) ([3b1a2d3](https://github.com/duyet/herdr-desk/commit/3b1a2d397c3404463c40e8cfc6bdf823719d1e46))

## [0.1.6](https://github.com/duyet/herdr-desk/compare/v0.1.5...v0.1.6) (2026-09-28)


### Features

* **notify:** one hub for the machine, and reports that mean something ([643b668](https://github.com/duyet/herdr-desk/commit/643b668b0474055f60591fa478ee286f2e5f50d8))
* **notify:** one-line breadcrumb header, tappable link, health runbook ([#26](https://github.com/duyet/herdr-desk/issues/26)) ([45a0b9a](https://github.com/duyet/herdr-desk/commit/45a0b9a0288143ef35f1327e878ad8bbd1b34222))


### Bug Fixes

* **desk:** this repo's job is herdr-desk, not chmonitor ([#30](https://github.com/duyet/herdr-desk/issues/30)) ([74b2b63](https://github.com/duyet/herdr-desk/commit/74b2b63c2c14cc2501102294eac07a16519eed8b))
* **notify:** keep precondition skips out of the notice channel ([e05bf81](https://github.com/duyet/herdr-desk/commit/e05bf815401fcadcb5f51b3a2789ccf8468edddf))

## [0.1.5](https://github.com/duyet/herdr-desk/compare/v0.1.4...v0.1.5) (2026-09-27)


### Features

* 0.2 desk line — agent ladder, config layers, and Telegram notices ([#24](https://github.com/duyet/herdr-desk/issues/24)) ([22c62e8](https://github.com/duyet/herdr-desk/commit/22c62e8fd6a26911b7481f260fe6a03417a3f232))
* **notify:** host-level Telegram notices tagged with machine and repo ([#17](https://github.com/duyet/herdr-desk/issues/17)) ([b5ab98c](https://github.com/duyet/herdr-desk/commit/b5ab98c31755fbbaf7224e986b9941cfa85b07e4))


### Bug Fixes

* **daemon:** key the fire ledger by slot, not by day ([#21](https://github.com/duyet/herdr-desk/issues/21)) ([e986336](https://github.com/duyet/herdr-desk/commit/e986336aa2de2aa9982088bf1ba17c6a2e261c65))

## [0.1.4](https://github.com/duyet/herdr-desk/compare/v0.1.3...v0.1.4) (2026-09-27)


### Bug Fixes

* **run:** resolve the worktree base from origin/HEAD, not a hardcoded main ([#18](https://github.com/duyet/herdr-desk/issues/18)) ([bb89446](https://github.com/duyet/herdr-desk/commit/bb894464f7451626653687ef32dc33bcc5550730))
* **run:** stop a stale LATEST dir from silencing every later fire ([#15](https://github.com/duyet/herdr-desk/issues/15)) ([85c976c](https://github.com/duyet/herdr-desk/commit/85c976cf4415294dd6701718f7c6adb081be77dc))

## [0.1.3](https://github.com/duyet/herdr-desk/compare/v0.1.2...v0.1.3) (2026-09-25)


### Features

* **run:** spawn worktree child of the open project Space ([c3f5796](https://github.com/duyet/herdr-desk/commit/c3f579651fc5d582b928bcb335faa1af66ff399d))


### Bug Fixes

* **run:** reuse one manager session instead of forking per tick ([380bab1](https://github.com/duyet/herdr-desk/commit/380bab103598b8073b26fb08c1c3813879928cda))

## [0.1.2](https://github.com/duyet/herdr-desk/compare/v0.1.1...v0.1.2) (2026-09-07)


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
