/**
 * Compare Command - Compare two financial types or date ranges
 */

export interface CompareResult {
  itemCode: string
  friendlyName: string
  valueA: number | null
  valueB: number | null
  diff: number | null
}

export function formatCompareResults(
  labelA: string,
  labelB: string,
  results: CompareResult[]
): string {
  let lines = '**Compare: ' + labelA + ' vs ' + labelB + '**\n\n'
  lines += '| Item | ' + labelA + ' | ' + labelB + ' | Difference |\n'
  lines += '|------|------|------|------------|\n'
  for (const r of results) {
    lines += '| ' + r.friendlyName + ' [' + r.itemCode + '] | '
      + fmt(r.valueA) + ' | '
      + fmt(r.valueB) + ' | '
      + fmtDiff(r.diff) + ' |\n'
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

function fmtDiff(v: number | null): string {
  if (v === null) return '---'
  const absValue = Math.abs(v)
  const sign = v < 0 ? '-' : '+'
  if (absValue >= 1000) return sign + '$' + (absValue / 1000).toFixed(1) + 'Mil'
  return sign + '$' + absValue.toFixed(0) + 'K'
}
