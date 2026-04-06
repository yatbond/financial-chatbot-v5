/**
 * Total Command - Sum sub-items under a parent item
 */

export interface TotalResult {
  itemCode: string
  friendlyName: string
  value: number | null
  financialType: string
}

export function formatTotalResults(
  parentName: string,
  results: TotalResult[],
  total: number | null
): string {
  let lines = '**Total: ' + parentName + '**\n\n'
  lines += '| Item | Value |\n'
  lines += '|------|-------|\n'
  for (const r of results) {
    const val = r.value !== null ? fmt(r.value) : '---'
    lines += '| ' + r.friendlyName + ' [' + r.itemCode + '] | ' + val + ' |\n'
  }
  if (total !== null) {
    lines += '| **Total** | **' + fmt(total) + '** |\n'
  }
  return lines
}

function fmt(v: number): string {
  const absValue = Math.abs(v)
  const sign = v < 0 ? '-' : ''
  if (absValue >= 1000) return sign + '$' + (absValue / 1000).toFixed(1) + 'Mil'
  return sign + '$' + absValue.toFixed(0) + 'K'
}
