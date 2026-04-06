/**
 * Category isolation utilities
 * Ensures queries only match within the inferred category
 */

export type Category = 'Income' | 'Cost' | 'Summary' | 'Reconciliation' | 'Overhead' | 'Project Info' | 'unknown'

/**
 * Infer category from context keywords in a query
 */
export function inferCategory(query: string): Category {
  const q = query.toLowerCase()
  
  // Explicit category keywords
  if (/\b(income|revenue|item 1)\b/i.test(q)) return 'Income'
  if (/\b(cost|expense|item 2|less.*cost)\b/i.test(q)) return 'Cost'
  if (/\b(summary|gp|gross profit|item 3)\b/i.test(q)) return 'Summary'
  if (/\b(reconciliation|recon|item 4)\b/i.test(q)) return 'Reconciliation'
  if (/\b(overhead|item 5)\b/i.test(q)) return 'Overhead'
  
  // Item code prefix
  if (/\b1\.[0-9]/.test(q)) return 'Income'
  if (/\b2\.[0-9]/.test(q)) return 'Cost'
  if (/\b3\.[0-9]/.test(q)) return 'Summary'
  if (/\b4\.[0-9]/.test(q)) return 'Reconciliation'
  if (/\b5\.[0-9]/.test(q)) return 'Overhead'
  
  return 'unknown'
}

/**
 * Get the opposite category (for comparison queries)
 */
export function getOppositeCategory(cat: Category): Category {
  switch (cat) {
    case 'Income': return 'Cost'
    case 'Cost': return 'Income'
    default: return 'unknown'
  }
}

/**
 * Check if an item code belongs to a category
 */
export function isItemInCategory(itemCode: string, category: Category): boolean {
  if (!itemCode) return false
  const firstChar = itemCode.charAt(0)
  switch (category) {
    case 'Income': return firstChar === '1'
    case 'Cost': return firstChar === '2'
    case 'Summary': return firstChar === '3'
    case 'Reconciliation': return firstChar === '4'
    case 'Overhead': return firstChar === '5'
    case 'Project Info': return itemCode === '' || firstChar === '0'
    default: return true // unknown = allow all
  }
}

/**
 * Get category label for display
 */
export function getCategoryLabel(itemCode: string): string {
  const firstChar = itemCode.charAt(0)
  switch (firstChar) {
    case '1': return 'Income'
    case '2': return 'Cost'
    case '3': return 'Summary'
    case '4': return 'Reconciliation'
    case '5': return 'Overhead'
    default: return 'Project Info'
  }
}