# Setup

Give a machine Herdr plus this plugin, and it keeps its own projects alive
while nobody is watching.

## 1. Prerequisites

- [Herdr](https://herdr.dev) 0.9+
- `bun`
- `gh` (GitHub CLI), authenticated
- at least one coding agent on `PATH` — `claude`, `codex`, `grok`, `opencode`, …

Check the agent integrations you want lifecycle reporting for:

```sh
herdr integration status
herdr integration install claude
```

Not required. Without an integration Herdr still falls back to screen
detection; you just lose session restore.

## 2. Install the plugin

```sh
herdr plugin install duyet/herdr-desk
herdr plugin action invoke herdr-desk.start
herdr plugin action invoke herdr-desk.status
```

The daemon also starts on Herdr startup and on `workspace.focused`. If it comes
up after a day's slot has passed, it still fires that slot once that day.

Local checkout instead:

```sh
herdr plugin link /path/to/herdr-desk
```

A linked plugin never auto-upgrades. That is deliberate — you own that tree.

## 3. Pick the agent, once per machine

`herdr plugin config-dir herdr-desk` prints the config directory. Create
`config.json` there:

```json
{
  "agent": {
    "ladder": ["opencode2", "opencode", "claude", "codex"],
    "permission": "yolo"
  },
  "features": { "issues": false, "selfUpgrade": "check" }
}
```

The ladder is tried **in order**. If the first rung cannot start — not logged
in, out of credit, rate limited — the desk moves to the next. A rung is either a
bare Herdr kind or a command, so a wrapper works too:

```json
{ "agent": { "ladder": ["anyr claude --yolo", "claude"] } }
```

`permission: yolo` is what lets a child run unattended. Leave it at the default
and a child that hits a permission prompt stops and waits for you.

`0600` that file. It is per-user, not in any repo, and it is where a
`${TELEGRAM_BOT_TOKEN}` style reference resolves from.

## 4. One config for a tree of projects

Put one file above your repos:

```sh
~/project/
  .herdr-desk.json      ← "group": true
  myrepo/
  otherrepo/
```

```json
{
  "name": "myrepos",
  "group": true,
  "repos": ["*/"],
  "schedule": "0 7 * * *",
  "agent": { "ladder": ["opencode2", "claude"], "permission": "yolo" },
  "maxChildren": 8,
  "tasks": [{ "id": "desk:github-issues", "playbook": "github-issues" }]
}
```

Every repo beneath it inherits that. A member needs no config at all, or one
line:

```json
{ "name": "myrepo", "schedule": "30 6 * * *" }
```

`"group": true` is required. Without it a config in a parent directory is
ignored, so a stray file cannot silently start steering your repos.

Member repos do not have to be open in Herdr — `repos: ["*/"]` finds them. Runs
still need the repo open as a workspace, because the manager runs inside Herdr.

## 5. Open the repos in Herdr

A run needs an open Space for the repo. It will not create a sibling Space.

```sh
herdr workspace create --cwd ~/project/myrepo
```

## 6. Confirm

```sh
herdr plugin action invoke herdr-desk.list      # repos and jobs found
bun src/cli.ts config explain --repo ~/project/myrepo   # what won, and why
bun src/cli.ts status                            # next and last fire per job
```

`config explain` is the one to read when something is not what you expected. It
prints every layer and which one supplied each value:

```
config for myrepo

  global  config.json
  group   ../../.herdr-desk.json
  repo    .herdr-desk.json

| FIELD       | VALUE                       | FROM  |
| ----------- | --------------------------- | ----- |
| name        | myrepo                      | repo  |
| schedule    | 30 6 * * *                  | repo  |
| agent       | {"permission":"yolo"}       | repo  |
| maxChildren | 8                           | group |
```

## 7. Run it now

Do not wait for 07:00 to find out it works:

```sh
bun src/cli.ts run desk:github-issues --repo ~/project/myrepo
```

Then read the run folder for what actually happened:

```sh
bun src/cli.ts last          # today's changes.md from every repo
```

## What the defaults are

| Field | Default |
|---|---|
| playbook | `github-issues` |
| job id | `desk:github-issues` |
| schedule | `0 7 * * *` |
| agent | `grok` (see the note below) |
| permission | `default` |
| max children | 5 |
| agent name | `<name>-desk` |
| state | `.herdr-desk/runs/github-issues/<date>/` |

**The default agent is `grok` because that is what 0.1.x used.** It is not a
recommendation — it is what every repo that never set `kind` was already
running, and changing it would switch agents on upgrade without telling anyone.
Set `agent` in your machine config and the question is moot.

## Repo addendum

Per-repo special rules, inline or as a path:

```json
{
  "name": "myrepo",
  "extra": "Children never deploy. Manager deploys from main."
}
```

## Keeping it healthy

```sh
bun src/cli.ts validate      # every discovered config against the schema
bun src/cli.ts history 40    # recent runs
bun src/cli.ts config explain --repo DIR --tasks
```

Schema for editors and agents:
`https://raw.githubusercontent.com/duyet/herdr-desk/main/herdr-desk.schema.json`

Point `$schema` at it in each config file.

## Upgrading

There is no `herdr plugin update` in Herdr v1. Upgrading means reinstalling:

```sh
herdr plugin install duyet/herdr-desk
```

Config and state live outside the plugin checkout, so a reinstall never loses
`config.json`, `runs.jsonl`, or `fires.json`. The desk checks for a newer
version on every tick and reports it in `status`; applying one is a separate
step you trigger yourself. `docs/design.md` has the details.

## Troubleshooting

**Nothing fires.** `status` shows the next and last fire. If next is `-`, the
cron never matches. If last is `never`, the daemon is not running — check
`herdr plugin action invoke herdr-desk.status`.

**"no open Herdr session".** The repo is not an open workspace. The desk
deliberately refuses to create a sibling Space.

**Wrong agent.** `bun src/cli.ts config explain --repo DIR --tasks` prints the
resolved ladder and permission per job.

**A run was skipped.** `bun src/cli.ts history` shows the reason in `detail`.
