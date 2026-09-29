const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }

/** `30m`, `12h`, `7d`, `2w` -> epoch ms that long before `now`. Throws on anything else. */
export function parseSince(text: string, now = Date.now()): number {
  const m = /^(\d+)([mhdw])$/.exec(text.trim())
  if (!m) throw new Error(`bad --since ${text}: use e.g. 30m, 12h, 7d, 2w`)
  return now - Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS]
}
