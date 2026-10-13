# Task: Review opened pull requests

Someone opened a PR on {{repo}} and the watcher woke you. Work **only** the
PRs in the `# Event` section below. That is the whole queue for this run.

If the backlog has an issue or a PR nobody sent you, leave it. This task wakes
on events, not on a calendar — going looking is how one event turns into ten
manager runs. The repo's backlog job owns the backlog.

## Never merge

**Never merge a PR, and never tell a child to merge one.** Not with
`--squash`, not with `--auto`, not when CI is green, not when the review found
nothing. Merging belongs to the repo's backlog job, and two managers racing
to squash the same PR is worse than a slow one. Never auto-merge release-please
PRs either, which is a separate rule that outlives this one.

This overrides the merge paragraph in `{{childPromptPath}}` for every child
you spawn here. Say so in the child's prompt, in those words — a child that
read only the child prompt will merge, because it tells it to.

Your job ends at a commit on the PR's branch.

## The events

The events are in the `# Event` section below, and the same list is in
`{{eventPath}}`. Each event carries `number`, `title`, `author`, `base`,
`head`, `headFork`, `url`, and `at`. `{{eventCount}}` events fired this run, woken by `{{triggerKind}}`.

Reviewing a PR you were not sent is out of scope even if it looks urgent.
Reviewing the *same* PR twice is normal: a second commit on the head branch
does not fire a new event, so use the PR's current head, not the event's `at`.

## Run files

All under `{{runDir}}`:

| File | Purpose |
|------|---------|
| `queue.md` | The events, one line each: PR number, title, author, what you plan |
| `workers.md` | Child worktrees, agent names, PR links |
| `changes.md` | **After the run:** what actually changed |
| `status.md` | **After the run:** the one-line insight that gets notified |

Do not put secrets in these files.

## Run

1. Read `{{eventPath}}` and write `queue.md` — one line per event, plus a
   verdict you are committing to now: review it, or leave it alone and say why.
2. Write `workers.md` before spawning anyone.
3. Dispatch at most **{{maxChildren}}**. One PR per worktree. If more events
   arrived than `{{maxChildren}}`, work the most substantive and list the rest
   in `changes.md` as untouched — do not spawn a child per event.
4. For each PR you decided to work, one child worktree on the PR's head
   branch:

   ```
   git fetch origin
   herdr worktree create --workspace "{{workspaceId}}" --branch review-pr-<n> --base origin/<head-ref> --no-focus
   herdr agent start hd-pr-<n> --kind {{kind}} --pane <pane>
   herdr agent prompt hd-pr-<n> <child prompt>
   ```

   `--base origin/<head-ref>` puts the child on the PR's code, which is what
   a review needs. Check `herdr worktree list` and `herdr agent list` first: a
   child already reviewing this PR gets re-prompted, not duplicated. Use
   `worktree open` if the branch already exists.

5. Give each child `{{childPromptPath}}`, plus a prompt that says, in these
   words, that this is a review of PR #<n>: read the diff against
   `origin/<base-ref>`, push a commit **to the PR's head branch** when the
   review finds something real, never merge, and report what it changed or
   that it found nothing. Two overrides, both in the child's words and not
   buried: **do not open a PR** (the PR is already open — push to its head),
   and **do not merge**. The child prompt says to do both, so the override has to be
   explicit or the child will do what it was told first.
6. Stay up. Watch children. Read each PR's `ci` conclusion when it lands. A
   child reports in the child prompt's shape:
   `herdr agent prompt {{agentName}} "STATUS hd-pr-<n>: <state> PR #<n> <url> — <one line>"`.
   The child prompt's states are `opened|ci-red|merged|blocked` and a review child
   reaches neither `opened` (it opened nothing) nor `merged` (it must not
   merge). Use `blocked` for anything it could not finish; for the normal case
   spell out what happened — `reviewed PR #<n>, pushed a fix for <finding>` or
   `reviewed PR #<n>, nothing worth a commit`. Read the sentence, not the verb.

## What a review is

The bar is this repo's, from `{{repo}}/AGENTS.md` and the identity section:

- Match the surrounding code. No drive-by refactors, no renaming things the PR
  did not touch, no comment novels, no README the PR did not ask for.
- Small diff. A review commit that is larger than the bug is a failed review.
- A commit earns its place only by **fixing something real**: a bug, a missing
  test for the rule the PR encodes, a doc the PR contradicts. Name the finding
  in the commit body.
- **No finding worth a commit means the PR is left alone.** Say that in the
  report. Do not manufacture a change to look useful — a review commit with
  nothing to fix is noise the PR author has to read and revert.
- Push to the PR's head branch: `git push origin HEAD:refs/heads/<head-ref>`
  from the child worktree. Do not open a second PR for the same work, and do
  not merge.
- **A PR from a fork cannot be pushed to, and the event says so**: `headFork` is
  `true` on it. Do not fight it and do not try to work around it with a
  maintainer token. Leave the review as a comment
  (`gh pr review <n> --comment --body-file <file>`), say in the report that the
  finding is on a branch the desk cannot write to, and let a human decide. A
  watcher that pushes to a fork it happens to have access to is a desk editing
  someone else's repository.

## CI

Read the repo's required checks from `{{repo}}/AGENTS.md` or the repo
addendum. Children rely on the PR's checks and read their conclusions; a local
test run on a review worktree with the wrong deps says nothing about the gate.
A red check is a finding for the report, not a reason to merge.

## When the run is done

Close what is finished, then write the report. Both are in the manager
prompt above; this is the shape:

- `herdr worktree remove --workspace <id>` reclaims the checkout **and** the
  Space. Plain `git worktree remove <path>` leaves a Space behind. Then
  `git branch -d review-pr-<n>` for a branch whose work is done.
- **Close a child's worktree only after its PR is merged.** An unmerged PR is
  still in review, so its worktree stays. Never `-D` on unmerged work.
- Anything you spawned and no longer need must be gone by the end of the run. A
  run that adds worktrees and leaves them behind is a leak, not a review.

Write `{{runDir}}/changes.md` — the human-facing delta:

```markdown
# Changes {{day}}

- PR #<n>: reviewed, pushed a commit for <finding> (url)
- PR #<n>: reviewed, nothing worth a commit — <why>
- Left alone: #<n> <one clause>
- Skipped: <event> not dispatched this run (<maxChildren> cap)
```

Then write `{{runDir}}/status.md` in the format the manager prompt specifies: a
`level`, one sentence, at most one link. No counts, no bullets, no file lists.
`level` is the truth — `skip` when every PR was left alone, `ok` when you
pushed something real, `blocked` when a human has to decide, `fail` when the
run could not do its job. Do not report `ok` for a review that found nothing
and changed nothing.

Then send it, one notice for the project:

```sh
{{deskBin}} report --repo {{repo}} --settle 45
```

A local toast at a terminal is still fine:
`herdr notification show "{{deskName}} done" --body "{{runDir}}/changes.md"`

Do not wait until later to write `changes.md`.
