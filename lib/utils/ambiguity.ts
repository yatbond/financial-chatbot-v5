/**
 * Ambiguity detection and option formatting
 * Implements "Never Assume" rule - always show options when unclear
 */

import { loadHeadings, loadFinancialTypes } from '../csv-loader'
import { Category, isItemInCategory } from './category'

export interface AmbiguityOption {
  itemCode: string
  friendlyName: string
  category: string
  financialType?: string
  value?: number
}

/**
 * Find all headings matching a query term, optionally filtered by category
 */
export function findMatchingHeadings(term: string, category?: Category): AmbiguityOption[] {
  const headings = loadHeadings()
  const termLower = term.toLowerCase()
  const matches: AmbiguityOption[] = []
  
  for (const h of headings) {
    // Skip Project Info items
    if (h.Category === 'Project Info') continue
    
    // Filter by category if specified
    if (category && category !== 'unknown' && !isItemInCategory(h.Item_Code, category)) continue
    
    // Check Friendly_Name match
    if (h.Friendly_Name.toLowerCase().includes(termLower)) {
      matches.push({
        itemCode: h.Item_Code,
        friendlyName: h.Friendly_Name,
        category: h.Category,
      })
      continue
    }
    
    // Check acronym match
    const acronyms = h.Acronyms.split('|').map(a => a.trim().toLowerCase())
    if (acronyms.includes(termLower)) {
      matches.push({
        itemCode: h.Item_Code,
        friendlyName: h.Friendly_Name,
        category: h.Category,
      })
    }
  }
  
  return matches
}

/**
 * Check if a term matches multiple items across categories
 */
export function isAmbiguous(term: string): { ambiguous: boolean; options: AmbiguityOption[] } {
  const options = findMatchingHeadings(term)
  return {
    ambiguous: options.length > 1,
    options,
  }
}

/**
 * Format ambiguity options as inline buttons for the user
 */
export function formatAmbiguityOptions(options: AmbiguityOption[], context?: string): string {
  if (options.length === 0) {
    return `❌ No matches found${context ? ` for "${context}"` : ''}.`
  }
  
  let lines = `Multiple matches found. Please select one:\n`
  
  for (let i = 0; i < options.length; i++) {
    const opt = options[i]
    lines += `[${i + 1}] ${opt.friendlyName} (${opt.category}) [${opt.itemCode}]\n`
  }
  
  return lines
}

/**
 * Find matching financial types for a term
 */
export function findMatchingFinancialTypes(term: string): string[] {
  const types = loadFinancialTypes()
  const termLower = term.toLowerCase()
  const matches: string[] = []
  
  for (const t of types) {
    // Check Clean_Financial_Type match
    if (t.Clean_Financial_Type.toLowerCase().includes(termLower)) {
      matches.push(t.Clean_Financial_Type)
      continue
    }
    
    // Check acronym match
    const acronyms = t.Acronyms.split('|').map(a => a.trim().toLowerCase())
    if (acronyms.includes(termLower)) {
      matches.push(t.Clean_Financial_Type)
    }
  }
  
  return matches
}

/**
 * Resolve a term to a single heading, or return ambiguity if multiple matches
 */
export function resolveHeading(
  term: string, 
  category?: Category
): { resolved: AmbiguityOption | null; ambiguous: boolean; options: AmbiguityOption[] } {
  const options = findMatchingHeadings(term, category)
  
  if (options.length === 1) {
    return { resolved: options[0], ambiguous: false, options }
  }
  
  if (options.length === 0) {
    return { resolved: null, ambiguous: false, options }
  }
  
  // Multiple matches - check if all in same category
  const categories = new Set(options.map(o => o.category))
  if (categories.size === 1) {
    // Same category - still ambiguous but related
    return { resolved: null, ambiguous: true, options }
  }
  
  // Different categories - definitely ambiguous
  return { resolved: null, ambiguous: true, options }
}