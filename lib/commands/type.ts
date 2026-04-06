/**
 * Type Command - List all Financial Types and Sheet Names
 */

import { loadFinancialTypes, loadHeadings } from '../csv-loader'

export function handleType(): string {
  const types = loadFinancialTypes()
  const headings = loadHeadings()
  
  let lines = '📋 **Financial Types**\n\n'
  
  for (const t of types) {
    const acronyms = t.Acronyms.split('|').map(a => a.trim()).join(', ')
    lines += '• **' + t.Clean_Financial_Type + '** _(' + acronyms + ')_\n'
  }
  
  // Show unique categories
  const categories: string[] = []
  for (const h of headings) {
    if (h.Category !== 'Project Info' && !categories.includes(h.Category)) {
      categories.push(h.Category)
    }
  }
  
  lines += '\n**Categories:**\n'
  for (const cat of categories) {
    const count = headings.filter(h => h.Category === cat).length
    lines += '• **' + cat + '** (' + count + ' items)\n'
  }
  
  lines += '\n_Type "list" to see all data items by tier_'
  
  return lines
}