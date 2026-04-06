/**
 * Shortcuts Command - List all shortcuts and usage
 */

export function handleShortcuts(): string {
  return `📋 **Financial Chatbot Shortcuts**

**Query Format:** [Shortcut] [Data Type] [Financial Type] [Month/Number]

**10 Commands:**

1. **Analyze** — Run financial analysis (5 comparisons)
   \`analyze\`

2. **Compare** — Compare two financial types
   \`compare projection vs wip\`
   \`compare committed cost vs projection cost\`

3. **Trend** — Show values over time
   \`trend gp 8\` (last 8 months)
   \`trend preliminaries cash flow 6\`

4. **List** — Show available data items
   \`list\` → Tier 1+2 items
   \`list more\` → All tiers
   \`list 2.2\` → Items under 2.2

5. **Total** — Sum sub-items under a parent
   \`total preliminaries projection\`
   \`total materials\`

6. **Detail** — Drill down into previous results
   \`detail 1\` or \`detail 2.1\`

7. **Risk** — Show risk items across WIP/Committed/Cash Flow
   \`risk\`

8. **Cash Flow** — Last 12 months GP summary
   \`cash flow\`

9. **Type** — List all Financial Types
   \`type\`

10. **Shortcuts** — Show this help
    \`shortcuts\` or \`help\`

**Financial Type Shortcuts:**
\`bp\` = Business Plan | \`wip\` = WIP | \`projection\` = Projection
\`committed\` = Committed Cost | \`cf\` = Cash Flow | \`accrual\` = Accrual
\`budget\` = Budget Tender | \`revision\` = Budget Revision

**Examples:**
• "projection gp" → Show projected GP
• "trend gp 8" → GP trend for 8 months
• "compare projected vs business plan" → Compare
• "risk" → Show risk analysis
• "total materials projection" → Sum materials sub-items`
}
