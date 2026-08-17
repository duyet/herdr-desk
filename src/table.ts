export function textTable(headers: string[], rows: string[][]): string {
  const cols = headers.length
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  )
  const line = (cells: string[]) =>
    `| ${cells.map((c, i) => (c ?? '').padEnd(widths[i])).join(' | ')} |`
  const sep = `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`
  return [line(headers), sep, ...rows.map((r) => line(r.slice(0, cols)))].join(
    '\n',
  )
}
