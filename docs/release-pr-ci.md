# Release PRs — CI sits blocked, not failed

A PR opened by release-please shows a `ci` check that never starts. It reads as
red. It is not failing. GitHub declines to start the run, so there is no result.

## Why

`release-please` runs on push to `main` with `token: ${{ secrets.GITHUB_TOKEN }}`
(`.github/workflows/release-please.yml`). A PR that workflow opens therefore
carries `GITHUB_TOKEN` into the `pull_request` event.

GitHub puts such a run in an approval-required state by default. From
[Triggering a workflow](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows):

> when a workflow using `GITHUB_TOKEN` creates or updates a pull request, the
> resulting `pull_request` event creates workflow runs in an approval-required
> state. The pull request displays a banner in the merge box, and a user with
> write access to the repository can start the runs by selecting **Approve
> workflows to run**.

So every release-please PR gets a `ci` run that ends `action_required` at 0
seconds, with zero jobs. The commit ends up with no `ci` check-run at all — only
the Socket and GitGuardian checks.

Across the 54 runs release-please has triggered on its own branch back to
2026-08-18, no first attempt has ever passed. 49 were blocked outright — 40
`action_required`, and 9 ending `failure` with zero jobs just the same. The
remaining 5 are second attempts, and all 5 passed.

This is default behaviour, not a misconfiguration. There is no setting to flip.

## It is specific to `GITHUB_TOKEN`

Renovate PRs are the control. Renovate authenticates as a GitHub App, so its runs
are not approval-gated. On 2026-09-28 a release-please run was created at
`03:47:52Z` and gated; a renovate run was created at `03:47:59Z` on a different
branch and passed. Same repo, same workflow, seven seconds apart, opposite
outcomes. All 11 renovate runs of `ci` have succeeded.

Push-triggered `ci` on `main` is not gated either, including pushes by
`github-actions[bot]`. Same token, same workflow, outside the
`GITHUB_TOKEN`-created-PR path. Those runs do get an answer — three of them came
back `failure` on 2026-09-28 — which is the contrast: a push run is answered,
a `GITHUB_TOKEN`-created PR run is not.

## Rules

1. **A blocked release PR is not a red build.** Merge on the approval banner plus
   a green push run on `main`, not on the `ci` status of the release PR.
2. **To see the check run, approve it first.** On the PR, use **Approve
   workflows to run** in the merge box. Then `ci` runs normally.
3. **One approval does not cover the next run.** Approval is per run, not per
   branch. Every merge to `main` makes release-please re-commit its branch, and
   GitHub creates a *new* `pull_request` run for that new commit, back in
   `action_required`. All five merges to `main` on 2026-10-04 did this, each one
   landing about 20 seconds after the merge:

   | merged to `main` | run created | gap | outcome |
   |---|---|---|---|
   | #71 at `07:21:18Z` | `37185542343` at `07:21:38Z` | 20s | `action_required` |
   | #72 at `07:28:50Z` | `37185917352` at `07:29:06Z` | 16s | `action_required` |
   | #70 at `09:09:43Z` | `37191266946` at `09:10:00Z` | 17s | `action_required` |
   | #73 at `09:13:17Z` | `37191463930` at `09:13:35Z` | 18s | `success`, attempt 2 |
   | #74 at `10:58:34Z` | `37197144804` at `10:58:53Z` | 19s | `success`, attempt 2 |

   The last two were approved and passed; the first three were never approved and
   are still blocked. So on that day the release PR read red more often than
   green, every time for a reason unrelated to the code in it. **A `ci` check
   turning red again on the next merge is expected, not a new failure.** Do not
   go looking for what broke it.
4. **Keep the branch mergeable.** `main` has no branch protection and
   `allow_auto_merge` is off, so nothing blocks a merge and no CI gate exists to
   wait on. Read the check, then merge.

## Do not add `branches-ignore` for this

The tempting fix is `branches-ignore: ['release-please--**']` on the
`pull_request` trigger. It does not work. Under `pull_request`, `branches` and
`branches-ignore` match the **base** ref — the branch the PR targets, per the
[workflow syntax reference](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpull_requestpull_request_targetbranchesbranches-ignore).
Every release-please PR targets `main`, so `release-please--**` matches nothing.
The only pattern that would exclude them is `main`, which would exclude every PR.

Even a pattern that did work would remove the check rather than fix the cause,
and would keep CI off release PRs after the real fix below lands.

## The two real fixes, both a human's call

1. **Approve per release.** No code change, no new secret, and all 5 approved
   runs on the release branch passed — on 2026-08-21, 2026-09-13, 2026-09-27,
   and twice on 2026-10-04. The cost is not the click, it is the wait, and the
   wait comes back on every merge to `main` (rule 3). The first two sat blocked
   from 2026-08-18 and from 2026-09-07 before anyone approved them, three and six
   days. The third was approved 40 seconds after it was created; the two on
   2026-10-04 after 58 minutes and 2 minutes.
2. **Give release-please an app token or PAT** instead of `secrets.GITHUB_TOKEN`.
   GitHub documents that this removes the approval prompt. It also widens what the
   release workflow can reach, so it is a deliberate trade rather than a cleanup.

Not established: the runs that report `failure` instead of `action_required` look
identical from the API — zero jobs, no logs to read. They are very likely the same
blocked state, but no reason string was available to confirm it.