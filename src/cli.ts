#!/usr/bin/env bun

import { resolve } from 'node:path'
import { listBundledTasks, loadDeskConfig } from './config'
import { daemonPid, runDaemon, startDaemon, stopDaemon, tickOnce } from './daemon'
import { discoverDesks, formatScan } from './discover'
import { formatHistory, loadRuns, appendRun } from './history'
import { stripAllDeskCrons } from './install'
import { runTask } from './run'
import { formatSchedule } from './status'

function usage(): never {
  console.log(`herdr-desk — Herdr plugin. Each repo is .herdr-desk.json; the daemon picks them up.

  herdr-desk scan
  herdr-desk validate
  herdr-desk status
  herdr-desk history [N]
  herdr-desk last
  herdr-desk start | stop | daemon
  herdr-desk tick
  herdr-desk on-focus
  herdr-desk run [TASK] --repo DIR --morning|--nightly
  herdr-desk tasks
  herdr-desk uninstall-cron
`)
  process.exit(2)
}

function arg(flag: string, argv: string[]): string | undefined {
  const i = argv.indexOf(flag)
  if (i === -1) return undefined
  return argv[i + 1]
}

function has(flag: string, argv: string[]): boolean {
  return argv.includes(flag)
}

async function main() {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  if (!cmd || cmd === '-h' || cmd === '--help') usage()

  if (cmd === 'tasks') {
    for (const t of listBundledTasks()) console.log(t)
    return
  }

  if (cmd === 'scan') {
    console.log(formatScan(await discoverDesks()))
    return
  }

  if (cmd === 'validate') {
    const desks = await discoverDesks()
    for (const d of desks) loadDeskConfig(d.repo)
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
    const { readLastChanges } = await import('./last')
    console.log(await readLastChanges())
    return
  }

  if (cmd === 'start') {
    const r = startDaemon()
    console.log(r.already ? `already running (pid ${r.pid})` : `started pid ${r.pid}`)
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

  if (cmd === 'uninstall-cron' || cmd === 'uninstall') {
    stripAllDeskCrons()
    console.log('removed host crontab blocks (plugin daemon is the scheduler now)')
    return
  }

  if (cmd === 'run') {
    const repo = resolve(arg('--repo', argv) ?? process.cwd())
    const rest = argv
      .slice(1)
      .filter((a) => !a.startsWith('--') && a !== arg('--repo', argv))
    const taskId = rest[0]
    const mode = has('--nightly', argv) ? 'nightly' : 'morning'
    if (!has('--morning', argv) && !has('--nightly', argv)) usage()
    try {
      const result = await runTask({ repo, taskId, mode })
      appendRun({
        at: new Date().toISOString(),
        name: loadDeskConfig(repo).name,
        repo,
        task: taskId ?? loadDeskConfig(repo).tasks[0]?.id ?? 'issues',
        mode,
        ok: true,
        detail: JSON.stringify(result),
      })
      console.log(JSON.stringify(result))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      appendRun({
        at: new Date().toISOString(),
        name: loadDeskConfig(repo).name,
        repo,
        task: taskId ?? 'issues',
        mode,
        ok: false,
        detail: msg,
      })
      throw err
    }
    return
  }

  if (cmd === 'list') {
    const repo = resolve(arg('--repo', argv) ?? process.cwd())
    if (arg('--repo', argv)) {
      const cfg = loadDeskConfig(repo)
      console.log(`${cfg.name}  ${repo}`)
      for (const t of cfg.tasks) {
        console.log(
          `  ${t.id}\t${t.agentName}\tmorning=${t.schedule?.morning ?? '-'}\tnightly=${t.schedule?.nightly ?? '-'}`,
        )
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
