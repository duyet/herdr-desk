# Machine health — do not stack node runs

The desk host is a single 15 GB / 4-user machine shared by the manager pane,
every Herdr worktree child, and unrelated repos. It runs `earlyoom`
(`-r 15 -m 15,8 -s 40,20`) configured to evict `node`, `vite`, `tsc`, `make`,
`cargo`, and `chrome` **first**. Under memory pressure the kernel kills those
before anything else, so a too-many-parallel-runs failure looks like a
half-finished test run rather than an out-of-memory event.

## Observed 2026-09-27

`uptime` reported load 21.2 with 2 GB available of 15 GB. The cause was not one
big job but two children (`smoke-stream-tail`, `smoke-dims-unsup`) re-running
`vitest` in a loop — a fresh `vitest.mjs` process every ~4 seconds, two full
cycles inside 30 seconds. Nothing was individually large; the *rate* was the
problem.

## Rules

1. **One heavy `node` run per host at a time.** `vitest`, `tsc --noEmit`, `vite
   build`, and `wrangler` are all heavy. Do not start one while another is
   running, even in a different repo or worktree.
2. **Check before starting, not after.**
   ```bash
   uptime; free -g | head -2
   pgrep -fa "vitest|tsc --noEmit|vite build" | grep -v pgrep
   ```
   If load is climbing or available memory is under ~3 GB, wait.
3. **Text work needs no gate.** Editing markdown, YAML, or small TypeScript
   files is free. Gate only the *verification* runs, and batch them: lint every
   touched file in one `biome check`, then one `vitest run <files>`.
4. **A child that loops tests is a host emergency.** Tell it to stop rather than
   waiting for it to notice:
   ```bash
   herdr agent prompt <name> "STOP running tests. Host is at <N>GB free / load <N>. \
   Do not run vitest, tsc, or builds again. Stop here and go idle."
   ```
   Prefer a prompt over `send-keys` or killing the pane — the child keeps its
   work and its context.
5. **Prefer merging an open PR over having a child re-implement it.** Two
   children racing to rebuild a fix that is already in review doubles the load
   and guarantees a rebase conflict. Merge first, then let the child rebase.

## Reporting

A status line that mentions a checkout being mid-rebase or unpushed is telling
the manager to unblock a child. Finish or stash the lane and return the
checkout to `main` *before* reporting, so the next lane can claim work.
