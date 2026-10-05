# Watch: a desk job that wakes on a repo event

A cron slot is good at "once a day, look at the backlog" and wrong at
"someone opened a PR". The interesting minute is a guess between two slots,
and every slot in between is a full manager run that finds nothing and
writes `skip` to the ledger.

The plugin cannot learn what a PR is. "New PR opened" is
`GET /pulls?sort=created` plus a filter; "a human commented on a release
issue" is a search query; "the deploy finished" is a URL. So instead it
learns one thing: **a repo can hand the desk a command that prints events,
and the desk turns events into runs.**

```
.herdr-desk.json ──▶ watch.command (repo-owned)  ──▶ NDJSON on stdout
                                                            │
                     poll ◀───────────────────────────────┘
                      │
                      ├─ dedupe   repo::task::eventId, 7 days
                      ├─ queue    per task, cap maxPending
                      └─ run      one manager run carrying the whole queue
```

The split of ownership is the whole design: **the script owns what an event
is, the desk owns when to run and not running twice.**

## Config

`watch` is **task-level only** — there is no root-level `watch`, and a
group config must not be able to point a whole tree at one repo-specific
script. It is additive: a task with `watch` and a `schedule` gets both, a
task with `watch` and `"schedule": []` is event-only.

```jsonc
{
  "id": "local:pr-watch",
  "playbook": "prompts/tasks/pr-review.md",
  "agentName": "hd-pr-watch",
  "schedule": [],
  "maxChildren": 2,
  "watch": {
    "command": ["bun", "scripts/watch-prs.ts"],
    "intervalSec": 60,
    "timeoutSec": 45,
    "maxPending": 8
  }
}
```

| Field | Default | Range |
|---|---|---|
| `command` | required | argv array, non-empty, `argv[0]` non-empty |
| `intervalSec` | 60 | 15–3600 |
| `timeoutSec` | 30 | 5–300 |
| `maxPending` | 8 | 1–64 |

The ranges are enforced twice, on purpose. A repo's own file is checked by
`validate`, which rejects a number outside them. A **group config is not
validated** — one bad shared layer must not break every repo on the host at
once — so a group layer's `watch` numbers are clamped into the same range as
they are applied. A range the code honours only sometimes is a range the docs
are lying about.

### A task with `watch` and no `schedule` is NOT event-only

This is the trap, so it is here rather than in a changelog:

> **`schedule` omitted means the root cron is inherited.** A watched task
> with no `schedule` of its own still fires on every root slot, as well as
> on events. That inherited cron is the **reconciliation sweep** — the pass
> that catches anything the watcher missed — but it is still a full manager
> run every slot, which is exactly the cost you were trying to remove.

If you want events only, say so explicitly:

```jsonc
"schedule": []
```

An empty array is the event-only form. `cronsOf([])` is `[]`,
`scheduleLabel([])` is `-`, and `validate` accepts it — **but only with a
`watch` block on the same task.** `schedule: []` with no `watch` is a job that
can never run, and it is a validation error saying so: a `-` in `desk status`
reads as "unset", and the next thing you learn about that job is that it has
been silently never owed anything.

```jsonc
"schedule": []   // no "watch" on this task -> validate: no cron and no "watch" block
```

## The script contract

One NDJSON object per line on **stdout**:

```json
{"id":"pr-42","type":"pull_request.opened","at":"2026-10-05T02:14:07Z","summary":"#42 fix retry","url":"https://github.com/o/r/pull/42"}
```

- **`id` is required**, and must be stable across polls. It is the dedupe
  key. A PR number, a deploy id, an issue id plus action.
- `type`, `at`, `summary` and any other keys are optional and pass
  straight through to the manager prompt. The desk does not interpret them.
- **exit `0` is healthy**, whether or not anything was printed. A poll with
  nothing to report is the normal case, not a failure.
- **exit non-zero is a failed poll.** Nothing fires, no state advances, the
  failure is recorded and backed off.
- A line that is not a JSON object, or has no `id`, is **counted and
  skipped** — never fatal. One bad line must not mute a watcher, and a
  silent skip is how a script printing garbage for a week still reads as
  "nothing to report".
- **The script owns its cursor.** Keep it under
  `.herdr-desk/watch/` in the repo (gitignore it) so a restart resumes
  rather than replays. The desk does not invent one for you.

### A copy-pasteable watcher

```ts
// scripts/watch-prs.ts — new PRs this repo has not been told about yet
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const repo = process.env.HERDR_DESK_REPO
if (!repo) throw new Error('HERDR_DESK_REPO is not set')

const cursorDir = join(repo, '.herdr-desk', 'watch')
mkdirSync(cursorDir, { recursive: true })
const cursorPath = join(cursorDir, 'prs.json')
const since = readFileSync(cursorPath, 'utf8').trim() || new Date(0).toISOString()

// Your API call here. Any non-zero exit below fails the poll.
const out = await Bun.$`gh pr list --repo ${repo} --state open --json number,title,headRefName,url`
  .cwd(repo)
  .quiet()
  .nothrow()

for (const pr of JSON.parse(out.stdout.toString()) as Array<{
  number: number
  title: string
  url: string
}>) {
  // Stable across polls: the PR number alone. Reopening a PR is the same event.
  console.log(
    JSON.stringify({
      id: `pr-${pr.number}`,
      type: 'pull_request.opened',
      summary: `#${pr.number} ${pr.title}`,
      url: pr.url,
    }),
  )
}

// Advance the cursor only after everything above succeeded.
writeFileSync(cursorPath, new Date().toISOString())
```

Ignore your own branches (`desk/*`) and release-please PRs in it, or the
desk will review its own children in a loop.

### argv, not a shell string

`.herdr-desk.json` is committed, so:

- `command` is **argv**. No shell, so there is nothing to quote and nothing
  for a repo to inject.
- `argv[0]` that looks like a path (`./x`, `../x`, `a/b`, or absolute)
  resolves against the repo root and **must stay inside it**. A bare name
  like `bun` is looked up on `PATH` as normal.
- **There is no `env` block.** A committed config cannot carry a secret, so
  putting one there is a hard `validate` error rather than a silent strip.
  The command inherits the daemon's environment and the plugin adds exactly:

  | Variable | |
  |---|---|
  | `HERDR_DESK_REPO` | the repo root, and the cwd |
  | `HERDR_DESK_TASK` | the task id |
  | `HERDR_DESK_STATE_DIR` | the plugin state dir |
  | `HERDR_DESK_POLL_AT` | this poll's start, ISO |

- `stdin` is ignored. A poll that waits for input would hold the tick.

## What the desk does with the events

Per poll, at most one pass per watched task per tick and only when
`nextPollAt` has come:

1. **Paused** → events are counted and dropped. Resuming must not fire a
   burst of everything that happened while the job was off.
2. **Run** the command with `timeoutSec`; kill it on timeout and count that
   as a failure.
3. **Parse** NDJSON into events and warnings.
4. **Dedupe** each event against `seen`, then push onto `pending` up to
   `maxPending`. Past the cap it is counted as `overflow` and dropped — and
   **the dedupe key is written anyway**, so an overflowed event cannot be
   re-queued on every poll forever.
5. **Success** → `fails = 0`, `lastOkAt` set. **Failure** → `fails++`,
   `firstFailAt`, `lastError`, and the next poll backs off to
   `min(intervalSec * 2^fails, intervalSec * 8)`.
6. **Dispatch** — if `pending` is non-empty and the health gate passes, one
   `runTask(trigger: 'event')` carrying the whole queue.

### Failure backoff

```
poll 1 fails → next in 2 × interval
poll 2 fails → next in 4 × interval
poll 3 fails → next in 8 × interval  (the cap)
poll 4+ fails → next in 8 × interval
first success → next in 1 × interval
```

Uncapped, a watcher broken for a week is still polling every two minutes.
Capped, one dead script costs one poll per eight intervals, which is cheap
and still gets noticed.

### Paused and held, which are not the same thing

- **Paused** (you asked) → events counted and dropped, so resuming does not
  fire a burst.
- **Held** (the host was too busy) → events **stay pending** and nothing is
  dispatched. The queue *is* the backpressure: a saturated box absorbs a
  burst and drains it on a later tick, rather than being handed ten
  managers. The events are not written to `fires.json`, because an event is
  not a slot and claiming it fired would be a lie.

### The queue drains on any fire

A cron fire, a manual `trigger`, and an event fire all drain the queue and
carry the events. That is deliberate: an event that arrived while the cron
path was also working is then not stranded behind a queue only the watch
step knows how to empty. A cron run with an empty queue gets a
**byte-identical prompt** to what it got before this feature existed.

If the run fails before the manager sees the prompt, **a failed run is
recorded** — `runs.jsonl` gets `ok: false` with the reason, and the hub settles
the cell as `fail` — but **no successful run is**, and the events go back on the
**front** of the queue, because they arrived first. So the queue keeps the work
it was handed rather than swallowing it, and nothing claims a run happened that
did not. What is deliberately *not* written is `fires.json`: an event fire never
appears there, because an event is not a slot and a record claiming a slot fired
would be a lie.

## Not allowed to be silent

A watcher whose script broke on day one looks exactly like a watcher with
nothing to report, and the ledger records both as "no events". So:

- `desk watch status` prints **`fails N from <date>`** — the number and the
  day, not a status word.
- **Five consecutive failures notify**, reusing the same `failures.ts` dedupe
  every other fault uses, so one dead script is one message rather than one per
  poll. The notice clears when the watcher recovers.

The announced line is `watch poll failed: <error>` and deliberately carries **no
failure count**. `shouldAnnounce` keys on a hash of that line, so a count in it
made every consecutive failure a different fault: fails 5, 6, 7 and 8 were four
first sightings and four notices, where the intent was one. On a script dead
since day one that is one message per poll — and because the poll interval backs
off to `intervalSec * 8` after a few failures, roughly one every eight minutes at
the 60s default, not one a minute. The streak is in the `watch fail … (fails N)`
line in `daemon.log` and in `watch status`, which is where a number belongs. A
*different* error is still a different fault, and does announce.

"Once" means once per `REANNOUNCE_MS` — 12 hours — not once ever. The same fault
is announced again after a quiet period, so a watcher that nobody fixed is still
mentioned the next morning.

State lives in one file, `watch.json` in the plugin state dir, written the
way `fires.json` is (tmp + rename, pruned on the way out). A corrupt file is
moved to `watch.json.bak` and the desk starts fresh — the same recovery
`loadFires` uses, rather than a second dialect of it.

## Commands

```sh
desk watch --repo DIR [--task ID]        # one pass; print what it saw; fire nothing
desk watch status [--repo DIR] [--task ID]      # per task: pending, overflow, fails, last/next poll
desk watch test --repo DIR [--task ID]   # run the command directly: argv, cwd, exit, stderr, events
desk watch reset [--repo DIR] [--task ID]       # forget pending + dedupe
```

All four take `--repo` and `--task`, but **they do not mean the same thing
without `--repo`**:

| Command | No `--repo` |
|---|---|
| `desk watch` | the **current directory** — one repo, or an error |
| `desk watch test` | the **current directory** — one repo, or an error |
| `desk watch status` | **every repo on the machine** |
| `desk watch reset` | **every repo on the machine** |

`watch` and `watch test` act on exactly one task, so they need one repo and fall
back to `process.cwd()`. Run them from a non-desk directory and they say
`no herdr-desk config in /some/path` and exit 1 — they do not go looking for
watchers elsewhere. `status` and `reset` are machine-wide reads and writes, so
they enumerate every desk the daemon knows about.

`--task` narrows to one watched task wherever it is accepted, and a desk with
several watchers is the case where it matters.

A flag with **no value is an error**, not "no filter" — a flag written to
narrow scope must never widen it. `desk watch reset --repo DIR --task` resets
nothing and exits 2, as does `--task --repo DIR`, where the "value" is another
flag. An unrecognised word is an error too: `desk watch bogus` prints the usage
line and exits 2 rather than quietly running a poll pass and ignoring the word.

`watch` and `watch test` **exit non-zero when the poll failed**, so either
can be a check.

### `watch` and `watch test` write no *desk* state

They write nothing the desk keeps: no `watch.json` entry, no dedupe key, no
queue. A dry run that recorded a key would make the next real poll skip an event
just because someone looked at it.

They do run your script, though, and the script keeps its own cursor. **A
`watch test` can move that cursor** — which is the point of a test, and is also
how you lose the events it was meant to show you. If that matters, read what
your script does before pointing `watch test` at the live one, or run it against
a copy. `examples/watch-events` sidesteps the question entirely: its script
prints one fixed event and keeps no cursor.

`watch test` is the `notify-test` of this feature. Debugging a watcher at
03:00 from a phone must not mean reading `daemon.log`.

Actions: `herdr-desk.watch`, `herdr-desk.watch-status`,
`herdr-desk.watch-test`. Plugin actions take no arguments, so the flags above
belong to the `bun src/cli.ts watch …` form only — and that matters, because
without `--repo` the three actions do three different things:

- `herdr-desk.watch` runs `desk watch` with **no `--repo`**, so it polls **the
  current directory**: one repo, or an error if that directory is not a desk.
  It cannot sweep every watcher.
- `herdr-desk.watch-status` runs `desk watch status`, which **is** machine-wide:
  every watched task on this machine.
- `herdr-desk.watch-test` runs `desk watch test`, so like `watch` it is
  cwd-scoped.

To poll one watcher from the command line, name it:
`bun src/cli.ts watch --repo /path/to/repo`.

## Limits, so a failed poll can say why

Three bounds. The first two say so when they bite; the third is silent, which is
worth knowing before you rely on the other two.

| Limit | Value | What happens past it |
|---|---|---|
| `MAX_STDOUT_BYTES` | 4 MB | **The poll fails**, with `stdout over 4194304 bytes` |
| `MAX_LINE_BYTES` | 64 KB | That line alone is skipped, counted as a warning |
| `SEEN_MAX` | 10 000 keys | The **oldest** dedupe keys are evicted |

The stdout cap fails the poll rather than parsing a prefix of it: a truncated
event list is silently wrong, which is worse than no list. Print less, or print
summaries — events travel to a manager as prompt text, so an unbounded list is
an unbounded prompt.

`SEEN_MAX` is the one with a sharp edge, and it is the reason to read this
section. The 7-day TTL is what stops a rewound cursor replaying a week of
history; the cap is what stops the file growing forever. A watcher louder than
10 000 events inside the TTL evicts its own oldest keys, and an evicted event
can then be **re-fired inside the 7-day window**. `watch status` does not count
evictions, so past that volume the dedupe ledger is no longer protecting you and
`maxPending` is the only thing between a burst and a manager.

## In the manager prompt

`assembleManagerPrompt` gains an `# Event` section, **only** when the run has
events: one bullet per event (`- type — summary`), the pretty-printed JSON,
and the path to `<runDir>/events.json`. Template vars `{{eventCount}}`,
`{{eventSummary}}`, `{{eventJson}}`, `{{eventPath}}` and `{{triggerKind}}`
are all empty or zero when there are none.

The block in `prompts/run.md` renders on **any** fire carrying events, not only
an event fire — `run.ts` claims the queue on every fire — so it comes in **two
versions**, and `triggerKind` picks which one renders:

- an **event** fire gets *Repo events on this run*: the events woke the run, so
  work them and stop, and `level: skip` is a real answer if they need nothing.
- a **`cron` or `manual`** fire that merely found a queue gets *A repo event
  queue on this run*: the events were waiting, not the reason it started, so do
  the slot's (or the person's) normal work **and** handle them. A queue of no-op
  events is explicitly **not** a reason to skip the run.

The second one exists because the first was the only one, and "work them and
stop" told a reconciliation sweep to abandon the slot's own work over a queue of
already-handled events, and told a hand-triggered run to `level: skip`.

`history` records `trigger: 'event'` and prints `(event)` next to
`(manual)`.

See `examples/watch-events/` for a config you can copy as it stands: its playbook
is inline markdown and its watcher is the one script beside it, so nothing else
has to exist. That watcher prints one fixed event and keeps no cursor — a
fixture for the config, not a poller.
