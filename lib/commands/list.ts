/**
 * List Command - Show available data items by tier
 * 
 * Usage:
 *   "list"       → Tier 1 + Tier 2
 *   "list more"  → All tiers
 *   "list 2.2"   → All sub-items under Item 2.2
 */

import { loadHeadings, getChildHeadings } from '../csv-loader'

export function handleList(args: string): string {
  const trimmed = args.trim().toLowerCase()
  
  // "list more" — show all tiers
  if (trimmed === 'more') {
    return listAll()
  }
  
  // "list X.Y" — show sub-items under a parent
  if (/^\d+(\.\d+)*$/.test(trimmed)) {
    return listChildren(trimmed)
  }
  
  // Default "list" — show tier 1 + tier 2
  return listTier1And2()
}

function listTier1And2(): string {
  const headings = loadHeadings()
  const items = headings.filter(h => h.Tier <= 2 && h.Category !== 'Project Info')
  
  let lines = '📊 **Data Items (Tier 1 & 2)**\n\n'
  
  let currentCategory = ''
  for (const item of items) {
    if (item.Category !== currentCategory) {
      currentCategory = item.Category
      lines += `\n**${currentCategory}**\n`
    }
    
    const indent = item.Tier === 1 ? '' : '  '
    lines += `${indent}${item.Item_Code || '—'} ${item.Friendly_Name}\n`
  }
  
  lines += `\n_Type "list more" for all tiers, or "list 2.2" for sub-items_`
  
  return lines
}

function listAll(): string {
  const headings = loadHeadings()
  const items = headings.filter(h => h.Category !== 'Project Info')
  
  let lines = '📊 **All Data Items**\n\n'
  
  let currentCategory = ''
  for (const item of items) {
    if (item.Category !== currentCategory) {
      currentCategory = item.Category
      lines += `\n**${currentCategory}**\n`
    }
    
    const indent = '  '.repeat(item.Tier - 1)
    lines += `${indent}${item.Item_Code || '—'} ${item.Friendly_Name}\n`
  }
  
  return lines
}

function listChildren(parentCode: string): string {
  const children = getChildHeadings(parentCode)
  
  if (children.length === 0) {
    return `❌ No sub-items found under "${parentCode}". Check the item code with "list".`
  }
  
  let lines = `📊 **Sub-items under ${parentCode}**\n\n`
  
  for (const item of children) {
    const indent = '  '.repeat(item.Tier - (parentCode.split('.').length + 1))
    lines += `${indent}${item.Item_Code} ${item.Friendly_Name}\n`
  }
  
  return lines
}
