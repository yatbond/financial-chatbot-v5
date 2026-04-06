/**
 * Detail Command - Drill down into previous results (Analyze/Compare/Trend)
 */

export interface DetailResult {
  itemCode: string
  friendlyName: string
  values: Record<string, number | null>
}

export function formatDetailResults(
  title: string,
  results: DetailResult[],
  columns: string[]
): string {
  let lines = '**Detail: ' + title + '**\n\n'
  let header = '| Item |'
  let sep = '|------|'
  for (const col of columns) {
    header += ' ' + col + ' |'
    sep += '------|'
  }
  lines += header + '\n' + sep + '\n'
  for (const r of results) {
    let row = '| ' + r.friendlyName + ' [' + r.itemCode + '] |'
    for (const col of columns) {
      const v = r.values[col]
      row += ' ' + (v !== null ? fmt(v) : '---') + ' |'
    }
    lines += row + '\n'
  }
  return lines
}

function fmt(v: number): string {
  const absValue = Math.abs(v)
  const sign = v < 0 ? '-' : ''
  if (absValue >= 1000) return sign + '$' + (absValue / 1000).toFixed(1) + 'Mil'
  return sign + '$' + absValue.toFixed(0) + 'K'
}
