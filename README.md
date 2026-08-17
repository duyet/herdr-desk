# herdr-desk

A [Herdr](https://herdr.dev) plugin. Same shape as
[herdr-routines](https://github.com/mrcndz/herdr-routines): a daemon
inside Herdr, not host crontab.

Each repo drops a **`.herdr-desk.json`**. The plugin **picks it up**
from open Herdr workspaces (and remembers the path so it still fires if
that workspace is later closed).

When a schedule hits, it starts a **duyetbot / Grok manager** on `main`
and that manager fans work into isolated Herdr worktrees. Prompts stay
markdown under `prompts/`.

## Install

```sh
herdr plugin install duyet/herdr-desk
# local checkout:
# herdr plugin link ~/project/herdr-desk

herdr plugin action invoke herdr-desk.start
```

`workspace.focused` also starts the daemon, so opening any workspace is
enough after the plugin is linked.

## Per-repo config (this is all a repo needs)

```json
{
  "name": "chmonitor",
  "tasks": [
    {
      "id": "issues",
      "label": "GitHub issues and PRs",
      "task": "github-issues",
      "agentName": "chm-desk",
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

`task` is a bundled id (`prompts/tasks/<id>.md`) or a path to markdown
in the repo. `extraPrompt` is repo-specific addendum.

Optional extra roots (even if never opened in Herdr):

```json
// $(herdr plugin config-dir herdr-desk)/config.json
{ "repos": ["~/project/some-other-repo"] }
```

## Actions

```sh
herdr plugin action invoke herdr-desk.start
herdr plugin action invoke herdr-desk.stop
herdr plugin action invoke herdr-desk.status
herdr plugin action invoke herdr-desk.list
herdr plugin action invoke herdr-desk.validate
```

On-demand (actions take no args):

```sh
bun src/cli.ts run issues --repo ~/project/chmonitor --morning
```

## New repo

1. Add `.herdr-desk.json` (+ optional `.herdr-desk/extra.md`).
2. Open that repo as a Herdr workspace once (or list it in plugin
   `config.json`).
3. Done. No crontab, no copy of the CLI.

## Dev

```sh
herdr plugin link .
bun test
```
