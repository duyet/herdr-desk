#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { listBundledTasks, loadDeskConfig } from './config'
import { explainConfig, explainTasks, showConfig } from './configShow'
import {
  daemonPid,
  runDaemon,
  startDaemon,
  stopDaemon,
  tickOnce,
} from './daemon'
import { dayKey } from './day'
import { discoverDesks, formatScan } from './discover'
import { formatHistory, loadRuns } from './history'
import { formatHub, publish, snapshot } from './hub'
import { stripAllDeskCrons } from './install'
import { readLastChanges } from './last'
import {
  loadNotifyConfig,
  type NotifyProvenance,
  notify,
  resolveNotify,
} from './notify'
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
import { formatSchedule } from './status'
import { textTable } from './table'

function usage(): never {
  console.log(`herdr-desk — Herdr plugin. Each repo is .herdr-desk.json; the daemon picks them up.

  herdr-desk scan
  herdr-desk validate
  herdr-desk config show   [--repo DIR]
  herdr-desk config explain [--repo DIR] [--tasks]
  herdr-desk status
  herdr-desk history [N]
  herdr-desk last
  herdr-desk start | stop | daemon
  herdr-desk tick
  herdr-desk on-focus
  herdr-desk run [JOB] --repo DIR
  herdr-desk tasks
  herdr-desk notify MESSAGE [--repo DIR] [--label TEXT]
  herdr-desk report --repo DIR [--settle SECONDS] [--dry-run] [--force]
  herdr-desk hub [--send] [--json] [--force]
  herdr-desk prompts list | check | apply [--accept] | pin REPO SHA
  herdr-desk uninstall-cron
`)
  process.exit(2)
}

function arg(flag: string, argv: string[]): string | undefined {
  const i = argv.indexOf(flag)
  if (i === -1) return undefined
  return argv[i + 1]
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
    console.log(formatScan(await discoverDesks()))
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
    const desks = await discoverDesks()
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
    console.log(`daemon: ${pid ? `running (pid ${pid})` : 'stopped'}`)
    console.log(formatSchedule(await discoverDesks()))
    return
  }

  if (cmd === 'history') {
    const n = Number(argv[1])
    console.log(formatHistory(loadRuns(Number.isFinite(n) && n > 0 ? n : 40)))
    return
  }

  if (cmd === 'last') {
    console.log(await readLastChanges())
    return
  }

  if (cmd === 'start') {
    const r = startDaemon()
    console.log(
      r.already ? `already running (pid ${r.pid})` : `started pid ${r.pid}`,
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
    console.log(r.already ? `daemon pid ${r.pid}` : `started pid ${r.pid}`)
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

  if (cmd === 'prompts') {
    await promptsCommand(argv.slice(1))
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
    console.log(formatScan(await discoverDesks()))
    return
  }

  usage()
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
