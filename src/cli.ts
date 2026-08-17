#!/usr/bin/env bun

import { resolve } from 'node:path'
import {
  findConfigPath,
  listBundledTasks,
  loadDeskConfig,
} from './config'
import { installRepo, uninstallRepo } from './install'
import { runTask } from './run'

function usage(): never {
  console.log(`herdr-desk — scheduled Herdr manager (config lives in the target repo)

  herdr-desk list [--repo DIR]
  herdr-desk tasks
  herdr-desk run [TASK] --repo DIR --morning|--nightly
  herdr-desk install --repo DIR
  herdr-desk uninstall --repo DIR
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

  const repo = resolve(arg('--repo', argv) ?? process.cwd())

  if (cmd === 'tasks') {
    for (const t of listBundledTasks()) console.log(t)
    return
  }

  if (cmd === 'list') {
    const path = findConfigPath(repo)
    if (!path) {
      console.log(`no config in ${repo}`)
      process.exit(1)
    }
    const cfg = loadDeskConfig(repo)
    console.log(`${cfg.name}  ${path}`)
    for (const t of cfg.tasks) {
      console.log(
        `  ${t.id}\t${t.task}\t${t.agentName}\tmorning=${t.schedule?.morning ?? '-'}\tnightly=${t.schedule?.nightly ?? '-'}`,
      )
    }
    return
  }

  if (cmd === 'install') {
    console.log(installRepo(repo))
    return
  }

  if (cmd === 'uninstall') {
    uninstallRepo(repo)
    console.log(`removed crontab block for ${repo}`)
    return
  }

  if (cmd === 'run') {
    const rest = argv.slice(1).filter((a) => !a.startsWith('--') && a !== arg('--repo', argv))
    const taskId = rest[0]
    const mode = has('--nightly', argv) ? 'nightly' : 'morning'
    if (!has('--morning', argv) && !has('--nightly', argv)) {
      usage()
    }
    const result = await runTask({ repo, taskId, mode })
    console.log(JSON.stringify(result))
    return
  }

  usage()
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
