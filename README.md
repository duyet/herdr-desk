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

## Actions

```sh
herdr plugin action invoke herdr-desk.start
herdr plugin action invoke herdr-desk.stop
herdr plugin action invoke herdr-desk.status
herdr plugin action invoke herdr-desk.list
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
