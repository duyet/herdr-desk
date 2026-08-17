# herdr-desk

One CLI that starts a **Grok manager** in a live Herdr session. Each
repo is only JSON config. Logic and markdown prompts live here.

AnyRouter’s `ops/herdr-daily` and chmonitor’s issue-desk are the same
job: morning manager on `main`, isolated worktrees, leave panes open,
write a dated run folder. This repo is that job.

## Install on a machine

Needs: running Herdr (`~/.config/herdr/herdr.sock`), `gh`, `git`, `bun`.

```bash
bun ~/project/herdr-desk/src/cli.ts install --repo ~/project/chmonitor
bun ~/project/herdr-desk/src/cli.ts install --repo ~/project/anyrouter
```

Cron calls this CLI. Re-run `install` after you move the checkout.

```bash
bun ~/project/herdr-desk/src/cli.ts run issues --repo ~/project/chmonitor --morning
bun ~/project/herdr-desk/src/cli.ts list --repo ~/project/chmonitor
bun ~/project/herdr-desk/src/cli.ts tasks
```

If the Herdr socket is missing, `run` exits 0 and logs a skip.

## Per-repo config

Put `.herdr-desk.json` at the repo root:

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

`task` is a bundled id (`prompts/tasks/<id>.md`) or a path to a markdown
file in the repo. `extraPrompt` is repo-specific addendum (deploy rules,
CI babysit, …).

Also accepted: `herdr-desk.json`, `ops/desk.json`.

## Prompts (markdown, not code)

```
prompts/identity.md     duyetbot — manager, co-author, anti-slop
prompts/morning.md      envelope
prompts/nightly.md      envelope
prompts/child.md        worktree child
prompts/tasks/*.md      generic jobs
```

## State

The manager writes under `stateDir` / date (queue, summary, workers).
Gitignore that folder in the target repo. Workspaces stay **open**.

## New repo

1. Copy an example from `examples/`.
2. Add a one-line pointer in that repo’s `AGENTS.md`.
3. `bun …/herdr-desk/src/cli.ts install --repo /path`.
