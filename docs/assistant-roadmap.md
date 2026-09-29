# Roadmap — herdr-desk as the machine's assistant

Status: proposed. Builds on `docs/design.md`; where the two disagree, design.md
wins until this file says otherwise and design.md is updated.

Everything here is a decision, not a brainstorm. Each item names the command,
where its data comes from, the files it touches, and the check that says it is
done.

## 1. Goal and boundary

The desk already decides *when* and *who*. The next step is to make it the one
place you ask "what ran, what will run, what happened, and what did the agents
already do here" — for every local coding agent, not only the manager it fires.

The scope boundary in design.md §1 still holds:

- the desk is a **scheduler and router**, not an agent. Summaries are written by
  an agent the desk fires, never by the desk calling a model itself.
- it never reviews or merges PRs.
- it does not install agent CLIs.

New in this file, and a real widening of scope: **reading other agents' session
files** (`~/.claude/projects`, `~/.codex/sessions`, …). design.md never says the
desk reads them. §5 below keeps this read-only, local, and opt-in, so it stays a
"record and show" feature rather than an agent feature. Flagged as a conflict
to settle in design.md §1 before P2 ships.

## 2. Phases at a glance

| Phase | Theme | Items |
|---|---|---|
| P0 | See the schedule and the run you just had | `agenda`, `next`, `hub` done-notice format, `cleanup --dry-run` |
| P1 | Manage jobs without editing JSON | `trigger`, `pause`/`resume`, `cleanup`, `summary` |
| P2 | Every agent knows the history | `sessions index`, `sessions`, `context` file |
| P3 | Visual analytics | `timeline`, `heatmap`, `analytics`, `calendar --ics`, HTML board |

Order matters: P0 is read-only over data the desk already has. P1 adds the first
writes. P2 adds a new data source. P3 is rendering on top of P0–P2.

## 3. P0 — see the schedule

### 3.1 `desk agenda [DAYS]` — shipped with this file

- **Does:** every upcoming fire for the next 1–7 local days, grouped by day, one
  line per slot. A minute where two or more jobs fire is marked
  `[shares slot xN]`; a job firing more than 6 times a day collapses to one
  range line.
- **Data:** discovered desks + `cronNext`, chained. Same source as `status`, so
  the two cannot disagree.
- **Files:** `src/timeline.ts`, `src/timeline.test.ts`, `src/cli.ts`,
  `herdr-plugin.toml` (action `agenda`), `README.md`.
- **Accept:** `bun test src/timeline.test.ts` passes; `herdr plugin action
  invoke herdr-desk.agenda` prints today's remaining slots first and nothing
  already past.

`timeline.ts` is the module design.md §18 already names; `timeline` and
`heatmap` (P3) land in it later.

### 3.2 `desk next [N]`

- **Does:** the next N fires across the machine as a table (`When`, `In`,
  `Repo`, `Job`, `Agent`). The one-glance answer to "what runs next".
- **Data:** `upcomingFires` from 3.1.
- **Files:** `src/timeline.ts`, `src/cli.ts`, `herdr-plugin.toml`.
- **Accept:** test that `next 3` over two desks returns the three earliest
  fires in order, with `In` rendered as `2h05m`.

### 3.3 Done-notice format

- **Does:** one fixed shape for every run notice: `<state> <repo>/<job> ·
  <agent> · <duration> · <n PRs> · <one line from status.md>`. Replaces
  free-form text in the report path.
- **Data:** `report.ts` merged report, `runs.jsonl`.
- **Files:** `src/report.ts`, `src/notify.ts`, `src/report.test.ts`.
- **Accept:** snapshot test of the rendered line for `ok`, `fail`, `blocked`;
  still only the 4 rare events from design.md §2 page you.

### 3.4 `desk cleanup --dry-run`

- **Does:** lists what a cleanup would remove: merged or closed child worktrees,
  finished run dirs older than 14 days, stale panes the desk opened. Removes
  nothing.
- **Data:** `git worktree list`, `gh pr view` state, run dirs under the state
  dir, `herdr` pane list.
- **Files:** new `src/cleanup.ts`, `src/cleanup.test.ts`, `src/cli.ts`.
- **Accept:** test over a fake state dir lists the old dir and keeps the new
  one; a worktree with an open PR is never listed.

## 4. P1 — manage jobs

### 4.1 `desk trigger JOB --repo DIR`

design.md §15.2. Fires a job now through the normal path so it lands in the
ledger like a scheduled fire. **Files:** `src/run.ts`, `src/cli.ts`, toml.
**Accept:** a triggered fire appears in `history` with `trigger: manual`.

### 4.2 `desk pause JOB|--all [--until DATE]`, `desk resume`

- **Data:** a `paused.json` in the state dir, read by `daemon.ts` on each tick.
  Not written into `.herdr-desk.json`, which is committed.
- **Files:** new `src/pause.ts`, `src/daemon.ts`, `src/status.ts` (show
  `paused` in `Next`), `src/timeline.ts` (skip paused slots).
- **Accept:** a paused job is skipped by `tickOnce` with a `skip: paused`
  record, and absent from `agenda`.

### 4.3 `desk cleanup`

3.4 without `--dry-run`. Only removes what dry-run lists; never touches a
branch with unpushed commits. **Accept:** test that an unpushed worktree
survives.

### 4.4 `desk summary [--since 1d] [--repo DIR]`

- **Does:** fires a short-lived summary job (an agent from the ladder) with a
  prompt `prompts/summary.md` and the ledger slice as input; prints and
  optionally notifies its answer.
- **Boundary:** the desk gathers the data and routes it; the agent writes the
  prose. The desk never calls a model API itself.
- **Data:** `runs.jsonl`, `changes.md` per repo (`last.ts`), report files.
- **Files:** `prompts/summary.md`, `src/summary.ts`, `src/cli.ts`, toml.
- **Accept:** `summary --dry-run` prints the exact input it would hand the
  agent; test that the slice respects `--since`.

## 5. P2 — every agent knows the history

The point: when you open Codex in a repo, it should know what Claude did there
this morning, and the reverse.

### 5.1 `desk sessions index`

- **Does:** builds one local index, `sessions.jsonl` in the state dir, one row
  per session: `agent`, `repo` (resolved to a git root), `started`, `ended`,
  `title` (first user line, trimmed to 120 chars), `path` to the source file.
  No message bodies are copied.
- **Data (read-only):**

  | Agent | Source |
  |---|---|
  | Claude Code | `~/.claude/projects/<slug>/*.jsonl` |
  | Codex | `~/.codex/sessions/YYYY/MM/DD/*.jsonl` |
  | Gemini CLI | `~/.gemini/tmp/<hash>/` checkpoints and logs |
  | Grok | `~/.grok/` session files (format to verify) |
  | desk runs | `runs.jsonl` (already ours) |

  One reader per agent in `src/sessions/<agent>.ts`, each returning the same
  row type. An unknown format is skipped with a warning, never a crash.
- **Opt-in:** `sessions.enabled` in the machine-global config, default off.
- **Incremental:** keyed by path + mtime, so a re-run reads only new files.
- **Files:** `src/sessions/*.ts`, `src/sessions.test.ts` with fixture files,
  `src/config.ts`, `herdr-desk.schema.json`.
- **Accept:** fixture test per reader; a second `index` over unchanged files
  reads zero files.

### 5.2 `desk sessions [--repo DIR] [--agent NAME] [--since 7d]`

Table view of the index: `When`, `Agent`, `Repo`, `Length`, `Title`. The
"sessions view". **Accept:** filter tests.

### 5.3 Shared context file

- **Does:** writes `<state>/context/<repo-slug>.md`: the last 20 sessions for
  that repo across all agents, plus the last desk run and its `changes.md`
  line. Agents read it; the desk never edits an agent's own config to point at
  it.
- **How agents find it:** `desk context --repo DIR` prints the path and the
  file, so a line in a repo's `AGENTS.md` / `CLAUDE.md` can say "run
  `herdr-desk context` for recent history". Adding that line is the user's
  choice; `validate` only suggests it.
- **Files:** `src/sessions/context.ts`, `src/cli.ts`, toml, README.
- **Accept:** test that a repo with Claude and Codex sessions gets both, newest
  first, with no message bodies in the file.

**Privacy:** index and context files stay in the local state dir, are never
sent by notify, and carry titles only. This is the reason for opt-in.

## 6. P3 — visual analytics

All read-only, all in `src/timeline.ts` or `src/analytics.ts` (design.md §10).

| Command | Shows | Data | Accept |
|---|---|---|---|
| `desk timeline` | one lane per job, next 7 days | `upcomingFires` | lane test over two jobs |
| `desk heatmap [--actual]` | 7×24 density; `--actual` from the ledger | crons / `runs.jsonl` | a `0 7` job fired at 09:00 shows in the 09 column with `--actual` |
| `desk analytics [--since 30d]` | throughput, success rate, escalation and skip causes, per-agent session counts | `runs.jsonl`, `sessions.jsonl` | rollup test over a fixture ledger |
| `desk calendar --ics` | the agenda as an `.ics` file for any calendar app | `upcomingFires` | output parses as RFC 5545, one VEVENT per fire |
| `desk board --html` | a static HTML page: agenda, last runs, sessions | all above | page renders with no network access |

`calendar --ics` writes a file; it does not talk to any calendar service.

## 7. Conflicts and open questions

1. **Reading other agents' files** widens design.md §1. Proposed wording for
   §1 "In scope": "reading, not changing, local agent session files to index
   history, when opted in".
2. **`summary` needs an agent run.** It uses the ladder like any job, so it
   costs quota. It is manual only; no scheduled summary until the cost is known.
3. **Session formats are not stable APIs.** Each reader must tolerate unknown
   fields and fail per-file. Grok and Gemini paths need verifying on a real
   machine before their readers ship.
4. **Cleanup is the first command that deletes.** It ships dry-run first (P0)
   and only removes what dry-run lists (P1).
