# Watcher smoke test

This file exists so the PR that adds it is a real new pull request on this
repo. It is a smoke test for the `local:pr-watch` job that #99 armed: the
watcher should notice this PR, wake a manager, and review it.

It carries no product content. The correct review outcome is "nothing worth
a commit", and this file should never land.
