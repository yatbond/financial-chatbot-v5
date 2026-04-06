/**
 * CSV Loader - Load lookup tables from CSV files at runtime
 * This allows editing lookup data without code changes
 */

import fs from 'fs'
import path from 'path'

// Types for lookup tables
export interface HeadingRow {
  Item_Code: string
  Data_Type: string
  Friendly_Name: string
  Category: string
  Tier: number
  Acronyms: string
}

export interface FinancialTypeRow {
  Raw_Financial_Type: string
  Clean_Financial_Type: string
  Acronyms: string
}

// Loaded data caches
let headingsCache: HeadingRow[] | null = null
let financialTypesCache: FinancialTypeRow[] | null = null

/**
 * Parse CSV string into array of objects
 */
function parseCSV<T>(csv: string, createRow: (headers: string[], values: string[]) => T): T[] {
  const lines = csv.trim().split('\n')
  if (lines.length < 2) return []
  
  const headers = parseCSVLine(lines[0])
  const result: T[] = []
  
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i])
    result.push(createRow(headers, values))
  }
  
  return result
}

/**
 * Parse a single CSV line handling quoted values
 */
function parseCSVLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  
  result.push(current.trim())
  return result
}

/**
 * Load construction headings from CSV file
 */
export function loadHeadings(): HeadingRow[] {
  if (headingsCache) return headingsCache
  
  const csvPath = path.join(process.cwd(), 'public', 'construction_headings_enriched.csv')
  
  try {
    const csvContent = fs.readFileSync(csvPath, 'utf-8')
    headingsCache = parseCSV(csvContent, (headers, values) => ({
      Item_Code: values[0] || '',
      Data_Type: values[1] || '',
      Friendly_Name: values[2] || '',
      Category: values[3] || '',
      Tier: parseInt(values[4]) || 0,
      Acronyms: values[5] || ''
    }))
    return headingsCache
  } catch (error) {
    console.error('Failed to load headings CSV:', error)
    return []
  }
}

/**
 * Load financial type map from CSV file
 */
export function loadFinancialTypes(): FinancialTypeRow[] {
  if (financialTypesCache) return financialTypesCache
  
  const csvPath = path.join(process.cwd(), 'public', 'financial_type_map.csv')
  
  try {
    const csvContent = fs.readFileSync(csvPath, 'utf-8')
    financialTypesCache = parseCSV(csvContent, (headers, values) => ({
      Raw_Financial_Type: values[0] || '',
      Clean_Financial_Type: values[1] || '',
      Acronyms: values[2] || ''
    }))
    return financialTypesCache
  } catch (error) {
    console.error('Failed to load financial types CSV:', error)
    return []
  }
}

/**
 * Get heading by Item_Code
 */
export function getHeadingByCode(itemCode: string): HeadingRow | undefined {
  const headings = loadHeadings()
  return headings.find(h => h.Item_Code === itemCode)
}

/**
 * Get heading by Friendly_Name or acronym
 */
export function getHeadingByName(name: string): HeadingRow | undefined {
  const headings = loadHeadings()
  const nameLower = name.toLowerCase()
  
  // First try exact match on Friendly_Name
  let result = headings.find(h => h.Friendly_Name.toLowerCase() === nameLower)
  if (result) return result
  
  // Then try matching on acronyms
  for (const heading of headings) {
    const acronyms = heading.Acronyms.split('|').map(a => a.trim().toLowerCase())
    if (acronyms.includes(nameLower)) {
      return heading
    }
  }
  
  // Try partial match on Friendly_Name
  return headings.find(h => h.Friendly_Name.toLowerCase().includes(nameLower))
}

/**
 * Get all headings in a category
 */
export function getHeadingsByCategory(category: string): HeadingRow[] {
  const headings = loadHeadings()
  return headings.filter(h => h.Category.toLowerCase() === category.toLowerCase())
}

/**
 * Get all headings under a parent Item_Code (e.g., "2.2" returns "2.2.1", "2.2.2", etc.)
 */
export function getChildHeadings(parentCode: string): HeadingRow[] {
  const headings = loadHeadings()
  const prefix = parentCode + '.'
  return headings.filter(h => h.Item_Code.startsWith(prefix))
}

/**
 * Get financial type by clean name or acronym
 */
export function getFinancialType(name: string): FinancialTypeRow | undefined {
  const types = loadFinancialTypes()
  const nameLower = name.toLowerCase()
  
  // First try exact match on Clean_Financial_Type
  let result = types.find(t => t.Clean_Financial_Type.toLowerCase() === nameLower)
  if (result) return result
  
  // Then try matching on acronyms
  for (const ft of types) {
    const acronyms = ft.Acronyms.split('|').map(a => a.trim().toLowerCase())
    if (acronyms.includes(nameLower)) {
      return ft
    }
  }
  
  // Try partial match on Clean_Financial_Type
  return types.find(t => t.Clean_Financial_Type.toLowerCase().includes(nameLower))
}

/**
 * Clear caches (useful for testing or hot reload)
 */
export function clearCache(): void {
  headingsCache = null
  financialTypesCache = null
}