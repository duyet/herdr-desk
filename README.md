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
- opens a PR per item, then babysits CI before merging
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

## Update

There is no `herdr plugin update`. These reinstall the plugin and restart
the daemon. `config.json`, `notify.json`, and run history stay where they are.

Latest GitHub release (what the daily auto-update does). Run the desk
binary. `herdr plugin action invoke` answers with Herdr's JSON envelope
and hides this text inside a log.

```sh
desk=$(echo "$HOME"/.config/herdr/plugins/github/herdr-desk-*/bin/desk)
"$desk" update --check
"$desk" update
```

`update --check` only prints. Both print a short changelog of what is
newer than the installed version (eight lines, then a count):

```text
update available 0.1.6 -> v0.1.7
  0.1.7 notify: write telegram notices like a short text
  0.1.7 daemon: a signal-driven stop leaves a line
  +12 more
```

`update` stops the daemon, installs `duyet/herdr-desk`, and starts it
again. It moves only when a release tag is newer than the installed
version. A linked checkout or a `--ref` pin refuses. `"autoUpdate": false`
in the machine `config.json` stops the daily run; the commands above still
work.

Tip of `main`, before that tag exists:

```sh
herdr plugin install duyet/herdr-desk --yes
herdr plugin action invoke herdr-desk.start
```

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

The repo layer is whatever `.herdr-desk.json` says in that checkout's working
tree, at whatever commit it is on — nothing pulls it first, and a path-shaped
`extra` is read out of that same tree. So a config fix that merged changes
nothing on a checkout that is behind, and reports nothing about it. (`gh:`
playbooks are the exception: the registry locks each to an approved commit.)
To unstick one:

```sh
git -C ~/project/myrepo pull --ff-only
```

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
| `examples/watch-events/` | Event-only task: a repo script prints events, `schedule` is `[]` |

Optional extra roots (repos you never open in Herdr):

```json
// $(herdr plugin config-dir herdr-desk)/config.json
{ "repos": ["~/src/other-repo"] }
```

## Waking a job on an event

A cron slot is good at "once a day, look at the backlog" and wrong at
"someone opened a PR". The interesting minute is a guess between two slots,
and every slot in between is a full manager run that finds nothing.

The plugin does not learn what a PR is. It learns one thing: **a repo can
hand the desk a command that prints events, and the desk turns events into
runs.** "New PR" is an API call plus a filter; "a human commented" is a
search query; "the deploy finished" is a URL. A cron cannot express any of
them, so every repo hand-rolls a `while true; do …; done` loop beside the
desk and the two drift.

```json
{
  "id": "local:pr-watch",
  "playbook": "prompts/tasks/pr-review.md",
  "agentName": "hd-pr-watch",
  "schedule": [],
  "watch": { "command": ["bun", "scripts/watch-prs.ts"], "intervalSec": 60 }
}
```

The script prints NDJSON on stdout, one object per line, each with a stable
`id` — that id is the dedupe key, so a PR number works. The script owns its
cursor; the desk owns when to run and not running twice. Events are deduped
for 7 days, queued up to `maxPending`, and dispatched as **one** manager run
carrying the whole queue, so a storm is one manager with ten items rather
than ten managers.

Two things to know before you rely on it:

- **`"schedule": []` is what makes a task event-only.** Omit `schedule` and
  the task inherits the root cron, which is a useful reconciliation sweep —
  and also a full manager run every slot.
- **A broken watcher is never silent.** `desk watch status` prints
  `fails: N from <date>`, and five consecutive failures notify.

```sh
bun src/cli.ts watch --repo DIR   # one pass: what it saw, fires nothing
bun src/cli.ts watch status       # pending, overflow, fails, last/next poll
bun src/cli.ts watch test --repo DIR   # argv, cwd, exit, stderr, events — no log reading
```

**→ [docs/watch.md](docs/watch.md) is the contract, with a copy-pasteable
watcher.**

## See the cron and history

Herdr has no built-in crontab UI. This plugin is the schedule. Use:

```sh
herdr plugin action invoke herdr-desk.status    # daemon + next/last fire per slot
herdr plugin action invoke herdr-desk.agenda    # upcoming fires per slot, next 7 days
herdr plugin action invoke herdr-desk.next      # the next 5 fires, soonest first
herdr plugin action invoke herdr-desk.history   # recent runs (runs.jsonl)
herdr plugin action invoke herdr-desk.cleanup-dry-run  # what cleanup would remove; `cleanup` removes exactly that
herdr plugin action invoke herdr-desk.timeline  # one lane per job, next 7 days
herdr plugin action invoke herdr-desk.heatmap   # 7x24 cron density (heatmap-actual: from the ledger)
herdr plugin action invoke herdr-desk.analytics # success rate, skip/failure causes, last 30 days
herdr plugin action invoke herdr-desk.board     # static HTML board in the state dir
herdr plugin action invoke herdr-desk.serve     # dashboard on 127.0.0.1:8787, plus Tailscale when this node is online
herdr plugin action invoke herdr-desk.last      # today's changes.md from each repo
herdr plugin action invoke herdr-desk.summary   # preview the summary prompt
herdr plugin action invoke herdr-desk.list      # discovered repos
herdr plugin action invoke herdr-desk.sessions-index  # index local agent sessions
herdr plugin action invoke herdr-desk.sessions  # recent sessions, every agent
bun src/cli.ts context --repo DIR               # per-repo history file for any agent
bun src/cli.ts config explain --repo DIR        # which layer supplied what
```

Or:

```sh
bun src/cli.ts status
bun src/cli.ts history
bun src/cli.ts heatmap --actual --since 14d
bun src/cli.ts analytics --since 7d
bun src/cli.ts calendar --ics ~/desk.ics    # writes a file only with --ics
bun src/cli.ts board --html /tmp/board.html # no scripts, no network
bun src/cli.ts dash
bun src/cli.ts dash --json
bun src/cli.ts serve
```

`dash` is the terminal view (sessions, agents, PRs, runs for 24h). `serve` binds 127.0.0.1:8787 — `/` is the page, `/api/dashboard` and `/api/analytics?since=7d` are the JSON. When `tailscale status` shows this node online, it also binds that node's Tailscale addresses and prints the MagicDNS URL. `--host` pins one address and skips that detection. It reads the session index; it does not rescan agent files. `sessions index` is what refreshes that index.

Manage jobs without editing JSON (a job is `JOB --repo DIR`, like `run`):

```sh
bun src/cli.ts next 10                          # next 10 fires: When, In, Repo, Job, Agent
bun src/cli.ts trigger triage --repo DIR        # fire now; history shows "(manual)"
bun src/cli.ts pause triage --repo DIR          # until `resume`
bun src/cli.ts pause --all --until 2026-10-05   # every job, until local midnight
bun src/cli.ts resume triage --repo DIR         # or: resume --all
```

Pauses live in `paused.json` in the state dir, never in the committed
`.herdr-desk.json`. A paused slot is recorded as skipped, so resuming does not
replay it. `status`, `agenda` and `next` show what is paused. `trigger` runs
even a paused job, since you asked for it.

Terminal views fit `$COLUMNS` (narrow terminals get one mark per day or merged
hour buckets) and drop color when piped or when `NO_COLOR` is set. `analytics`
and `board` also count sessions per agent when `sessions.jsonl` exists in the
state dir.

Host-level plugin command log (start / focus hooks, not the schedule itself):

```sh
herdr plugin log list --plugin herdr-desk --limit 20
```

State on disk: `~/.local/state/herdr/plugins/herdr-desk/` (`daemon.log`, `runs.jsonl`, `sessions.jsonl`, `context/`).

### Agent sessions across the machine

`sessions index` reads, never changes, other agents' local session files and
writes one row per session (agent, repo, start, end, title) to
`sessions.jsonl` in the state dir. Titles only (the first user line, or the
agent's own generated title, capped at 80 chars, secrets redacted); no message bodies are copied.
Re-runs only open files whose mtime or size changed; a file a reader cannot
parse is counted as skipped, never fatal.

| Agent | Source read |
|---|---|
| Claude Code | `~/.claude/projects/<slug>/*.jsonl` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/*.jsonl` |
| Gemini CLI | `~/.gemini/tmp/<sha256(project)>/logs.json` |
| Grok | `~/.grok/sessions/<cwd>/<id>/summary.json` |
| desk runs | `runs.jsonl` |

```sh
bun src/cli.ts sessions index
bun src/cli.ts sessions --repo . --agent codex --since 7d
bun src/cli.ts context --repo .   # writes and prints <state>/context/<repo>.md
```

`context` re-indexes, then writes the last 20 sessions for that repo plus the
last desk run. To let every agent see it, add a line like "run `herdr-desk
context --repo .` for recent history" to the repo's `AGENTS.md` — the desk
never edits an agent's config for you. Nothing here is ever sent by notify.

### A written summary

```sh
bun src/cli.ts summary --since 1d --dry-run        # print the exact prompt
bun src/cli.ts summary --since 7d --repo DIR       # hand it to an agent
bun src/cli.ts summary --since 1d --notify         # ... and have it sent
```

The desk never calls a model. `summary` gathers the ledger records since
`--since` (the whole window, not the last 200), plus each job's `changes.md`
and `status.md` for every day in it, fences them as data in
`prompts/summary.md`, and prompts a `<desk>-summary` agent through the same
Herdr path a job fire uses (first rung of the desk's first job's ladder). The
agent writes plain text to `summaries/<time>.txt` in the state dir. With
`--notify` it then runs `summary --send FILE`, and the desk escapes and sends
it. Without `--repo` it covers every desk; the cwd must still be a desk, since
that is where the agent runs. Manual only: it costs an agent run, so nothing
schedules it.

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
🟢 ok anyrouter/desk:github-issues · grok · 18m · 1 PR · 1 issue · next Thu 07:00
  Shipped #418 — schema call landed. Watching CI.
  • #418
🟠 blocked anyrouter/local:merge-queue · claude · 7m · next Wed 18:00
  Queue drained. Need a call on the squash policy.
#blocked #desk
```

Every job gets the same verdict line: dot, level, `repo/job`, agent, duration,
PR and issue counts (from the fragment's GitHub links), next fire. A field the
desk does not know is left out. Duration runs from the fire's start to when
`status.md` was written, and the next fire is an absolute time — so it moves
when the schedule rolls over. If Telegram rejects the MarkdownV2, the retry is a
real plain rendering: no escapes, and each link as `label (url)`.

Three things make that one message rather than four:

- **`--settle` waits before reading.** Jobs that finish together are merged by
  the time anyone looks.
- **The reports are fingerprinted.** Whoever sends first records the hash of
  what the jobs wrote; the others find it unchanged and stand down. The next
  fire is left out of that hash on purpose — it advances at every schedule
  boundary, and hashing it resent the same paragraph on every tick. A send is
  recorded *after* it succeeds — claiming first would let a crash mid-send
  swallow the notice silently, and a quiet desk is worse than a repeated one.
- **Jobs are split by destination.** Two jobs routed to different topics stay
  two notices, so merging never puts an outcome in a channel that job did not
  choose.

The worst level wins the dot, so one blocked job is visible without opening
anything. `level` is `ok` / `info` / `skip` / `blocked` / `fail`.

`status.md` is written by the manager. The headline is a text: one or two
sentences, a fact and the next move (`Shipped #418 — schema call landed.
Watching CI.`). The full delta stays in `changes.md`; the notice is what you
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
herdr plugin action invoke herdr-desk.summary   # summary prompt preview (dry run)
```

On-demand (plugin actions take no arguments):

```sh
bun src/cli.ts run desk:github-issues --repo /path/to/repo
bun src/cli.ts report --repo /path/to/repo --settle 45   # merged status notice
bun src/cli.ts summary --since 1d --repo /path/to/repo    # agent-written summary
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

Upgrading means reinstalling. See [Update](#update). The daemon does that
once a day unless the machine `config.json` sets `"autoUpdate": false`.
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

A weekly workflow runs the first one, never the second, so nothing clears these
for you and they stay on the remote until someone runs `prune:branches:apply` by
hand. Its Monday log is just a list.

The safety is in the script, not the workflow — a branch is only deleted if it
has at least one **merged** PR, no open PR, and is not ahead of `main`. A branch
with no PR history is never touched, which is what protects work that was pushed
but not yet proposed.

It also skips `main`, `release-please--*`, and `desk/*` (the manager worktree
branches the plugin creates at run time).
