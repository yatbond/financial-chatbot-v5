/**
 * Trend Command - Show values over time (monthly)
 */

export interface TrendPoint {
  month: string
  value: number | null
}

export interface TrendResult {
  itemCode: string
  friendlyName: string
  points: TrendPoint[]
  average: number | null
}

export function formatTrendResults(
  results: TrendResult[],
  months: number
): string {
  let lines = '**Trend (Last ' + months + ' months)**\n\n'
  for (const r of results) {
    lines += '**' + r.friendlyName + ' [' + r.itemCode + ']**\n'
    lines += '| Month | Value |\n'
    lines += '|-------|-------|\n'
    for (const p of r.points) {
      lines += '| ' + p.month + ' | ' + fmt(p.value) + ' |\n'
    }
    if (r.average !== null) {
      lines += '| **Avg** | **' + fmt(r.average) + '** |\n'
    }
    lines += '\n'
  }
  return lines
}

function fmt(v: number | null): string {
  if (v === null) return '---'
  const absValue = Math.abs(v)
  const sign = v < 0 ? '-' : ''
  if (absValue >= 1000) return sign + '$' + (absValue / 1000).toFixed(1) + 'Mil'
  return sign + '$' + absValue.toFixed(0) + 'K'
}
