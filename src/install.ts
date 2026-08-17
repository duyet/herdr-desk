import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DESK_ROOT, loadDeskConfig, type TaskConfig } from './config'

const BEGIN = (name: string) => `# BEGIN herdr-desk:${name}`
const END = (name: string) => `# END herdr-desk:${name}`

function crontabNow(): string {
  const proc = Bun.spawnSync(['crontab', '-l'], { stdout: 'pipe', stderr: 'pipe' })
  return proc.exitCode === 0 ? proc.stdout.toString() : ''
}

function writeCrontab(text: string) {
  const proc = Bun.spawnSync(['crontab', '-'], {
    stdin: Buffer.from(text.endsWith('\n') ? text : `${text}\n`),
    stderr: 'pipe',
  })
  if (proc.exitCode !== 0) {
    throw new Error(`crontab install failed: ${proc.stderr.toString()}`)
  }
}

function stripBlock(src: string, name: string): string {
  const begin = BEGIN(name)
  const end = END(name)
  const lines = src.split('\n')
  const out: string[] = []
  let skip = false
  for (const line of lines) {
    if (line === begin) {
      skip = true
      continue
    }
    if (line === end) {
      skip = false
      continue
    }
    if (!skip) out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
}

function stripLegacy(src: string): string {
  return src
    .split('\n')
    .filter((line) => !line.includes('chmonitor-issue-desk'))
    .filter((line) => !line.includes('anyrouter-morning-worktree.sh'))
    .join('\n')
}

function stripNamedLegacy(src: string): string {
  let next = src
  for (const name of ['anyrouter-herdr-daily']) {
    const begin = `# BEGIN ${name}`
    const end = `# END ${name}`
    const lines = next.split('\n')
    const out: string[] = []
    let skip = false
    for (const line of lines) {
      if (line === begin) {
        skip = true
        continue
      }
      if (line === end) {
        skip = false
        continue
      }
      if (!skip) out.push(line)
    }
    next = out.join('\n')
  }
  return next
}

function bunBin(): string {
  return process.env.BUN_BIN ?? Bun.which('bun') ?? `${homedir()}/.bun/bin/bun`
}

function lineFor(
  repo: string,
  task: TaskConfig,
  mode: 'morning' | 'nightly',
  log: string,
): string | null {
  const spec = task.schedule?.[mode]
  if (!spec) return null
  const cli = join(DESK_ROOT, 'src', 'cli.ts')
  const cmd = `${bunBin()} ${cli} run ${task.id} --repo ${repo} --${mode}`
  return `${spec} ${cmd} >>${log} 2>&1`
}

export function installRepo(repo: string): string {
  const config = loadDeskConfig(repo)
  const logDir = join(homedir(), '.local', 'logs', 'herdr-desk', config.name)
  mkdirSync(logDir, { recursive: true })
  const log = join(logDir, 'cron.log')

  let current = stripNamedLegacy(stripLegacy(stripBlock(crontabNow(), config.name)))
  const lines: string[] = [BEGIN(config.name)]
  for (const task of config.tasks) {
    const morning = lineFor(repo, task, 'morning', log)
    const nightly = lineFor(repo, task, 'nightly', log)
    if (morning) lines.push(morning)
    if (nightly) lines.push(nightly)
  }
  lines.push(END(config.name))
  if (lines.length === 2) {
    throw new Error(`${config.name}: no task has a schedule`)
  }
  writeCrontab(`${current}\n\n${lines.join('\n')}\n`)
  return lines.join('\n')
}

export function uninstallRepo(repo: string): void {
  const config = loadDeskConfig(repo)
  writeCrontab(`${stripBlock(crontabNow(), config.name)}\n`)
}
