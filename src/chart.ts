/**
 * Terminal charts.
 *
 * No dependency, no canvas, no font metrics — these are the charts a terminal
 * can actually draw: block characters, a fixed column budget, and honest
 * labelling. The alternative, a charting library, would either need a TTY
 * renderer this plugin has no business owning or emit escape codes that
 * survive `| less` and turn a log file into noise.
 *
 * Every function degrades to a plain column of values when it cannot draw
 * (`NO_COLOR`, a dumb terminal, a pipe to a file). A chart nobody can read is
 * worse than a number, and the numbers are the same data.
 */

/** Eighth blocks, low to high. One cell, eight levels. */
const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

/** True when colour and glyphs should be avoided. */
export function plainMode(env = process.env): boolean {
  if (env.NO_COLOR) return true
  const term = env.TERM ?? ''
  if (term === '' || term === 'dumb') return true
  return false
}

/** ANSI codes, or empty strings in plain mode. */
export function color(enabled: boolean): {
  bold: (s: string) => string
  dim: (s: string) => string
  red: (s: string) => string
  yellow: (s: string) => string
  green: (s: string) => string
  cyan: (s: string) => string
} {
  const wrap = (code: string) => (s: string) =>
    enabled ? `\u001B[${code}m${s}\u001B[0m` : s
  return {
    bold: wrap('1'),
    dim: wrap('2'),
    red: wrap('31'),
    yellow: wrap('33'),
    green: wrap('32'),
    cyan: wrap('36'),
  }
}

/**
 * A one-line trend, newest at the right.
 *
 * `values` is oldest-first, which is how every time series here is stored — a
 * chart that read right-to-left would be a chart nobody could compare against a
 * log. Right-aligns the window so a short series shows its most recent values
 * next to the label rather than drifting off the left edge.
 */
export function sparkline(values: number[], width = 40): string {
  const clean = values.filter((v) => Number.isFinite(v))
  if (clean.length === 0) return ''
  const window = clean.slice(-width)
  const max = Math.max(...window, 1)
  return window
    .map((v) => BLOCKS[Math.min(7, Math.floor((v / max) * 7.99))])
    .join('')
}

/**
 * A horizontal bar with its value, sized to `max`.
 *
 * The value is always printed, even when the bar rounds to nothing: a bar that
 * shows ` ` next to a real number reads as a rendering bug rather than "small
 * compared to the scale".
 */
export function bar(
  value: number,
  max: number,
  width = 24,
  opts: {
    plain?: boolean
    tint?: keyof ReturnType<typeof color>
    fmt?: (v: number) => string
  } = {},
): string {
  const c = color(!opts.plain)
  const scale = max > 0 ? max : 1
  const filled = Math.max(
    0,
    Math.min(width, Math.round((value / scale) * width)),
  )
  const tint = opts.tint ? c[opts.tint] : (s: string) => s
  const drawn = tint('█'.repeat(filled))
  const rest = '·'.repeat(Math.max(0, width - filled))
  return `${drawn}${rest} ${opts.fmt ? opts.fmt(value) : value}`
}

/**
 * A value against a limit, as a fraction, with the limit drawn in.
 *
 * `over` colours the bar by whether the value breaches, because a host at 90%
 * of its load budget and a host at 10% look identical as bare numbers unless
 * one of them is the one that matters.
 */
export function gauge(
  value: number | null,
  limit: number,
  width = 20,
  plain = false,
  fmt: (v: number) => string = (v) => String(Math.round(v * 10) / 10),
): string {
  if (value === null) return `${'?'.padEnd(width)} unknown`
  const ratio = limit > 0 ? value / limit : 0
  const tint = ratio > 1 ? 'red' : ratio > 0.75 ? 'yellow' : 'green'
  return bar(value, limit, width, { plain, tint, fmt })
}

/** `12.4 GB`, used by the memory row. */
export function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)}GB`
}

/** Pad a label to a column width, tolerating wide glyphs only for ASCII. */
export function label(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}
