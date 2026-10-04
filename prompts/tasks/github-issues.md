# Task: GitHub issues and PRs

Triage open issues and PRs. Dispatch only work that will make this
codebase *better* — not busier. Research and audits are first-class;
a PR is not required.

## Run files

All under `{{runDir}}`:

| File | Purpose |
|------|---------|
| `queue.md` / `issues.md` | Classification of open issues + PRs |
| `workers.md` | Child worktrees, agent names, PR links |
| `summary.md` / `SUMMARY.md` | Start-of-run plan + running log |
| `changes.md` | **After the run:** what actually changed (PRs, merges, skips) |
| `status.md` | **After the run:** the one-line insight that gets notified |
| `research-<n>.md` | Write-up when the right output is a note, not a PR |
| `run.json` | Machine-readable snapshot if you want one |

Do not put secrets in these files.

## Run

1. `git fetch origin` and `git pull --ff-only origin main`. If this
   checkout is not a clean `main`, write the blocker in the summary and stop.
2. List open issues and PRs (`gh issue list` / `gh pr list`, limit 40).
3. Classify:
   - **autonomous** — narrow bug, docs, test, or CI with a clear verify path
   - **research** — needs a note, not a change
   - **audit** — red CI, stale bot review, merge conflict
   - **needs-human** — product/vision, security, license, release-please
   - **defer** — stale, duplicate, no repro
4. Dispatch at most **{{maxChildren}}** autonomous or audit items.
   One issue (or one tightly related PR) per worktree. Skip anything
   already in-flight this week.
5. Spawn with Herdr (you stay here). Parent is the **open project
   Space** (`{{workspaceId}}` — anyrouter, chmonitor, …). Nested
   worktree child, never a sibling Space:

```
herdr worktree open  --workspace "{{workspaceId}}" --branch "fix/<short>" --label "<short>" --no-focus
herdr agent start <name> --kind {{kind}} --pane <pane>
herdr agent prompt <name> <child prompt>
```

   Use `worktree open` for a branch that already exists (it re-attaches);
   `worktree create --base origin/main` only for a genuinely new one.
   Check `herdr worktree list` and `herdr agent list` first: a child
   already working the same issue gets re-prompted, not duplicated.

6. Fill workers + summary (counts, spawned, skipped + why).
7. Stay up. Watch children. Pull `main` when a PR merges. Tell remaining
   children to rebase. **Do not close** workspaces you still need. Once a
   child's PR has merged and nothing remains for it, close its worktree
   with `herdr worktree remove --workspace <id>` — that reclaims both the
   checkout and the Herdr Space — then delete the merged branch with
   `git branch -d <branch>`. Plain `git worktree remove <path>` leaves a
   Space behind in Herdr, so do not use it. Worktrees are disk, and a desk
   that leaks one per run stops being navigable within a week.
8. **When the run is done** (children settled, or you are not
   starting more), write `changes.md` — the human-facing delta:

```markdown
# Changes {{day}}

- Opened: PR #… title (url)
- Merged: PR #… 
- Still open / in review:
- Research only (no PR):
- Skipped + why:
```

Keep it short. This is what status/`last` shows. Then report the run
the way you would text it — see **Report** in the manager prompt. One
sentence, one fact, no counts, no second notice. Write it to
`{{runDir}}/status.md`, then
`{{deskBin}} report --repo {{repo}} --settle 45`.

A local toast is still fine for a human at the terminal:
`herdr notification show "{{deskName}} done" --body "{{runDir}}/changes.md"`

Do not wait until later to write `changes.md`.

## Quality gate

Ship only if the change would survive a cold review: correct, small,
named like its neighbors, tested for the rule it encodes. If the issue
is vague, write a research note and leave it. Do not empty the backlog
with empty PRs.
