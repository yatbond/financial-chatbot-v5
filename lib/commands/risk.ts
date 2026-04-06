/**
 * Risk Command - Compare risk items across WIP, Committed, Cash Flow
 */

export const INCOME_RISK_ITEMS = [
  { code: '1.2.1', name: 'VO / CE Amount' },
  { code: '1.7', name: 'Claims Income' },
  { code: '1.8', name: 'Price Fluctuation (CPF)' },
  { code: '1.12.1', name: 'Other Revenue' },
]

export const COST_RISK_ITEMS = [
  { code: '2.2.15', name: 'Potential Savings (Materials)' },
  { code: '2.4.4', name: 'Contra Charge' },
  { code: '2.4.7', name: 'Potential Savings (DSC)' },
  { code: '2.7', name: 'Contingencies' },
  { code: '2.8', name: 'Rectification Works' },
  { code: '2.14', name: 'Stretch Target' },
]

export interface RiskData {
  code: string
  name: string
  values: Record<string, number | null>
}

export function formatRiskResults(
  incomeResults: RiskData[],
  costResults: RiskData[]
): string {
  let lines = '**Risk Analysis**\n\n'
  lines += '**Income Risk Items**\n'
  lines += '| Item | WIP | Committed | Cash Flow |\n'
  lines += '|------|-----|-----------|----------|\n'
  for (const r of incomeResults) {
    lines += '| ' + r.name + ' [' + r.code + '] | '
      + fmt(r.values['WIP']) + ' | '
      + fmt(r.values['Committed Cost']) + ' | '
      + fmt(r.values['Cash Flow']) + ' |\n'
  }
  lines += '\n**Cost Risk Items**\n'
  lines += '| Item | WIP | Committed | Cash Flow |\n'
  lines += '|------|-----|-----------|----------|\n'
  for (const r of costResults) {
    lines += '| ' + r.name + ' [' + r.code + '] | '
      + fmt(r.values['WIP']) + ' | '
      + fmt(r.values['Committed Cost']) + ' | '
      + fmt(r.values['Cash Flow']) + ' |\n'
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
