# herdr-desk

Give your agent a persistent computer.

Clone your repos into one machine. Install [Herdr](https://herdr.dev)
and this plugin. Then get out of the way: every repo keeps a manager
session that wakes on a cron, triages its own backlog, and works it —
tomorrow, next week, and every week after, with nobody watching.

```
~/project/                     ← the machine's workspace
  .herdr-desk.json             ← "group": true — ladder, cron, notify
  anyrouter/                   ← inherits everything
  chmonitor/                   ← inherits everything
  herdr-desk/
    .herdr-desk.json           ← overrides just the schedule
```

Three steps, once:

1. **Clone** the repos you care about into one directory.
2. **Install** the plugin — see [Install](#install) below.
3. **Open** each repo as a Herdr workspace, once. The desk finds the
   config, remembers the path, and takes over from there.

Each job's `schedule` cron starts a manager agent **inside Herdr**, in a
worktree child of the Space that repo is already open in, fanning real
work into further isolated worktrees. It is a manager, not a crontab: a
crontab cannot see whether your terminal is up, cannot find the Space a
repo is open in, and cannot hand work to an agent that already has
context.

What it does without you:

- picks up open issues and PRs, and decides what is worth doing
- opens a PR per item, arms auto-merge, and babysits CI
- merges what is green, leaves what needs a human
- writes `changes.md` every run, and toasts you the delta
- reports to Telegram, so the machine is legible from your phone

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

**What notifies you by default: a job that failed.** That is all. Successes and
skips are silent, because a channel that says "spawned manager" on every cron
slot and "no open Herdr session" once per job is a channel you mute — and a
muted channel reports nothing at all, including the failure. Four jobs on one
repo once produced four identical notices in forty minutes for a condition that
had not changed. The real status of a run is the **merged report** below, written
by the manager once it has actually done the work, and the **hub** above, which
counts what every job on the machine is doing.

Skips and successes are still recorded in `runs.jsonl` and printed to stdout, so
`status` and `history` still answer "why did this not run".

**The two precondition skips are quiet**: *herdr is not running*, and *no open
Space for this repo*. A precondition is not something you can act on from a
phone, and it recurs on every tick for as long as it holds — announcing one
turned a single closed Space into a message every 30 minutes, per task, forever.
The run is still recorded in full, so `history` can still tell "the desk never
ran" from "the desk ran and had nothing to say". A task that needs a skip
announced can build its result with `preconditionSkip(reason, false)`.

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

Every notice leads with a one-line header — **repo · machine · task** — because
a host-level channel is read by scanning, not parsing, and several machines and
lanes post to the same chat. Repo is bold because it is the field you look for
first; the user suffix on the machine is dropped because it is the same
everywhere and the hostname is what tells two boxes apart.

```
*anyrouter* · homerep · `desk:github-issues`
🟢 *ok* 3 PRs merged
• PR #418 merged
• #412 filed
#ok #desk
```

Pass `--url` to attach the thing the notice is about. It renders as a tappable
trailing line with the scheme stripped, so the text stays short enough not to
wrap:

```sh
bun src/cli.ts notify "PR #3651 opened" --repo /path/to/anyrouter --url https://github.com/duyet/anyrouter/pull/3651
```

```
*anyrouter* · homerep
PR #3651 opened
→ [github.com/duyet/anyrouter/pull/3651](https://github.com/duyet/anyrouter/pull/3651)
```

Bodies are Telegram **MarkdownV2**: bold, italic, underline, strikethrough,
spoiler, inline code, fenced code with language highlighting, links, blockquote,
and expandable blockquote. Telegram has **no colour in message text** — emoji are
the only marks that render in colour, so a level dot marks the outcome and a
`#tag` makes it searchable in a busy channel.

```
*anyrouter* · homerep · `desk:github-issues`
🟢 *ok* 3 PRs merged
• PR #418 merged
• [run folder](https://example.com/run)
#ok #desk
```

MarkdownV2 rather than legacy `Markdown`, because legacy returns **200** for
`__underline__`, `~strike~`, and `||spoiler||` and then renders them as literal
characters — a status check cannot tell you the formatting failed.

Everything interpolated into a body is escaped, because an issue title like
`fix *auth* in _middleware_` would otherwise make Telegram reject the whole
message with a 400. If that happens anyway, the notice is retried once as plain
text rather than lost; the plain form is rebuilt separately, so its escapes never
leak as literal backslashes.

Sending is best-effort and never throws, so a failed notice cannot abort a desk
run, and a failed notice is never recorded as a failed run. Unconfigured or
failing sends print `not sent (<reason>)` and exit 0.

### The hub: one count for the whole machine

A merged report answers *"what happened to this repo"*, and only once a job has
finished. Nothing answered *"what is happening right now, across everything"* —
which is why the only mid-run notices that used to arrive were the useless ones:
`spawned manager` on every slot, `re-prompted live manager` on every tick, four
times a day per job, saying only that something happened.

Counting is the signal. **`herdr-desk hub`** is the state of every job on the
machine, and the daemon sends it to the host channel when it changes:

```
🔵 11 running · 1 done · 1 blocked
• anyrouter/local:deps — upgrade needs a human on the lockfile
• repo10/local:collect  44m · repo9/local:collect  40m · … · +5 more
#info #desk #hub #attention
```

Eleven `running` jobs are one line. The jobs that need a human get a line each,
with the reason the manager itself reported.

```sh
herdr-desk hub            # the table
herdr-desk hub --json     # machine-readable
herdr-desk hub --send     # send it now, ignoring the gates
```

**Three states a job can be in**, and only the third is an emergency:

| state | meaning |
| --- | --- |
| `running` | fired, no report yet |
| `ok` / `info` / `skip` / `blocked` / `fail` | settled from the job's own `status.md` |
| `stuck` | still `running` after 45 min — a manager that died or hung |

A report settles a job; it does not announce it. The per-repo notice below
already says what happened, so `report` only writes hub state — which means a
job that finished while you were asleep reads as **done**, not as a run that has
been going for eight hours.

**Three gates, and the order is the point.** Unchanged state is never re-sent —
the daemon ticks every 20s, so without this a single job produces 180 identical
messages an hour. A routine change (2 running → 3 running) waits for a 30-minute
quiet window, because that is not news. A job that needs a human — `stuck`,
`blocked`, or `fail` — **does not wait**. That bypass is the whole cost of the
throttling, and the reason the two rules above are safe to have.

The claim is written *before* the send and released if the send fails. Two jobs
that finish in the same second would otherwise both see "not yet sent" and both
send; and a send that never left the machine must not be recorded as delivered,
or the failure is never reported at all.

### One notice per project, not one per job

A repo usually has several jobs, and they can finish within seconds of each
other. Each manager writes a small `status.md` into its run dir, then hands it
to one command:

```sh
bun src/cli.ts report --repo /path/to/anyrouter --dry-run   # preview
bun src/cli.ts report --repo /path/to/anyrouter --settle 45 # send
```

```
🟠 blocked 2 jobs · 1 ok · 1 blocked
• desk:github-issues — 3 PRs merged, 1 blocked on a schema call
  • PR #418 merged
  • #412 filed
• local:merge-queue — queue drained, needs a human on the squash policy
  • waiting on decision for docs/*
• [changes.md](https://example.com/run/changes.md)
#blocked #desk
```

Three things make that one message rather than four:

- **`--settle` waits before reading.** Jobs that finish together are merged by
  the time anyone looks.
- **The body is fingerprinted.** Whoever sends first records the hash; the
  others find it unchanged and stand down. A send is recorded *after* it
  succeeds — claiming first would let a crash mid-send swallow the notice
  silently, and a quiet desk is worse than a repeated one.
- **Jobs are split by destination.** Two jobs routed to different topics stay
  two notices, so merging never puts an outcome in a channel that job did not
  choose.

The worst level wins the dot, so one blocked job is visible without opening
anything. `level` is `ok` / `info` / `skip` / `blocked` / `fail`.

`status.md` is written by the manager, so keep it to one line of insight and
three bullets. The full delta stays in `changes.md`; the notice is what you
read on a phone.

### Per-desk channels

A repo or task can point somewhere else. **Destination only** — a repo config
can never set the token, because repo configs are committed:

```json
{ "name": "anyrouter", "notify": { "chatId": "-1004420104760", "topicId": "7" } }
```

Precedence, highest first: **task → repo → group → host default.** `enabled`
only ever narrows: a repo cannot re-enable what the host muted.

```sh
bun src/cli.ts config explain --repo DIR     # shows which layer chose what
```

The token is read **only** from `notify.json` or `HERDR_DESK_TELEGRAM_TOKEN`.
Putting a `token` in a `.herdr-desk.json` is a hard `validate` error, not a
silent strip — a committed credential in git history with no warning is worse
than a failed check. Telegram puts the token in the request URL, so every error
string is token-redacted before it can reach `daemon.log` or the ledger.

Wiring the token:

```sh
CFG="$(herdr plugin config-dir herdr-desk)"
printf '{\n  "token": "<paste bot token>",\n  "chatId": "<real chat id>"\n}\n' > "$CFG/notify.json"
chmod 600 "$CFG/notify.json"
bun src/cli.ts notify "test" --repo "$PWD" --label desk:github-issues
```

**The bot's own id is not a chat id.** @BotFather shows the bot's numeric id,
and sending to it fails with `403 Forbidden: the bot can't send messages to the
bot`. A bot cannot DM you first: message it once in Telegram, then the bot can
read that conversation and learn the real chat id.

To set this up on another machine, paste
[`prompts/notify-setup-agent.md`](prompts/notify-setup-agent.md) to a coding
agent there. To bring an existing machine up to date and point it at the same
chat, use [`prompts/sync-machine-agent.md`](prompts/sync-machine-agent.md).

## Prompts as a registry

A repo can keep its own playbooks, and a **GitHub repo can be a shared library**
of them — a team writes one triage playbook and every repo on the machine uses
it, without copying it into each one.

Configure it host-level, in `registry.json` beside `notify.json`:

```json
{
  "allow": ["duyet/herdr-desk-prompts"],
  "registries": [{ "repo": "duyet/herdr-desk-prompts", "ref": "main" }]
}
```

Then point a job at it:

```json
{ "id": "desk:triage", "playbook": "gh:duyet/herdr-desk-prompts/triage.md" }
```

A registry holds playbooks under `tasks/` (or `prompts/tasks/`, so a repo can
just copy this plugin's `prompts/`). `herdr-desk tasks` lists what is
available.

```sh
bun src/cli.ts prompts list              # registries, allowlist, approved sha
bun src/cli.ts prompts check             # what upstream changed (read-only)
bun src/cli.ts prompts apply --accept    # approve it
bun src/cli.ts prompts pin REPO SHA      # freeze one registry to a commit
```

**Two independent trust layers.** Either alone leaves a gap:

1. **`allow` is an allowlist and fails closed.** A repo not listed can never be
   fetched, whatever any other file says. Removing a repo from `allow` also
   stops it being referenceable, so it really goes out of service.
2. **Content is locked by sha256.** The first `apply` records the commit and a
   hash per file. After that, `check` reports drift and `apply` **refuses**
   without `--accept`. An upstream edit cannot silently rewrite the
   instructions your agent runs.

Other things that make this safe rather than merely convenient:

- **A registry may only supply `tasks/*.md`.** The manager envelope, the
  identity rules, and the child prompt stay local, because those decide who the
  agent is allowed to be. A remote that could change them would be a remote
  code-execution channel, not a prompt library.
- **Path traversal, absolute paths, and non-`.md` files are refused**, and each
  file is capped at 256 KB.
- **Runs never touch the network.** Resolution reads the approved cache only —
  an unattended 07:00 job must not depend on GitHub being up.
- **`gh` is the transport**, so the plugin holds no GitHub token and private
  registries work with the credentials you already have.
- **Nothing is executed.** A playbook is text interpolated into a prompt, the
  same as a repo's own `.md`. The cache is re-verified against the lock on
  every read, so a hand-edited cache is treated as unapproved.

`check` is read-only and safe to run on a timer. Approving is always a separate,
explicit step.

## Actions

```sh
herdr plugin action invoke herdr-desk.start
herdr plugin action invoke herdr-desk.stop
herdr plugin action invoke herdr-desk.status
herdr plugin action invoke herdr-desk.list
herdr plugin action invoke herdr-desk.history
herdr plugin action invoke herdr-desk.validate
herdr plugin action invoke herdr-desk.notify
herdr plugin action invoke herdr-desk.prompts   # registries and what is approved
```

On-demand (plugin actions take no arguments):

```sh
bun src/cli.ts run desk:github-issues --repo /path/to/repo
bun src/cli.ts report --repo /path/to/repo --settle 45   # merged status notice
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

## Branches

This repo squash-merges, so nothing tells you a branch is spent: `git cherry`
and patch-id report already-landed branches as unmerged, because a squash
rewrites every patch-id. Branches then pile up.

```sh
bun run prune:branches          # report what is spent
bun run prune:branches:apply    # delete it
```

A weekly workflow does the second one. The safety is in the script, not the
workflow — a branch is only deleted if it has at least one **merged** PR, no
open PR, and is not ahead of `main`. A branch with no PR history is never
touched, which is what protects work that was pushed but not yet proposed.

It also skips `main`, `release-please--*`, and `desk/*` (the manager worktree
branches the plugin creates at run time).
