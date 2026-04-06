/**
 * Query Parser - Parse natural language queries into structured commands
 * Implements "Never Assume" rule - always show options when ambiguous
 */

import { loadHeadings, loadFinancialTypes, getHeadingByName, getFinancialType } from './csv-loader'
import { inferCategory, Category } from './utils/category'
import { resolveHeading, findMatchingFinancialTypes } from './utils/ambiguity'

// Month name mappings
const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1, '1': 1,
  feb: 2, february: 2, '2': 2,
  mar: 3, march: 3, '3': 3,
  apr: 4, april: 4, '4': 4,
  may: 5, '5': 5,
  jun: 6, june: 6, '6': 6,
  jul: 7, july: 7, '7': 7,
  aug: 8, august: 8, '8': 8,
  sep: 9, september: 9, '9': 9,
  oct: 10, october: 10, '10': 10,
  nov: 11, november: 11, '11': 11,
  dec: 12, december: 12, '12': 12,
}

export type CommandType = 
  | 'analyze' | 'compare' | 'trend' | 'total' 
  | 'list' | 'detail' | 'risk' | 'cashflow' 
  | 'type' | 'shortcuts' | 'query'

export interface ParsedQuery {
  command: CommandType
  itemCode?: string
  friendlyName?: string
  category?: Category
  financialType?: string
  month?: number
  year?: number
  monthCount?: number  // for trend: last N months
  compareA?: string    // for compare: first financial type
  compareB?: string    // for compare: second financial type
  detailTarget?: string // for detail: which comparison #
  listTarget?: string   // for list: item code or 'more'
  raw: string
  ambiguous?: {
    field: string
    options: Array<{ code: string; name: string; category: string }>
  }
}

/**
 * Main query parser entry point
 */
export function parseQuery(query: string): ParsedQuery {
  const q = query.trim()
  const qLower = q.toLowerCase()

  // Detect command type
  if (/^(analyze|analyse)\b/i.test(qLower)) {
    return { command: 'analyze', raw: q }
  }

  if (/^risk\b/i.test(qLower)) {
    return { command: 'risk', raw: q }
  }

  if (/^(cashflow|cash\s*flow)\b/i.test(qLower)) {
    return { command: 'cashflow', raw: q }
  }

  if (/^type\b/i.test(qLower)) {
    return { command: 'type', raw: q }
  }

  if (/^(shortcuts|help|commands)\b/i.test(qLower)) {
    return { command: 'shortcuts', raw: q }
  }

  if (/^list\b/i.test(qLower)) {
    const rest = qLower.replace(/^list\s*/i, '').trim()
    return { command: 'list', listTarget: rest || undefined, raw: q }
  }

  if (/^detail\b/i.test(qLower)) {
    const rest = qLower.replace(/^detail\s*/i, '').trim()
    return { command: 'detail', detailTarget: rest || undefined, raw: q }
  }

  // Compare: "compare A vs B" or "A vs B"
  if (/^(compare|cmp)\b/i.test(qLower) || /\bvs\.?\b/i.test(qLower)) {
    return parseCompare(q)
  }

  // Trend: "trend [item] [financial type] [N]"
  if (/^trend\b/i.test(qLower)) {
    return parseTrend(q)
  }

  // Total: "total [item] [financial type]"
  if (/^total\b/i.test(qLower)) {
    return parseTotal(q)
  }

  // Default: general query
  return parseGeneralQuery(q)
}

/**
 * Parse compare query: "compare A vs B"
 */
function parseCompare(q: string): ParsedQuery {
  const qLower = q.toLowerCase()
  
  // Extract sides of comparison
  const vsMatch = qLower.match(/(.+?)\s+(?:vs\.?|versus|compared?\s+to)\s+(.+)/i)
  if (!vsMatch) {
    return { command: 'compare', raw: q, ambiguous: { field: 'compare_format', options: [] } }
  }

  const sideA = vsMatch[1].replace(/^(compare|cmp)\s+/i, '').trim()
  const sideB = vsMatch[2].trim()

  const ftA = resolveFinancialType(sideA)
  const ftB = resolveFinancialType(sideB)

  return {
    command: 'compare',
    compareA: ftA,
    compareB: ftB,
    category: inferCategory(q),
    raw: q,
  }
}

/**
 * Parse trend query: "trend gp 8" or "trend preliminaries cf 6"
 */
function parseTrend(q: string): ParsedQuery {
  const rest = q.replace(/^trend\s*/i, '').trim()
  const parts = rest.split(/\s+/)

  let monthCount = 6 // default
  let itemTerm = ''
  let ftTerm = ''

  // Check if last token is a number (month count)
  const lastPart = parts[parts.length - 1]
  if (parts.length > 1 && /^\d+$/.test(lastPart) && parseInt(lastPart) <= 24) {
    monthCount = parseInt(lastPart)
    parts.pop()
  }

  // Parse remaining parts for item and financial type
  for (const part of parts) {
    const ft = resolveFinancialType(part)
    if (ft && !ftTerm) {
      ftTerm = ft
    } else {
      itemTerm += (itemTerm ? ' ' : '') + part
    }
  }

  // Resolve item
  const category = inferCategory(q)
  const resolved = resolveHeading(itemTerm, category)

  if (resolved.ambiguous) {
    return {
      command: 'trend',
      monthCount,
      financialType: ftTerm || undefined,
      category,
      raw: q,
      ambiguous: {
        field: 'item',
        options: resolved.options.map(o => ({
          code: o.itemCode,
          name: o.friendlyName,
          category: o.category,
        })),
      },
    }
  }

  return {
    command: 'trend',
    itemCode: resolved.resolved?.itemCode,
    friendlyName: resolved.resolved?.friendlyName,
    category,
    financialType: ftTerm || undefined,
    monthCount,
    raw: q,
  }
}

/**
 * Parse total query: "total preliminaries projection"
 */
function parseTotal(q: string): ParsedQuery {
  const rest = q.replace(/^total\s*/i, '').trim()
  return parseGeneralQuery(rest, 'total')
}

/**
 * Parse a general query into item + financial type + month
 */
function parseGeneralQuery(q: string, command?: CommandType): ParsedQuery {
  const parts = q.split(/\s+/)
  const category = inferCategory(q)

  let itemCode: string | undefined
  let friendlyName: string | undefined
  let financialType: string | undefined
  let month: number | undefined
  let year: number | undefined
  let remaining: string[] = []

  // Extract month/year
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].toLowerCase()
    
    // Check for month name or number
    if (MONTH_NAMES[part] !== undefined) {
      month = MONTH_NAMES[part]
      continue
    }

    // Check for 4-digit year
    if (/^\d{4}$/.test(part)) {
      year = parseInt(part)
      continue
    }

    remaining.push(parts[i])
  }

  // Extract financial type from remaining
  for (let i = remaining.length - 1; i >= 0; i--) {
    const ft = resolveFinancialType(remaining[i])
    if (ft) {
      financialType = ft
      remaining.splice(i, 1)
      break
    }
  }

  // Resolve item from remaining text
  const itemTerm = remaining.join(' ')
  if (itemTerm) {
    // Check if it's an item code (e.g., "2.2.1")
    if (/^\d+(\.\d+)*$/.test(itemTerm)) {
      itemCode = itemTerm
    } else {
      const resolved = resolveHeading(itemTerm, category)
      if (resolved.resolved) {
        itemCode = resolved.resolved.itemCode
        friendlyName = resolved.resolved.friendlyName
      } else if (resolved.ambiguous) {
        return {
          command: command || 'query',
          category,
          financialType,
          month,
          year,
          raw: q,
          ambiguous: {
            field: 'item',
            options: resolved.options.map(o => ({
              code: o.itemCode,
              name: o.friendlyName,
              category: o.category,
            })),
          },
        }
      }
    }
  }

  return {
    command: command || 'query',
    itemCode,
    friendlyName,
    category,
    financialType,
    month,
    year,
    raw: q,
  }
}

/**
 * Resolve a string to a financial type name
 */
function resolveFinancialType(term: string): string | undefined {
  if (!term) return undefined
  
  const types = loadFinancialTypes()
  const termLower = term.toLowerCase()

  // Exact match on Clean_Financial_Type
  const exact = types.find(t => t.Clean_Financial_Type.toLowerCase() === termLower)
  if (exact) return exact.Clean_Financial_Type

  // Acronym match
  for (const t of types) {
    const acronyms = t.Acronyms.split('|').map(a => a.trim().toLowerCase())
    if (acronyms.includes(termLower)) {
      return t.Clean_Financial_Type
    }
  }

  // Partial match
  const partial = types.find(t => t.Clean_Financial_Type.toLowerCase().includes(termLower))
  if (partial) return partial.Clean_Financial_Type

  return undefined
}
