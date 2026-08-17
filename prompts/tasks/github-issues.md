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
| `summary.md` / `SUMMARY.md` | Morning kickoff + running log |
| `changes.md` | **After the run:** what actually changed (PRs, merges, skips) |
| `research-<n>.md` | Write-up when the right output is a note, not a PR |
| `run.json` | Machine-readable snapshot if you want one |

Do not put secrets in these files.

## Morning

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
5. Spawn with Herdr (you stay here):

```
herdr worktree create --cwd "{{repo}}" --branch "fix/<short>" --base origin/main --label "<short>" --no-focus
herdr agent start <name> --kind {{kind}} --pane <pane>
herdr agent prompt <name> <child prompt>
```

6. Fill workers + summary (counts, spawned, skipped + why).
7. Stay up. Watch children. Pull `main` when a PR merges. Tell remaining
   children to rebase. **Do not close** workspaces.
8. **When the morning run is done** (children settled, or you are not
   starting more), write `changes.md` — the human-facing delta:

```markdown
# Changes {{day}}

- Opened: PR #… title (url)
- Merged: PR #… 
- Still open / in review:
- Research only (no PR):
- Skipped + why:
```

Keep it short. This is what status/`last` shows. Also toast:
`herdr notification show "{{deskName}} morning done" --body "{{runDir}}/changes.md"`

There is no nightly slot. Do not wait until evening to write `changes.md`.

## Quality gate

Ship only if the change would survive a cold review: correct, small,
named like its neighbors, tested for the rule it encodes. If the issue
is vague, write a research note and leave it. Do not empty the backlog
with empty PRs.
