/**
 * Analyze Command - Run financial analysis (5 comparisons)
 */

export interface AnalysisItem {
  itemCode: string
  friendlyName: string
  valueA: number | null
  valueB: number | null
  diff: number | null
}

export interface AnalysisResult {
  id: number
  title: string
  items: AnalysisItem[]
  totalDiff: number | null
}

export function formatAnalysisResults(results: AnalysisResult[]): string {
  let lines = '**Financial Analysis**\n\n'
  for (const r of results) {
    lines += '**#' + r.id + ': ' + r.title + '**\n'
    if (r.items.length === 0) {
      lines += '  No significant items found.\n\n'
      continue
    }
    for (const item of r.items) {
      const diff = item.diff !== null ? ' (' + fmtDiff(item.diff) + ')' : ''
      const va = item.valueA !== null ? fmt(item.valueA) : '---'
      const vb = item.valueB !== null ? fmt(item.valueB) : '---'
      lines += '  - ' + item.friendlyName + ' [' + item.itemCode + ']: ' + va + ' vs ' + vb + diff + '\n'
    }
    if (r.totalDiff !== null) {
      lines += '  **Total difference: ' + fmtDiff(r.totalDiff) + '**\n'
    }
    lines += '\n'
  }
  lines += '_Type "detail [number]" to drill down into any comparison_'
  return lines
}

function fmt(v: number): string {
  const absValue = Math.abs(v)
  const sign = v < 0 ? '-' : ''
  if (absValue >= 1000) return sign + '$' + (absValue / 1000).toFixed(1) + 'Mil'
  return sign + '$' + absValue.toFixed(0) + 'K'
}

function fmtDiff(v: number): string {
  const absValue = Math.abs(v)
  const sign = v < 0 ? '-' : '+'
  if (absValue >= 1000) return sign + '$' + (absValue / 1000).toFixed(1) + 'Mil'
  return sign + '$' + absValue.toFixed(0) + 'K'
}
