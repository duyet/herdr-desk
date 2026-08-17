#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { applyDefaults } from '../src/defaults'
import { DESK_ROOT } from '../src/config'
import { validateDeskJson } from '../src/schema'

function check(file: string): string[] {
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  const errors = validateDeskJson(raw, file)
  if (errors.length) return errors
  applyDefaults(raw, DESK_ROOT)
  return []
}

const files: string[] = []
const examples = join(DESK_ROOT, 'examples')
for (const name of readdirSync(examples)) {
  const dir = join(examples, name)
  if (!statSync(dir).isDirectory()) continue
  const file = join(dir, '.herdr-desk.json')
  if (!existsSync(file)) {
    console.error(`missing ${file}`)
    process.exit(1)
  }
  files.push(file)
}

const root = join(DESK_ROOT, '.herdr-desk.json')
if (existsSync(root)) files.push(root)

let failed = 0
for (const file of files) {
  const errors = check(file)
  if (errors.length) {
    failed++
    console.error(`FAIL ${file}`)
    for (const e of errors) console.error(`  ${e}`)
  } else {
    console.log(`ok   ${file.slice(DESK_ROOT.length + 1)}`)
  }
}

if (failed) {
  console.error(`${failed} invalid`)
  process.exit(1)
}
console.log(`${files.length} ok`)
