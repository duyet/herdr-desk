# Paste to a coding agent: install herdr-desk

Wire one repo, or a tree of repos, to the desk. Keep the config tiny.

Use **today's local date** (`date +%F`) if you write a run folder. Never
hardcode a date. Do not copy this plugin into the target repo.

## 1. This machine, once

```sh
herdr plugin install duyet/herdr-desk   # or: herdr plugin link <path>
herdr plugin action invoke herdr-desk.start
herdr plugin action invoke herdr-desk.status
```

Needs Herdr, `bun`, and an authenticated `gh`. Stop there — do not add features
the user did not ask for.

## 2. Choose the agent, once per machine

`herdr plugin config-dir herdr-desk` prints the path. If `config.json` does not
exist, offer to create it. Ask which agents they actually have working — do not
guess a ladder.

```json
{
  "agent": {
    "ladder": ["<best>", "<second>", "<third>"],
    "permission": "yolo"
  }
}
```

- The ladder is tried **in order**. First rung that starts wins.
- A rung is a bare Herdr kind (`claude`, `codex`, `grok`, `opencode`) or a
  command (`anyr claude --yolo`, `opencode2`, `./scripts/desk-agent.sh`).
- `permission: yolo` is required for unattended runs. Without it a child that
  hits a permission prompt stops and waits.
- Write the file `0600`. It is per-user and holds secrets-adjacent references.
- If they set none of this, the default is `grok`, which is only a
  back-compatibility default — say so rather than presenting it as a choice.

## 3. The repo

Check for `.herdr-desk.json`, then `herdr-desk.json`, then `ops/desk.json`. If
none exists, write the smallest file that validates:

```json
{
  "$schema": "https://raw.githubusercontent.com/duyet/herdr-desk/main/herdr-desk.schema.json",
  "name": "<repo-folder>"
}
```

Defaults fill in playbook `github-issues`, id `desk:github-issues`, `0 7 * * *`,
5 children, `<name>-desk`.

Add `extra` **only** if this repo has rules the playbook does not already
imply — inline text, not a new file, unless a file already exists.

```json
{ "name": "myrepo", "extra": "Children never deploy. Manager deploys from main." }
```

Then:

```sh
echo '.herdr-desk/runs/*/' >> .gitignore
herdr plugin action invoke herdr-desk.status
```

## 4. A tree of repos, instead

If they maintain several repos under one directory, offer a group config one
level up rather than writing N files. It is strictly less config.

`~/project/.herdr-desk.json`:

```json
{
  "name": "myrepos",
  "group": true,
  "repos": ["*/"],
  "schedule": "0 7 * * *",
  "agent": { "ladder": ["claude", "codex"], "permission": "yolo" }
}
```

`"group": true` is required — without it the file is ignored. Members need no
config, or one line to override. Confirm before creating a file outside the repo
they asked about.

## 5. Open it

A run needs an open Herdr Space for the repo. The desk will not create a
sibling Space.

```sh
herdr workspace create --cwd <repo>
```

## 6. Verify, do not assume

```sh
bun src/cli.ts config explain --repo <repo>   # which layer supplied what
bun src/cli.ts run desk:github-issues --repo <repo>
bun src/cli.ts last
```

`config explain` is how you answer "why is it using that agent" instead of
guessing. If a value is coming from an unexpected layer, that is a bug to
report, not something to paper over.

## 7. Tell them

- It fires daily at the cron. Next and last fire: `herdr-desk.status`.
- The manager lives **inside Herdr**, in a worktree child of the Space they
  already have open. It is not a crontab, and it will not run a repo that is
  not open.
- `docs/setup.md` is the full guide.

Stop. Do not add features, and do not edit this plugin's own repo.
