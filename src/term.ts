/** How a terminal view may render: how wide, and whether ANSI color is allowed. */
export type TermOpts = { width: number; color: boolean }

/**
 * The real terminal's options. Not a TTY (piped, a Herdr action log) means no
 * color and a conservative 80 columns; `NO_COLOR` always wins.
 */
export function termOpts(): TermOpts {
  const tty = process.stdout.isTTY === true
  return {
    width: tty && process.stdout.columns ? process.stdout.columns : 80,
    color: tty && !process.env.NO_COLOR,
  }
}

export const paint = (on: boolean, code: string, text: string): string =>
  on ? `\x1b[${code}m${text}\x1b[0m` : text
