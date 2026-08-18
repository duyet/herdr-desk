# herdr-desk

Standalone [Herdr](https://herdr.dev) plugin for unattended repo
maintenance.

The idea: a manager agent should live **inside Herdr**, on `main`, and
fan real work into isolated worktrees — not a host crontab that hopes
the terminal multiplexer is up.

Put a **`.herdr-desk.json`** in a repo. Open that repo as a Herdr
workspace once. The plugin finds the file, remembers the path, and
fires each job's `schedule` cron by starting a Grok manager.
Prompts are markdown in this plugin (`prompts/`). Repos stay config
only.

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
| `examples/custom-agent/` | Another Herdr kind + agent name |
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

## Actions

```sh
herdr plugin action invoke herdr-desk.start
herdr plugin action invoke herdr-desk.stop
herdr plugin action invoke herdr-desk.status
herdr plugin action invoke herdr-desk.list
herdr plugin action invoke herdr-desk.history
herdr plugin action invoke herdr-desk.validate
```

On-demand (plugin actions take no arguments):

```sh
bun src/cli.ts run desk:github-issues --repo /path/to/repo
```

A successful run leaves the Herdr workspace **open** and writes
under `stateDir/<YYYY-MM-DD>/`.

## New repo

1. Add `.herdr-desk.json` (and optional `.herdr-desk/extra.md`).
2. Open the repo as a Herdr workspace once, or list it in plugin `config.json`.
3. Stop. Do not copy this plugin into the repo.

## Version

**0.1.x only.** release-please opens a `chore(main): release 0.1.N` PR
and updates `CHANGELOG.md`. `feat` / `fix` bump the patch, not 0.2.
Merge that PR yourself — do not auto-merge it.

## Dev

```sh
herdr plugin link .
bun test
```
