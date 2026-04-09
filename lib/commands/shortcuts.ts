/**
 * Shortcuts Command - List all shortcuts and usage
 */

export function handleShortcuts(): string {
  return `📋 **Financial Chatbot Shortcuts**

**Query Format:** [Shortcut] [Data Type] [Financial Type] [Month/Number]

**10 Commands:**

1. **Analyze** — Run financial analysis (6 comparisons)
   \`analyze\`
   Compares Projection vs BP/WIP/Committed/Latest Budget for income & cost items

2. **Compare** — Compare two financial types side by side
   \`compare projection vs wip\`
   \`compare committed cost vs projection cost\`

3. **Trend** — Show values over time (monthly)
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
   Works after: Analyze, Compare, Trend, or any query

7. **Risk** — Show risk items across WIP/Committed/Cash Flow
   \`risk\`

8. **Cash Flow** — Last 12 months GP summary
   \`cash flow\`

9. **Type** — List all Financial Types and Sheet Names
   \`type\`

10. **Shortcuts** — Show this help
    \`shortcuts\` or \`help\`

**Financial Type Shortcuts:**
\`bp\` = Business Plan | \`budget\`/\`bt\` = Latest Budget
\`1wb\` = 1st Working Budget | \`tender\` = Budget Tender
\`projection\` = Projection | \`wip\`/\`audit\` = WIP
\`committed\` = Committed Cost | \`cf\`/\`cashflow\` = Cash Flow
\`accrual\` = Accrual | \`revision\`/\`rev\` = Latest Budget (same)

**Data Type Shortcuts:**
\`gp\` = Gross Profit | \`np\` = Net Profit
\`prelim\` = Preliminaries | \`materials\` = Materials
\`plant\` = Plant & Machinery | \`subcon\`/\`sub\`/\`subbie\` = Subcontractor
\`labour\` = Direct Labour | \`rebar\` = Reinforcement
\`income\`/\`revenue\` = Total Income | \`cost\` = Total Cost

**Examples:**
• "projection gp" → Show projected GP
• "trend gp 8" → GP trend for 8 months
• "compare projected vs business plan" → Compare
• "risk" → Show risk analysis
• "total materials projection" → Sum materials sub-items
• "cashflow prelim" → Show cash flow preliminaries
• "detail 2.1" → Drill down into item 2.1`
}