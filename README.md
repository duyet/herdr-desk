# herdr-desk

Standalone [Herdr](https://herdr.dev) plugin for unattended repo
maintenance.

The idea: a manager agent should live **inside Herdr**, on `main`, and
fan real work into isolated worktrees — not a host crontab that hopes
the terminal multiplexer is up.

Put a **`.herdr-desk.json`** in a repo. Open that repo as a Herdr
workspace once. The plugin finds the file, remembers the path, and
fires each job's `schedule` cron by starting a manager agent.
Prompts are markdown in this plugin (`prompts/`). Repos stay config
only.

**→ [docs/setup.md](docs/setup.md) is the install guide.**
**→ [docs/design.md](docs/design.md) is the 0.2 design.**

## Install

Needs [Herdr](https://herdr.dev), [bun](https://bun.sh), and `gh`.

```sh
herdr plugin install duyet/herdr-desk
herdr plugin action invoke herdr-desk.start
```

Local checkout:

```sh
herdr plugin link /path/to/herdr-desk
herdr plugin action invoke herdr-desk.start
```

The daemon also starts on Herdr startup and on `workspace.focused`.
If it comes up after a daily slot, it still fires that slot once the same
day. `start` / `on-focus` restart the process when plugin source is newer
than the live daemon (stale code after a plugin pull).

## Paste to a coding agent

Lightweight. Do not copy this plugin into the target repo. Use **today’s
local date** (`date +%F`) for any run folder — never hardcode a date.

**This machine (once):**

```
Install the Herdr plugin duyet/herdr-desk.
Need Herdr + bun + gh. Prefer: herdr plugin install duyet/herdr-desk
If this checkout is already herdr-desk: herdr plugin link .
Then: herdr plugin action invoke herdr-desk.start
Then: herdr plugin action invoke herdr-desk.status
Stop. Do not add features.
```

**This repo only:**

```
Wire herdr-desk for the current repo. Keep it tiny.

1. herdr plugin install duyet/herdr-desk (or link). Start the plugin.
2. If .herdr-desk.json is missing, write { "$schema": "<schema url>", "name": "<folder>" }.
   Defaults fill the rest. Only add extra for special rules (inline text, not a new file).
3. Gitignore .herdr-desk/runs/*/
4. Leave this repo as a Herdr workspace.
5. herdr plugin action invoke herdr-desk.status
```

Same text lives in [`prompts/install-agent.md`](prompts/install-agent.md).
Upgrades are a different task, with their own prompt:
[`prompts/update-agent.md`](prompts/update-agent.md).

## Repo config

Schema (editors + agents):  
https://raw.githubusercontent.com/duyet/herdr-desk/main/herdr-desk.schema.json

Set `"$schema"` to that URL. `herdr-desk validate` checks every discovered
file against it.

Usually this is the whole file:

```json
{
  "$schema": "https://raw.githubusercontent.com/duyet/herdr-desk/main/herdr-desk.schema.json",
  "name": "my-repo"
}
```

Defaults: playbook `github-issues`, job id `desk:github-issues`, agent `<name>-desk`, 5 worktrees, `schedule` `0 7 * * *`, state `.herdr-desk/runs/github-issues/`. `desk:` is a bundled playbook; `local:` is a repo-owned `.md`.

### Which agent runs it

`agent` replaces `kind`. It takes a **ladder** — tried in order, so a rung that
cannot start (not logged in, out of credit, rate limited) escalates to the next:

```json
{ "name": "my-repo", "agent": { "ladder": ["opencode2", "opencode", "claude", "codex"] } }
```

A rung is a bare Herdr kind (`claude`, `codex`, `grok`, `opencode`) **or a
command**, so wrappers work: `"anyr claude --yolo"`. The default is `grok`,
which is only a back-compatibility default, not a recommendation.

`kind` is still read, so 0.1.x configs keep working untouched.

### A whole tree of repos, one file

A config above your repos with `"group": true` covers everything beneath it:

```json
// ~/project/.herdr-desk.json
{ "name": "myrepos", "group": true, "repos": ["*/"], "schedule": "0 7 * * *",
  "agent": { "ladder": ["claude", "codex"], "permission": "yolo" } }
```

Members need no config, or one line to override. `group: true` is required, so
a stray file in a parent directory cannot steer your repos by accident.

Precedence, highest first: `HERDR_DESK_*` env → repo → nearest group config →
machine `config.json` → built-in defaults.

Not sure why a value is what it is?

```sh
bun src/cli.ts config explain --repo DIR          # every layer, and which won
bun src/cli.ts config show --repo DIR             # effective, after defaults
```

Optional extras — **inline markdown or a `.md` path** (if the file exists it is loaded; otherwise the string is the prompt):

```json
{
  "name": "my-repo",
  "tasks": [
    {
      "id": "desk:github-issues",
      "playbook": "github-issues",
      "schedule": "0 8 * * *",
      "extra": "Children never deploy. Manager deploys from main."
    }
  ]
}
```

Also accepted: `herdr-desk.json`. Copy from `examples/<kind>/.herdr-desk.json`:

| Example | What it shows |
|---|---|
| `examples/minimal/` | `{ "name" }` only — all defaults |
| `examples/inline-extra/` | Extra rules as inline text (not a file) |
| `examples/custom-agent/` | An `agent` ladder, including a wrapper command |
| `examples/legacy-kind/` | Deprecated `kind`, still valid |
| `examples/inline-prompt/` | Custom playbook inline; id `local:…` |

Optional extra roots (repos you never open in Herdr):

```json
// $(herdr plugin config-dir herdr-desk)/config.json
{ "repos": ["~/src/other-repo"] }
```

## See the cron and history

Herdr has no built-in crontab UI. This plugin is the schedule. Use:

```sh
herdr plugin action invoke herdr-desk.status    # daemon + next/last fire per slot
herdr plugin action invoke herdr-desk.history   # recent runs (runs.jsonl)
herdr plugin action invoke herdr-desk.last      # today's changes.md from each repo
herdr plugin action invoke herdr-desk.list      # discovered repos
bun src/cli.ts config explain --repo DIR        # which layer supplied what
```

Or:

```sh
bun src/cli.ts status
bun src/cli.ts history
```

Host-level plugin command log (start / focus hooks, not the schedule itself):

```sh
herdr plugin log list --plugin herdr-desk --limit 20
```

State on disk: `~/.local/state/herdr/plugins/herdr-desk/` (`daemon.log`, `runs.jsonl`).

## Notify

Send yourself a Telegram message from any desk. Config is **host-level**, not
per-repo, so one destination receives notices from every repo on the machine
and the token is never committed into a `.herdr-desk.json`.

`~/.config/herdr/plugins/herdr-desk/notify.json`:

```json
{
  "token": "123456:ABC",
  "chatId": "-1004420104760",
  "topicId": "42"
}
```

`topicId` is optional (Telegram forum topic). Set `"enabled": false` to mute
without deleting the token. Environment overrides, useful for a scheduled
daemon or CI: `HERDR_DESK_TELEGRAM_TOKEN`, `HERDR_DESK_TELEGRAM_CHAT_ID`,
`HERDR_DESK_TELEGRAM_TOPIC_ID`.

```sh
bun src/cli.ts notify "desk run finished" --repo /path/to/repo --label desk:github-issues
```

Every notice is prefixed with the machine and repo, because a host-level
channel otherwise cannot tell which desk or which box reported:

```
[duet-ubuntu (duyet)] [aidr] [desk:github-issues] desk run finished
```

Sending is best-effort and never throws, so a failed notice cannot abort a desk
run. Unconfigured or failing sends print `not sent (<reason>)` and exit 0.

## Actions

```sh
herdr plugin action invoke herdr-desk.start
herdr plugin action invoke herdr-desk.stop
herdr plugin action invoke herdr-desk.status
herdr plugin action invoke herdr-desk.list
herdr plugin action invoke herdr-desk.history
herdr plugin action invoke herdr-desk.validate
herdr plugin action invoke herdr-desk.notify
```

On-demand (plugin actions take no arguments):

```sh
bun src/cli.ts run desk:github-issues --repo /path/to/repo
```

A successful run finds the **already-open** Herdr Space for that repo
(anyrouter, chmonitor, …), creates a **worktree child** of it, and
starts the manager there. It will not open a sibling Space at the same
level. If that project is not open, the run skips. Children are further
worktrees of the same parent. Writes under `stateDir/<YYYY-MM-DD>/`.

## New repo

1. Add `.herdr-desk.json` (and optional `.herdr-desk/extra.md`).
2. Open the repo as a Herdr workspace once, or list it in plugin `config.json`.
3. Stop. Do not copy this plugin into the repo.

## Version

**0.1.x only.** release-please opens a `chore(main): release 0.1.N` PR
and updates `CHANGELOG.md`. `feat` / `fix` bump the patch, not 0.2.
Merge that PR yourself — do not auto-merge it.

There is no `herdr plugin update` in Herdr v1, so upgrading means reinstalling.
Config and state live outside the plugin checkout, so a reinstall keeps both.
`bun src/cli.ts status` reports the installed version.

## Dev

```sh
herdr plugin link .
bun test
bunx tsc --noEmit
bunx biome check src
bun scripts/validate-examples.ts
```
