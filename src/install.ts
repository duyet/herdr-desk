/** Host crontab leftovers from the pre-plugin CLI. */

function crontabNow(): string {
  const proc = Bun.spawnSync(['crontab', '-l'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return proc.exitCode === 0 ? proc.stdout.toString() : ''
}

function writeCrontab(text: string) {
  const proc = Bun.spawnSync(['crontab', '-'], {
    stdin: Buffer.from(text.endsWith('\n') ? text : `${text}\n`),
    stderr: 'pipe',
  })
  if (proc.exitCode !== 0) {
    throw new Error(`crontab update failed: ${proc.stderr.toString()}`)
  }
}

function stripBlocks(src: string): string {
  const names = ['chmonitor', 'anyrouter']
  let next = src
  for (const name of names) {
    const begin = `# BEGIN herdr-desk:${name}`
    const end = `# END herdr-desk:${name}`
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
    .split('\n')
    .filter((line) => !line.includes('chmonitor-issue-desk'))
    .filter((line) => !line.includes('anyrouter-herdr-daily'))
    .filter((line) => !line.includes('anyrouter-morning-worktree.sh'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
}

export function stripAllDeskCrons(): void {
  writeCrontab(`${stripBlocks(crontabNow())}\n`)
}
