# Design — herdr-desk 0.2

Status: proposed. Supersedes the 0.1.x behaviour described in `README.md`.

Everything here is a decision, not a brainstorm. Where something is still
unverified it says so, and where a decision is reversible it says that too.

## 1. Scope

A desk is a **scheduler and router**, not an agent. It decides *when* to run and
*who* should run, then gets out of the way. A host crontab cannot do this: it
cannot know whether the terminal multiplexer is up, cannot find the open Space
for a repo, and cannot hand work to a manager that already has context.

In scope:

- firing a scheduled manager session inside an already-open Herdr Space
- a ranked ladder of local coding agents, with retry and escalation
- delegating child worktrees to work the queue
- filing real GitHub issues for findings
- recording what actually happened, and showing it

Out of scope, deliberately:

- being the agent that writes code (that is the manager's and children's job)
- installing agent CLIs or Herdr integrations (it will *tell* you, not do it)
- reviewing or merging PRs, ever

### 1.1 The use case

You install Herdr and this plugin on a machine, and the machine starts keeping
its own projects alive while you are not looking at it.

```sh
# once, on the machine
herdr plugin install duyet/herdr-desk

# the project, opened as a Herdr workspace
open ~/project/myrepo          # or: herdr workspace create
```

From then on, every day at 07:00 that repo gets a manager session. The manager
triages its open issues and PRs, files anything worth tracking, opens a child
worktree per approved item, works them in parallel, opens PRs, and writes a
`changes.md` saying what actually happened.

The important part is where the manager lives: **inside Herdr, on `main`, in a
worktree child of the Space you already have open for that project.** Not in a
crontab. A crontab cannot see whether your terminal multiplexer is up, cannot
find the open Space for a repo, and cannot hand work to a manager that already
has context. That is the whole reason this is a plugin.

Scale that to a group of projects, and the config goes on top of them rather
than in each one:

```
~/project/
  .herdr-desk.json          ← one group config: ladder, notify, schedule
  myrepo/                   ← inherits everything
  otherrepo/                ← inherits everything
  third/
    .herdr-desk.json        ← overrides just the schedule
```

A fleet of twenty repos is one file. See §3.5.

## 2. Settled decisions

| Decision | Choice | Why |
|---|---|---|
| `kind` → `agent` | Rename, `kind` kept as deprecated alias | `agent` accepts commands, not just enum values |
| Ladder | Ordered list, first rung preferred | Rungs are accounts with different credentials |
| Parallelism | High fan-out via a slot pool + work queue | Requested; the right shape for "address them all" |
| Config layers | Machine-global → repo → env, with locking | Notify and the ladder are per-machine, not per-repo |
| Issues | **Real `gh issue create`**, not a local queue | Settled by request. `queue.md` remains the audit record, not a gate |
| Blocked escalation | Off by default | An unattended desk must not answer its own permission gate |
| Notify | One HTTPS transport, Telegram as a preset | No per-provider code paths |
| Notify trigger | 4 rare events, not every run | Notification fatigue kills the channel |
| Upgrade | Self-`plugin install`; no-op on local links | Herdr v1 has no `plugin update` |
| Secrets in repo config | Rejected by `validate` | `.herdr-desk.json` is committed and public |

## 3. Config surface

### 3.1 `agent` replaces `kind`

```jsonc
{
  "name": "my-repo",
  "agent": {
    "default": "opencode2",
    "ladder": ["opencode2", "opencode", "devin", "claude", "codex"],
    "permission": "yolo",
    "timeoutMs": 180000
  },
  "tasks": [
    { "id": "desk:github-issues", "schedule": "0 7 * * *", "agent": "claude" }
  ]
}
```

A task-level `agent` is either a string (pin this rung) or an object (override
part of the block). Resolution order, first hit wins:

1. `task.agent`
2. root `agent`
3. plugin-global `agent` in `$HERDR_PLUGIN_CONFIG_DIR/config.json`
4. the built-in default — **`grok`**, not `claude`

`kind` is read as a fallback for `agent` and emits a deprecation warning. A repo
with `"kind": "claude"` keeps working unchanged.

**The default rung stays `grok` on purpose.** 0.1.x defaulted to grok, so every
repo that never set `kind` was running grok. Defaulting to `claude` would switch
the agent on every existing repo at upgrade time, silently, which is the opposite
of back-compatible. An earlier draft of this document said `claude`; it was wrong
and is corrected here. Changing the default is a 0.2.0 decision, not a rename.

The object form exists so a repo can override one field without restating a
machine-wide ladder it does not own: `{"permission": "yolo"}` inherits the
inherited ladder and changes only the posture.

### 3.2 Per-repo files stay tiny

The global block exists so the ladder is written once. A repo that agrees with
the global default needs no `agent` field at all — which is the common case, and
the reason the field is not required.

### 3.3 Machine-global config

Notify targets, the agent ladder, feature toggles, budgets, and extra repo roots
are **per-machine, not per-repo**. They belong in
`$HERDR_PLUGIN_CONFIG_DIR/config.json` (per-user, `0600`, outside every repo):

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/duyet/herdr-desk/main/herdr-desk.schema.json",
  "repos": ["~/src/other-repo"],

  "agent": {
    "ladder": ["opencode2", "opencode", "devin", "claude", "codex"],
    "permission": "yolo",
    "lock": false
  },

  "notify": {
    "targets": [
      { "id": "desk-telegram",
        "url": "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage",
        "body": { "chat_id": "${DESK_TG_CHAT}", "text": "{{message}}" } }
    ]
  },

  "features": { "issues": false, "notify": true },
  "autoUpdate": true,
  "defaults": { "schedule": "0 7 * * *", "maxChildren": 16 },
  "limits":  { "concurrentChildren": 8, "perRung": 3, "issuesPerRun": 6 }
}
```

`{ "repos": [...] }` — the existing 0.1.x shape — stays valid, so this is a
superset rather than a migration.

**Precedence, highest first:**

1. `HERDR_DESK_*` environment (CI, one-off runs)
2. repo `.herdr-desk.json`
3. machine-global `config.json`
4. built-in defaults

**Locking.** A machine owner can pin what repos are allowed to run:
`agent.lock: true` makes the global ladder and permission profile
authoritative — a repo may still choose *which rung* for a task, but cannot
introduce a rung the machine has not approved, and cannot downgrade `permission`.
This is the difference between "one place to configure notify" and "one place to
*govern* the machine", and it is why the global layer is a real layer and not
just a default block.

**Provenance is a feature, not a debug leftover.** Every resolved value remembers
which layer won it, and that is queryable:

```
$ desk config explain my-repo
agent.ladder        ["opencode2","opencode","devin","claude","codex"]   machine
agent.permission    "yolo"                                              machine
tasks[0].schedule   "0 8 * * *"                                         repo
features.issues     false                                               machine
notify.targets[0]   desk-telegram                                       machine
```

Without this, a three-layer config is unauditable, and "why is this repo using
grok" has no answer. `desk config show` prints the effective config; `explain`
prints the effective config *with* provenance.

### 3.4 Features are launched from config

Every optional subsystem is a flag, so a machine can turn on exactly what it
wants without editing code:

| Feature | Default | Notes |
|---|---|---|
| `supervise` | on | escalation loop; off reverts to fire-only |
| `ledger` | on | typed records; `analytics` depends on it |
| `analytics` | on | read-only rollups |
| `fanout` | on | slot pool + work queue |
| `sidebar` | on | `agent.view.set` + the overlay pane |
| `notify` | off | needs targets anyway |
| `issues` | off | files real GitHub issues, so per-machine opt-in |
Self-upgrade is not a feature flag: it is the top-level `autoUpdate` boolean in
the machine `config.json` (default `true`). The daemon checks the latest GitHub
release at most once a day; `autoUpdate` only gates *applying* it. A committed
repo file cannot turn it on or off — the schema accepts the key, the daemon
reads it only from the machine config.

### 3.5 Group config: one file for a tree of repos

Config can sit on top of a directory of projects instead of inside each one.
An ancestor config marked `"group": true` becomes a layer for every repo
beneath it:

```jsonc
// ~/project/.herdr-desk.json
{
  "name": "duyet",
  "group": true,
  "repos": ["*/"],                 // glob relative to this file
  "agent":    { "ladder": ["opencode2", "opencode", "claude", "codex"] },
  "notify":   { "targets": [ … ] },
  "features": { "issues": true },
  "defaults": { "schedule": "0 7 * * *", "maxChildren": 16 },
  "tasks": [
    { "id": "desk:github-issues", "playbook": "github-issues" }
  ]
}
```

A member repo then needs no config at all, or one line to override:

```jsonc
// ~/project/third/.herdr-desk.json
{ "name": "third", "schedule": "30 6 * * *" }
```

**Resolution walks up from the repo root**, collecting each ancestor config
nearest-first, so `~/project/third/` wins over `~/project/`. Full precedence,
highest first:

1. `HERDR_DESK_*` environment
2. repo `.herdr-desk.json`
3. nearest ancestor group config, then progressively further ones
4. machine-global `config.json`
5. built-in defaults

The `group: true` marker is required rather than inferred, so a stray config in
an unrelated parent directory can never silently start steering a repo. Glob
`repos` is how a group enumerates members that are not open in Herdr — they show
up in `desk scan` and the board, but runs still need an open Space, which
remains the existing constraint.

**Config always resolves from the project root, never from a worktree child.**
Children are siblings of the main checkout, not descendants, so resolving from
the child would miss the repo's own config entirely. It also means a config
change made inside a worktree does not take effect until it is merged — which is
correct, and worth stating because it is the kind of thing that would otherwise
be a silent bug.

## 4. One agent string, two transports

`herdr agent start --kind` is a **closed 23-value enum** in 0.9.0:

```
pi claude codex gemini cursor devin agy cline omp mastracode opencode
copilot kimi kiro droid amp grok hermes kilo qodercli qwen maki muse
```

It maps to a *canonical executable*, so it can express `claude --yolo` but
**cannot** express a wrapper prefix like `anyr claude --yolo`. There is no
`opencode2` kind and no way to add one.

So the transport is chosen by the **shape** of the string, not by a config flag:

| Shape | Transport | Gets you |
|---|---|---|
| known kind, no prefix | `agent start --kind <kind> -- <args>` | lifecycle authority, session restore, `prompt --wait`, `wait --until blocked` |
| prefix, or unknown kind | `pane run "<argv>"` + `pane report-metadata` | custom agents and scripts |

```
opencode2                  → custom  (pane run)
anyr claude --yolo         → custom  (pane run)
claude --yolo              → native  (agent start --kind claude -- --yolo)
codex                      → native
./scripts/desk-agent.sh    → custom
```

Native rungs keep full Herdr integration. Custom rungs work, but the desk owns
their supervision, because Herdr cannot enforce a lifecycle contract on a
process it does not recognise.

## 5. Ladder, failure classes, retry

### 5.1 Classification

The single most useful property here: **`auth` and `quota` are deterministic.**
Retrying the same rung with the same broken credentials is pure waste, so those
classes skip the retry budget and escalate immediately.

| Class | Detected by | Retry | Escalate |
|---|---|---|---|
| `unavailable` | pre-flight: binary not on `PATH` | no | **immediately** |
| `auth` | structured, then output | **no** | immediately |
| `quota` | structured, then output | **no** | immediately |
| `crash` | process gone before ready | 1× | after retry |
| `notready` | `agent start` timeout | 1× | after retry |
| `context` | gone, no report, no PR | 1× | after retry |
| `blocked` | `agent wait --until blocked` | no | **no** (default) |
| `unknown` | none of the above | 1× | after retry |

### 5.2 Detection, layered by reliability

1. **Pre-flight** — binary on `PATH`, required env present. Deterministic, and
   costs nothing. Catches most `unavailable` before spending a readiness timeout.
2. **Launch** — `agent start` exit code and timeout. Structured.
3. **Post-launch probe** — `agent get`, `agent explain --json` (reports matched
   rule, evidence flags, idle-fallback reason), `pane process-info`. Structured.
4. **Output sniff** — `agent read --source detection`. **Last resort only.**

Layer 4 is the fragile one and will rot as agents reword their errors. Signatures
live in one table in `src/agents.ts`, per agent, and are covered by tests that
fail when the wording changes. If nothing matches, the class is `unknown` and we
retry the same rung — never guess an escalation.

### 5.3 Circuit breaker

A permanently broken rung must not burn a 30s timeout on every run. Per-rung
health in `$HERDR_PLUGIN_STATE_DIR/agents.json`: three consecutive failures marks
a rung sick and skips it for 30 minutes. Auth and quota failures extend that to
6 hours, because a key does not fix itself. `desk doctor` prints the table.

## 6. Two loops, not one

The daemon today is fire-only. Escalation is impossible without supervision.

- **fire loop** (20s) — unchanged cron logic, unchanged `fires.json` semantics
- **supervise loop** (60s) — walk live children, classify, escalate, record why

Escalation is tracked per child worktree, and a rung is only ever escalated for
work that has produced **nothing**. A child holding an open PR is finished as far
as the ladder is concerned.

## 7. Fan-out: discover → propose → dispatch

Three separable phases, which is what makes the analytics legible:

1. **Discover** — wide, cheap, no side effects. Classify everything, write
   `queue.md`. Nothing is filed, nothing is spawned.
2. **Propose** — rank candidates by confidence × value. File real GitHub issues
   for the ones that clear the bar.
3. **Dispatch** — a slot pool drains a work queue. One child worktree per
   approved issue, in ranked order.

Numbers stay separable: *found 23, filed 6, landed 3, skipped 14*. Today
`spawned: true` collapses all of that into one bit.

### 7.1 Filing issues safely

Autonomous issue creation on a public repo is a spam surface:

- **Dedupe** against open issues before filing
- **Label** with `desk` provenance so filed issues are greppable and
  bulk-closable
- **Cap** new issues per run
- **Never file** for anything already classified `defer` or already tracked
- Findings whose right output is a note stay in `research-<n>.md`

`gh issue create` failure is non-fatal. A triage run that cannot file is still a
triage run.

### 7.2 High fan-out: a slot pool, not a batch

Addressing the whole queue is a **scheduling** problem, not a spawning problem.
The wrong shape is a fixed batch: pick N, spawn N, wait for all N, repeat. It
idles every slot whenever one child is slow, and its concurrency is fixed no
matter how much work is queued.

The right shape is a pool draining a queue:

```
  queue (ranked)  ──►  [ s1 ][ s2 ][ s3 ][ s4 ][ s5 ][ s6 ]
                     ▲      ▲      ▲      ▲      ▲      ▲
                     └──────┴── child exits ── next issue takes the slot
```

- slots are a machine-level limit (`limits.concurrentChildren`, default 8)
- a child finishing — merged, blocked, failed, or abandoned — **immediately**
  returns its slot to the pool, and the dispatcher takes the next issue
- `maxChildren` becomes a per-run ceiling, raised from the current hard 1–8
  (see `src/schema.ts`) to a configurable value with a much higher absolute cap
- the dispatcher is deterministic plugin code, not the manager, so a slow or
  context-heavy manager cannot throttle fan-out

This is what lets one quiet issue and twenty urgent ones both drain fully, and
it is why fan-out does not have to be rationed to look responsible.

### 7.3 The correlated-failure trap

This is the real constraint at high parallelism, and it is not a review concern.

Rungs are usually **credentials, not capacity**. Ten children on
`opencode2` share one API key, so the tenth does not get 10× throughput — it gets
a 429. Worse, the failure is *correlated*: the ladder reacts by escalating, and
escalation moves load onto the next rung, which has its own key, and the whole
ladder burns inside one run. Naive escalation makes a rate limit much worse.

So concurrency is limited **per rung**, not just globally:

| Limit | Default | Why |
|---|---|---|
| `limits.concurrentChildren` | 8 | total in-flight children machine-wide |
| `limits.perRung` | 3 | children sharing one credential |
| `limits.issuesPerRun` | 6 | new issues per run, anti-spam |

And `quota` classification has a second effect beyond skipping the retry budget:
it applies **global backoff to that rung** for the rest of the day, not just to
the current child. One throttled key stops taking new work instead of cascading
through the ladder.

Per-issue atomicity is what makes this safe to scale: one issue per worktree, one
branch per child, one PR per child. Parallel children cannot conflict, so there
is no coordination cost to pay for the extra concurrency. PR discipline gets
stricter rather than looser — small diffs, no drive-by refactors, the existing
"prefer no change over a weak change" bar, and never auto-merge release-please.

Review load is reported, not capped. `desk analytics` surfaces landed-PR count per
repo per day, and the digest says so. If a repo is drowning in review that is a
fact the maintainer needs, and hiding it behind a cap would be worse than
surfacing it.

## 8. Move coordination out of the manager

At max parallelism the manager becomes the bottleneck: one context window doing
triage, bookkeeping, supervision, and reporting. The desk is deterministic code
and should own the bookkeeping — budget, in-flight tracking, dedupe, ladder,
retries, ledger — leaving the manager only the judgement calls (is this worth
doing, what is the right fix).

This is the largest single change to how the prompts are written, and the main
reason the child protocol shrinks.

## 9. Ledger

`runs.jsonl` currently stores `detail` as a JSON blob, which is why nothing is
queryable. Split it into typed fields:

```jsonc
{
  "at": "2026-09-26T07:00:03Z", "day": "2026-09-26", "cron": "0 7 * * *",
  "repo": "…", "task": "desk:github-issues",
  "agent": { "ladder": ["opencode2","opencode","claude"], "used": "opencode",
             "rung": 1, "escalatedFrom": "opencode2", "why": "auth",
             "permission": "yolo", "transport": "custom" },
  "prompt": { "sha256": "…", "bytes": 8123, "path": ".herdr-desk/runs/…/run.json" },
  "children": [ { "pane": "w3:p2", "branch": "desk/…", "pr": "https://…", "outcome": "opened" } ],
  "issues": [ 412, 415 ],
  "phase": { "found": 23, "filed": 6, "landed": 3, "skipped": 14 },
  "outcome": "ok", "skipped": null, "durationS": 4210
}
```

Prompt **bodies** stay in the run dir; only the hash and byte count go in the
ledger, so analytics can prove which prompt ran without duplicating megabytes.
`skipped` becomes a real field — a desk that skips 6 and lands 1 is doing well,
and today that distinction is buried in a string.

## 10. Analytics and timeline

`cronNext` already walks 8 days, so the timeline data is free — only rendering
is new.

```
$ desk timeline            # next 7 days, one lane per job
  github-issues  mon ██ 07:00   wed ██ 07:00   fri ██ 07:00
  deps           mon ░ 09:30    wed ░ 09:30

$ desk heatmap             # 7 days × 24h, cron density
        00    06    12    18
  mon   ······████········
  tue   ·······█···█████·
```

The more useful heatmap is **actual** fires from the ledger, not cron density. A
`0 7` slot that really fires between 07:00 and 11:00 tells you the daemon is the
bottleneck, not the schedule — which is the opposite of what the config implies.

`desk analytics [--since 30d]` reports throughput, success rate, escalation
causes, and skip reasons, all read from the typed ledger.

## 11. Sidebar projection — verified mechanism

`agent.view.set` is **socket-only**; it is not in `herdr agent --help`. Verified
against the v0.9.1 socket API:

- `source` must be `plugin:<HERDR_PLUGIN_ID>`; Herdr rejects the set if that
  plugin is missing or disabled
- `filter` ops: `all`, `any`, `not`, `eq`, `in`, `exists`
- built-in filter fields: `status`, `workspace_id`, `tab_id`, `pane_id`,
  `agent`, `seen`, `state_change_seq`
- plugin metadata is addressable as `{"token":"name"}` in both filter and sort
- the view drives the expanded **and collapsed** sidebar, the mobile Agents list,
  mouse targets, indexed focus, and next/previous navigation
- it does **not** change `agent.list`, notifications, or detection
- it is transient: cleared on server exit, and plugins must save the query under
  `HERDR_PLUGIN_STATE_DIR` and reapply from a `[[startup]]` hook

So the schedule is shown by **tagging panes and projecting them**, not by
inventing a calendar widget:

1. `pane report-metadata --source user:herdr-desk --token desk=github-issues
   --token next=07:00` on manager and child panes
2. one `agent.view.set` from the startup hook, filtered on the desk token

The token value carries the schedule text, so `next=07:00` is visible in the
sidebar through the existing token surface. Use `report-metadata`, **not**
`report-agent` — metadata is presentation-only and will not steal lifecycle
authority from a Herdr-managed integration.

A `[[panes]]` overlay rendering the same ASCII timeline is the fallback if the
socket path proves unreliable, and is worth shipping regardless since it is
easier to read than a sidebar.

## 12. Notify

One HTTPS transport, N targets. Telegram is a preset, not a provider:

```jsonc
"notify": { "targets": [
  { "id": "desk-telegram",
    "url": "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage",
    "body": { "chat_id": "${DESK_TG_CHAT}", "text": "{{message}}" } },
  { "id": "hooks", "url": "${DESK_WEBHOOK}",
    "body": { "text": "{{message}}", "repo": "{{repo}}", "task": "{{task}}" } }
] }
```

`chat_id` covers both a private chat and a broadcast channel. Four events only:

| Event | Why it is worth interrupting for |
|---|---|
| `landed` | a PR merged — the win |
| `blocked` | a child is stuck on a permission decision; the one failure that cannot self-heal |
| `failed` | the whole ladder was exhausted — the alarm |
| `digest` | end of run: found / filed / landed / skipped |

Everything else is ledger, not chat. Dedupe on
`event + repo + task + reason` with a cooldown, or one dead credential becomes
forty pings.

**Notify must never break a run.** Short timeout, swallow, record the delivery
failure. A flaky webhook is not a reason to skip a day's triage. Ship
`notify-test` as a first-class action — debugging a webhook at 07:00 is the
failure mode this avoids.

**Secrets are enforced, not documented.** `.herdr-desk.json` is committed to a
public repo, so `validate` rejects any target whose `url` embeds a literal
credential, and points at the `${VAR}` form. Values resolve from the plugin
config dir (`0600`) or the environment. Nothing posts file contents, diffs, or
command output by default, and all outbound text passes a redactor.

## 13. Upgrade, migrate, changelog

Verified: **Herdr v1 has no `plugin update`.** "There is no separate
`plugin update` in v1; reinstall from GitHub to refresh a managed plugin."
Reinstall replaces the managed checkout, and is refused over a local link.

- `herdr plugin list --json` exposes the plugin's own `source`
  (`owner`/`subdir`/`requested_ref`/`resolved_commit`), `plugin_root`, and
  `version` — that is how the desk discovers what it is
- **local links never auto-upgrade.** `source.kind == "local"` is a hard skip
  with a log line. A dev owns that tree
- `github` kind: compare the manifest `version` with the latest GitHub release
  tag, and if behind, **stop daemon → `herdr plugin install <source> --yes` → start**
- reinstall, not `git pull`: only reinstall re-registers the manifest, and a new
  release adds new `[[actions]]`. A pull would leave the registered manifest stale
- honour a pinned `requested_ref` — never silently move a user off their pin
- the restart must happen *after* the swap, not before

`desk update [--check]` runs this; `--check` is read-only. The daemon runs the
same check once a day and, with `autoUpdate` on, reinstalls, drops its pid
file, asks Herdr to start the new plugin, and exits. Changelog: read
`CHANGELOG.md` from the installed plugin root and show what changed since the
running version, and surface it in the status output after an upgrade.

Migration is additive and idempotent — `kind` → `agent` is the only rename, and
migrating a config in place is opt-in via `desk migrate`, never automatic.

## 14. Config doctor

`desk doctor` is read-only and reports; `desk doctor --fix` repairs only what is
unambiguously safe:

- unknown `kind` value that is not in the current enum
- `maxChildren` outside 1–8
- `stateDir` that escapes the repo
- a literal credential in a `notify` target URL
- a bundled playbook id that no longer exists
- an agent rung whose binary is not installed → suggest `herdr integration install`
- cron that can never fire (e.g. `0 0 30 2 *`)

No repair is applied without a diff being printed first.

## 15. The board

One cross-machine view of every tracked item, for every repo, in one place. It
is a **query over the same store** that backs `status`, `analytics`, and the
sidebar — not a separate system. One source of truth, three projections.

```
$ desk board
  REPO        TITLE              STATE      AGE    NEXT / DETAIL
  myrepo      #412 flaky auth    in-review  2d     PR #418
  myrepo      #415 log spam      doing      4h     pane w3:p2  grok
  myrepo      #420 docs drift    queued     —      due 07:00
  myrepo      auth key rotated   blocked    1d     needs human
  otherrepo   #88 cache stampede filed      3h     due 07:00
```

States come from the ledger and the repo, and the columns map to one lifecycle:
`queued → filed → doing → in-review → landed`, plus `blocked` and `skipped`.
`blocked` is the column that matters most, because it is the only state the desk
cannot fix by itself.

### 15.1 Two cadences, because the data changes at different speeds

| Source | Cadence | Why |
|---|---|---|
| Herdr agent state | event-driven (§16.1) | changes by the second |
| `gh` PR / issue state | every 5–10 min | changes by the minute, and costs a subprocess |

Reconciling on the agent cadence would mean thousands of `gh` calls a minute and
a board full of confidently wrong "in review" rows. The slow cadence is
deliberate: **a board that is 5 minutes stale is useful, a board that is
constantly wrong is not.**

### 15.2 Trigger now

The board can fire a task immediately, bypassing the cron. This already exists
as `runTask`; it needs a first-class surface:

```sh
desk trigger <repo> <task>     # fire now
desk trigger <repo> --all      # every due task
```

and a `trigger` plugin action, so it is reachable from Herdr without a terminal.
Triggers reuse the ordinary ladder, budget, and ledger paths — a manual run is
recorded as a run with `trigger: "manual"`, so analytics can tell a human-fired
run from a scheduled one. A trigger respects the same concurrency limits;
otherwise a human clicking "run now" eight times becomes an 800-agent incident.

## 16. Fleet scale

Target: **~2,000 tracked items, with concurrency a config value** rather than a
hardcoded assumption. Tracked items and live sessions are different limits, and
conflating them is how a fleet design goes wrong.

2,000 *live* child worktrees on one machine is not viable, and the wall is git
worktrees and PTYs, not agents. 2,000 tracked items over time is routine — that
is just a mature backlog plus history. So the design takes the first number
seriously and treats the second as a sharding question.

### 16.1 The subprocess wall, and the fix

`herdrCall` spawns a `herdr` process per call. A supervise loop that calls
`agent get`, `agent read`, and `pane process-info` per child is 3N processes per
minute — 6,000 a minute at 2,000 children, which is not a performance problem,
it is a fork bomb with extra steps.

Two fixes, both required:

1. **Batch through the socket.** `agent.list` returns every agent in **one**
   call, so a tick reads the whole fleet once instead of N times. The CLI is for
   humans and scripts; the daemon talks to the socket.
2. **Subscribe instead of poll.** The socket exposes `events.subscribe` with
   `pane.agent_status_changed` and friends. The daemon keeps a local index fed
   by events, making a tick O(changes) rather than O(agents). Polling stays only
   as a slow reconciliation pass, because subscriptions can be missed across a
   server handoff.

This is not an optimisation to add later. It is a prerequisite for the fan-out
in §7, and it is why the rollout does supervision after the transport work.

### 16.2 Naming, worktrees, and the store

- **Names** must be unique and fit `[a-z][a-z0-9_-]{0,31}`, so children get
  deterministic ids (`d<repo>-<task>-<seq>`) rather than ad-hoc ones
- **Worktrees** get a hard live cap with LRU eviction and branch cleanup after
  merge; without it, a long-lived desk accumulates thousands of directories
- **`runs.jsonl`** is append-only and will grow. It needs size-based rotation and
  a compacted rollup, and `analytics` must never load the whole file — the
  current `loadRuns` caps at the last 200 lines, which is fine at desk scale and
  wrong at fleet scale
- **Sharding** is a config boundary, not a rewrite: `nodeId` in the global
  config, with each node owning a slice of the queue. Design the field now so
  going multi-machine is a config change

## 17. Performance

Measured on this repo, 12 repos × 2 tasks, before and after:

| | before | after |
|---|---|---|
| `cronNext` | 3.05 ms | **0.01 ms** (~290×) |
| `cronDueToday` (no match) | 0.69 ms | **~0 ms** |
| daemon tick, cron math | 16.7 ms | **0.01 ms** |
| idle CPU per day | 72 s | ~0 s |

The old `cronNext` stepped one minute at a time across an 8-day horizon — up to
11,520 evaluations, each re-parsing all five fields into fresh `Set`s. It now
jumps by the largest mismatching field, and expressions are parsed once and
memoised. `cronDueToday` walked backwards through up to 1,440 minutes; it now
enumerates only the `(hour, minute)` pairs the expression can produce.

Correctness is enforced by a differential suite in `src/cron.test.ts` that
compares both functions against a brute-force minute-stepper across month, year,
and leap-day boundaries. An optimisation of this kind is only worth having if
the test proves it changed no answers.

**Config loading turned out not to need optimising**: `loadDeskConfig` is
0.045 ms, and a full `discoverDesks` is 0.35 ms, so ~1.5 s/day. The obvious
move — caching configs by mtime — would have added invalidation bugs to save
almost nothing. Measured, then skipped.

The remaining cost is the one that actually matters at scale, and it is not
arithmetic: it is `herdrCall` (§16.1). Every rule here is "reduce process spawns
and IPC round-trips", not "make the maths faster".

## 18. Module map

New or rewritten:

| File | Role |
|---|---|
| `src/agents.ts` | rung parsing, transport choice, known-kind list, failure signatures |
| `src/launch.ts` | pre-flight, launch, probe, classification |
| `src/supervise.ts` | supervise loop, escalation, circuit breaker |
| `src/socket.ts` | batched socket client; `agent.list` + `events.subscribe` |
| `src/layers.ts` | env → repo → group-walk → global resolution + provenance |
| `src/board.ts` | cross-repo item index, states, two-cadence reconcile |
| `src/dispatch.ts` | slot pool, work queue, per-rung limits, backoff |
| `src/issues.ts` | dedupe, file, label, cap |
| `src/budget.ts` | review budget, in-flight accounting |
| `src/ledger.ts` | typed records (replaces the `detail` blob) |
| `src/analytics.ts` | rollups |
| `src/timeline.ts` | ASCII timeline + heatmaps |
| `src/notify.ts` | transport, templates, dedupe, redaction |
| `src/upgrade.ts` | source discovery, check, install, changelog |
| `src/doctor.ts` | diagnose + safe fixes |
| `src/view.ts` | metadata tokens + `agent.view.set` |

Rewritten: `config.ts`, `defaults.ts`, `schema.ts`, `run.ts`, `describe.ts`,
`cli.ts`, `herdr-plugin.toml`, `README.md`, `herdr-desk.schema.json`.
Prompts: `run.md` and `child.md` shrink as coordination moves into code.

## 19. Rollout

Ordering is not arbitrary. Steps 1–2 change no behaviour a user depends on, and
everything later reads from the config layer they establish.

1. **`agent` + back-compat** — config, schema, resolution order, two transports.
   A superset: every existing repo keeps working, `kind` still reads.
2. **Layers + group config** — env → repo → group-walk → global, with provenance
   and `desk config explain`. Also where the global file, features, and notify
   config land.
3. **Transport** — batched socket client, `agent.list` in one call, event
   subscription. **Before supervision**, because the supervise loop is what makes
   this necessary and it is not viable without it (§16.1).
4. **Launch probe + ledger** — structured classification, typed records. Pure
   addition; `status` and `history` keep their shape.
5. **Supervise + ladder** — retry, escalation, circuit breaker. First behaviour
   change: a run can now pick a different agent.
6. **Analytics + timeline** — read-only over the ledger.
7. **Board + trigger** — the cross-repo index, then manual firing.
8. **Notify** — opt-in, `notify-test` first.
9. **Slot pool + per-rung limits** — high fan-out, backpressure, `issues` behind
   a per-machine opt-in. The real behaviour change, so it goes late and guarded.
10. **Sidebar + pane** — presentation only.
11. **Upgrade + doctor** — self-update, then `doctor --fix`.

Each step is independently revertible. Steps 1–4 are additive.

## 20. Open questions

1. **Custom-rung supervision.** For `pane run` rungs Herdr has no lifecycle
   contract, so the desk infers state from process liveness plus
   `pane report-metadata`. This is the weakest part of the design and the most
   likely source of false "escalated" reports.
2. **Circuit-breaker defaults.** 30 min / 6 h are guesses. Needs real failure
   data.
3. **Review budget unit.** Per-day PR ceiling per repo is a guess. Real answer
   probably depends on how many humans review.
4. **`agent.view.set` durability.** Verified as socket-only and transient. The
   startup-hook reapply is the documented path but is untested here; the
   `[[panes]]` overlay is the hedge.
5. **Issue volume.** Settled as "real issues", but the per-run cap is unset and
   is the number most likely to need tuning against a real repo.
6. **Fleet ceiling.** 2,000 tracked is designed for; the honest concurrent
   ceiling per machine is unknown until step 3 is measured. `nodeId` exists so
   sharding is a config change rather than a rewrite, but the split point needs
   real numbers.
