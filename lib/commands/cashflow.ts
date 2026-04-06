/**
 * Cash Flow Command - Show last 12 months GP + GP after recon & overhead
 */

export interface CashFlowMonth {
  month: string
  gp: number | null
  gpAfterRecon: number | null
}

export function formatCashFlowResults(months: CashFlowMonth[]): string {
  let lines = '**Cash Flow - Last 12 Months GP**\n\n'
  lines += '| Month | GP | GP After Recon & OH |\n'
  lines += '|-------|-----|--------------------|\n'
  let gpSum = 0
  let gpAfterSum = 0
  let gpCount = 0
  let gpAfterCount = 0
  for (const m of months) {
    lines += '| ' + m.month + ' | ' + fmt(m.gp) + ' | ' + fmt(m.gpAfterRecon) + ' |\n'
    if (m.gp !== null) { gpSum += m.gp; gpCount++ }
    if (m.gpAfterRecon !== null) { gpAfterSum += m.gpAfterRecon; gpAfterCount++ }
  }
  if (gpCount > 0) {
    lines += '\n**Average GP:** ' + fmt(gpSum / gpCount)
  }
  if (gpAfterCount > 0) {
    lines += '\n**Average GP After Recon & OH:** ' + fmt(gpAfterSum / gpAfterCount)
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
