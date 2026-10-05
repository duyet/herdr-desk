#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { formatAnalytics, rollup } from './analytics'
import { formatBoard } from './board'
import {
  applyCleanup,
  formatCleanup,
  formatResult,
  planCleanup,
} from './cleanup'
import { listBundledTasks, loadDeskConfig, resolveTask } from './config'
import { explainConfig, explainTasks, showConfig } from './configShow'
import {
  daemonPid,
  runDaemon,
  startDaemon,
  stopDaemon,
  tickOnce,
} from './daemon'
import { collect, dashboardJson, render } from './dashboard'
import { dayKey } from './day'
import { discoverAll, discoverDesks, formatScan } from './discover'
import { defaultHerdrBin } from './herdr'
import { formatHistory, loadRuns, loadRunsSince } from './history'
import { serve } from './http'
import { formatHub, publish, snapshot } from './hub'
import { countParts, insightsOf } from './insights'
import { stripAllDeskCrons } from './install'
import { readLastChanges } from './last'
import {
  loadNotifyConfig,
  type NotifyProvenance,
  noticeBody,
  notify,
  resolveNotify,
} from './notify'
import { pluginStateDir } from './paths'
import {
  describePause,
  loadPaused,
  parseUntil,
  pauseKey,
  savePaused,
  withoutPause,
  withPause,
} from './pause'
import {
  approve,
  approvedContent,
  type Diff,
  diffRepo,
  fetchPlaybooks,
  ghCommand,
  isAllowed,
  listRegistryTasks,
  loadRegistryConfig,
  loadRegistryLock,
  needsAccept,
  playbookName,
  registryConfigPath,
  resolveCommit,
  unapprovedPlaybooks,
  writeCache,
} from './registry'
import { collectReports, REPORT_FILE, sendReports } from './report'
import { runTask } from './run'
import { scheduleLabel } from './schedule'
import { SCHEMA_PATH, SCHEMA_URL } from './schema'
import { writeContext } from './sessions/context'
import {
  filterSessions,
  formatIndexStats,
  formatSessions,
  indexSessions,
  loadSessions,
} from './sessions/index'
import type { SessionRow } from './sessions/types'
import { parseSince } from './since'
import { formatSchedule } from './status'
import {
  buildSummaryPrompt,
  handToAgent,
  runsSince,
  summaryInput,
  summaryOutPath,
} from './summary'
import { textTable } from './table'
import { bindHosts, dashboardUrls, detectTailnet } from './tailscale'
import { termOpts } from './term'
import {
  formatAgenda,
  formatHeatmap,
  formatNext,
  formatTimeline,
  heatOf,
  toIcs,
  upcomingFires,
} from './timeline'
import {
  checkForUpdate,
  reinstall,
  releaseUpdateLock,
  saveLastCheck,
  takeUpdateLock,
} from './update'
import {
  formatWatchStatus,
  loadWatchState,
  parseWatchOutput,
  resetTask,
  runWatchCommand,
  saveWatchState,
} from './watch'
import { oneWatchedTask, watchedRows } from './watchTarget'

function usage(): never {
  console.log(`herdr-desk — Herdr plugin. Each repo is .herdr-desk.json; the daemon picks them up.

  herdr-desk scan
  herdr-desk validate
  herdr-desk config show   [--repo DIR]
  herdr-desk config explain [--repo DIR] [--tasks]
  herdr-desk status
  herdr-desk agenda [DAYS]
  herdr-desk next [N]
  herdr-desk trigger [JOB] --repo DIR
  herdr-desk pause JOB|--all [--repo DIR] [--until DATE]
  herdr-desk resume JOB|--all [--repo DIR]
  herdr-desk timeline
  herdr-desk heatmap [--actual] [--since 30d]
  herdr-desk analytics [--since 30d] [--wide] [--json]
  herdr-desk calendar [--ics FILE]
  herdr-desk board --html [FILE]
  herdr-desk history [N]
  herdr-desk watch --repo DIR [--task ID]
  herdr-desk watch status [--repo DIR] [--task ID]
  herdr-desk watch test --repo DIR [--task ID]
  herdr-desk watch reset [--repo DIR] [--task ID]
  herdr-desk cleanup [--dry-run]
  herdr-desk last
  herdr-desk sessions index
  herdr-desk sessions [--repo DIR] [--agent NAME] [--since 7d]
  herdr-desk context --repo DIR
  herdr-desk start | stop | daemon
  herdr-desk tick
  herdr-desk on-focus
  herdr-desk run [JOB] --repo DIR
  herdr-desk tasks
  herdr-desk notify MESSAGE [--repo DIR] [--label TEXT]
  herdr-desk report --repo DIR [--settle SECONDS] [--dry-run] [--force]
  herdr-desk hub [--send] [--json] [--force]
  herdr-desk summary [--since 1d] [--repo DIR] [--dry-run] [--notify]
  herdr-desk dash [--json] [--no-color]
  herdr-desk serve [--port 8787] [--host ADDR]
  herdr-desk prompts list | check | apply [--accept] | pin REPO SHA
  herdr-desk update [--check]
  herdr-desk uninstall-cron
`)
  process.exit(2)
}

function arg(flag: string, argv: string[]): string | undefined {
  const i = argv.indexOf(flag)
  if (i === -1) return undefined
  return argv[i + 1]
}

/** `--since 30d` as epoch ms; a bad value is a usage error, not a guess. */
function sinceMs(text: string): number {
  try {
    return parseSince(text)
  } catch (e) {
    console.error((e as Error).message)
    process.exit(2)
  }
}

/** `--since`, default 30 days, as a Date. */
function sinceArg(argv: string[]): Date {
  return new Date(sinceMs(arg('--since', argv) ?? '30d'))
}

/** Index rows that started at or after `since`, skipping rows with no usable start. */
function sessionsSince(since: Date): SessionRow[] {
  return loadSessions().filter((s) => Date.parse(s.started) >= since.getTime())
}

/**
 * One read of the ledger and the session index for both renders.
 *
 * The text view and `GET /api/analytics` have to count the same PRs.
 * Loading twice would let a run land between them.
 */
function loadAnalytics(since: Date) {
  const runs = loadRunsSince(since)
  const sessions = sessionsSince(since)
  return {
    rolled: rollup(runs, sessions, since),
    insights: insightsOf({ runs, sessions, since }),
  }
}

/** JSON for `analytics --json` and `GET /api/analytics`. */
function analyticsPayload(since: Date) {
  const { rolled, insights } = loadAnalytics(since)
  return {
    insights,
    jobs: rolled.jobs,
    failCauses: rolled.failCauses,
    skipCauses: rolled.skipCauses,
    rate: rolled.rate,
    total: rolled.total,
    perDay: rolled.perDay,
    since: rolled.since,
  }
}

/** Show which layer chose the chat, so "it went to the wrong place" is answerable. */
function describeDestination(
  chatId: string,
  provenance: NotifyProvenance,
): string {
  const from = provenance.chatId
    ? ` (from ${provenance.chatId})`
    : ' (host default)'
  return `${chatId}${from}`
}

/**
 * `desk watch` — one pass, printed, and nothing else.
 *
 * Fires nothing and writes no state, deliberately. This is the command for
 * answering "what would this watcher see right now", and a dry run that quietly
 * recorded a dedupe key would make the next real poll skip an event just
 * because someone looked at it. It parses the same `parseWatchOutput` the tick
 * uses, so what it prints is what the desk would queue.
 */
async function watchOnce(
  repoArg: string | undefined,
  taskArg: string | undefined,
): Promise<void> {
  const { repo, taskId, watch } = await oneWatchedTask(repoArg, taskArg)
  console.log(`watch ${taskId}  ${repo}`)
  console.log(`  argv  ${watch.command.join(' ')}`)
  const result = await runWatchCommand({ repo, taskId, watch })
  if (result.error) {
    console.log(`  error ${result.error}`)
    process.exit(1)
  }
  if (result.timedOut) {
    console.log(`  timed out after ${watch.timeoutSec}s`)
    process.exit(1)
  }
  console.log(`  exit ${result.code}  ${result.durationMs}ms`)
  if (result.stderr.trim()) {
    for (const line of result.stderr.trim().split('\n'))
      console.log(`  stderr ${line}`)
  }
  const { events, warnings } = parseWatchOutput(result.stdout)
  for (const w of warnings) console.log(`  warning ${w}`)
  console.log(`  ${events.length} event(s), ${warnings.length} warning(s)`)
  for (const e of events) {
    console.log(
      `  - ${e.id}${e.type ? `  ${e.type}` : ''}${e.summary ? `  ${e.summary}` : ''}`,
    )
  }
  // Non-zero when the poll failed, so this is usable as a cron or a check.
  if (result.failure) process.exit(1)
}

/**
 * `desk watch test` — the `notify-test` of this feature.
 *
 * Debugging a watcher at 03:00 from a phone must not mean reading
 * `daemon.log`. Prints what was run, where, how it ended, what it said on
 * stderr, and what the desk made of its output — in that order, because that is
 * the order the questions get asked in. Writes no state, for the same reason
 * `watch` does.
 */
async function watchTest(
  repoArg: string | undefined,
  taskArg: string | undefined,
): Promise<void> {
  const { repo, taskId, watch } = await oneWatchedTask(repoArg, taskArg)
  console.log(`watch test ${taskId}  ${repo}`)
  console.log(`  argv   ${watch.command.join(' ')}`)
  console.log(`  cwd    ${repo}`)
  const result = await runWatchCommand({ repo, taskId, watch })
  console.log(
    result.error
      ? `  error  ${result.error}`
      : result.timedOut
        ? `  timed out after ${watch.timeoutSec}s (killed)`
        : `  exit   ${result.code}  ${result.durationMs}ms`,
  )
  const tail = result.stderr.trim().split('\n').slice(-10)
  console.log('  stderr (tail)')
  for (const line of tail) console.log(`    ${line}`)
  const { events, warnings } = parseWatchOutput(result.stdout)
  console.log(`  events ${events.length}  warnings ${warnings.length}`)
  for (const e of events) {
    console.log(
      `    - ${e.id}${e.type ? `  ${e.type}` : ''}${e.summary ? `  ${e.summary}` : ''}`,
    )
  }
  for (const w of warnings) console.log(`    ! ${w}`)
  if (result.failure) {
    console.log(`  poll failed: ${result.failure}`)
    process.exit(1)
  }
}

/**
 * `desk watch` and its three subcommands.
 *
 * The subcommand form follows `config`/`prompts`/`sessions`: `status` and
 * `reset` are machine-wide reads and writes, and `reset` takes `--task` because
 * a desk with several watchers is the case where it matters.
 */
const WATCH_SUBS = new Set(['status', 'test', 'reset'])

const WATCH_USAGE =
  'usage: herdr-desk watch [--repo DIR] [--task ID] | watch status [--repo DIR] [--task ID] | watch test --repo DIR [--task ID] | watch reset --repo DIR [--task ID]'

/**
 * A watch-family flag's value, or the reason it has none.
 *
 * Every flag in this family *narrows* scope, so a valueless one has to be an
 * error. `arg` answers `undefined` both for "absent" and for "present with
 * nothing after it", and reading those the same way meant `desk watch reset
 * --repo DIR --task` — a flag written to reset one task — reset every watched
 * task in the repo and printed `reset a, b, c` as if that were what was asked
 * for. The next token being another flag counts as valueless too, for the same
 * reason: `--task --repo DIR` is a typo, not a task id.
 */
function watchFlag(
  flag: string,
  argv: string[],
): { value: string | undefined; error: string | null } {
  const i = argv.indexOf(flag)
  if (i === -1) return { value: undefined, error: null }
  const v = argv[i + 1]
  if (v === undefined || v.startsWith('--')) {
    return { value: undefined, error: `${flag} needs a value` }
  }
  return { value: v, error: null }
}

/**
 * Read `--repo` and `--task`, or exit 2 rather than run with a widened scope.
 *
 * `--flag=value` is not a form this CLI parses anywhere, so `--task=local:x`
 * would read as no `--task` at all — and "no filter" is the wide reading. Named
 * here because the failure it produces is silent and the opposite of the intent.
 */
function watchFlags(argv: string[]): {
  repo: string | undefined
  task: string | undefined
} {
  const joined = argv.find((a) => /^--[^=]+=/.test(a))
  const repo = watchFlag('--repo', argv)
  const task = watchFlag('--task', argv)
  const bad = joined
    ? `${joined.split('=')[0]}=<value> is not parsed here; write ${joined.split('=')[0]} <value>`
    : (repo.error ?? task.error)
  if (bad) {
    console.error(`${bad}\n${WATCH_USAGE}`)
    process.exit(2)
  }
  return { repo: repo.value, task: task.value }
}

async function watchCommand(argv: string[]): Promise<void> {
  // `argv[0]` is `watch` itself, so the subcommand is `argv[1]`. A flag there
  // instead (`desk watch --repo DIR`) is the one-pass form, not a subcommand
  // called `--repo`. Anything else that is not a bare flag *is* claimed as a
  // subcommand, and an unknown one is a usage error: falling through to the
  // one-pass form ran a real poll pass and ignored the stray word, so a typo
  // cost a repo script run and told the reader nothing.
  const head = argv[1]
  const sub = head !== undefined && !head.startsWith('--') ? head : undefined
  if (sub !== undefined && !WATCH_SUBS.has(sub)) {
    console.error(`unknown watch subcommand '${sub}'\n${WATCH_USAGE}`)
    process.exit(2)
  }
  const { repo, task } = watchFlags(argv)
  if (sub === undefined) return watchOnce(repo, task)
  if (sub === 'status') {
    const state = loadWatchState()
    const rows = (await watchedRows(repo)).filter(
      (r) => !task || r.taskId === task,
    )
    if (rows.length === 0) {
      console.log(repo ? 'no watched tasks' : 'no watched desks')
      return
    }
    console.log(formatWatchStatus(state, rows))
    return
  }
  if (sub === 'test') return watchTest(repo, task)
  const state = loadWatchState()
  const rows = await watchedRows(repo)
  const targets = task ? rows.filter((r) => r.taskId === task) : rows
  if (targets.length === 0) {
    console.error(
      task ? `no watched task '${task}' to reset` : 'no watched task to reset',
    )
    process.exit(1)
  }
  const now = new Date()
  for (const { repo: r, taskId } of targets) resetTask(state, r, taskId, now)
  saveWatchState(state, now)
  console.log(
    `reset ${targets.map((t) => t.taskId).join(', ')} — pending and dedupe forgotten`,
  )
}

/**
 * Registry of playbooks kept in a GitHub repo.
 *
 * `check` is read-only and safe on a timer: it reports what upstream changed
 * without touching the cache or the lock. `apply` is the only thing that
 * approves, and it refuses changed content unless asked. A repo outside the
 * `allow` list is never fetched at all.
 */
async function promptsCommand(args: string[]): Promise<void> {
  const sub = args[0] ?? 'list'
  const config = loadRegistryConfig()
  const lock = loadRegistryLock()

  if (sub === 'pin') {
    const repo = args[1]
    const ref = args[2]
    if (!repo || !ref) {
      console.log('usage: herdr-desk prompts pin <owner/repo> <commit-sha>')
      process.exit(2)
    }
    if (!config.allow.includes(repo)) {
      console.log(
        `refusing: ${repo} is not in "allow" in ${registryConfigPath()}`,
      )
      process.exit(1)
    }
    const path = registryConfigPath()
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      registries?: Array<Record<string, unknown>>
    }
    const list = Array.isArray(raw.registries) ? raw.registries : []
    const hit = list.find((r) => r.repo === repo)
    if (!hit) {
      console.log(`${repo} is not in "registries" in ${path}`)
      process.exit(1)
    }
    hit.ref = ref
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`)
    console.log(`${repo} pinned to ${ref}`)
    return
  }

  if (sub === 'list') {
    if (config.sources.length === 0) {
      console.log(
        `no registries configured. Add one to ${registryConfigPath()}:\n` +
          '  { "allow": ["owner/repo"], "registries": [{ "repo": "owner/repo", "ref": "main" }] }',
      )
      return
    }
    const rows = config.sources.map((s) => [
      s.repo,
      isAllowed(config, s.repo) ? 'allowed' : 'BLOCKED',
      s.ref,
      lock.repos[s.repo]?.commit.slice(0, 8) ?? '-',
      lock.repos[s.repo]
        ? Object.keys(lock.repos[s.repo].files).map(playbookName).join(', ')
        : '(not approved)',
    ])
    console.log(
      textTable(['REGISTRY', 'ALLOW', 'REF', 'APPROVED', 'PLAYBOOKS'], rows),
    )
    return
  }

  if (sub !== 'check' && sub !== 'apply') {
    console.log(
      'usage: herdr-desk prompts list | check | apply [--accept] | pin REPO SHA',
    )
    process.exit(2)
  }

  const accept = args.includes('--accept')
  const diffs: Diff[] = []
  for (const source of config.sources) {
    if (!isAllowed(config, source.repo)) {
      console.log(`skip ${source.repo}: not in "allow"`)
      continue
    }
    const commit = await resolveCommit(ghCommand, source.repo, source.ref)
    const files = await fetchPlaybooks(ghCommand, source.repo, commit)
    const entry = lock.repos[source.repo]
    diffs.push(
      diffRepo({
        repo: source.repo,
        ref: source.ref,
        fromCommit: entry?.commit ?? null,
        from: approvedContent(source.repo, entry),
        to: files,
        toCommit: commit,
      }),
    )
  }
  if (diffs.length === 0) {
    console.log('nothing to check — no allowed registries configured')
    return
  }

  for (const diff of diffs) {
    const moved = diff.fromCommit !== diff.toCommit
    console.log(
      `\n${diff.repo}  ${diff.ref}  ${diff.fromCommit?.slice(0, 8) ?? '(new)'} -> ${diff.toCommit.slice(0, 8)}${moved ? '' : '  (same commit)'}`,
    )
    console.log(
      textTable(
        ['PLAYBOOK', 'CHANGE', 'SHA256'],
        diff.changes.map((c) => [
          playbookName(c.path),
          c.change,
          (c.to ?? c.from ?? '').slice(0, 12),
        ]),
      ),
    )
  }

  if (sub === 'check') {
    const dirty = diffs.filter(needsAccept)
    console.log(
      dirty.length
        ? '\nrun `herdr-desk prompts apply --accept` to approve these changes'
        : '\nnothing changed',
    )
    return
  }

  const dirty = diffs.filter(needsAccept)
  if (dirty.length && !accept) {
    console.log(
      '\nrefusing to apply changed content without --accept.\n' +
        'Review the diff above, then re-run with --accept.',
    )
    process.exit(1)
  }
  for (const diff of diffs) {
    if (!needsAccept(diff) && lock.repos[diff.repo]) continue
    const files = await fetchPlaybooks(ghCommand, diff.repo, diff.toCommit)
    writeCache(diff.repo, diff.toCommit, files)
  }
  approve(diffs)
  console.log(
    `\napproved ${diffs.length} registry(ies) at ${diffs.map((d) => d.toCommit.slice(0, 8)).join(', ')}`,
  )
}

async function main() {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  if (!cmd || cmd === '-h' || cmd === '--help') usage()

  if (cmd === 'tasks') {
    for (const t of listBundledTasks()) console.log(t)
    // `listRegistryTasks` already returns full `gh:` specs.
    for (const t of listRegistryTasks()) console.log(t)
    return
  }

  if (cmd === 'scan') {
    // Reports the repos it could not read, not just the ones that loaded: `scan`
    // is what a person runs to answer "is this repo even being read", so a repo
    // missing from it with no error is the #97 shape all over again.
    const { desks, failed } = await discoverAll()
    console.log(formatScan(desks, failed))
    return
  }

  if (cmd === 'config') {
    const sub = argv[1]
    const repo = resolve(arg('--repo', argv) ?? process.cwd())
    if (sub === 'explain') {
      console.log(explainConfig(repo))
      if (argv.includes('--tasks')) console.log(`\n${explainTasks(repo)}`)
      return
    }
    if (sub === 'show' || sub === undefined) {
      console.log(showConfig(repo))
      return
    }
    usage()
  }

  if (cmd === 'validate') {
    const { desks, failed } = await discoverAll()
    const problems: string[] = []
    for (const d of desks) {
      const desk = loadDeskConfig(d.repo)
      // A `gh:` playbook that is not approved is a config error the schema
      // cannot see: the string is perfectly valid, it just resolves to
      // nothing. Reporting it here is the difference between a warning now and
      // a job that fails at 07:00 because nobody ran `prompts apply`.
      problems.push(
        ...unapprovedPlaybooks(desk.tasks).map((p) => `${desk.name}: ${p}`),
      )
    }
    // A repo that failed to load is the loudest thing this command can say, and
    // it exits non-zero: before #97 a broken config was simply not visited here,
    // so `validate` reported `0 errors` over a desk that was not being read.
    for (const f of failed) {
      problems.push(`${f.repo}: ${f.error.replace(/\n/g, '\n  ')}`)
    }
    if (problems.length) {
      console.error(problems.join('\n'))
      process.exit(1)
    }
    console.log(`schema: ${SCHEMA_URL}`)
    console.log(`local:  ${SCHEMA_PATH}`)
    console.log(`0 errors, ${desks.length} desk(s)`)
    return
  }

  if (cmd === 'status') {
    const pid = daemonPid()
    const { desks, failed } = await discoverAll()
    console.log(`daemon: ${pid ? `running (pid ${pid})` : 'stopped'}`)
    console.log(formatSchedule(desks, new Date(), loadPaused()))
    // A count, not a table: `status` is what a phone notification carries, and
    // the per-repo detail is one command away in `scan`. A desk that is not
    // being read at all is otherwise a healthy machine doing nothing.
    if (failed.length) {
      console.log(
        `${failed.length} desk(s) skipped: unreadable config (desk scan)`,
      )
    }
    return
  }

  if (cmd === 'agenda') {
    const n = Number(argv[1])
    const days = Number.isInteger(n) && n > 0 && n <= 7 ? n : 7
    console.log(
      formatAgenda(await discoverDesks(), new Date(), days, loadPaused()),
    )
    return
  }

  if (cmd === 'next') {
    const n = Number(argv[1])
    const count = Number.isInteger(n) && n > 0 ? Math.min(n, 100) : 5
    console.log(
      formatNext(await discoverDesks(), count, new Date(), loadPaused()),
    )
    return
  }

  if (cmd === 'pause' || cmd === 'resume') {
    const all = argv.includes('--all')
    const repo = resolve(arg('--repo', argv) ?? process.cwd())
    const until = arg('--until', argv)
    const skip = new Set([arg('--repo', argv), until])
    const job = argv.slice(1).find((a) => !a.startsWith('--') && !skip.has(a))
    if (!all && !job) {
      console.log(
        `usage: herdr-desk ${cmd} JOB|--all [--repo DIR]${cmd === 'pause' ? ' [--until DATE]' : ''}`,
      )
      process.exit(2)
    }
    if (job && !all) resolveTask(loadDeskConfig(repo), job) // unknown job -> error
    const target = all ? 'all' : pauseKey(repo, job as string)
    const state = loadPaused()
    if (cmd === 'pause') {
      const next = withPause(
        state,
        target,
        until ? parseUntil(until) : undefined,
      )
      savePaused(next)
      const entry = target === 'all' ? next.all : next.jobs[target]
      console.log(`${all ? 'all jobs' : job}: ${describePause(entry ?? {})}`)
      return
    }
    const next = withoutPause(state, target)
    savePaused(next)
    console.log(`${all ? 'all jobs' : job}: resumed`)
    if (!all && next.all) {
      console.log('note: all jobs are still paused (herdr-desk resume --all)')
    }
    return
  }

  if (cmd === 'trigger') {
    const repo = resolve(arg('--repo', argv) ?? process.cwd())
    const job = argv
      .slice(1)
      .find((a) => !a.startsWith('--') && a !== arg('--repo', argv))
    console.log(
      JSON.stringify(await runTask({ repo, taskId: job, trigger: 'manual' })),
    )
    return
  }

  if (cmd === 'watch') {
    await watchCommand(argv)
    return
  }

  if (cmd === 'cleanup') {
    const dryRun = argv.includes('--dry-run')
    const desks = (await discoverDesks()).map((d) => ({
      repo: d.repo,
      tasks: d.config.tasks,
    }))
    const plan = await planCleanup(desks)
    console.log(formatCleanup(plan, dryRun))
    if (dryRun) return
    const result = await applyCleanup(plan)
    console.log(formatResult(result))
    if (result.failed.length > 0) process.exit(1)
    return
  }

  if (cmd === 'timeline') {
    console.log(
      formatTimeline(
        await discoverDesks(),
        termOpts(),
        new Date(),
        7,
        loadPaused(),
      ),
    )
    return
  }

  if (cmd === 'heatmap') {
    if (argv.includes('--actual')) {
      const since = sinceArg(argv)
      const dates = loadRunsSince(since).map((r) => new Date(r.at))
      console.log(
        formatHeatmap(
          heatOf(dates),
          termOpts(),
          `actual fires since ${since.toISOString().slice(0, 10)}`,
        ),
      )
      return
    }
    const fires = upcomingFires(
      await discoverDesks(),
      new Date(),
      7,
      loadPaused(),
    )
    console.log(
      formatHeatmap(
        heatOf(fires.map((f) => f.at)),
        termOpts(),
        'scheduled fires, next 7 days',
      ),
    )
    return
  }

  if (cmd === 'analytics') {
    const since = sinceArg(argv)
    if (argv.includes('--json')) {
      console.log(JSON.stringify(analyticsPayload(since), null, 2))
      return
    }
    const { rolled, insights } = loadAnalytics(since)
    // Runs and failures are the next line. This one is only the counts
    // that line does not have: sessions, agents, pull URLs.
    const counts = countParts(insights.counts, [
      'sessions',
      'agents',
      'prs',
    ]).join(' · ')
    if (counts) console.log(counts)
    console.log(formatAnalytics(rolled, termOpts(), argv.includes('--wide')))
    return
  }

  if (cmd === 'calendar') {
    const ics = toIcs(
      upcomingFires(await discoverDesks(), new Date(), 7, loadPaused()),
    )
    const file = arg('--ics', argv)
    if (argv.includes('--ics')) {
      if (!file || file.startsWith('--')) usage()
      writeFileSync(resolve(file), ics)
      console.log(`wrote ${resolve(file)}`)
      return
    }
    process.stdout.write(ics)
    return
  }

  if (cmd === 'board') {
    if (!argv.includes('--html')) usage()
    const next = arg('--html', argv)
    const file = resolve(
      next && !next.startsWith('--')
        ? next
        : join(pluginStateDir(), 'board.html'),
    )
    const now = new Date()
    const since = sinceArg(argv)
    const sessions = sessionsSince(since)
    const html = formatBoard({
      now,
      days: 7,
      fires: upcomingFires(await discoverDesks(), now, 7, loadPaused()),
      runs: loadRuns(40),
      rollup: rollup(loadRunsSince(since), sessions, since, now),
      sessions,
    })
    writeFileSync(file, html)
    console.log(`wrote ${file}`)
    return
  }

  if (cmd === 'history') {
    const n = Number(argv[1])
    console.log(formatHistory(loadRuns(Number.isFinite(n) && n > 0 ? n : 40)))
    return
  }

  if (cmd === 'sessions') {
    if (argv[1] === 'index') {
      console.log(formatIndexStats(indexSessions()))
      return
    }
    const sinceText = arg('--since', argv)
    const since = sinceText ? sinceMs(sinceText) : undefined
    const repo = arg('--repo', argv)
    const rows = filterSessions(loadSessions(), {
      repo: repo ? resolve(repo) : undefined,
      agent: arg('--agent', argv),
      since,
    })
    console.log(formatSessions(rows))
    return
  }

  if (cmd === 'context') {
    const repo = arg('--repo', argv)
    if (!repo) usage()
    indexSessions()
    const { path, text } = writeContext(resolve(repo), loadSessions())
    console.log(`${path}\n\n${text}`)
    return
  }

  if (cmd === 'last') {
    console.log(await readLastChanges())
    return
  }

  if (cmd === 'start') {
    const r = startDaemon()
    console.log(
      r.updating
        ? 'not started: an update is in progress'
        : r.already
          ? `already running (pid ${r.pid})`
          : `started pid ${r.pid}`,
    )
    return
  }

  if (cmd === 'stop') {
    console.log(stopDaemon() ? 'stopped' : 'not running')
    return
  }

  if (cmd === 'daemon') {
    await runDaemon()
    return
  }

  if (cmd === 'tick') {
    const n = await tickOnce()
    console.log(`fired ${n}`)
    return
  }

  if (cmd === 'on-focus') {
    await discoverDesks()
    const r = startDaemon()
    console.log(
      r.updating
        ? 'not started: an update is in progress'
        : r.already
          ? `daemon pid ${r.pid}`
          : `started pid ${r.pid}`,
    )
    return
  }

  if (cmd === 'notify') {
    const repo = resolve(arg('--repo', argv) ?? process.cwd())
    const label = arg('--label', argv)
    const url = arg('--url', argv)
    const message = argv
      .slice(1)
      .filter(
        (a) =>
          !a.startsWith('--') &&
          a !== arg('--repo', argv) &&
          a !== arg('--label', argv) &&
          a !== arg('--url', argv),
      )
      .join(' ')
    // Same layered resolution a real run uses, so testing delivery also proves
    // the destination is the one a run would pick.
    const { config: notifyConfig, provenance } = resolveNotify({ repo })
    const r = await notify({ message, repo, label, url }, notifyConfig)
    const who = `${r.repo} · ${r.machine}`
    if (r.sent) {
      console.log(
        `sent ${who} to ${describeDestination(notifyConfig.chatId, provenance)}`,
      )
    } else {
      // `reason` is already token-redacted by notify().
      console.log(`not sent (${r.reason}) ${who}`)
    }
    return
  }

  if (cmd === 'report') {
    const repo = resolve(arg('--repo', argv) ?? process.cwd())
    const day = arg('--day', argv) ?? dayKey()
    const settle = Number(arg('--settle', argv) ?? 0)
    const dryRun = argv.includes('--dry-run')
    const force = argv.includes('--force')

    if (Number.isFinite(settle) && settle > 0) {
      // Jobs on one repo finish at their own pace. Waiting briefly before
      // reading the fragments is what turns four simultaneous finishes into one
      // notice instead of four, and the fingerprint below keeps whichever one
      // wins from sending the same thing twice.
      await Bun.sleep(Math.min(settle, 300) * 1000)
    }

    const groups = collectReports({ repo, day })
    if (groups.length === 0) {
      console.log(`no job wrote ${REPORT_FILE} for ${day} in ${repo}`)
      return
    }
    // The desk name goes to the hub so a job is identifiable there by the name
    // the config uses, rather than by a directory basename the manager never
    // saw.
    let desk: string | undefined
    try {
      desk = loadDeskConfig(repo).name
    } catch {
      // `collectReports` already threw on a bad config, so this only fails if
      // the config changed underneath us. The report is still worth sending.
    }
    const outcomes = await sendReports({
      repo,
      groups,
      day,
      desk,
      force,
      dryRun,
    })
    for (const o of outcomes) {
      if (dryRun) console.log(`${o.body}\n`)
      console.log(
        o.sent
          ? `sent ${o.jobs} job(s) to Telegram`
          : `not sent (${o.reason}) ${o.jobs} job(s)`,
      )
    }
    return
  }

  if (cmd === 'summary') {
    const repoArg = arg('--repo', argv)
    const repo = resolve(repoArg ?? process.cwd())

    const sendPath = arg('--send', argv)
    if (sendPath) {
      // The agent's prose is not MarkdownV2. It goes through `noticeBody`,
      // which escapes every line, so a `_` or `*` in it cannot 400 the notice.
      const lines = readFileSync(resolve(sendPath), 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
      const { config: dest } = resolveNotify({ repo })
      const r = await notify(
        {
          message: noticeBody({
            level: 'info',
            headline: lines[0] ?? 'summary',
            items: lines.slice(1),
            tags: ['desk', 'summary'],
          }),
          repo,
          label: 'summary',
        },
        dest,
      )
      console.log(r.sent ? 'sent summary' : `not sent (${r.reason})`)
      return
    }

    const now = new Date()
    const since = new Date(sinceMs(arg('--since', argv) ?? '1d'))
    // The routing desk: `--repo`, or the cwd. Not a desk is a loud failure,
    // never a guess at some other repo on the machine.
    const config = loadDeskConfig(repo)
    const routedRepo = config.repo ?? repo
    // Without `--repo` the summary covers the whole machine; with it, only
    // that repo — matched on the resolved path `recordRun` stores.
    const desks = repoArg
      ? [{ repo: routedRepo, config }]
      : (await discoverDesks()).map((d) => ({
          repo: d.config.repo ?? d.repo,
          config: d.config,
        }))
    const input = summaryInput({
      runs: runsSince(since, repoArg ? routedRepo : undefined),
      desks,
      since,
      now,
    })
    const outPath = summaryOutPath(now)
    const prompt = buildSummaryPrompt({
      input,
      scope: repoArg ? config.name : 'every desk on this machine',
      since,
      now,
      outPath,
      notifyRepo: argv.includes('--notify') ? routedRepo : undefined,
    })
    if (argv.includes('--dry-run')) {
      console.log(prompt)
      return
    }
    const r = await handToAgent({ config, repo: routedRepo, prompt })
    console.log(`${r.how} ${r.agent}; summary will be written to ${outPath}`)
    return
  }

  if (cmd === 'hub') {
    const send = argv.includes('--send')
    const force = argv.includes('--force')
    if (argv.includes('--json')) {
      // Machine-readable, for anything that wants to render this itself.
      console.log(JSON.stringify(snapshot(), null, 2))
      return
    }
    if (!send) {
      console.log(formatHub(snapshot()))
      return
    }
    // The host destination, like every other machine-level notice: the hub is
    // about the machine, so a repo's committed config must not retarget where
    // the whole machine reports to.
    const result = await publish({ dest: loadNotifyConfig(), force })
    console.log(result.body)
    console.log(
      result.sent ? '\nsent to Telegram' : `\nnot sent (${result.reason})`,
    )
    return
  }

  if (cmd === 'dash') {
    const d = collect()
    if (argv.includes('--no-color')) d.plain = true
    if (argv.includes('--json')) {
      console.log(JSON.stringify(dashboardJson(d), null, 2))
      return
    }
    console.log(render(d))
    return
  }

  if (cmd === 'serve') {
    const portText = arg('--port', argv)
    const port = argv.includes('--port') ? Number(portText) : 8787
    if (!Number.isInteger(port) || port < 1 || port > 65535) usage()
    const explicit = arg('--host', argv)
    // `--host` pins one address. Otherwise listen on localhost, and on this
    // node's Tailscale addresses when `tailscale status` says it is online.
    const tailnet = explicit ? null : await detectTailnet()
    const deps = {
      dashboard: () => collect(),
      analytics: (sinceText: string) =>
        analyticsPayload(new Date(parseSince(sinceText))),
    }
    const bound: string[] = []
    for (const hostname of bindHosts(explicit, tailnet)) {
      try {
        serve({ port, hostname, deps })
        bound.push(hostname)
      } catch (err) {
        if (bound.length === 0) throw err
        const message = err instanceof Error ? err.message : String(err)
        console.error(`not bound ${hostname}: ${message}`)
      }
    }
    for (const url of dashboardUrls(port, bound, tailnet)) {
      console.log(`desk ${url}`)
    }
    return
  }

  if (cmd === 'prompts') {
    await promptsCommand(argv.slice(1))
    return
  }

  if (cmd === 'update') {
    const check = await checkForUpdate()
    saveLastCheck(new Date(), `manual ${check.installed} -> ${check.latest}`)
    const what = `${check.installed} -> ${check.latest}`
    const showChanges = () => {
      for (const line of check.changes ?? []) console.log(`  ${line}`)
    }
    if (!check.newer) {
      console.log(
        `already current (${check.installed}, latest ${check.latest})`,
      )
      return
    }
    if (argv.includes('--check')) {
      console.log(
        `update available ${what}${check.blocked ? ` (not applicable: ${check.blocked})` : ''}`,
      )
      showChanges()
      return
    }
    if (check.blocked) {
      console.log(`update available ${what}, refusing: ${check.blocked}`)
      showChanges()
      process.exit(1)
    }
    showChanges()
    // Stop, then install, then start: installing under a running daemon leaves
    // it reading files that are being replaced.
    takeUpdateLock()
    stopDaemon()
    const startPlugin = () => {
      // Release first: the start action itself honours the lock.
      releaseUpdateLock()
      return Bun.spawnSync(
        [defaultHerdrBin(), 'plugin', 'action', 'invoke', 'herdr-desk.start'],
        { stdout: 'pipe', stderr: 'pipe' },
      )
    }
    try {
      await reinstall(check.source)
    } catch (err) {
      // Bring the old daemon back so scheduled jobs keep firing.
      startPlugin()
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
    const start = startPlugin()
    if (start.exitCode !== 0) {
      console.error(
        `updated ${what}, but restart failed: ${start.stderr.toString().trim()}`,
      )
      process.exit(1)
    }
    console.log(`updated ${what}`)
    return
  }

  if (cmd === 'uninstall-cron' || cmd === 'uninstall') {
    stripAllDeskCrons()
    console.log(
      'removed host crontab blocks (plugin daemon is the scheduler now)',
    )
    return
  }

  if (cmd === 'run') {
    const repo = resolve(arg('--repo', argv) ?? process.cwd())
    const rest = argv
      .slice(1)
      .filter((a) => !a.startsWith('--') && a !== arg('--repo', argv))
    const taskId = rest[0]
    console.log(JSON.stringify(await runTask({ repo, taskId })))
    return
  }

  if (cmd === 'list') {
    const repo = resolve(arg('--repo', argv) ?? process.cwd())
    if (arg('--repo', argv)) {
      const cfg = loadDeskConfig(repo)
      console.log(`${cfg.name}  ${repo}`)
      for (const t of cfg.tasks) {
        console.log(`  ${t.id}\t${t.agentName}\t${scheduleLabel(t.crons)}`)
      }
      return
    }
    // Same reporting as `scan`: this renders the same list, so a repo missing
    // from it should say why in both places rather than only one.
    const { desks, failed } = await discoverAll()
    console.log(formatScan(desks, failed))
    return
  }

  usage()
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
