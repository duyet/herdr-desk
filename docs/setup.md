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

The manifest requires Herdr 0.8.0 or newer. The `card` popup uses
`placement = "popup"`, which 0.7.x does not have, and declaring the newer floor
means a 0.7.x host refuses to link the plugin with a reason instead of failing
later on a manifest field it cannot parse.

## 3. Pick the agent, once per machine

`herdr plugin config-dir herdr-desk` prints the config directory. Create
`config.json` there:

```json
{
  "agent": {
    "ladder": ["opencode2", "opencode", "claude", "codex"],
    "permission": "yolo"
  },
  "features": { "issues": false },
  "autoUpdate": true
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
bun src/cli.ts here                             # this workspace's desk card
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

## The workspace desk card

`desk here` prints one repo's scheduled work on a single screen: which
`.herdr-desk.json` it resolved, every job with its agent, cron and next fire,
whether the daemon is up, and the dashboard URL.

```sh
bun src/cli.ts here                    # the workspace in focus
bun src/cli.ts here --repo ~/work/x    # any directory
```

The same card is available as a Herdr action and as a popup:

```sh
herdr plugin action invoke herdr-desk.here
herdr plugin pane open --plugin herdr-desk --entrypoint card
```

### It is not a right-click menu

Herdr cannot put plugin items in the sidebar context menu, and this is not a
manifest gap waiting to be filled:

- `src/client/shell/context_menu.rs` in Herdr 0.9.3 builds the menu as a `match`
  over the target kind (workspace / tab / pane) returning hardcoded
  `ClientContextMenuAction` variants. There is no plugin branch.
- `PluginActionContext` — the enum behind `contexts = ["workspace"]` — is
  deserialized by the manifest loader, stored in `PluginActionInfo`, and has no
  consumer anywhere in Herdr's `src/`. Declaring it is honest intent that Herdr
  parses and never acts on.
- The plugin manifest accepts only `build`, `startup`, `actions`, `events`,
  `panes` and `link_handlers`. There is no menu or grouping key to add, and
  plugins.mdx states outright that native non-terminal plugin UI is not part of
  plugin v1.

So the manifest still declares `contexts = ["workspace"]` on the `here` action,
because it is the correct declaration and costs nothing. Do not expect it in a
right-click menu.

### Which workspace it uses

Herdr tells an action which workspace it was invoked for. That arrives in
`HERDR_PLUGIN_CONTEXT_JSON`, with `HERDR_WORKSPACE_ID` as the fallback when the
JSON is missing or unparseable.

There is no *clicked* workspace to read — no plugin hook receives one. What
arrives is the workspace Herdr invoked the command for, which for a keybinding is
the one in focus. The card prints `repo from` so you can see which directory it
chose and why:

| `repo from` | Meaning |
|---|---|
| `checkout` | the workspace's own checkout, which a linked worktree has |
| `repo-root` | the main checkout, when the worktree checkout is gone |
| `cwd` | `workspace_cwd` from the context |
| `cwd-fallback` | the command's cwd — no usable workspace context |

A linked worktree resolves to its own checkout first, so the config shown is the
one in the worktree you are looking at, not the main repo's.

### What the dashboard line does and does not claim

There is no per-repo dashboard route. `src/http.ts` serves `/`,
`/api/dashboard` and `/api/analytics`, and nothing else — a link with the repo
name in it would be a 404.

The card prints the canonical URL and probes the port with a TCP connect. It
says `listening` when something accepted a connection, `nothing listening` plus
the command to start it when nothing did, and `not checked` when the probe was
skipped. A TCP connect proves a listener and nothing more, so the card never
claims more than that. There is no per-repo URL to give even when it is up.

### Reading it safely

The card only reads. It starts nothing, fires no job, and writes no state, so it
is safe to bind to a key.

It reads a fixed list of fields out of Herdr's context JSON by name, and
deliberately drops two that are present there: `selected_text` and `clicked_url`.
`selected_text` is whatever you had selected in the pane, and printing it would
put terminal content into a plugin log, a screenshot, or a bug report. Any field
a future Herdr adds is dropped rather than carried through by accident. There is
no shell involvement: the manifest's `command` is an argv array, which Herdr does
not run through a shell.

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

There is no `herdr plugin update` in Herdr v1. Upgrading means reinstalling,
which `desk update` does for you (stop daemon, `herdr plugin install
duyet/herdr-desk --yes`, start):

```sh
herdr plugin action invoke herdr-desk.update-check   # read-only
herdr plugin action invoke herdr-desk.update
```

`herdr plugin install` without `--ref` installs the tip of the default branch,
not the release tag. That is always at or ahead of the latest release, and the
version string only moves when a release PR merges, so after an update the
installed version equals the latest tag and there is no upgrade loop. The
update does not pass `--ref`, because Herdr would record it as a pin and later
checks would then refuse to move it.

While `desk update` runs it holds an `updating` lock in the state dir;
`desk start` and the `workspace.focused` hook skip starting the daemon while
that lock is under 10 minutes old.

Config and state live outside the plugin checkout, so a reinstall never loses
`config.json`, `runs.jsonl`, or `fires.json`.

The daemon checks the latest GitHub release at most once a day (the stamp is
`update-check.json` in the state dir) and applies it when `autoUpdate` in the
machine `config.json` is on, which is the default. Set `"autoUpdate": false` to
only log what is available. It notifies on upgrade and on failure. A linked
plugin or a pinned `--ref` is never upgraded. `docs/design.md` has the details.

## Troubleshooting

**Nothing fires.** `status` shows the next and last fire. If next is `-`, the
cron never matches. If last is `never`, the daemon is not running — check
`herdr plugin action invoke herdr-desk.status`.

**"no open Herdr session".** The repo is not an open workspace. The desk
deliberately refuses to create a sibling Space.

**Wrong agent.** `bun src/cli.ts config explain --repo DIR --tasks` prints the
resolved ladder and permission per job.

**A run was skipped.** `bun src/cli.ts history` shows the reason in `detail`.
