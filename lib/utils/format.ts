/**
 * Format utilities for currency, source references, tables
 */

/**
 * Format a number (in thousands) to display string
 * Data values are in thousands ('000)
 */
export function formatCurrency(value: number | string): string {
  if (typeof value === 'string') {
    if (value.includes('%')) return value
    if (value.includes('-') && value.length === 10) return value // date
    const num = parseFloat(value)
    if (isNaN(num)) return value
    value = num
  }
  
  const absValue = Math.abs(value)
  const sign = value < 0 ? '-' : ''
  
  if (absValue >= 1e6) {
    return `${sign}$${(absValue / 1e6).toFixed(1)}B`
  } else if (absValue >= 1000) {
    return `${sign}$${(absValue / 1000).toFixed(1)}Mil`
  }
  
  return `${sign}$${absValue.toFixed(1)}K`
}

/**
 * Format a number with full commas
 */
export function formatNumber(value: number): string {
  return `$${Math.round(value).toLocaleString()}`
}

/**
 * Format source reference for traceability
 */
export function formatSourceRef(row: {
  Sheet_Name?: string
  Financial_Type?: string
  Item_Code?: string
  Month?: string | number
  Year?: string | number
}): string {
  const parts: string[] = []
  if (row.Sheet_Name) parts.push(row.Sheet_Name)
  if (row.Financial_Type) parts.push(row.Financial_Type)
  if (row.Item_Code) parts.push(row.Item_Code)
  if (row.Month && row.Year) parts.push(`${row.Month}/${row.Year}`)
  return `[${parts.join(', ')}]`
}

/**
 * Format a comparison table row
 */
export function formatComparisonRow(
  item: string,
  valueA: number | string,
  valueB: number | string,
  diff?: number,
  labelA?: string,
  labelB?: string
): string {
  const a = typeof valueA === 'number' ? formatCurrency(valueA) : valueA
  const b = typeof valueB === 'number' ? formatCurrency(valueB) : valueB
  const d = diff !== undefined ? (diff >= 0 ? `+${formatCurrency(diff)}` : formatCurrency(diff)) : ''
  
  return `${item}: ${a} vs ${b}${d ? ` (${d})` : ''}`
}

/**
 * Format percentage
 */
export function formatPercent(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

/**
 * Bold dollar amounts in text for display
 */
export function boldDollars(text: string): string {
  return text.replace(/(\$-?[\d,.]+(?:\s*(?:Mil|B|K))?)/g, '**$1**')
}

/**
 * Format a month number to name
 */
export function formatMonth(month: number | string): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const m = typeof month === 'string' ? parseInt(month) : month
  return months[m - 1] || String(m)
}
