# herdr-desk

Standalone [Herdr](https://herdr.dev) plugin for unattended repo
maintenance.

The idea: a manager agent should live **inside Herdr**, on `main`, and
fan real work into isolated worktrees — not a host crontab that hopes
the terminal multiplexer is up.

Put a **`.herdr-desk.json`** in a repo. Open that repo as a Herdr
workspace once. The plugin finds the file, remembers the path, and
fires the schedule (morning / nightly) by starting a Grok manager.
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

1. herdr plugin install duyet/herdr-desk (or link if already cloned). Start the plugin.
2. If .herdr-desk.json is missing, add one: name = repo folder, one task id "issues",
   task "github-issues", agentName "<short>-desk", kind grok, maxChildren 3,
   stateDir ".herdr-desk/runs/issues", morning "0 7 * * *", nightly "0 22 * * *".
   Gitignore .herdr-desk/runs/*/
3. Do not add extraPrompt unless this repo already has special CI/deploy rules.
4. Open or leave this repo as a Herdr workspace so the plugin can pick it up.
5. Verify: bun <plugin-root>/src/cli.ts status   (or herdr plugin action invoke herdr-desk.status)
   Run folders use today's date automatically. Do not invent a date. Do not copy prompts here.
```

Same text lives in [`prompts/install-agent.md`](prompts/install-agent.md).

## Repo config

This is all a target repo needs:

```json
{
  "name": "my-repo",
  "tasks": [
    {
      "id": "issues",
      "label": "GitHub issues and PRs",
      "task": "github-issues",
      "agentName": "my-desk",
      "kind": "grok",
      "maxChildren": 3,
      "stateDir": ".herdr-desk/runs/issues",
      "extraPrompt": ".herdr-desk/extra.md",
      "schedule": {
        "morning": "0 7 * * *",
        "nightly": "0 22 * * *"
      }
    }
  ]
}
```

Also accepted: `herdr-desk.json`, `ops/desk.json`.

| Field | Meaning |
|---|---|
| `task` | Bundled playbook id (`prompts/tasks/<id>.md`) or a path to markdown in the repo |
| `extraPrompt` | Optional repo-local addendum (CI rules, deploy rules) |
| `schedule` | 5-field cron, local wall clock |

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
bun src/cli.ts run issues --repo /path/to/repo --morning
bun src/cli.ts run issues --repo /path/to/repo --nightly
```

A successful morning leaves the Herdr workspace **open** and writes
under `stateDir/<YYYY-MM-DD>/`.

## New repo

1. Add `.herdr-desk.json` (and optional `.herdr-desk/extra.md`).
2. Open the repo as a Herdr workspace once, or list it in plugin `config.json`.
3. Stop. Do not copy this plugin into the repo.

## Dev

```sh
herdr plugin link .
bun test
```
