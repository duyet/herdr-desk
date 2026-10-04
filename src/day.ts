/** Local `YYYY-MM-DD HH:MM`. */
export function formatLocal(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}:${p(at.getMinutes())}`
}

export function dayKey(at = new Date()): string {
  return formatLocal(at).split(' ')[0]
}
