/**
 * Which watched task a `desk watch …` command line means, and where its state is.
 *
 * Its own module, not a function in `cli.ts`, for one reason: `cli.ts` runs
 * `main()` at import, so a test cannot import anything from it. These two are
 * the pieces whose correctness is a *key* — get the key wrong and `status`
 * reports `never polled` for a task whose events are sitting in the file, while
 * `reset` reports success and clears nothing — and a test that can drive them
 * directly is the only thing that catches it. Re-deriving the key inside a test
 * is not a test of the key; it is a test of the test.
 */

import { resolve } from 'node:path'
import type { WatchConfig } from './config'
import { loadDeskConfig } from './config'
import { discoverDesks } from './discover'
import { watchRepo } from './watch'

/**
 * Watched tasks for one repo, or every repo on the machine.
 *
 * The repo is resolved first, because it is the state key: `discoverDesks`
 * always hands back absolute paths, so a `--repo .` left unresolved would build
 * a key the tick never writes and `watch reset` would silently reset nothing.
 */
export async function watchedRows(
  repo: string | undefined,
): Promise<Array<{ repo: string; taskId: string }>> {
  const desks = repo
    ? [{ repo: resolve(repo), config: loadDeskConfig(resolve(repo)) }]
    : await discoverDesks()
  return desks.flatMap((d) =>
    d.config.tasks
      .filter((t) => t.watch)
      // `watchRepo`, not `d.repo`: on the `--repo` path the row above is a
      // hand-built desk whose `repo` is the directory, and a config naming a
      // different `repo` keys its state somewhere else — the same key the tick
      // writes, or the CLI reads a queue that does not exist.
      .map((t) => ({ repo: watchRepo(d.config, d.repo), taskId: t.id })),
  )
}

/** Resolve `--repo` / `--task` to exactly one watched task, or fail loudly. */
export async function oneWatchedTask(
  repo: string | undefined,
  taskId: string | undefined,
): Promise<{ repo: string; taskId: string; watch: WatchConfig }> {
  const root = resolve(repo ?? process.cwd())
  const desk = loadDeskConfig(root)
  const watched = desk.tasks.filter((t) => t.watch)
  if (taskId) {
    // `resolveTask` says `unknown task 'x'` for an id the desk does not have.
    // "pass --task" for the same id reads as a forgotten flag rather than a
    // wrong one, and sends the reader looking at their command line instead of
    // their config.
    const hit = desk.tasks.find((t) => t.id === taskId)
    if (!hit) throw new Error(`unknown task '${taskId}'`)
    if (!hit.watch) {
      throw new Error(
        `task '${taskId}' has no 'watch' block (watched: ${watched.map((t) => t.id).join(', ')})`,
      )
    }
    return { repo: watchRepo(desk, root), taskId: hit.id, watch: hit.watch }
  }
  if (watched.length === 0) {
    throw new Error(
      `no task in ${root} has a 'watch' block (tasks: ${desk.tasks.map((t) => t.id).join(', ')})`,
    )
  }
  if (watched.length > 1) {
    throw new Error(
      `pass --task (watched: ${watched.map((t) => t.id).join(', ')})`,
    )
  }
  const only = watched[0]
  if (!only?.watch) {
    // Unreachable given the checks above; kept so the return type is honest
    // rather than asserted with a non-null assertion.
    throw new Error(`no watched task in ${root}`)
  }
  // `watchRepo`, not `root`: the tick keys on `config.repo` when the config
  // names a different path, so the CLI has to agree or the two address
  // different queues.
  return { repo: watchRepo(desk, root), taskId: only.id, watch: only.watch }
}
