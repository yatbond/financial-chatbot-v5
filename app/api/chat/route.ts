import { NextRequest, NextResponse } from 'next/server'
import { google } from 'googleapis'
import { loadHeadings, loadFinancialTypes } from '../../../lib/csv-loader'

/**
 * ============================================================
 * FINANCIAL CHATBOT - FUNCTION GUIDE
 * ============================================================
 *
 * AVAILABLE COMMANDS (processed in priority order):
 *
 * 1. ANALYZE
 *    - Trigger: "Analyze" or "Analyse"
 *    - Purpose: Run comprehensive financial analysis (6 comparisons)
 *    - Uses Financial Status sheet (cumulative values)
 *    - Compares Income (1.x) and Cost (2.x) items across Financial Types
 *    - Comparisons:
 *      #1: Projection vs Business Plan — Income Shortfalls
 *      #2: Projection vs WIP — Income Shortfalls
 *      #3: Projection vs Business Plan — Cost Overruns
 *      #4: Projection vs WIP — Cost Overruns
 *      #5: Committed vs Projection — Committed Exceeds Projection
 *      #6: Projection vs Latest Budget — Exceeds Latest Budget
 *    - Results are cached (30 min TTL) for Detail drill-down
 *    - Example: "Analyze"
 *
 * 2. DETAIL
 *    - Trigger: "Detail X" or "Detail X.Y"
 *    - Purpose: Drill down into Analyze results
 *    - Prerequisite: Must run "Analyze" first (cached 30 min)
 *    - Examples:
 *      - "Detail 3"   → Show all 3rd tier items for comparison #3
 *      - "Detail 3.1" → Show 3rd tier items for the 1st flagged item in comparison #3
 *
 * 3. TOTAL
 *    - Trigger: "Total [Item] [Financial Type]" or "Total [Financial Type] [Item]"
 *    - Purpose: Sum all sub-items under a parent item for a Financial Type
 *    - Without month: uses Financial Status sheet
 *    - With month: uses the specific Financial Type worksheet
 *    - Examples:
 *      - "Total Preliminaries Cashflow"
 *      - "Total Committed Materials"
 *      - "Total Cashflow Preliminaries Jan 2025"
 *      - "Total Plant Projection"
 *
 * 4. COMPARE
 *    - Trigger: "compare X with Y", "X vs Y", "X versus Y", "X compared to Y"
 *    - Purpose: Compare same metric across two Financial Types
 *    - Always from Financial Status sheet
 *    - Examples:
 *      - "compare projected gp with business plan gp"
 *      - "projection vs budget"
 *      - "wip gp versus projection gp"
 *      - "committed vs projection"
 *
 * 5. TREND (planned)
 *    - Trigger: "trend [metric] [N months]"
 *    - Purpose: Show metric trend over time
 *    - Examples:
 *      - "trend gp 6 months"
 *      - "trend cash flow 12"
 *
 * 6. NORMAL QUERY (fallback)
 *    - Any query not matching above patterns
 *    - Uses fuzzy matching to find Financial Type, Data Type, and optional month
 *    - Examples:
 *      - "projected gp"
 *      - "business plan np"
 *      - "gp jan 2025"
 *      - "wip gp"
 *
 * ============================================================
 * FINANCIAL TYPE SHORTCUTS (resolved by expandAcronyms + resolveFinancialType):
 *   bp, business plan                   → "Business Plan"
 *   budget, bt                          → "Latest Budget" (UPDATED)
 *   1st working, first working, 1wb     → "1st Working Budget"
 *   tender, budget tender               → "Budget Tender"
 *   projection, projected               → "Projection"
 *   wip, audit, audit report            → "WIP"
 *   committed, committed cost/value     → "Committed Cost"
 *   accrual, accrued                    → "Accrual"
 *   revision, rev, rev as at            → "Latest Budget" (same as budget/bt)
 *   cf, cashflow, cash flow, cash       → "Cash Flow"
 *
 * DATA TYPE / ITEM SHORTCUTS (ACRONYM_MAP below):
 *   gp                → Gross Profit (Item 3)
 *   np, net profit    → Acc. Net Profit/(Loss) (Item 7)
 *   cost, total cost  → Less : Cost (Item 2)
 *   prelim, preliminary, preliminaries, total prelim → Preliminaries (Item 2.1)
 *   supervision, staff → Manpower (Mgt. & Supervision) (Item 2.1.1)
 *   material, materials, material cost → Materials (Item 2.2)
 *   plant, machinery, all plant        → Plant & Machinery (Item 2.3)
 *   subcon, sub, subbie, subcontractor, subcontractors → Less : Cost - Subcontractor (Item 2.4)
 *   contract works, subbie/subcon/subcontractors contract works → -Contract Works (Item 2.4.1)
 *   vo, variation(s), subbie/subcon/subcontractors vo/variation(s) → -Variation (Item 2.4.2)
 *   claim(s), subbie/subcon/subcontractors claim(s) → -Claim (Item 2.4.3)
 *   labour, labor     → Manpower (Labour) (Item 2.5)
 *   rebar             → Reinforcement (Item 2.6)
 *   income, revenue   → Income (Item 1)
 *   profit            → Gross Profit (Item 3)
 *   loss              → Net Loss
 *
 * QUERY PRIORITY ORDER:
 *   Analyze → Detail → Total → Compare → Normal
 * ============================================================
 */

// Acronym mapping - comprehensive shortcut expansion
const ACRONYM_MAP: Record<string, string> = {
  // === Data Type shortcuts ===
  'gp': 'gross profit',
  'np': 'net profit',
  'net profit': 'net profit',

  // === Financial Type shortcuts (UPDATED per financial_type_map.csv v2) ===
  // NOTE: "budget" / "bt" now maps to "latest budget" (was "business plan")
  'bp': 'business plan',
  'business plan': 'business plan',
  'budget': 'latest budget',  // Changed: now maps to Latest Budget
  'bt': 'latest budget',      // Changed: now maps to Latest Budget
  'latest budget': 'latest budget',
  '1st working': '1st working budget',
  'first working': '1st working budget',
  '1wb': '1st working budget',
  'revision': 'latest budget',
  'rev': 'latest budget',
  'budget revision': 'latest budget',
  'rev as at': 'latest budget',
  'tender': 'budget tender',
  'budget tender': 'budget tender',
  'committed': 'committed cost',
  'committed cost': 'committed cost',
  'committed value': 'committed cost',
  'accrual': 'accrual',
  'accrued': 'accrual',
  'wip': 'wip',
  'audit': 'wip',
  'audit report': 'wip',
  'projection': 'projection',
  'projected': 'projection',
  'cf': 'cash flow',
  'cashflow': 'cash flow',
  'cash flow': 'cash flow',
  'cash': 'cash flow',

  // === Item / category shortcuts (Item_Code 2.1 - Preliminaries) ===
  'prelim': 'preliminaries',
  'preliminary': 'preliminaries',
  'preliminaries': 'preliminaries',

  // === Item / category shortcuts (Item_Code 2 - Less : Cost) ===
  'cost': 'less cost',
  'total cost': 'less cost',

  // === Item / category shortcuts (Item_Code 2.2 - Materials) ===
  'material': 'materials',
  'materials': 'materials',
  'material cost': 'materials',

  // === Item / category shortcuts (Item_Code 2.3 - Plant & Machinery) ===
  'plant': 'plant and machinery',
  'machinery': 'plant and machinery',
  'all plant': 'plant and machinery',

  // === Item / category shortcuts (Item_Code 2.4 - Subcontractor) ===
  'subcon': 'subcontractor',
  'sub': 'subcontractor',
  'subcontractor': 'subcontractor',
  'subcontractors': 'subcontractor',
  'subbie': 'subcontractor',

  // === Item / category shortcuts (Item_Code 2.4.1 - Contract works) ===
  'contract works': 'contract works',
  'subbie contract works': 'contract works',
  'subcon contract works': 'contract works',
  'subcontractors contract works': 'contract works',

  // === Item / category shortcuts (Item_Code 2.4.2 - Variation) ===
  'vo': 'variation',
  'variations': 'variation',
  'subbie vo': 'variation',
  'subcon vo': 'variation',
  'subcontractors vo': 'variation',
  'subbie variation': 'variation',
  'subcon variation': 'variation',
  'subcontractors variation': 'variation',
  'subbie variations': 'variation',
  'subcon variations': 'variation',
  'subcontractors variations': 'variation',

  // === Item / category shortcuts (Item_Code 2.4.3 - Claim) ===
  'claim': 'claim',
  'claims': 'claim',
  'subbie claim': 'claim',
  'subcon claim': 'claim',
  'subcontractors claim': 'claim',
  'subbie claims': 'claim',
  'subcon claims': 'claim',
  'subcontractors claims': 'claim',

  // === Item shortcuts from construction_headings_enriched.csv ===
  // Income items
  'revenue': 'total income',
  'income': 'total income',
  'total income': 'total income',
  'ocw': 'original contract value',
  'original contract': 'original contract value',
  'contract value': 'original contract value',
  'ps': 'provisional sum',
  'provisional sum': 'provisional sum',
  'provisional': 'provisional sum',
  'cpf': 'price fluctuation',
  'price fluctuation': 'price fluctuation',
  'mpf': 'mpf reimbursement',
  'nsc': 'nsc',
  'sa': 'special account income',
  'csd': 'csd income',
  'ld': 'liquidated damages',
  'liquidated damages': 'liquidated damages',
  'damages': 'liquidated damages',
  'advance': 'advance payment',
  'advance payment': 'advance payment',

  // Cost sub-items
  'rebar': 'rebar',
  'reinforcement': 'rebar',
  'concrete': 'concrete',
  'tile': 'tile granite marble',
  'granite': 'tile granite marble',
  'marble': 'tile granite marble',
  'diesel': 'fuel lubricant',
  'fuel': 'fuel lubricant',
  'depreciation': 'plant depreciation',
  'contra': 'contra charges',
  'contra charge': 'contra charges',
  'cc': 'contra charges',
  'contingency': 'contingency reserve',
  'defects': 'defects rectification',
  'rectification': 'defects rectification',
  'tender fee': 'tender fee',
  'incentive': 'incentive por bonus',
  'por bonus': 'incentive por bonus',
  'cpr': 'cpr penalty',
  'stretch': 'stretch target cost',

  // Prelim sub-items
  'supervision': 'management supervision',
  'staff': 'management supervision',
  'mgt supervision': 'management supervision',
  're': 'resident engineer staff',
  'resident engineer': 'resident engineer staff',
  'insurance': 'insurance bond',
  'bond': 'insurance bond',
  'site overhead': 'site overhead re',
  'interest': 'interest bank charges',
  'bank charge': 'interest bank charges',
  'messing': 'messing canteen',
  'canteen': 'messing canteen',
  'dsc': 'dsc',
  'levies': 'levies',
  'levy': 'levies',

  // Overhead/Recon
  'overhead': 'total overhead',
  'oh': 'total overhead',
  'recon': 'total reconciliation',
  'reconciliation': 'total reconciliation',

  // === Other synonyms ===
  'labour': 'manpower (labour)',
  'labor': 'manpower (labour)',
  'lab': 'labour',
  'profit': 'gross profit',
  'loss': 'net loss',
  'actual': 'actual cost',
  'ytd': 'year to date',
  'mtd': 'month to date',
}

function expandAcronyms(text: string): string {
  const words = text.toLowerCase().split(/\s+/)
  return words.map(word => ACRONYM_MAP[word] || word).join(' ')
}

// Stopwords that should NOT contribute to match scoring
// These are common words that appear in many Financial Types and create false matches
const STOPWORDS = new Set([
  'as', 'at', 'the', 'and', 'or', 'for', 'in', 'on', 'to', 'of', 'a', 'an',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
  'by', 'from', 'with', 'about', 'into', 'through', 'during', 'before',
  'after', 'above', 'below', 'between', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
  'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only',
  'own', 'same', 'so', 'than', 'too', 'very', 'can', 'just', 'but', 'now'
])

// ============================================
// Trend Context Cache (for Detail drill-down)
// ============================================
interface TrendContext {
  itemCode: string
  itemName: string
  sheetName: string
  financialType: string
  monthRange: Array<{ year: number; month: number }>
  monthCount: number
  project: string
  children: Array<{ code: string; name: string }>  // Cached children list
}

// Global cache for last Trend context (per project)
const trendContextCache: Map<string, TrendContext> = new Map()
let lastDetailPage: number = 0  // Track pagination for "more" command

// ============================================
// List Context Cache (for "list" + "more")
// ============================================
interface ListContext {
  project: string
  allItems: Array<{ code: string; name: string; tier: number }>  // All items with tier info
  timestamp: number
}

const listContextCache: Map<string, ListContext> = new Map()
const LIST_CACHE_TTL = 30 * 60 * 1000  // 30 minutes

// ============================================
// Compare Context Cache (for Detail drill-down)
// ============================================
interface CompareContext {
  finType1: string
  finType2: string
  targetSheet: string
  targetDataType: string | null
  project: string
  children: Array<{ code: string; name: string }>  // Cached children list
  // For compareByDate support
  isCompareByDate: boolean
  date1?: { month?: string | null; year?: string | null }
  date2?: { month?: string | null; year?: string | null }
  parentItemCode?: string  // Parent item code for finding children
  displayFinType?: string  // Short display name (e.g., "Cash Flow" instead of full Financial_Type)
  actualFinType?: string   // Actual Financial_Type from the data (e.g., "Cash Flow" from Cash Flow sheet)
}

// Global cache for last Compare context (per project)
const compareContextCache: Map<string, CompareContext> = new Map()
let lastCompareDetailPage: number = 0  // Track pagination for "more" command

// Primary keywords for Financial Type matching (10x weight)
// These are the KEY differentiators between Financial Types
// Maps canonical Financial_Type names to their user-facing keyword variants
// UPDATED per financial_type_map.csv v2 (Latest Budget, 1st Working Budget, etc.)
const FINANCIAL_TYPE_KEYWORDS: Record<string, string[]> = {
  'cash flow': ['cash flow', 'cashflow', 'cf'],
  'committed cost': ['committed', 'committed cost', 'committed value'],
  'projection': ['projection', 'projected'],
  'accrual': ['accrual', 'accrued'],
  'business plan': ['business plan', 'bp'],
  'latest budget': ['latest budget', 'budget', 'bt', 'revision', 'rev', 'rev as at', 'budget revision'],
  '1st working budget': ['1st working budget', '1st working', 'first working', '1wb'],
  'budget tender': ['budget tender', 'tender'],
  'wip': ['wip', 'audit', 'audit report'],
}

// Check if a word is a primary Financial Type keyword
function isFinancialTypeKeyword(word: string): boolean {
  const lowerWord = word.toLowerCase()
  for (const keywords of Object.values(FINANCIAL_TYPE_KEYWORDS)) {
    if (keywords.includes(lowerWord)) return true
  }
  return false
}

// Helper to convert Value to number safely
function toNumber(val: number | string): number {
  if (typeof val === 'number') return val
  return parseFloat(val) || 0
}

// Format a source reference for data traceability
// Output: [Sheet_Name, Financial_Type, Data_Type, Item_Code, Month, Year]
function formatSourceRef(row: FinancialRow): string {
  return `[${row.Sheet_Name}, ${row.Financial_Type}, ${row.Data_Type}, ${row.Item_Code}, ${row.Month}, ${row.Year}]`
}

interface FinancialRow {
  Year: string
  Month: string
  Sheet_Name: string
  Financial_Type: string
  Data_Type: string
  Item_Code: string
  Value: number | string
  _project?: string
  _rowIndex?: number  // Row number from flat.csv (0-indexed, +2 for header)
}

interface ProjectInfo {
  code: string
  name: string
  year: string
  month: string
  filename: string
  fileId?: string
}

interface FolderStructure {
  [year: string]: string[]
}

// Google Drive helper functions
async function getDriveService() {
  // For Vercel: use environment variable
  const credentials = process.env.GOOGLE_CREDENTIALS
  if (!credentials) {
    throw new Error('GOOGLE_CREDENTIALS not set')
  }

  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(credentials),
    scopes: ['https://www.googleapis.com/auth/drive.readonly']
  })

  return google.drive({ version: 'v3', auth })
}

async function findRootFolder(drive: any) {
  const res = await drive.files.list({
    q: "name='Ai Chatbot Knowledge Base' and mimeType='application/vnd.google-apps.folder' and trashed=false",
    fields: 'files(id, name)'
  })

  return res.data.files?.[0] || null
}

async function listYearFolders(drive: any, rootId: string) {
  const allFiles: any[] = []
  let pageToken: string | null = null

  do {
    const res: any = await drive.files.list({
      q: `'${rootId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name), nextPageToken',
      pageSize: 100,
      pageToken: pageToken || undefined
    })
    if (res.data.files) allFiles.push(...res.data.files)
    pageToken = res.data.nextPageToken || null
  } while (pageToken)

  return allFiles
}

async function listMonthFolders(drive: any, yearId: string) {
  const allFiles: any[] = []
  let pageToken: string | null = null

  do {
    const res: any = await drive.files.list({
      q: `'${yearId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name), nextPageToken',
      pageSize: 100,
      pageToken: pageToken || undefined
    })
    if (res.data.files) allFiles.push(...res.data.files)
    pageToken = res.data.nextPageToken || null
  } while (pageToken)

  return allFiles
}

async function listCsvFiles(drive: any, monthId: string) {
  const allFiles: any[] = []
  let pageToken: string | null = null

  do {
    const res: any = await drive.files.list({
      q: `'${monthId}' in parents and name contains '_flat.csv' and trashed=false`,
      fields: 'files(id, name), nextPageToken',
      pageSize: 100,
      pageToken: pageToken || undefined
    })
    if (res.data.files) allFiles.push(...res.data.files)
    pageToken = res.data.nextPageToken || null
  } while (pageToken)

  return allFiles
}

// Extract project code and name from filename
function extractProjectInfo(filename: string): { code: string | null; name: string } {
  const name = filename.replace('_flat_v5.csv', '').replace('_flat.csv', '')
  const match = name.match(/^(\d+)/)
  if (match) {
    const code = match[1]
    const projectName = name.slice(code.length).trim()
    const cleanName = projectName.replace(/\s*Financial\s*Report.*/i, '').trim()
    return { code, name: cleanName }
  }
  return { code: null, name }
}

// Get folder structure from Google Drive
async function getFolderStructure(): Promise<{ folders: FolderStructure; projects: Record<string, ProjectInfo>; error?: string }> {
  const folders: FolderStructure = {}
  const projects: Record<string, ProjectInfo> = {}

  try {
    const drive = await getDriveService()
    const rootFolder = await findRootFolder(drive)

    if (!rootFolder) {
      return { folders, projects, error: 'Folder "Ai Chatbot Knowledge Base" not found' }
    }

    console.log('[DEBUG] Root folder:', rootFolder)
    const yearFolders = await listYearFolders(drive, rootFolder.id!)
    console.log('[DEBUG] Year folders:', yearFolders.map((f: any) => f.name))

    for (const yearFolder of yearFolders) {
      const year = yearFolder.name!
      const monthFolders = await listMonthFolders(drive, yearFolder.id!)
      console.log(`[DEBUG] Year ${year} months:`, monthFolders.map((f: any) => f.name))

      for (const monthFolder of monthFolders) {
        const csvFiles = await listCsvFiles(drive, monthFolder.id!)
        console.log(`[DEBUG] ${year}/${monthFolder.name} CSVs:`, csvFiles.length, csvFiles.map((f: any) => f.name).slice(0, 3))

        if (csvFiles.length > 0) {
          if (!folders[year]) folders[year] = []
          if (!folders[year].includes(monthFolder.name!)) folders[year].push(monthFolder.name!)

          for (const file of csvFiles) {
            const { code, name } = extractProjectInfo(file.name!)
            if (code) {
              const key = `${year}-${monthFolder.name}-${code}`
              const existing = projects[key]
              const isV5 = file.name!.includes('_flat_v5.csv')
              // Prefer _flat_v5.csv over _flat.csv; otherwise keep existing
              if (!existing || isV5) {
                projects[key] = {
                  code,
                  name,
                  year,
                  month: monthFolder.name!,
                  filename: file.name!,
                  fileId: file.id!
                }
              }
            }
          }
        }
      }
    }
  } catch (error: any) {
    console.error('Error getting folder structure:', error)
    return { folders, projects, error: error.message || 'Unknown error' }
  }

  return { folders, projects }
}

// Load a single project CSV from Google Drive
async function loadProjectData(filename: string, year: string, month: string): Promise<FinancialRow[]> {
  try {
    const drive = await getDriveService()
    const rootFolder = await findRootFolder(drive)
    if (!rootFolder) return []

    const yearFolders = await listYearFolders(drive, rootFolder.id!)
    const yearFolder = yearFolders.find(f => f.name === year)
    if (!yearFolder) return []

    const monthFolders = await listMonthFolders(drive, yearFolder.id!)
    const monthFolder = monthFolders.find(f => f.name === month)
    if (!monthFolder) return []

    const csvFiles = await listCsvFiles(drive, monthFolder.id!)
    const targetFile = csvFiles.find(f => f.name === filename)
    if (!targetFile) return []

    // Download file
    const res = await drive.files.get({
      fileId: targetFile.id!,
      alt: 'media'
    }, { responseType: 'text' })

    // Parse CSV - columns are at fixed positions:
    // 0: Year, 1: Month, 2: Sheet_Name, 3: Financial_Type, 4: Item_Code, 5: Data_Type, 6: Value
    const lines = (res.data as string).split('\n').filter(line => line.trim())

    const { name } = extractProjectInfo(filename)
    const code = filename.match(/^(\d+)/)?.[1] || ''
    const projectLabel = `${code} - ${name}`

    const data: FinancialRow[] = []
    for (let i = 0; i < lines.length; i++) {
      // Handle quoted CSV values
      const values: string[] = []
      let inQuote = false
      let current = ''
      for (let j = 0; j < lines[i].length; j++) {
        const char = lines[i][j]
        if (char === '"') {
          inQuote = !inQuote
        } else if (char === ',' && !inQuote) {
          values.push(current.trim().replace(/"/g, ''))
          current = ''
        } else {
          current += char
        }
      }
      values.push(current.trim().replace(/"/g, ''))

      // Skip header row if present
      const firstValue = values[0]?.toLowerCase()
      if (i === 0 && (firstValue === 'year' || firstValue === 'sheet_name')) continue

      // Parse each column - columns are at fixed positions:
      // 0: Year, 1: Month, 2: Sheet_Name, 3: Financial_Type, 4: Item_Code, 5: Data_Type, 6: Value

      // Extract Data_Type directly from column 5 (not pattern matching)
      const dataType = values[5] || ''

      // Extract Item_Code from column 4
      const itemCode = values[4] || ''

      // Financial_Type from column 3
      const financialType = values[3] || ''

      // For Project Info (Financial_Type = "General"), keep values as strings (dates, percentages)
      // For financial data, parse as numbers
      // Value is always at column index 7 in the v5 CSV format:
      // Year,Month,Sheet_Name,Financial_Type,Item_Code,Friendly_Name,Category,Value,Match_Status,_source_file,_source_subfolder
      const rawValue = values[7] || ''
      let value: number | string

      if (financialType === 'General') {
        // Keep Project Info values as strings
        value = rawValue
      } else {
        // Parse financial values as numbers
        value = parseFloat(rawValue) || 0
      }

      const row: FinancialRow = {
        Year: values[0] || '',
        Month: values[1] || '',
        Sheet_Name: values[2] || '',
        Financial_Type: financialType,
        Data_Type: dataType || '',
        Item_Code: itemCode,
        Value: value,
        _project: projectLabel,
        _rowIndex: i + 2,  // +2 because row 0 is header, row 1 is first data row
      }
      data.push(row)
    }
    return data
  } catch (error) {
    console.error('Error loading project data:', error)
    return []
  }
}

// Calculate project metrics
function getProjectMetrics(data: FinancialRow[], project: string) {
  // Data is already filtered by project (single CSV file per project)
  // Just use the full dataset
  const projectData = data
  if (projectData.length === 0) {
    return {
      'Business Plan GP': 0,
      'Projected GP': 0,
      'WIP GP': 0,
      'Cash Flow': 0,
      'Start Date': 'N/A',
      'Complete Date': 'N/A',
      'Target Complete Date': 'N/A',
      'Time Consumed (%)': 'N/A',
      'Target Completed (%)': 'N/A'
    }
  }

  const gpFilter = (d: FinancialRow) => d.Item_Code === '3' && d.Data_Type?.toLowerCase().includes('gross profit')

  // Helper to convert Value to number safely
  const toNumber = (val: number | string): number => {
    if (typeof val === 'number') return val
    return parseFloat(val) || 0
  }

  const bp = projectData.filter(d =>
    d.Sheet_Name === 'Financial Status' &&
    d.Financial_Type?.toLowerCase().includes('business plan') &&
    gpFilter(d)
  ).reduce((sum, d) => sum + toNumber(d.Value), 0)

  const proj = projectData.filter(d =>
    d.Sheet_Name === 'Financial Status' &&
    d.Financial_Type?.toLowerCase().includes('projection') &&
    gpFilter(d)
  ).reduce((sum, d) => sum + toNumber(d.Value), 0)

  const wip = projectData.filter(d =>
    d.Sheet_Name === 'Financial Status' &&
    d.Financial_Type?.toLowerCase().includes('audit report') &&
    gpFilter(d)
  ).reduce((sum, d) => sum + toNumber(d.Value), 0)

  const cf = projectData.filter(d =>
    d.Sheet_Name === 'Financial Status' &&
    d.Financial_Type?.toLowerCase().includes('cash flow') &&
    gpFilter(d)
  ).reduce((sum, d) => sum + toNumber(d.Value), 0)

  // Extract Project Info (Financial_Type = "General")
  const projectInfo = projectData.filter(d => d.Financial_Type === 'General')

  const getProjectInfoValue = (dataType: string) => {
    const row = projectInfo.find(d => d.Data_Type === dataType)
    const val = row ? String(row.Value) : ''
    return (val && val !== 'Nil') ? val : 'N/A'
  }

  return {
    'Business Plan GP': bp,
    'Projected GP': proj,
    'WIP GP': wip,
    'Cash Flow': cf,
    'Start Date': getProjectInfoValue('Start Date'),
    'Complete Date': getProjectInfoValue('Complete Date'),
    'Target Complete Date': getProjectInfoValue('Target Complete Date'),
    'Time Consumed (%)': getProjectInfoValue('Time Consumed (%)'),
    'Target Completed (%)': getProjectInfoValue('Target Completed (%)')
  }
}

// Handle monthly category queries
function handleMonthlyCategory(data: FinancialRow[], project: string, question: string, month: string): string {
  const expandedQuestion = expandAcronyms(question).toLowerCase()

  const categoryMap: Record<string, string> = {
    'plant and machinery': '2.3',
    'preliminaries': '2.1',
    'materials': '2.2',
    'plant': '2.3',
    'machinery': '2.3',
    'labour': '2.4',
    'labor': '2.4',
    'manpower (labour) for works': '2.5',
    'manpower (labour)': '2.5',
    'manpower': '2.5',
    'subcontractor': '2.4',
    'subcontractors': '2.4',
    'subcon': '2.4',
    'subbie': '2.4',
    'staff': '2.6',
    'admin': '2.7',
    'administration': '2.7',
    'insurance': '2.8',
    'bond': '2.9',
    'others': '2.10',
    'other': '2.10',
    'contingency': '2.11',
  }

  if (!expandedQuestion.includes('monthly')) return ''

  let categoryPrefix = ''
  let categoryName = ''

  const sortedCategories = Object.entries(categoryMap).sort((a, b) => b[0].length - a[0].length)
  for (const [kw, prefix] of sortedCategories) {
    const pattern = new RegExp(`\\b${kw}\\b`, 'i')
    if (pattern.test(expandedQuestion)) {
      categoryPrefix = prefix
      categoryName = kw
      break
    }
  }

  if (!categoryPrefix) return ''

  const projectData = data.filter(d => d._project === project)

  const monthNames = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
  const monthAbbr = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

  let targetMonth = parseInt(month)
  for (let i = 0; i < monthNames.length; i++) {
    if (expandedQuestion.includes(monthNames[i]) || expandedQuestion.includes(monthAbbr[i])) {
      targetMonth = i + 1
      break
    }
  }

  const financialTypes = ['Projection', 'Committed Cost', 'Accrual', 'Cash Flow']
  const results: Record<string, number> = {}

  for (const ft of financialTypes) {
    const filtered = projectData.filter(d =>
      d.Sheet_Name === ft &&
      d.Month === String(targetMonth) &&
      (d.Item_Code.startsWith(categoryPrefix + '.') || d.Item_Code === categoryPrefix)
    )
    results[ft] = filtered.reduce((sum, d) => sum + toNumber(d.Value), 0)
  }

  const displayName = categoryName.charAt(0).toUpperCase() + categoryName.slice(1)
  let response = `## Monthly ${displayName} (${targetMonth}/${month}) ('000)\n\n`

  for (const [ft, value] of Object.entries(results)) {
    response += `- **${ft}:** $${value.toLocaleString()}\n`
  }

  return response
}

// ============================================
// New Query Logic (Revised)
// ============================================

interface ParsedQuery {
  year?: string
  month?: string
  sheetName?: string
  financialType?: string
  dataType?: string
  itemCode?: string
  monthsAgo?: number  // PHASE 2: for "last 3 months" type queries
  comparison?: string  // PHASE 2: for "vs", "compare" type queries
}

interface FuzzyResult {
  text: string
  candidates: Array<{
    id: number
    value: number | string
    score: number
    sheet: string
    financialType: string
    dataType: string
    itemCode: string
    month: string
    year: string
    matchedKeywords: string[]
    rowLabel?: string  // Row number from flat.csv (e.g., "5324", "5869")
  }>
}

// Parse date from question - maps "january 2025" or "2025 jan" or "jan" or "feb 25" or "1st month" or "last month" to month/year
function parseDate(question: string, defaultMonth: string): ParsedQuery {
  const monthNames = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
  const monthAbbr = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
  const monthMap: Record<string, string> = {}
  monthNames.forEach((name, i) => monthMap[name] = String(i + 1))
  monthAbbr.forEach((abbr, i) => monthMap[abbr] = String(i + 1))

  // Ordinal number map: 1st, 2nd, 3rd, etc.
  const ordinalMap: Record<string, string> = {
    '1st': '1', '2nd': '2', '3rd': '3', '4th': '4', '5th': '5', '6th': '6',
    '7th': '7', '8th': '8', '9th': '9', '10th': '10', '11th': '11', '12th': '12'
  }

  const result: ParsedQuery = {}
  const lowerQ = question.toLowerCase()
  const currentMonth = new Date().getMonth() + 1
  const currentYear = new Date().getFullYear()

  // === PHASE 2: Time Keywords ===
  // Handle "last month", "this month", "previous month", "last 3 months"
  if (lowerQ.includes('last month') || lowerQ.includes('previous month') || lowerQ.includes('prev month')) {
    const lastMonth = currentMonth === 1 ? 12 : currentMonth - 1
    const lastYear = currentMonth === 1 ? currentYear - 1 : currentYear
    result.month = String(lastMonth)
    result.year = String(lastYear)
    return result
  }
  
  if (lowerQ.includes('this month')) {
    result.month = String(currentMonth)
    result.year = String(currentYear)
    return result
  }

  // Handle "last 3 months", "last 6 months" (for aggregation - mark for special handling)
  const lastMonthsMatch = lowerQ.match(/last (\d+) months?/)
  if (lastMonthsMatch) {
    result.monthsAgo = parseInt(lastMonthsMatch[1])
    return result
  }

  // === PHASE 2: Comparison Queries ===
  // Handle "vs", "versus", "compare", "difference" for comparisons
  if (lowerQ.includes(' vs ') || lowerQ.includes(' versus ') || 
      lowerQ.includes(' compare ') || lowerQ.includes(' compared ') ||
      lowerQ.includes(' difference ')) {
    result.comparison = 'difference'
  }

  // Check for ordinal numbers first (1st, 2nd, 3rd... 12th)
  for (const [ordinal, monthNum] of Object.entries(ordinalMap)) {
    if (lowerQ.includes(ordinal)) {
      result.month = monthNum
      break
    }
  }

  // Find 4-digit year (2024, 2025, etc.)
  const yearMatch = lowerQ.match(/\b(20[2-4]\d)\b/)
  if (yearMatch) {
    result.year = yearMatch[1]
  }

  // Handle "M/YY" or "MM/YY" format like "2/25" or "02/25" → Feb 2025
  // This must be checked BEFORE 2-digit year
  const mmyyMatch = lowerQ.match(/(\d{1,2})\/(\d{2})\b/)
  if (mmyyMatch && !yearMatch) {
    const monthNum = mmyyMatch[1]
    const yearNum = mmyyMatch[2]
    // Validate month is 1-12
    const month = parseInt(monthNum)
    if (month >= 1 && month <= 12) {
      result.month = String(month)
      result.year = '20' + yearNum
    }
  }

  // Handle numeric month with 4-digit year: "10 2025" or "1 2026"
  // Pattern: standalone number (1-12) followed by space and 4-digit year
  const numericMonthYearMatch = lowerQ.match(/\b(\d{1,2})\s+(20[2-4]\d)\b/)
  if (numericMonthYearMatch) {
    const monthNum = parseInt(numericMonthYearMatch[1])
    const yearNum = numericMonthYearMatch[2]
    // Validate month is 1-12
    if (monthNum >= 1 && monthNum <= 12) {
      result.month = String(monthNum)
      result.year = yearNum
    }
  }

  // Find 2-digit year (24, 25, etc.) - only if preceded by space and not part of month name
  // "feb 25" should be Feb + 2025, not Feb + month 25
  const twoDigitYearMatch = lowerQ.match(/\b(\d{2})\b(?!.*\d{4})/)
  if (twoDigitYearMatch && !yearMatch && !result.year) {
    const year = parseInt(twoDigitYearMatch[1])
    if (year >= 20 && year <= 30) {
      result.year = '20' + twoDigitYearMatch[1]
    }
  }

  // Find month name or abbreviation - only if it doesn't conflict with year
  // Skip if we already found a numeric month
  if (!result.month) {
    for (let i = 0; i < monthNames.length; i++) {
      if (lowerQ.includes(monthNames[i]) || lowerQ.includes(monthAbbr[i])) {
        const monthNum = String(i + 1)
        // Only set month if it doesn't look like a year (e.g., don't treat "2025" as month 20)
        if (monthNum.length === 1 || (monthNum.length === 2 && monthNum !== '20' && monthNum !== '21' && monthNum !== '22' && monthNum !== '23')) {
          result.month = monthNum
        }
        break
      }
    }
  }

  // If no month found, use default month
  if (!result.month) {
    result.month = defaultMonth
  }

  return result
}

// Find closest match for a value against a list of candidates using Levenshtein distance
function findClosestMatch(input: string, candidates: string[]): string | null {
  if (!input || candidates.length === 0) return null

  const normalizedInput = input.toLowerCase().trim()
  let bestMatch: string | null = null
  let bestDistance = Infinity

  for (const candidate of candidates) {
    const normalizedCand = candidate.toLowerCase().trim()

    // Exact match - return immediately
    if (normalizedInput === normalizedCand) return candidate

    // Check for EXACT SUBSTRING match - input must appear as a WHOLE WORD in candidate
    // Split candidate into words and check if input matches any word
    const candWords = normalizedCand.split(/\s+/)
    let isWordMatch = false
    for (let i = 0; i < candWords.length; i++) {
      const word = candWords[i]
      // Input must match a candidate word EXACTLY, or be a substantial part (50%+) of that word
      if (word === normalizedInput) {
        isWordMatch = true
        break
      }
      // Check if word contains input OR input contains word (and input is substantial part)
      if (word.includes(normalizedInput)) {
        // Input is substring of word - only accept if input is at least 50% of the word
        if (normalizedInput.length >= word.length * 0.5) {
          isWordMatch = true
          break
        }
      }
    }

    if (isWordMatch) {
      // It's a word-level match
      const distance = Math.abs(normalizedCand.length - normalizedInput.length)
      if (distance < bestDistance) {
        bestDistance = distance
        bestMatch = candidate
      }
      continue
    }

    // For fuzzy matching (not substring), check character similarity
    const inputChars: Record<string, boolean> = {}
    for (let i = 0; i < normalizedInput.length; i++) {
      const c = normalizedInput[i]
      if (c !== ' ') inputChars[c] = true
    }
    const candChars: Record<string, boolean> = {}
    for (let i = 0; i < normalizedCand.length; i++) {
      const c = normalizedCand[i]
      if (c !== ' ') candChars[c] = true
    }
    let sharedChars = 0
    for (const c in inputChars) {
      if (candChars[c]) sharedChars++
    }
    const totalChars = Object.keys(inputChars).length + Object.keys(candChars).length - sharedChars
    const similarity = totalChars > 0 ? sharedChars / totalChars : 0

    // Only consider fuzzy match if at least 60% character similarity
    if (similarity < 0.6) continue

    // Levenshtein distance for fuzzy matching
    const distance = levenshteinDistance(normalizedInput, normalizedCand)
    if (distance < bestDistance) {
      bestDistance = distance
      bestMatch = candidate
    }
  }

  // Only return if reasonably close (word match OR very close fuzzy match)
  if (bestMatch && bestDistance <= normalizedInput.length / 2) {
    return bestMatch
  }
  return null
}

// Levenshtein distance calculation
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = []
  for (let i = 0; i <= b.length; i++) matrix[i] = [i]
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1]
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        )
      }
    }
  }
  return matrix[b.length][a.length]
}

// Format currency without decimals - e.g., $20.01 → $20
function formatCurrency(value: number): string {
  return `$${Math.round(value).toLocaleString()}`
}

// Get all unique values for a column
function getUniqueValues(data: FinancialRow[], project: string, field: keyof FinancialRow): string[] {
  const projectData = data.filter(d => d._project === project)
  const values = new Set<string>()
  projectData.forEach(row => {
    const val = row[field]
    if (val) values.add(String(val))
  })
  return Array.from(values)
}

// ============================================
// Trend Query Handler
// ============================================

// Mapping from user-facing sheet/type keywords to actual Sheet_Name values used in monthly data
const TREND_SHEET_MAP: Record<string, string[]> = {
  'projection': ['Projection', 'Projected Cost'],
  'projected': ['Projection', 'Projected Cost'],
  'accrual': ['Accrual'],
  'accrued': ['Accrual'],
  'cash flow': ['Cash Flow', 'Cashflow', 'Cash Flow Actual received & paid as at'],
  'cashflow': ['Cash Flow', 'Cashflow'],
  'cf': ['Cash Flow', 'Cashflow'],
  'committed': ['Committed Cost', 'Committed Value / Cost as at'],
  'committed cost': ['Committed Cost'],
  'committed value': ['Committed Cost'],
}

// Detect if a query is a Trend query
function isTrendQuery(question: string): boolean {
  const lowerQ = question.toLowerCase().trim()
  return lowerQ.startsWith('trend ')
}

// Parse a Trend query to extract sheet, metric/item, and month count
function parseTrendQuery(question: string): {
  sheetName: string | null
  dataTypeFilter: string | null
  itemCode: string | null
  monthCount: number
  rawMetric: string
} {
  const lowerQ = question.toLowerCase().trim()
  // Remove "trend" prefix
  const afterTrend = lowerQ.replace(/^trend\s+/, '').trim()

  // Expand acronyms in the remaining text
  const expanded = expandAcronyms(afterTrend)

  let sheetName: string | null = null
  let dataTypeFilter: string | null = null
  let itemCode: string | null = null
  let monthCount = 6 // default
  let rawMetric = afterTrend

  // Extract month count from end of query (e.g., "trend accrual preliminaries 3")
  const monthsMatch = expanded.match(/\s+(\d+)\s*(months?)?$/i)
  if (monthsMatch) {
    monthCount = parseInt(monthsMatch[1])
    if (monthCount < 1) monthCount = 1
    if (monthCount > 24) monthCount = 24
    rawMetric = afterTrend.replace(/\s+\d+\s*(months?)?$/i, '').trim()
  }

  // Re-expand after trimming month count
  const expandedClean = expandAcronyms(rawMetric)

  // === FEATURE 2: Detect standalone item codes (e.g., "2.1", "2.4.1") ===
  // Pattern: matches "2.1", "2.4.1", "1.2.3" but NOT standalone numbers like "10" or "2025"
  const itemCodePattern = /\b(\d+\.\d+(?:\.\d+)*)\b/
  const itemCodeMatch = expandedClean.match(itemCodePattern)

  if (itemCodeMatch) {
    itemCode = itemCodeMatch[1]
    // Remove item code from the query for further processing
    rawMetric = rawMetric.replace(itemCodeMatch[0], '').trim()
  }

  // Try to detect sheet/financial type from the query
  const sortedSheetEntries = Object.entries(TREND_SHEET_MAP).sort((a, b) => b[0].length - a[0].length)
  
  for (const [keyword, sheetCandidates] of sortedSheetEntries) {
    const pattern = new RegExp(`\\b${keyword.replace(/\s+/g, '\\s+')}\\b`, 'i')
    if (pattern.test(expandedClean)) {
      sheetName = sheetCandidates[0]
      break
    }
  }

  // Also check FINANCIAL_TYPE_KEYWORDS for sheet resolution
  if (!sheetName) {
    for (const [canonical, keywords] of Object.entries(FINANCIAL_TYPE_KEYWORDS)) {
      for (const kw of keywords) {
        const pattern = new RegExp(`\\b${kw.replace(/\s+/g, '\\s+')}\\b`, 'i')
        if (pattern.test(expandedClean)) {
          const mapped = TREND_SHEET_MAP[canonical] || TREND_SHEET_MAP[kw]
          if (mapped) {
            sheetName = mapped[0]
          } else {
            sheetName = canonical.charAt(0).toUpperCase() + canonical.slice(1)
          }
          break
        }
      }
      if (sheetName) break
    }
  }

  // Try to detect data type / item from query
  const sortedParentItems = Object.entries(PARENT_ITEM_MAP).sort((a, b) => b[0].length - a[0].length)
  for (const [keyword, info] of sortedParentItems) {
    const pattern = new RegExp(`\\b${keyword.replace(/\s+/g, '\\s+')}\\b`, 'i')
    if (pattern.test(expandedClean)) {
      itemCode = info.code
      dataTypeFilter = keyword
      break
    }
  }

  // Check for common metric keywords (gp, np, etc.)
  if (!dataTypeFilter) {
    const metricKeywords: Record<string, string> = {
      'gross profit': 'gross profit',
      'net profit': 'net profit',
      'gp': 'gross profit',
      'np': 'net profit',
      'income': 'income',
      'revenue': 'revenue',
      'cost': 'cost',
    }
    for (const [keyword, filter] of Object.entries(metricKeywords)) {
      if (expandedClean.includes(keyword)) {
        dataTypeFilter = filter
        break
      }
    }
  }

  return { sheetName, dataTypeFilter, itemCode, monthCount, rawMetric }
}

// Generate a list of (year, month) tuples going backwards from the report date
function getMonthRange(reportYear: number, reportMonth: number, count: number): Array<{ year: number; month: number }> {
  const result: Array<{ year: number; month: number }> = []
  let y = reportYear
  let m = reportMonth
  for (let i = 0; i < count; i++) {
    result.push({ year: y, month: m })
    m--
    if (m < 1) {
      m = 12
      y--
    }
  }
  return result.reverse()
}

// Handle a Trend query
function handleTrendQuery(data: FinancialRow[], project: string, question: string, defaultMonth: string): FuzzyResult | null {
  if (!isTrendQuery(question)) return null

  const parsed = parseTrendQuery(question)
  const projectData = data.filter(d => d._project === project)

  // === FEATURE 2: If item code was extracted, look up its Data_Type ===
  if (parsed.itemCode && !parsed.dataTypeFilter) {
    const itemRow = projectData.find(d => d.Item_Code === parsed.itemCode)
    if (itemRow) {
      parsed.dataTypeFilter = itemRow.Data_Type
    }
  }

  if (projectData.length === 0) {
    return { text: 'No data found for this project.', candidates: [] }
  }

  // Determine the report date from the data
  let reportYear = 0
  let reportMonth = 0
  
  // Try to get report date from General/Project Info
  const generalRows = projectData.filter(d => d.Financial_Type === 'General')
  const reportDateRow = generalRows.find(d => d.Data_Type === 'Report Date')
  if (reportDateRow) {
    const reportDateStr = String(reportDateRow.Value)
    const dateMatch = reportDateStr.match(/(\d{4})-(\d{1,2})/) || 
                      reportDateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/)
    if (dateMatch) {
      if (dateMatch[3]) {
        reportYear = parseInt(dateMatch[3])
        reportMonth = parseInt(dateMatch[2])
      } else {
        reportYear = parseInt(dateMatch[1])
        reportMonth = parseInt(dateMatch[2])
      }
    }
  }
  
  // Fallback: use the maximum year/month from actual data rows
  if (reportYear === 0) {
    for (const row of projectData) {
      if (row.Sheet_Name === 'Financial Status') continue
      const y = parseInt(row.Year) || 0
      const m = parseInt(row.Month) || 0
      if (y > reportYear || (y === reportYear && m > reportMonth)) {
        reportYear = y
        reportMonth = m
      }
    }
  }
  
  // Last fallback
  if (reportYear === 0) {
    reportYear = new Date().getFullYear()
    reportMonth = parseInt(defaultMonth) || new Date().getMonth() + 1
  }

  // Resolve the sheet name
  const availableSheets = Array.from(new Set(projectData.map(d => d.Sheet_Name)))
  let resolvedSheet: string | null = null
  
  if (parsed.sheetName) {
    resolvedSheet = availableSheets.find(s => s.toLowerCase() === parsed.sheetName!.toLowerCase()) || null
    
    if (!resolvedSheet) {
      resolvedSheet = availableSheets.find(s => 
        s.toLowerCase().includes(parsed.sheetName!.toLowerCase()) || 
        parsed.sheetName!.toLowerCase().includes(s.toLowerCase())
      ) || null
    }
    
    if (!resolvedSheet) {
      const expandedClean = expandAcronyms(parsed.rawMetric).toLowerCase()
      for (const [keyword, candidates] of Object.entries(TREND_SHEET_MAP)) {
        const pattern = new RegExp(`\\b${keyword.replace(/\s+/g, '\\s+')}\\b`, 'i')
        if (pattern.test(expandedClean)) {
          for (const candidate of candidates) {
            resolvedSheet = availableSheets.find(s => 
              s.toLowerCase() === candidate.toLowerCase() || 
              s.toLowerCase().includes(candidate.toLowerCase())
            ) || null
            if (resolvedSheet) break
          }
          if (resolvedSheet) break
        }
      }
    }
  }
  
  if (!resolvedSheet) {
    if (parsed.dataTypeFilter && ['gross profit', 'net profit'].includes(parsed.dataTypeFilter.toLowerCase())) {
      resolvedSheet = availableSheets.find(s => 
        s.toLowerCase().includes('projection') || s.toLowerCase().includes('projected')
      ) || null
    }
    
    if (!resolvedSheet) {
      const monthlySheetNames = availableSheets.filter(s => s !== 'Financial Status')
      if (monthlySheetNames.length > 0) {
        resolvedSheet = monthlySheetNames[0]
      }
    }
  }

  if (!resolvedSheet) {
    return {
      text: `❌ Could not determine which sheet to use for trend data.\n\nAvailable sheets: ${availableSheets.join(', ')}\n\nTry: "Trend Projection GP 6" or "Trend Accrual Preliminaries 3"`,
      candidates: []
    }
  }

  // Get the month range
  const monthRange = getMonthRange(reportYear, reportMonth, parsed.monthCount)

  // Filter data for the resolved sheet
  let sheetData = projectData.filter(d => d.Sheet_Name === resolvedSheet)

  // Apply data type filter
  if (parsed.dataTypeFilter) {
    const filterLower = parsed.dataTypeFilter.toLowerCase()
    
    if (parsed.itemCode) {
      sheetData = sheetData.filter(d => d.Item_Code === parsed.itemCode)
    } else {
      sheetData = sheetData.filter(d => d.Data_Type.toLowerCase().includes(filterLower))
    }
  }

  // IMPORTANT: Never sum multiple rows - always find the BEST single match
  // If multiple rows match, pick the one with the shortest Item_Code (most general/parent level)
  if (sheetData.length > 0) {
    // Get unique Item_Codes from matching rows
    const uniqueItemCodes = Array.from(new Set(sheetData.map(d => d.Item_Code)))
    
    if (uniqueItemCodes.length > 1) {
      // Sort by Item_Code length (shortest first = parent level)
      // Then by numeric value
      uniqueItemCodes.sort((a, b) => {
        const aParts = a.split('.').map(Number)
        const bParts = b.split('.').map(Number)
        // First sort by number of parts (fewer = more general)
        if (aParts.length !== bParts.length) {
          return aParts.length - bParts.length
        }
        // Then by numeric value
        for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
          const diff = (aParts[i] || 0) - (bParts[i] || 0)
          if (diff !== 0) return diff
        }
        return 0
      })
      
      // Pick the first (shortest/most general) Item_Code
      const bestItemCode = uniqueItemCodes[0]
      sheetData = sheetData.filter(d => d.Item_Code === bestItemCode)
    }
  }

  if (sheetData.length === 0) {
    const allDataTypes = Array.from(new Set(
      projectData.filter(d => d.Sheet_Name === resolvedSheet).map(d => `${d.Item_Code}: ${d.Data_Type}`)
    )).sort((a, b) => {
      // Sort by item code numerically (e.g., 2.10 should come after 2.9)
      const codeA = a.split(':')[0]
      const codeB = b.split(':')[0]
      const partsA = codeA.split('.').map(Number)
      const partsB = codeB.split('.').map(Number)
      for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
        const diff = (partsA[i] || 0) - (partsB[i] || 0)
        if (diff !== 0) return diff
      }
      return 0
    })

    let msg = `❌ No matching data found in "${resolvedSheet}" sheet`
    if (parsed.dataTypeFilter) msg += ` for "${parsed.dataTypeFilter}"`
    msg += '.\n\n'
    msg += `**Available items in ${resolvedSheet}:**\n`
    msg += allDataTypes.slice(0, 20).map(dt => `• ${dt}`).join('\n')
    if (allDataTypes.length > 20) msg += `\n• ... and ${allDataTypes.length - 20} more`
    
    return { text: msg, candidates: [] }
  }

  const matchedDataType = sheetData[0]?.Data_Type || parsed.dataTypeFilter || 'Unknown'
  const matchedItemCode = parsed.itemCode || sheetData[0]?.Item_Code || ''

  // Collect values for each month
  // IMPORTANT: Never sum - always take the single row's value
  const trendData: Array<{ year: number; month: number; value: number; hasData: boolean; rows: FinancialRow[] }> = []

  for (const { year, month } of monthRange) {
    const monthRows = sheetData.filter(d => 
      parseInt(d.Year) === year && parseInt(d.Month) === month
    )
    
    if (monthRows.length > 0) {
      // Never sum - always take the first (and only) row's value
      const value = toNumber(monthRows[0].Value)
      trendData.push({ year, month, value, hasData: true, rows: [monthRows[0]] })
    } else {
      trendData.push({ year, month, value: 0, hasData: false, rows: [] })
    }
  }

  const hasAnyData = trendData.some(d => d.hasData)
  if (!hasAnyData) {
    return {
      text: `❌ No trend data found for the requested ${parsed.monthCount} months.\n\nThe data may not contain monthly records for this date range.`,
      candidates: []
    }
  }

  const monthNames = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const itemLabel = matchedItemCode ? ` (Item ${matchedItemCode})` : ''
  
  const dataPoints = trendData.filter(d => d.hasData)
  const firstValue = dataPoints.length > 0 ? dataPoints[0].value : 0
  const lastValue = dataPoints.length > 0 ? dataPoints[dataPoints.length - 1].value : 0
  const trendDiff = lastValue - firstValue
  const trendPct = firstValue !== 0 ? (trendDiff / Math.abs(firstValue)) * 100 : 0
  const trendArrow = trendDiff > 0 ? '↑' : trendDiff < 0 ? '↓' : '→'
  const trendSign = trendDiff > 0 ? '+' : ''

  let response = `## Trend: ${matchedDataType}${itemLabel} (Last ${parsed.monthCount} Months)\n\n`
  response += `**Sheet:** ${resolvedSheet}\n`
  response += `**Period:** ${monthNames[monthRange[0].month]} ${monthRange[0].year} → ${monthNames[monthRange[monthRange.length-1].month]} ${monthRange[monthRange.length-1].year}\n\n`

  response += `| Month | ${matchedDataType} ('000) |\n`
  response += `|-------|${'-'.repeat(Math.max(matchedDataType.length + 8, 20))}|\n`

  for (const point of trendData) {
    const monthLabel = `${monthNames[point.month]} ${point.year}`
    if (point.hasData) {
      const sourceRef = point.rows.length === 1 
        ? ` ${formatSourceRef(point.rows[0])}` 
        : point.rows.length > 1 
          ? ` [${point.rows[0].Sheet_Name}, ${point.rows[0].Financial_Type}, ${point.rows[0].Data_Type}, ${point.rows[0].Item_Code}, ${point.month}, ${point.year}]`
          : ''
      response += `| ${monthLabel} | ${formatCurrency(point.value)}${sourceRef} |\n`
    } else {
      response += `| ${monthLabel} | — |\n`
    }
  }

  response += `\n**Trend:** ${trendArrow} ${formatCurrency(Math.abs(trendDiff))} (${trendSign}${trendPct.toFixed(1)}%)\n`
  response += `\n*Values in thousands ('000)*`

  // Save context for Detail drill-down
  // Find children items (one level down)
  const children: Array<{ code: string; name: string }> = []
  const childPrefix = matchedItemCode + '.'
  const seenChildCodes = new Set<string>()
  
  for (const row of projectData) {
    if (row.Sheet_Name === resolvedSheet && row.Item_Code.startsWith(childPrefix)) {
      // Get direct child only (e.g., "2.1" not "2.1.1" when parent is "2")
      const remaining = row.Item_Code.slice(childPrefix.length)
      const nextDot = remaining.indexOf('.')
      const childCode = nextDot === -1 ? row.Item_Code : row.Item_Code.slice(0, childPrefix.length + nextDot)
      
      if (!seenChildCodes.has(childCode)) {
        seenChildCodes.add(childCode)
        children.push({ code: childCode, name: row.Data_Type })
      }
    }
  }
  
  // Sort children by Item_Code
  children.sort((a, b) => {
    const aParts = a.code.split('.').map(Number)
    const bParts = b.code.split('.').map(Number)
    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
      const diff = (aParts[i] || 0) - (bParts[i] || 0)
      if (diff !== 0) return diff
    }
    return 0
  })

  // Clear other contexts so "detail"/"more" after Trend goes to Trend handler
  compareContextCache.delete(project)
  listContextCache.delete(project)

  trendContextCache.set(project, {
    itemCode: matchedItemCode,
    itemName: matchedDataType,
    sheetName: resolvedSheet,
    financialType: sheetData[0]?.Financial_Type || '',
    monthRange,
    monthCount: parsed.monthCount,
    project,
    children
  })

  return { text: response, candidates: [] }
}

// ============================================
// Detail Trend Handler (drill-down from Trend)
// ============================================

function handleDetailTrend(
  data: FinancialRow[], 
  project: string, 
  question: string
): FuzzyResult | null {
  const lowerQ = question.toLowerCase().trim()
  
  // Check if it's a detail/more command
  const isDetail = lowerQ === 'detail'
  const isMore = lowerQ === 'more'
  const detailMatch = lowerQ.match(/^detail\s+(\d+)$/)
  
  if (!isDetail && !isMore && !detailMatch) return null
  
  const context = trendContextCache.get(project)
  if (!context) {
    return null  // Let other detail handlers (Compare, Analyze) try
  }

  // Handle "detail N" - drill down into specific child
  if (detailMatch) {
    const childIndex = parseInt(detailMatch[1]) - 1
    if (childIndex < 0 || childIndex >= context.children.length) {
      return {
        text: `❌ Invalid detail number. Please use a number between 1 and ${context.children.length}.`,
        candidates: []
      }
    }
    
    const selectedChild = context.children[childIndex]
    const projectData = data.filter(d => d._project === project)
    
    // Find children of the selected child
    const grandChildren: Array<{ code: string; name: string }> = []
    const grandChildPrefix = selectedChild.code + '.'
    const seenGrandChildCodes = new Set<string>()
    
    for (const row of projectData) {
      if (row.Sheet_Name === context.sheetName && row.Item_Code.startsWith(grandChildPrefix)) {
        const remaining = row.Item_Code.slice(grandChildPrefix.length)
        const nextDot = remaining.indexOf('.')
        const grandChildCode = nextDot === -1 ? row.Item_Code : row.Item_Code.slice(0, grandChildPrefix.length + nextDot)
        
        if (!seenGrandChildCodes.has(grandChildCode)) {
          seenGrandChildCodes.add(grandChildCode)
          grandChildren.push({ code: grandChildCode, name: row.Data_Type })
        }
      }
    }
    
    if (grandChildren.length === 0) {
      return {
        text: `❌ No sub-items found for Item ${selectedChild.code} (${selectedChild.name}). This is a leaf-level item.`,
        candidates: []
      }
    }
    
    // Sort grandChildren
    grandChildren.sort((a, b) => {
      const aParts = a.code.split('.').map(Number)
      const bParts = b.code.split('.').map(Number)
      for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
        const diff = (aParts[i] || 0) - (bParts[i] || 0)
        if (diff !== 0) return diff
      }
      return 0
    })
    
    // Update context to the selected child
    context.itemCode = selectedChild.code
    context.itemName = selectedChild.name
    context.children = grandChildren
    lastDetailPage = 0
    
    // Fall through to display the children
  }

  // Handle "detail" or "more" - show children with pagination
  const pageSize = 20
  const startIndex = isMore ? (lastDetailPage + 1) * pageSize : 0
  const page = isMore ? lastDetailPage + 1 : 0
  lastDetailPage = page
  
  if (startIndex >= context.children.length) {
    return {
      text: '❌ No more sub-items to display.',
      candidates: []
    }
  }

  const childrenToShow = context.children.slice(startIndex, startIndex + pageSize)
  const hasMore = startIndex + pageSize < context.children.length

  const projectData = data.filter(d => d._project === project)
  const monthNames = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

  let response = `## Detail: ${context.itemName} (Item ${context.itemCode}) - Sub-Items\n\n`
  response += `**Sheet:** ${context.sheetName}\n`
  response += `**Period:** ${monthNames[context.monthRange[0].month]} ${context.monthRange[0].year} → ${monthNames[context.monthRange[context.monthRange.length-1].month]} ${context.monthRange[context.monthRange.length-1].year}\n\n`

  if (context.children.length === 0) {
    return {
      text: `❌ No sub-items found for Item ${context.itemCode} (${context.itemName}). This is a leaf-level item.`,
      candidates: []
    }
  }

  let tableIndex = startIndex
  for (const child of childrenToShow) {
    tableIndex++
    response += `### [${tableIndex}] Item ${child.code} - ${child.name}\n`
    response += `| Month | Value ('000) |\n`
    response += `|-------|-------------|\n`

    for (const { year, month } of context.monthRange) {
      const monthRows = projectData.filter(d => 
        d.Sheet_Name === context.sheetName &&
        d.Item_Code === child.code &&
        parseInt(d.Year) === year &&
        parseInt(d.Month) === month
      )
      
      const monthLabel = `${monthNames[month]} ${year}`
      if (monthRows.length > 0) {
        const value = toNumber(monthRows[0].Value)
        const sourceRef = ` ${formatSourceRef(monthRows[0])}`
        response += `| ${monthLabel} | ${formatCurrency(value)}${sourceRef} |\n`
      } else {
        response += `| ${monthLabel} | — |\n`
      }
    }
    response += '\n'
  }

  // Add navigation hints
  response += `---\n`
  if (hasMore) {
    response += `💡 Type **'more'** for next ${Math.min(pageSize, context.children.length - startIndex - pageSize)} sub-items\n`
  }
  response += `💡 Type **'detail N'** to drill down into sub-item N (show its children)\n`
  response += `*Showing ${startIndex + 1}-${startIndex + childrenToShow.length} of ${context.children.length} sub-items*`

  return { text: response, candidates: [] }
}

// ============================================
// Detail Compare Handler (drill-down from Compare)
// ============================================

function handleDetailCompare(
  data: FinancialRow[], 
  project: string, 
  question: string,
  defaultMonth: string
): FuzzyResult | null {
  const lowerQ = question.toLowerCase().trim()
  
  // Only handle "detail" or "more" after a compare query (not "detail N" which goes to Trend)
  // But we need to check if there's a Compare context first
  const context = compareContextCache.get(project)
  if (!context) return null
  
  const isDetail = lowerQ === 'detail'
  const isMore = lowerQ === 'more'
  const detailMatch = lowerQ.match(/^detail\s+(\d+)$/)
  
  if (!isDetail && !isMore && !detailMatch) return null

  const projectData = data.filter(d => d._project === project)

  // Handle "detail N" - drill down into specific child's sub-items
  if (detailMatch) {
    const childIndex = parseInt(detailMatch[1]) - 1
    if (childIndex < 0 || childIndex >= context.children.length) {
      return {
        text: `❌ Invalid detail number. Please use a number between 1 and ${context.children.length}.`,
        candidates: []
      }
    }

    const selectedChild = context.children[childIndex]

    // Find children of the selected child
    const grandChildren: Array<{ code: string; name: string }> = []
    const grandChildPrefix = selectedChild.code + '.'
    const seenCodes = new Set<string>()

    for (const row of projectData) {
      if (row.Sheet_Name === context.targetSheet && row.Item_Code.startsWith(grandChildPrefix)) {
        const remaining = row.Item_Code.slice(grandChildPrefix.length)
        // Only direct children (no further dots)
        if (!remaining.includes('.') && !seenCodes.has(row.Item_Code)) {
          seenCodes.add(row.Item_Code)
          grandChildren.push({ code: row.Item_Code, name: row.Data_Type })
        }
      }
    }

    if (grandChildren.length === 0) {
      return {
        text: `❌ No sub-items found for Item ${selectedChild.code} (${selectedChild.name}). This is a leaf-level item.`,
        candidates: []
      }
    }

    // Sort by Item_Code
    grandChildren.sort((a, b) => {
      const aParts = a.code.split('.').map(Number)
      const bParts = b.code.split('.').map(Number)
      for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
        const diff = (aParts[i] || 0) - (bParts[i] || 0)
        if (diff !== 0) return diff
      }
      return 0
    })

    // Update context to drill into this child
    context.targetDataType = selectedChild.name
    context.parentItemCode = selectedChild.code
    context.children = grandChildren
    lastCompareDetailPage = 0
    // Fall through to display
  }
  
  // Handle pagination
  const pageSize = 20
  const startIndex = isMore ? (lastCompareDetailPage + 1) * pageSize : 0
  const page = isMore ? lastCompareDetailPage + 1 : 0
  lastCompareDetailPage = page
  
  if (startIndex >= context.children.length) {
    return {
      text: '❌ No more sub-items to display.',
      candidates: []
    }
  }

  const childrenToShow = context.children.slice(startIndex, startIndex + pageSize)
  const hasMore = startIndex + pageSize < context.children.length

  // Build comparison labels based on comparison type
  // Use displayFinType for friendly labels (e.g., "Cash Flow" not "Cash Flow Actual received & paid as at")
  let label1: string, label2: string
  if (context.isCompareByDate && context.date1 && context.date2) {
    const monthNames = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    const m1 = context.date1.month ? monthNames[parseInt(context.date1.month)] : ''
    const y1 = context.date1.year || ''
    const m2 = context.date2.month ? monthNames[parseInt(context.date2.month)] : ''
    const y2 = context.date2.year || ''
    const displayName = context.displayFinType || context.finType1
    label1 = `${displayName} (${m1} ${y1})`.trim()
    label2 = `${displayName} (${m2} ${y2})`.trim()
  } else {
    label1 = context.finType1
    label2 = context.finType2
  }

  // Helper: match Financial_Type flexibly (exact OR contains)
  // Needed because Cash Flow sheet has Financial_Type="Cash Flow" but
  // matchFinancialType returns "Cash Flow Actual received & paid as at"
  // NOTE: actualFinType is only used for compareByDate (same type, different dates)
  // For compareByFinType, we must NOT leak actualFinType across both sides
  const matchFinType = (rowFinType: string, targetFinType: string): boolean => {
    if (rowFinType === targetFinType) return true
    // Only use actualFinType for compareByDate (both sides are the same type)
    if (context.isCompareByDate && context.actualFinType && rowFinType === context.actualFinType) return true
    // Contains matching as fallback — but only if one is a clear substring of the other
    // and they share meaningful keywords (not just short words)
    const rowLower = rowFinType.toLowerCase()
    const targetLower = targetFinType.toLowerCase()
    // Only match if the shorter string is at least 60% of the longer string length
    // This prevents "Cash Flow" matching "Cash Flow Actual received & paid as at" incorrectly
    if (rowLower === targetLower) return true
    const shorter = rowLower.length < targetLower.length ? rowLower : targetLower
    const longer = rowLower.length < targetLower.length ? targetLower : rowLower
    if (longer.includes(shorter) && shorter.length >= longer.length * 0.6) return true
    return false
  }

  let response = `## Detail: Comparing Sub-Items\n\n`
  response += `**Comparing:** ${label1} vs ${label2}\n`
  response += `**Metric:** ${context.targetDataType || 'All items'}\n\n`

  let tableIndex = startIndex
  for (const child of childrenToShow) {
    tableIndex++
    
    let filtered1: FinancialRow[]
    let filtered2: FinancialRow[]
    
    if (context.isCompareByDate && context.date1 && context.date2) {
      // Compare by date: same Financial_Type, different dates
      filtered1 = projectData.filter(d => 
        d.Sheet_Name === context.targetSheet &&
        matchFinType(d.Financial_Type, context.finType1) &&
        d.Item_Code === child.code &&
        (context.date1!.month ? d.Month === context.date1!.month : true) &&
        (context.date1!.year ? d.Year === context.date1!.year : true)
      )
      filtered2 = projectData.filter(d => 
        d.Sheet_Name === context.targetSheet &&
        matchFinType(d.Financial_Type, context.finType1) &&
        d.Item_Code === child.code &&
        (context.date2!.month ? d.Month === context.date2!.month : true) &&
        (context.date2!.year ? d.Year === context.date2!.year : true)
      )
    } else {
      // Compare by Financial_Type: different types, optionally filtered by date
      filtered1 = projectData.filter(d => 
        d.Sheet_Name === context.targetSheet &&
        matchFinType(d.Financial_Type, context.finType1) &&
        d.Item_Code === child.code
      )
      filtered2 = projectData.filter(d => 
        d.Sheet_Name === context.targetSheet &&
        matchFinType(d.Financial_Type, context.finType2) &&
        d.Item_Code === child.code
      )
    }
    
    const value1 = filtered1.reduce((sum, d) => sum + toNumber(d.Value), 0)
    const value2 = filtered2.reduce((sum, d) => sum + toNumber(d.Value), 0)
    
    if (value1 === 0 && value2 === 0) continue  // Skip items with no data
    
    const diff = value1 - value2
    const absDiff = Math.abs(diff)
    const pctChange = value2 !== 0 ? (diff / Math.abs(value2)) * 100 : 0
    const arrow = diff > 0 ? '↑' : diff < 0 ? '↓' : '→'
    const sign = diff > 0 ? '+' : ''
    
    response += `### [${tableIndex}] Item ${child.code} - ${child.name}\n`
    response += `| Type | Value ('000) |\n`
    response += `|------|-------------|\n`
    
    const sourceRef1 = filtered1.length > 0 ? ` ${formatSourceRef(filtered1[0])}` : ''
    const sourceRef2 = filtered2.length > 0 ? ` ${formatSourceRef(filtered2[0])}` : ''
    
    response += `| ${label1} | ${formatCurrency(value1)}${sourceRef1} |\n`
    response += `| ${label2} | ${formatCurrency(value2)}${sourceRef2} |\n`
    response += `| Diff | ${arrow} ${formatCurrency(absDiff)} (${sign}${pctChange.toFixed(1)}%) |\n\n`
  }

  // Add navigation hints
  response += `---\n`
  if (hasMore) {
    response += `💡 Type **'more'** for next ${Math.min(pageSize, context.children.length - startIndex - pageSize)} sub-items\n`
  }
  response += `*Showing ${startIndex + 1}-${startIndex + childrenToShow.length} of ${context.children.length} sub-items*`

  return { text: response, candidates: [] }
}

// ============================================
// List Query Handler
// ============================================

// Detect if a query is a List query
function isListQuery(question: string): boolean {
  const lowerQ = question.toLowerCase().trim()
  return lowerQ === 'list' || lowerQ === 'list all' || lowerQ.startsWith('list ')
}

// Get tier level from item code (e.g., "2.1.3" → 3, "2.1" → 2, "2" → 1)
function getTierLevel(itemCode: string): number {
  return itemCode.split('.').length
}

// Handle a List query
function handleListQuery(data: FinancialRow[], project: string, question: string): FuzzyResult | null {
  if (!isListQuery(question)) return null

  const lowerQ = question.toLowerCase().trim()
  const showAll = lowerQ === 'list all'

  const projectData = data.filter(d => d._project === project)

  if (projectData.length === 0) {
    return { text: 'No data found for this project.', candidates: [] }
  }

  // Get unique Item_Code + Data_Type pairs from Financial Status sheet (most complete)
  let sourceData = projectData.filter(d => d.Sheet_Name === 'Financial Status')

  // Fallback to any sheet if Financial Status is empty
  if (sourceData.length === 0) {
    sourceData = projectData
  }

  // Filter out non-financial metadata items (Project Code, Report Date, etc.)
  // Only keep items with numeric Item_Codes (e.g., "1", "2.1", "2.4.1")
  const isNumericItemCode = (code: string): boolean => /^\d+(\.\d+)*$/.test(code)

  // Build unique items map
  const itemsMap = new Map<string, { code: string; name: string; tier: number }>()

  for (const row of sourceData) {
    if (!row.Item_Code || !row.Data_Type) continue
    if (!isNumericItemCode(row.Item_Code)) continue  // Skip non-numeric codes

    const code = row.Item_Code
    if (!itemsMap.has(code)) {
      itemsMap.set(code, {
        code,
        name: row.Data_Type,
        tier: getTierLevel(code)
      })
    }
  }

  // Convert to array and sort by Item_Code numerically
  const allItems = Array.from(itemsMap.values()).sort((a, b) => {
    const partsA = a.code.split('.').map(Number)
    const partsB = b.code.split('.').map(Number)
    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
      const diff = (partsA[i] || 0) - (partsB[i] || 0)
      if (diff !== 0) return diff
    }
    return 0
  })

  // Clear other contexts so "more" after list goes to list handler
  trendContextCache.delete(project)
  compareContextCache.delete(project)

  // Save to cache for "more" command
  listContextCache.set(project, {
    project,
    allItems,
    timestamp: Date.now()
  })

  // Determine max tier to show
  const maxTier = showAll ? 4 : 2  // "list all" shows all, "list" shows top 2 tiers

  // Build hierarchical display
  let response = `## Financial Headings\n\n`

  // Group items by parent for hierarchical display
  const itemsByParent = new Map<string, typeof allItems>()

  for (const item of allItems) {
    if (item.tier === 1) {
      if (!itemsByParent.has('')) itemsByParent.set('', [])
      itemsByParent.get('')!.push(item)
    } else {
      const parentCode = item.code.split('.').slice(0, -1).join('.')
      if (!itemsByParent.has(parentCode)) itemsByParent.set(parentCode, [])
      itemsByParent.get(parentCode)!.push(item)
    }
  }

  // Helper function to display items recursively
  const displayItems = (parentCode: string, indent: number, maxTierLevel: number): string => {
    const items = itemsByParent.get(parentCode) || []
    let output = ''
    const prefix = '  '.repeat(indent)

    for (const item of items) {
      if (item.tier > maxTierLevel) continue

      // Format: "  2.1 - Less : Cost - Preliminaries"
      output += `${prefix}${item.code} - ${item.name}\n`

      // Recursively show children if within tier limit
      if (item.tier < maxTierLevel) {
        output += displayItems(item.code, indent + 1, maxTierLevel)
      }
    }

    return output
  }

  // Display top-level items (tier 1) with their children
  const tier1Items = allItems.filter(item => item.tier === 1)

  for (const tier1 of tier1Items) {
    if (tier1.tier > maxTier) continue

    // Add tier 1 as heading
    response += `### ${tier1.name} (Item ${tier1.code})\n`

    // Add tier 2 items under this tier 1
    const tier2Items = allItems.filter(item => 
      item.tier === 2 && item.code.startsWith(tier1.code + '.')
    )

    // For items without children (e.g., Item 3 Gross Profit, Item 7 Net Profit),
    // show a self-referencing entry so users know they can query it
    if (tier2Items.length === 0) {
      // Extract a short display name from the Data_Type
      const shortName = tier1.name.split('(')[0].trim()
      response += `  ${tier1.code} - ${shortName}\n`
    }

    for (const tier2 of tier2Items) {
      if (tier2.tier > maxTier) continue
      response += `  ${tier2.code} - ${tier2.name}\n`

      // Add tier 3+ if showing all
      if (showAll) {
        const childItems = allItems.filter(item =>
          item.tier > 2 && item.code.startsWith(tier2.code + '.')
        )
        for (const child of childItems) {
          if (child.tier > maxTier) continue
          const indent = '  '.repeat(child.tier)
          response += `${indent}${child.code} - ${child.name}\n`
        }
      }
    }

    response += '\n'
  }

  // Add hint for "more" command
  if (!showAll) {
    response += `💡 Type **'list all'** or **'more'** to see all sub-items (3rd and 4th tier)\n`
  } else {
    response += `*Showing all ${allItems.length} items*\n`
  }

  return { text: response, candidates: [] }
}

// Handle "more" after list
function handleListMore(data: FinancialRow[], project: string, question: string): FuzzyResult | null {
  const lowerQ = question.toLowerCase().trim()

  if (lowerQ !== 'more') return null

  // Check if there's a list context
  const context = listContextCache.get(project)

  if (!context || (Date.now() - context.timestamp > LIST_CACHE_TTL)) {
    // No list context - might be for compare/trend detail
    return null
  }

  // Re-run list query with all tiers
  return handleListQuery(data, project, 'list all')
}

// ============================================
// Comparison Query Handler
// ============================================

// Detect if a query is a comparison query and extract the two sides
function isComparisonQuery(question: string): boolean {
  const lowerQ = question.toLowerCase()
  return (
    lowerQ.includes(' vs ') || lowerQ.includes(' versus ') ||
    lowerQ.includes('compare ') || lowerQ.includes('compared ') ||
    lowerQ.includes('comparison ') ||
    // "X with Y" pattern (but only if combined with financial terms)
    (lowerQ.includes(' with ') && (
      lowerQ.includes('projected') || lowerQ.includes('projection') ||
      lowerQ.includes('business plan') || lowerQ.includes('budget') ||
      lowerQ.includes('wip') || lowerQ.includes('audit') ||
      lowerQ.includes('cash flow') || lowerQ.includes('actual') ||
      lowerQ.includes('tender') || lowerQ.includes('committed') ||
      lowerQ.includes('gp') || lowerQ.includes('np') ||
      lowerQ.includes('gross profit') || lowerQ.includes('net profit')
    ))
  )
}

// Extract two Financial Type keywords from a comparison query
// e.g. "compare projected gp with business plan gp" → ["projection", "business plan"]
// e.g. "projected gp vs budget gp" → ["projection", "business plan"]
function extractComparisonParts(expandedQuestion: string): { side1: string; side2: string; metric: string } | null {
  const lowerQ = expandedQuestion.toLowerCase()

  // Split by comparison keywords
  let parts: string[] = []
  if (lowerQ.includes(' vs ')) {
    parts = lowerQ.split(' vs ')
  } else if (lowerQ.includes(' versus ')) {
    parts = lowerQ.split(' versus ')
  } else if (lowerQ.includes(' compared to ')) {
    parts = lowerQ.split(' compared to ')
  } else if (lowerQ.includes(' compared with ')) {
    parts = lowerQ.split(' compared with ')
  } else if (lowerQ.match(/compare\s+(.+?)\s+with\s+(.+)/)) {
    const match = lowerQ.match(/compare\s+(.+?)\s+with\s+(.+)/)!
    parts = [match[1], match[2]]
  } else if (lowerQ.match(/compare\s+(.+?)\s+and\s+(.+)/)) {
    const match = lowerQ.match(/compare\s+(.+?)\s+and\s+(.+)/)!
    parts = [match[1], match[2]]
  } else if (lowerQ.includes(' with ')) {
    // Generic "X with Y" pattern
    parts = lowerQ.split(' with ')
  }

  if (parts.length < 2) return null

  let side1 = parts[0].trim()
  let side2 = parts[1].trim()

  // SMART INFERENCING: If side2 is just a date (no financial type/metric),
  // copy the metric from side1
  // Example: "compare committed income oct 2025 vs jan 2026"
  // side2 = "jan 2026" should become "committed income jan 2026"
  // Example: "compare cashflow subcontractor 10 2025 vs 1 2026"
  // side2 = "1 2026" should become "cash flow subcontractor 1 2026"
  
  // Check if side2 looks like just a date (month name or numeric month + optional year)
  const monthPattern = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\b/
  const dateOnlyPattern = /^\s*(\d{1,2}\s*)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\s*(\d{2,4})?\s*$/i
  // Also match purely numeric dates: "1 2026", "10 2025", "12 2025"
  const numericDateOnlyPattern = /^\s*(\d{1,2})\s+(\d{4})\s*$/
  
  const side2IsDateOnly = dateOnlyPattern.test(side2) || numericDateOnlyPattern.test(side2)
  
  if (side2IsDateOnly) {
    // side2 is just a date - extract the metric from side1
    // Remove the "compare" prefix if present
    let metricPart = side1.replace(/^compare\s+/i, '')
    
    // Find where the date starts in side1 (month name OR numeric month+year)
    const monthMatch = metricPart.match(monthPattern)
    // Also check for numeric month pattern: number followed by space and 4-digit year
    const numericMonthMatch = metricPart.match(/\b(\d{1,2})\s+(20[2-4]\d)\b/)
    
    if (monthMatch) {
      // Get everything before the month name date
      const dateIndex = metricPart.toLowerCase().indexOf(monthMatch[1].toLowerCase())
      if (dateIndex > 0) {
        const metricPrefix = metricPart.substring(0, dateIndex).trim()
        side2 = `${metricPrefix} ${side2}`.trim()
      }
    } else if (numericMonthMatch) {
      // Get everything before the numeric date (e.g., "cash flow subcontractor" from "cash flow subcontractor 10 2025")
      const dateIndex = metricPart.indexOf(numericMonthMatch[0])
      if (dateIndex > 0) {
        const metricPrefix = metricPart.substring(0, dateIndex).trim()
        side2 = `${metricPrefix} ${side2}`.trim()
      }
    }
  }

  return {
    side1: side1,
    side2: side2,
    metric: '' // Will be determined later
  }
}

// Match a text fragment to a Financial_Type from the available types
function matchFinancialType(text: string, financialTypes: string[]): string | null {
  const lowerText = text.toLowerCase()

  // Known keyword-to-Financial_Type mappings (expanded text after acronym expansion)
  // IMPORTANT: "business plan" / "budget" → "Business Plan" (NOT "1st Working Budget")
  // "revision" → "Revision as at"
  const knownMappings: Record<string, string[]> = {
    'projection as at': ['projection'],
    'projection': ['projection'],
    'projected': ['projection'],
    'business plan': ['business plan'],
    'budget': ['business plan'],
    'audit report (wip)': ['audit report'],
    'audit report': ['audit report'],
    'wip': ['audit report'],
    'cash flow': ['cash flow'],
    'tender': ['tender', 'budget tender'],
    'actual': ['actual'],
    'committed': ['committed'],
    'committed value': ['committed'],
    'accrual': ['accrual'],
    '1st working budget': ['1st working budget'],
    'first working budget': ['1st working budget'],
    'working budget': ['1st working budget'],
    'revision as at': ['revision as at', 'revision'],
    'revision': ['revision as at', 'revision'],
    'budget revision': ['revision as at', 'revision'],
    'balance': ['balance'],
    'adjustment': ['adjustment'],
    'variation': ['adjustment', 'variation'],
  }

  // First: try known mappings
  for (const [keyword, targetPhrases] of Object.entries(knownMappings)) {
    if (lowerText.includes(keyword)) {
      // Find matching Financial_Type from available types
      for (const phrase of targetPhrases) {
        const match = financialTypes.find(ft => ft.toLowerCase().includes(phrase))
        if (match) return match
      }
    }
  }

  // Second: try direct word matching against Financial_Type values
  const textWords = lowerText.split(/\s+/).filter(w => w.length > 1)
  for (const ft of financialTypes) {
    const ftLower = ft.toLowerCase()
    const ftWords = ftLower.split(/\s+/)
    for (const tw of textWords) {
      for (const fw of ftWords) {
        if (tw === fw && tw.length > 2) return ft
        if (fw.includes(tw) && tw.length >= fw.length * 0.5) return ft
      }
    }
  }

  // Third: fuzzy match
  for (const word of textWords) {
    const match = findClosestMatch(word, financialTypes)
    if (match) return match
  }

  return null
}

// Helper: Get Item_Code from metric name using PARENT_ITEM_MAP
// This ensures we filter by exact Item_Code (e.g., 2.4) instead of Data_Type text matching
function getItemCodeFromMetric(metricName: string | null): string | null {
  if (!metricName) return null
  const lowerMetric = metricName.toLowerCase()
  
  // Sort entries by length (longest first) to match more specific terms before substrings
  // e.g., "less : cost - subcontractor" should match "subcontractor" (2.4) not "cost" (2.2)
  const sortedEntries = Object.entries(PARENT_ITEM_MAP).sort((a, b) => b[0].length - a[0].length)
  
  for (const [keyword, info] of sortedEntries) {
    if (lowerMetric.includes(keyword)) {
      return info.code
    }
  }
  return null
}

// Extract the metric (Data_Type) from comparison text
function extractComparisonMetric(expandedQuestion: string, dataTypes: string[]): { metric: string | null; itemCode: string | null } {
  const lowerQ = expandedQuestion.toLowerCase()

  // === FEATURE 2: Detect item codes FIRST (highest priority) ===
  // Pattern: matches "2.1", "2.4.1", "1.2.3" but NOT standalone numbers like "10" or "2025"
  const itemCodePattern = /\b(\d+\.\d+(?:\.\d+)*)\b/
  const itemCodeMatch = lowerQ.match(itemCodePattern)

  if (itemCodeMatch) {
    // Found an item code - return it directly
    // The caller will look up the corresponding Data_Type from the data
    return { metric: null, itemCode: itemCodeMatch[1] }
  }

  // First: Check known acronyms for exact parent-level matching
  // This prevents matching child items (e.g., "Contract Works" instead of "Subcontractor")
  const compareMetricMap: Record<string, string> = {
    'subcontractor': 'subcontractor',
    'subcontractors': 'subcontractor',
    'subbie': 'subcontractor',
    'subcon': 'subcontractor',
    'preliminaries': 'preliminaries',
    'prelim': 'preliminaries',
    'total prelim': 'preliminaries',
    'materials': 'materials',
    'material': 'materials',
    'material cost': 'materials',
    'plant': 'plant and machinery',
    'machinery': 'plant and machinery',
    'all plant': 'plant and machinery',
    'labour': 'labour',
    'labor': 'labour',
    'staff': 'supervision',
    'supervision': 'supervision',
    'cost': 'less : cost',
    'total cost': 'less : cost',
    'gross profit': 'gross profit',
    'gp': 'gross profit',
    'net profit': 'net profit',
    'np': 'net profit',
    'income': 'income',
    'revenue': 'income',
    'overhead': 'overhead',
    'contract works': 'contract works',
    'subbie contract works': 'contract works',
    'subcon contract works': 'contract works',
    'subcontractors contract works': 'contract works',
    'variation': 'variation',
    'variations': 'variation',
    'vo': 'variation',
    'subbie vo': 'variation',
    'subcon vo': 'variation',
    'subcontractors vo': 'variation',
    'subbie variation': 'variation',
    'subcon variation': 'variation',
    'subcontractors variation': 'variation',
    'subbie variations': 'variation',
    'subcon variations': 'variation',
    'subcontractors variations': 'variation',
    'claim': 'claim',
    'claims': 'claim',
    'subbie claim': 'claim',
    'subcon claim': 'claim',
    'subcontractors claim': 'claim',
    'subbie claims': 'claim',
    'subcon claims': 'claim',
    'subcontractors claims': 'claim',
  }

  // Sort keywords by length (longest first) to match more specific terms before substrings
  // e.g., "subbie contract works" before "contract works", "subcontractor" before "contract"
  const sortedEntries = Object.entries(compareMetricMap).sort((a, b) => b[0].length - a[0].length)
  
  for (const [keyword, targetName] of sortedEntries) {
    // Use word boundary matching to prevent substring false positives
    // e.g., "subcontractor" should NOT match "contract works"
    const keywordPattern = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    if (!keywordPattern.test(lowerQ)) continue
    
    // Find Data_Type that matches the target name at the right level
    // Prefer shorter matches (parent level) over longer matches (child level)
    const matches = dataTypes.filter(dt => {
      const dtLower = dt.toLowerCase()
      // Match if Data_Type contains the target as a segment
      return dtLower.includes(' - ' + targetName + ' -') ||
             dtLower.includes(' - ' + targetName) ||
             dtLower === targetName ||
             dtLower.endsWith(' ' + targetName)
    })
    if (matches.length > 0) {
      // Sort by length - shortest first (parent level)
      matches.sort((a, b) => a.length - b.length)
      return { metric: matches[0], itemCode: null }
    }
  }

  // Known acronym-to-DataType mappings
  const acronymDataMap: Record<string, string[]> = {
    'gross profit': ['gross profit', 'acc. gross profit'],
    'net profit': ['net profit', 'acc. net profit'],
    'cash flow': ['cash flow'],
    'revenue': ['revenue', 'gross profit'],
    'income': ['income', 'gross profit'],
  }

  // Check known mappings
  for (const [keyword, expansions] of Object.entries(acronymDataMap)) {
    if (lowerQ.includes(keyword)) {
      for (const expansion of expansions) {
        const match = dataTypes.find(dt => dt.toLowerCase().includes(expansion))
        if (match) return { metric: match, itemCode: null }
      }
    }
  }

  // Try word-by-word matching (fallback)
  const questionWords = lowerQ.split(/\s+/).filter(w => w.length > 2)
  let bestMatch: string | null = null
  let bestScore = 0

  for (const dt of dataTypes) {
    const dtLower = dt.toLowerCase()
    const dtWords = dtLower.split(/\s+/)
    let score = 0
    for (const qw of questionWords) {
      for (const dw of dtWords) {
        if (qw === dw) score += 2
        else if (dw.includes(qw) && qw.length >= dw.length * 0.5) score += 1
      }
    }
    if (score > bestScore) {
      bestScore = score
      bestMatch = dt
    }
  }

  return { metric: bestMatch, itemCode: null }
}

// Handle comparison query - returns formatted comparison result or null if not a comparison
function handleComparisonQuery(data: FinancialRow[], project: string, question: string, defaultMonth: string): FuzzyResult | null {
  const expandedQuestion = expandAcronyms(question).toLowerCase()

  // Check if this is a comparison query
  if (!isComparisonQuery(expandedQuestion)) return null

  const projectData = data.filter(d => d._project === project)
  if (projectData.length === 0) return null

  // Extract the two sides of the comparison
  const compParts = extractComparisonParts(expandedQuestion)
  if (!compParts) return null

  // Get available Financial Types and Data Types
  const financialTypes = getUniqueValues(data, project, 'Financial_Type')
  const dataTypes = getUniqueValues(data, project, 'Data_Type')

  // Match each side to a Financial_Type
  const finType1 = matchFinancialType(compParts.side1, financialTypes)
  const finType2 = matchFinancialType(compParts.side2, financialTypes)

  // === FEATURE 2: Extract the metric (Data_Type) OR item code to compare ===
  const metricResult = extractComparisonMetric(expandedQuestion, dataTypes)
  let targetDataType = metricResult.metric
  let extractedItemCode = metricResult.itemCode

  // If an item code was extracted, look up its Data_Type from the data
  if (extractedItemCode && !targetDataType) {
    const itemRow = projectData.find(d => d.Item_Code === extractedItemCode)
    if (itemRow) {
      targetDataType = itemRow.Data_Type
    }
  }

  // Parse dates from both sides
  const date1 = parseDate(compParts.side1, defaultMonth)
  const date2 = parseDate(compParts.side2, defaultMonth)

  // Determine comparison type: by Financial_Type or by Date
  const compareByDate = finType1 && finType1 === finType2 && (date1.month || date2.month)
  const compareByFinType = finType1 && finType2 && finType1 !== finType2

  // === FEATURE 2: Use extracted item code if available ===
  // Priority: extractedItemCode > getItemCodeFromMetric
  let targetItemCode: string | null = extractedItemCode
  if (!targetItemCode && targetDataType) {
    targetItemCode = getItemCodeFromMetric(targetDataType)
  }

  // Detect target sheet from query (e.g., "cashflow" → "Cash Flow")
  // IMPORTANT: For cross-type comparisons (compareByFinType), ALWAYS use Financial Status
  // because only Financial Status has all Financial Types in one sheet.
  // Sheet override only applies to same-type date comparisons (compareByDate).
  const availableSheets = getUniqueValues(data, project, 'Sheet_Name')
  let targetSheet = 'Financial Status'  // default
  
  const lowerQ = expandedQuestion.toLowerCase()
  if (compareByDate) {
    // Only override sheet for same-type date comparisons
    if (lowerQ.includes('cash flow') || lowerQ.includes('cashflow') || lowerQ.includes('cf ')) {
      const cfSheet = availableSheets.find(s => 
        s.toLowerCase().includes('cash flow') || s.toLowerCase() === 'cashflow'
      )
      if (cfSheet) targetSheet = cfSheet
    } else if (lowerQ.includes('projection') || lowerQ.includes('projected')) {
      const projSheet = availableSheets.find(s => 
        s.toLowerCase().includes('projection')
      )
      if (projSheet) targetSheet = projSheet
    } else if (lowerQ.includes('accrual') || lowerQ.includes('accrued')) {
      const accrualSheet = availableSheets.find(s => 
        s.toLowerCase().includes('accrual')
      )
      if (accrualSheet) targetSheet = accrualSheet
    } else if (lowerQ.includes('committed')) {
      const committedSheet = availableSheets.find(s => 
        s.toLowerCase().includes('committed')
      )
      if (committedSheet) targetSheet = committedSheet
    }
  }
  // For compareByFinType: keep targetSheet = 'Financial Status' (has all types)

  if (!compareByDate && !compareByFinType) {
    // Can't determine comparison type - fall back to normal query
    return null
  }

  let result1: { total: number; rows: FinancialRow[] } = { total: 0, rows: [] }
  let result2: { total: number; rows: FinancialRow[] } = { total: 0, rows: [] }
  let label1 = ''
  let label2 = ''

  if (compareByDate) {
    // Compare same metric across different dates
    // IMPORTANT: For "cash flow" type queries, data may be in different sheets:
    // - Cash Flow sheet (monthly data) for historical months
    // - Financial Status sheet (Cash Flow Actual received & paid as at) for current month
    
    // Helper to find the actual sheet name that matches a pattern
    const findMatchingSheet = (pattern: string): string | null => {
      const patternLower = pattern.toLowerCase()
      return availableSheets.find(s => 
        s.toLowerCase() === patternLower || 
        s.toLowerCase().includes(patternLower) ||
        patternLower.includes(s.toLowerCase())
      ) || null
    }
    
    // Find the actual Cash Flow sheet name
    const cashFlowSheet = findMatchingSheet('Cash Flow') || findMatchingSheet('Cashflow')
    
    // Helper to find data for a specific date and metric
    const findValueForDate = (date: { month?: string | null; year?: string | null }): { total: number; rows: FinancialRow[]; label: string } => {
      // Try multiple sources in order of preference
      // Use actual sheet names found in the data
      const sources: Array<{ sheet: string | null; finTypePattern: string; displayFinType: string }> = []
      
      // PRIORITY 1: Try targetSheet first (user explicitly asked for this sheet)
      // e.g., "committed" → targetSheet = "Committed Cost"
      if (targetSheet && targetSheet !== 'Financial Status') {
        // Try with matching financial type first, then any type on that sheet
        if (finType1) {
          sources.push({ sheet: targetSheet, finTypePattern: finType1, displayFinType: finType1 })
        }
        // Try sheet name as financial type pattern (e.g., "Committed Cost" sheet might have "Committed Value / Cost as at" type)
        sources.push({ sheet: targetSheet, finTypePattern: '', displayFinType: finType1 || targetSheet })
      }
      
      // PRIORITY 2: For cash flow queries, try the Cash Flow sheet
      if (cashFlowSheet && (targetSheet === cashFlowSheet || !targetSheet || targetSheet === 'Financial Status')) {
        sources.push({ sheet: cashFlowSheet, finTypePattern: 'Cash Flow', displayFinType: 'Cash Flow' })
        sources.push({ sheet: cashFlowSheet, finTypePattern: 'Cash Flow Actual', displayFinType: 'Cash Flow' })
        sources.push({ sheet: cashFlowSheet, finTypePattern: '', displayFinType: 'Cash Flow' })
      }
      
      // PRIORITY 3: Fallback to Financial Status
      sources.push({ sheet: 'Financial Status', finTypePattern: 'Cash Flow Actual received & paid as at', displayFinType: 'Cash Flow' })
      if (finType1) {
        sources.push({ sheet: 'Financial Status', finTypePattern: finType1, displayFinType: finType1 })
      }
      
      for (const source of sources) {
        if (!source.sheet) continue
        
        let filtered = projectData.filter(d => 
          d.Sheet_Name === source.sheet
        )
        
        // Filter by financial type pattern (empty pattern means accept any)
        if (source.finTypePattern) {
          filtered = filtered.filter(d => 
            d.Financial_Type === source.finTypePattern || 
            d.Financial_Type.toLowerCase().includes(source.finTypePattern.toLowerCase())
          )
        }
        
        // Use EXACT Item_Code match if available, otherwise exact Data_Type match
        if (targetItemCode) {
          filtered = filtered.filter(d => d.Item_Code === targetItemCode)
        } else if (targetDataType) {
          // Exact match to avoid matching children (e.g., "Subcontractor" not "Contract Works")
          filtered = filtered.filter(d => d.Data_Type.toLowerCase() === targetDataType.toLowerCase())
        }
        
        if (date.month) {
          filtered = filtered.filter(d => d.Month === date.month)
        }
        if (date.year) {
          filtered = filtered.filter(d => d.Year === date.year)
        }
        
        if (filtered.length > 0) {
          const total = filtered.reduce((sum, d) => sum + toNumber(d.Value), 0)
          // Use the display financial type for the label, not the actual data value
          return { 
            total, 
            rows: filtered, 
            label: `${source.displayFinType} (${date.month}/${date.year})`
          }
        }
      }
      
      return { total: 0, rows: [], label: `${finType1 || 'Cash Flow'} (${date.month}/${date.year})` }
    }

    const r1 = findValueForDate(date1)
    const r2 = findValueForDate(date2)
    result1 = { total: r1.total, rows: r1.rows }
    result2 = { total: r2.total, rows: r2.rows }
    label1 = r1.label
    label2 = r2.label
  } else {
    // Compare different Financial_Types (existing logic)

    const getValueForType = (finType: string, date?: { month?: string | null; year?: string | null }): { total: number; rows: FinancialRow[] } => {
      let filtered = projectData.filter(d => d.Sheet_Name === targetSheet)
      filtered = filtered.filter(d => d.Financial_Type === finType)
      
      // Use EXACT Item_Code match if available
      if (targetItemCode) {
        filtered = filtered.filter(d => d.Item_Code === targetItemCode)
      } else if (targetDataType) {
        filtered = filtered.filter(d => d.Data_Type.toLowerCase() === targetDataType.toLowerCase())
      }
      
      if (date?.month) {
        filtered = filtered.filter(d => d.Month === date.month)
      }
      if (date?.year) {
        filtered = filtered.filter(d => d.Year === date.year)
      }
      const total = filtered.reduce((sum, d) => sum + toNumber(d.Value), 0)
      return { total, rows: filtered }
    }

    result1 = getValueForType(finType1!, date1.month || date1.year ? date1 : undefined)
    result2 = getValueForType(finType2!, date2.month || date2.year ? date2 : undefined)
    label1 = finType1!
    label2 = finType2!
  }

  // Calculate difference
  const diff = result1.total - result2.total
  const absDiff = Math.abs(diff)
  const pctChange = result2.total !== 0 ? (diff / Math.abs(result2.total)) * 100 : 0
  const arrow = diff > 0 ? '↑' : diff < 0 ? '↓' : '→'
  const sign = diff > 0 ? '+' : ''

  // Format response as comparison table
  const metricLabel = targetDataType || 'Total'
  let response = `## Comparing: ${label1} vs ${label2}\n`
  response += `**Table:** ${targetSheet}\n`
  response += `**Metric:** ${metricLabel}\n\n`

  // Build source refs for each side
  const sourceRef1 = result1.rows.length > 0 
    ? ` ${formatSourceRef(result1.rows[0])}` 
    : ''
  const sourceRef2 = result2.rows.length > 0 
    ? ` ${formatSourceRef(result2.rows[0])}` 
    : ''

  // Table header
  response += `| Financial Type | ${metricLabel} |\n`
  response += `|----------------|${'-'.repeat(Math.max(metricLabel.length, 14))}|\n`
  response += `| ${label1} | ${formatCurrency(result1.total)}${sourceRef1} |\n`
  response += `| ${label2} | ${formatCurrency(result2.total)}${sourceRef2} |\n`
  response += `| Difference | ${arrow} ${formatCurrency(absDiff)} (${sign}${pctChange.toFixed(1)}%) |\n`

  response += `\n*Values in ('000)*`

  // Find children items for Detail drill-down
  const children: Array<{ code: string; name: string }> = []
  const seenChildCodes = new Set<string>()
  const allRows = [...result1.rows, ...result2.rows]
  
  // Get the parent item code from the results
  let parentItemCode: string | undefined
  if (targetDataType) {
    const targetItemCode = getItemCodeFromMetric(targetDataType)
    if (targetItemCode) {
      parentItemCode = targetItemCode
    } else if (allRows.length > 0) {
      parentItemCode = allRows[0].Item_Code
    }
  } else if (allRows.length > 0) {
    parentItemCode = allRows[0].Item_Code
  }
  
  if (parentItemCode) {
    // Find direct children of the parent item in the target sheet
    const childPrefix = parentItemCode + '.'
    for (const row of projectData) {
      if (row.Sheet_Name === targetSheet && 
          row.Item_Code.startsWith(childPrefix) &&
          !seenChildCodes.has(row.Item_Code)) {
        // Only include direct children (one level deeper)
        const remaining = row.Item_Code.slice(childPrefix.length)
        if (!remaining.includes('.')) {
          seenChildCodes.add(row.Item_Code)
          children.push({ code: row.Item_Code, name: row.Data_Type })
        }
      }
    }
  } else {
    // Fallback: get unique item codes from the comparison results
    for (const row of allRows) {
      if (row.Item_Code && !seenChildCodes.has(row.Item_Code)) {
        seenChildCodes.add(row.Item_Code)
        children.push({ code: row.Item_Code, name: row.Data_Type })
      }
    }
  }
  
  // Sort children by Item_Code
  children.sort((a, b) => {
    const aParts = a.code.split('.').map(Number)
    const bParts = b.code.split('.').map(Number)
    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
      const diff = (aParts[i] || 0) - (bParts[i] || 0)
      if (diff !== 0) return diff
    }
    return 0
  })

  // Determine display name and actual Financial_Type from retrieved data
  // For Cash Flow sheet, data has Financial_Type = "Cash Flow" (short)
  // but matchFinancialType returns "Cash Flow Actual received & paid as at" (long)
  const actualFinType1 = result1.rows.length > 0 ? result1.rows[0].Financial_Type : finType1!
  const displayLabel = compareByDate
    ? (result1.rows.length > 0 ? result1.rows[0].Sheet_Name : targetSheet)
    : finType1!

  // Clear other contexts so "detail"/"more" after Compare goes to Compare handler
  trendContextCache.delete(project)
  listContextCache.delete(project)

  // Save context for Detail drill-down
  compareContextCache.set(project, {
    finType1: compareByDate ? finType1! : finType1!,
    finType2: compareByDate ? finType1! : finType2!,
    targetSheet,
    targetDataType,
    project,
    children,
    isCompareByDate: !!compareByDate,
    date1: compareByDate ? date1 : undefined,
    date2: compareByDate ? date2 : undefined,
    parentItemCode,
    displayFinType: displayLabel,
    actualFinType: actualFinType1
  })
  lastCompareDetailPage = 0

  // Add hint for Detail command if there are children
  if (children.length > 0) {
    response += `\n\n💡 Type **'detail'** to compare sub-items`
  }

  // Still provide candidates for drill-down
  const candidates = allRows.slice(0, 5).map((d, i) => ({
    id: i + 1,
    value: d.Value,
    score: 100,
    sheet: d.Sheet_Name,
    financialType: d.Financial_Type,
    dataType: d.Data_Type,
    itemCode: d.Item_Code,
    month: d.Month,
    year: d.Year,
    matchedKeywords: []
  }))

  return { text: response, candidates }
}

// ============================================
// Total Query Handler
// ============================================

// Parent item name → item code mapping
const PARENT_ITEM_MAP: Record<string, { code: string; name: string }> = {
  // Summary-level items (GP, NP) — important for disambiguation
  // Item 3 = "Gross Profit (Item 1.0-2.0)" vs Item 5 = "Gross Profit (Item 3.0-4.3)"
  // When user says "GP" they mean Item 3 (the primary Gross Profit)
  'gross profit': { code: '3', name: 'Gross Profit (Item 1.0-2.0) (Financial A/C)' },
  'net profit': { code: '7', name: 'Acc. Net Profit/(Loss)' },
  'income': { code: '1', name: 'Income' },
  'revenue': { code: '1', name: 'Income' },
  'overhead': { code: '6', name: 'Overhead' },
  
  // Item 2 - Less : Cost
  'cost': { code: '2', name: 'Less : Cost' },
  'total cost': { code: '2', name: 'Less : Cost' },
  'less cost': { code: '2', name: 'Less : Cost' },
  
  // Item 2.1 - Preliminaries
  'preliminaries': { code: '2.1', name: 'Preliminaries' },
  'prelim': { code: '2.1', name: 'Preliminaries' },
  'preliminary': { code: '2.1', name: 'Preliminaries' },
  'total prelim': { code: '2.1', name: 'Preliminaries' },
  
  // Item 2.1.1 - Manpower (Mgt. & Supervision)
  'supervision': { code: '2.1.1', name: 'Manpower (Mgt. & Supervision)' },
  'mgt supervision': { code: '2.1.1', name: 'Manpower (Mgt. & Supervision)' },
  'management supervision': { code: '2.1.1', name: 'Manpower (Mgt. & Supervision)' },
  
  // Item 2.2 - Materials
  'materials': { code: '2.2', name: 'Materials' },
  'material': { code: '2.2', name: 'Materials' },
  'material cost': { code: '2.2', name: 'Materials' },
  
  // Item 2.3 - Plant & Machinery
  'plant and machinery': { code: '2.3', name: 'Plant and Machinery' },
  'plant': { code: '2.3', name: 'Plant and Machinery' },
  'machinery': { code: '2.3', name: 'Plant and Machinery' },
  'all plant': { code: '2.3', name: 'Plant and Machinery' },
  
  // Item 2.4 - Subcontractor
  'subcontractor': { code: '2.4', name: 'Subcontractor' },
  'subcon': { code: '2.4', name: 'Subcontractor' },
  'subbie': { code: '2.4', name: 'Subcontractor' },
  'subcontractors': { code: '2.4', name: 'Subcontractor' },
  
  // Item 2.4.1 - Contract works
  'contract works': { code: '2.4.1', name: 'Contract works' },
  'subbie contract works': { code: '2.4.1', name: 'Contract works' },
  'subcon contract works': { code: '2.4.1', name: 'Contract works' },
  'subcontractors contract works': { code: '2.4.1', name: 'Contract works' },
  
  // Item 2.4.2 - Variation
  'vo': { code: '2.4.2', name: 'Variation' },
  'variation': { code: '2.4.2', name: 'Variation' },
  'variations': { code: '2.4.2', name: 'Variation' },
  'subbie vo': { code: '2.4.2', name: 'Variation' },
  'subcon vo': { code: '2.4.2', name: 'Variation' },
  'subcontractors vo': { code: '2.4.2', name: 'Variation' },
  'subbie variation': { code: '2.4.2', name: 'Variation' },
  'subcon variation': { code: '2.4.2', name: 'Variation' },
  'subcontractors variation': { code: '2.4.2', name: 'Variation' },
  'subbie variations': { code: '2.4.2', name: 'Variation' },
  'subcon variations': { code: '2.4.2', name: 'Variation' },
  'subcontractors variations': { code: '2.4.2', name: 'Variation' },
  
  // Item 2.4.3 - Claim
  'claim': { code: '2.4.3', name: 'Claim' },
  'claims': { code: '2.4.3', name: 'Claim' },
  'subbie claim': { code: '2.4.3', name: 'Claim' },
  'subcon claim': { code: '2.4.3', name: 'Claim' },
  'subcontractors claim': { code: '2.4.3', name: 'Claim' },
  'subbie claims': { code: '2.4.3', name: 'Claim' },
  'subcon claims': { code: '2.4.3', name: 'Claim' },
  'subcontractors claims': { code: '2.4.3', name: 'Claim' },
  
  // Other cost categories (keeping existing)
  'labour': { code: '2.5', name: 'Labour' },
  'labor': { code: '2.5', name: 'Labour' },
  'manpower': { code: '2.5', name: 'Manpower (Labour) for Works' },
  'staff': { code: '2.1.1', name: 'Manpower (Mgt. & Supervision)' },
  'admin': { code: '2.7', name: 'Administration' },
  'administration': { code: '2.7', name: 'Administration' },
  'insurance': { code: '2.8', name: 'Insurance' },
  'bond': { code: '2.9', name: 'Bond' },
  'others': { code: '2.10', name: 'Others' },
  'other': { code: '2.10', name: 'Others' },
  'contingency': { code: '2.11', name: 'Contingency' },
}

// Detect if a query starts with "Total" keyword
function isTotalQuery(question: string): boolean {
  const lowerQ = question.toLowerCase().trim()
  return lowerQ.startsWith('total ')
}

// Parse a Total query to extract item name, financial type, and optional month
function parseTotalQuery(question: string): {
  itemName: string | null
  itemCode: string | null
  itemDisplayName: string | null
  financialType: string | null
  month: string | null
  year: string | null
} {
  const lowerQ = question.toLowerCase().trim()
  // Remove "total" prefix
  const afterTotal = lowerQ.replace(/^total\s+/, '').trim()

  let itemName: string | null = null
  let itemCode: string | null = null
  let itemDisplayName: string | null = null
  let financialType: string | null = null
  let month: string | null = null
  let year: string | null = null

  // Parse month/year from query
  const monthNames = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
  const monthAbbr = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

  // Check for month names
  for (let i = 0; i < monthNames.length; i++) {
    if (afterTotal.includes(monthNames[i]) || afterTotal.includes(monthAbbr[i])) {
      month = String(i + 1)
      break
    }
  }

  // Check for 4-digit year
  const yearMatch = afterTotal.match(/\b(20[2-4]\d)\b/)
  if (yearMatch) {
    year = yearMatch[1]
  }

  // Check for 2-digit year
  if (!year) {
    const twoDigitMatch = afterTotal.match(/\b(\d{2})\b/)
    if (twoDigitMatch) {
      const y = parseInt(twoDigitMatch[1])
      if (y >= 20 && y <= 30) {
        year = '20' + twoDigitMatch[1]
      }
    }
  }

  // Try to find item name - sort by longest key first for greedy matching
  const sortedItems = Object.entries(PARENT_ITEM_MAP).sort((a, b) => b[0].length - a[0].length)
  for (const [keyword, info] of sortedItems) {
    // Use word boundary matching
    const pattern = new RegExp(`\\b${keyword.replace(/\s+/g, '\\s+')}\\b`, 'i')
    if (pattern.test(afterTotal)) {
      itemName = keyword
      itemCode = info.code
      itemDisplayName = info.name
      break
    }
  }

  // Try to find financial type - check multi-word phrases first
  const sortedFinTypes = Object.entries(FINANCIAL_TYPE_KEYWORDS).sort((a, b) => {
    const aMaxLen = Math.max(...a[1].map(k => k.length))
    const bMaxLen = Math.max(...b[1].map(k => k.length))
    return bMaxLen - aMaxLen
  })

  for (const [canonicalType, keywords] of sortedFinTypes) {
    for (const keyword of keywords.sort((a, b) => b.length - a.length)) {
      const pattern = new RegExp(`\\b${keyword.replace(/\s+/g, '\\s+')}\\b`, 'i')
      if (pattern.test(afterTotal)) {
        financialType = canonicalType
        break
      }
    }
    if (financialType) break
  }

  return { itemName, itemCode, itemDisplayName, financialType, month, year }
}

// Handle a Total query - sum all sub-items under a parent item for a given financial type
function handleTotalQuery(data: FinancialRow[], project: string, question: string, defaultMonth: string): FuzzyResult | null {
  if (!isTotalQuery(question)) return null

  const parsed = parseTotalQuery(question)

  if (!parsed.itemCode || !parsed.financialType) {
    // Build helpful error message
    let errorMsg = '❌ Could not parse Total query.\n\n'
    if (!parsed.itemCode) {
      errorMsg += '**Missing item name.** Supported items:\n'
      const seen = new Set<string>()
      for (const [, info] of Object.entries(PARENT_ITEM_MAP)) {
        if (!seen.has(info.code)) {
          seen.add(info.code)
          errorMsg += `• ${info.code} - ${info.name}\n`
        }
      }
    }
    if (!parsed.financialType) {
      errorMsg += '\n**Missing financial type.** Supported types:\n'
      for (const [canonicalType, keywords] of Object.entries(FINANCIAL_TYPE_KEYWORDS)) {
        errorMsg += `• ${canonicalType} (keywords: ${keywords.join(', ')})\n`
      }
    }
    errorMsg += '\n**Example:** "Total Preliminaries Cashflow", "Total Committed Materials Jan 2025"'
    return { text: errorMsg, candidates: [] }
  }

  const projectData = data.filter(d => d._project === project)
  if (projectData.length === 0) {
    return { text: 'No data found for this project.', candidates: [] }
  }

  // Determine which sheet to use and how to filter
  const hasMonth = !!parsed.month
  let sheetName: string
  let targetFinancialType: string | null = null

  if (hasMonth) {
    // User specified a month → go to the worksheet matching the financial type name
    // e.g., "Cash Flow" sheet, "Projection" sheet, "Committed Cost" sheet
    // The sheet name typically matches the canonical financial type name
    const sheetCandidates = Array.from(new Set(projectData.map(d => d.Sheet_Name)))

    // Try to find a sheet matching the financial type
    const ftLower = parsed.financialType.toLowerCase()
    let matchedSheet = sheetCandidates.find(s => s.toLowerCase() === ftLower)
    if (!matchedSheet) {
      // Try partial match
      matchedSheet = sheetCandidates.find(s => s.toLowerCase().includes(ftLower) || ftLower.includes(s.toLowerCase()))
    }
    if (!matchedSheet) {
      // Fallback to Financial Status
      matchedSheet = 'Financial Status'
    }
    sheetName = matchedSheet
  } else {
    // No month specified → use Financial Status sheet
    sheetName = 'Financial Status'
    // On Financial Status, we need to match Financial_Type column
    // Resolve the canonical name to an actual Financial_Type in the data
    const ftLower = parsed.financialType.toLowerCase()
    const availableFinTypes = Array.from(new Set(projectData.filter(d => d.Sheet_Name === 'Financial Status').map(d => d.Financial_Type)))

    // Try exact match
    targetFinancialType = availableFinTypes.find(ft => ft.toLowerCase() === ftLower) || null
    if (!targetFinancialType) {
      // Try partial/contains match
      targetFinancialType = availableFinTypes.find(ft => ft.toLowerCase().includes(ftLower) || ftLower.includes(ft.toLowerCase())) || null
    }
    if (!targetFinancialType) {
      // Try keyword-based matching using FINANCIAL_TYPE_KEYWORDS
      const keywords = FINANCIAL_TYPE_KEYWORDS[parsed.financialType] || []
      for (const keyword of keywords) {
        targetFinancialType = availableFinTypes.find(ft => ft.toLowerCase().includes(keyword)) || null
        if (targetFinancialType) break
      }
    }

    if (!targetFinancialType) {
      const availableList = availableFinTypes.map(ft => `• ${ft}`).join('\n')
      return {
        text: `❌ Could not find Financial Type "${parsed.financialType}" in Financial Status sheet.\n\nAvailable Financial Types:\n${availableList}`,
        candidates: []
      }
    }
  }

  // Filter data: get sub-items under the parent item code
  const parentCode = parsed.itemCode // e.g., "2.1"
  const subItemPrefix = parentCode + '.' // e.g., "2.1."

  let filtered = projectData.filter(d => {
    // Must be a sub-item (e.g., 2.1.1, 2.1.2, etc.) - NOT the parent itself
    if (!d.Item_Code.startsWith(subItemPrefix)) return false
    // Must be on the right sheet
    if (d.Sheet_Name !== sheetName) return false
    return true
  })

  // Apply Financial_Type filter (for Financial Status sheet)
  if (targetFinancialType && sheetName === 'Financial Status') {
    filtered = filtered.filter(d => d.Financial_Type === targetFinancialType)
  }

  // Apply month filter if specified
  if (parsed.month) {
    filtered = filtered.filter(d => d.Month === parsed.month)
  }

  // Apply year filter if specified
  if (parsed.year) {
    filtered = filtered.filter(d => d.Year === parsed.year)
  }

  if (filtered.length === 0) {
    // Try to provide helpful info about what's available
    const availableSubItems = projectData.filter(d => d.Item_Code.startsWith(subItemPrefix))
    const availableSheets = Array.from(new Set(availableSubItems.map(d => d.Sheet_Name)))
    const availableFinTypes = Array.from(new Set(availableSubItems.map(d => d.Financial_Type)))

    let msg = `No sub-items found for ${parsed.itemDisplayName} (${parentCode}) `
    if (targetFinancialType) msg += `with Financial Type "${targetFinancialType}" `
    msg += `on sheet "${sheetName}"`
    if (parsed.month) msg += ` for month ${parsed.month}`
    msg += '.\n\n'

    if (availableSheets.length > 0) {
      msg += `**Available sheets for ${parentCode}.x items:** ${availableSheets.join(', ')}\n`
    }
    if (availableFinTypes.length > 0) {
      msg += `**Available Financial Types:** ${availableFinTypes.join(', ')}\n`
    }

    return { text: msg, candidates: [] }
  }

  // Group by sub-item code and sum values
  const subItemGroups = new Map<string, { dataType: string; total: number; rows: FinancialRow[] }>()

  for (const row of filtered) {
    const key = row.Item_Code
    if (!subItemGroups.has(key)) {
      subItemGroups.set(key, { dataType: row.Data_Type, total: 0, rows: [] })
    }
    const group = subItemGroups.get(key)!
    group.total += toNumber(row.Value)
    group.rows.push(row)
  }

  // Sort sub-items by item code numerically
  const sortedSubItems = Array.from(subItemGroups.entries()).sort((a, b) => {
    const partsA = a[0].split('.').map(Number)
    const partsB = b[0].split('.').map(Number)
    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
      const diff = (partsA[i] || 0) - (partsB[i] || 0)
      if (diff !== 0) return diff
    }
    return 0
  })

  // Calculate grand total
  const grandTotal = sortedSubItems.reduce((sum, [, group]) => sum + group.total, 0)

  // Format the display financial type name
  const displayFinType = targetFinancialType || parsed.financialType
  const displayFinTypeCapitalized = displayFinType.charAt(0).toUpperCase() + displayFinType.slice(1)

  // Build response
  let response = `## Total: ${parsed.itemDisplayName} (${displayFinTypeCapitalized})\n\n`
  response += `**Parent Item:** ${parentCode} - ${parsed.itemDisplayName}\n`
  response += `**Financial Type:** ${displayFinTypeCapitalized}\n`
  response += `**Sheet:** ${sheetName}\n`
  if (parsed.month) {
    const monthNames = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
    response += `**Month:** ${monthNames[parseInt(parsed.month)] || parsed.month}`
    if (parsed.year) response += ` ${parsed.year}`
    response += '\n'
  }
  response += '\n'

  // Build table
  response += '| Sub-Item | Description | Value |\n'
  response += '|----------|-------------|-------|\n'

  for (const [itemCode, group] of sortedSubItems) {
    const description = group.dataType || '-'
    const sourceRef = group.rows.length > 0 ? ` ${formatSourceRef(group.rows[0])}` : ''
    response += `| ${itemCode} | ${description} | ${formatCurrency(group.total)}${sourceRef} |\n`
  }

  response += `\n**Total: ${formatCurrency(grandTotal)}** [sum of ${sortedSubItems.length} items] ('000)\n`

  // Build candidates for drill-down
  const candidates = sortedSubItems.map(([itemCode, group], i) => ({
    id: i + 1,
    value: group.total,
    score: 100,
    sheet: sheetName,
    financialType: displayFinType,
    dataType: group.dataType,
    itemCode: itemCode,
    month: parsed.month || defaultMonth,
    year: parsed.year || '',
    matchedKeywords: [parsed.itemDisplayName || '', displayFinType]
  }))

  return { text: response, candidates }
}

// ============================================
// Risk Query Handler
// ============================================
function handleRiskQuery(data: FinancialRow[], project: string, defaultMonth: string): FuzzyResult {
  const projectData = data.filter(d => d._project === project)
  
  // Find WIP, Committed, and Cash Flow data
  const wipRows = projectData.filter(r => r.Financial_Type?.toLowerCase().includes('wip'))
  const committedRows = projectData.filter(r => r.Financial_Type?.toLowerCase().includes('committed'))
  const cfRows = projectData.filter(r => r.Financial_Type?.toLowerCase().includes('cash flow'))
  
  let lines = '⚠️ **Risk Analysis**\n\n'
  
  // Check for cost overruns (WIP vs Budget)
  const wipTotal = wipRows.reduce((sum, r) => sum + toNumber(r.Value), 0)
  const bpRows = projectData.filter(r => r.Financial_Type?.toLowerCase().includes('business plan') || r.Financial_Type?.toLowerCase().includes('latest budget'))
  const bpTotal = bpRows.reduce((sum, r) => sum + toNumber(r.Value), 0)
  
  if (wipTotal > bpTotal && bpTotal > 0) {
    const overrun = wipTotal - bpTotal
    const pct = ((overrun / bpTotal) * 100).toFixed(1)
    lines += `🔴 **Cost Overrun:** WIP exceeds Budget by $${(overrun/1000).toFixed(1)}M (${pct}%)\n`
  }
  
  // Check Committed vs Projection
  const committedTotal = committedRows.reduce((sum, r) => sum + toNumber(r.Value), 0)
  const projRows = projectData.filter(r => r.Financial_Type?.toLowerCase().includes('projection'))
  const projTotal = projRows.reduce((sum, r) => sum + toNumber(r.Value), 0)
  
  if (committedTotal > projTotal && projTotal > 0) {
    const overrun = committedTotal - projTotal
    const pct = ((overrun / projTotal) * 100).toFixed(1)
    lines += `🔴 **Commitment Risk:** Committed exceeds Projection by $${(overrun/1000).toFixed(1)}M (${pct}%)\n`
  }
  
  // Check Cash Flow position
  if (cfRows.length > 0) {
    const cfTotal = cfRows.reduce((sum, r) => sum + toNumber(r.Value), 0)
    lines += `💰 **Cash Flow:** $${(cfTotal/1000).toFixed(1)}M${cfTotal < 0 ? ' (NEGATIVE!)' : ''}\n`
  }
  
  lines += '\n_Type **detail** to drill down into any risk item_'
  
  return { text: lines, candidates: [] }
}

// ============================================
// Analyze & Detail Query Handlers
// ============================================

// Session cache for analysis results (keyed by project name, with TTL)
interface AnalysisItem {
  subIndex: number        // e.g., 1, 2, 3... within the comparison
  itemCode: string        // e.g., "1.1", "2.3"
  itemName: string        // e.g., "Preliminaries"
  value1: number          // first value (e.g., Projected)
  value2: number          // second value (e.g., Business Plan)
  label1: string          // e.g., "Projected"
  label2: string          // e.g., "Business Plan"
  difference: number
  percentage: number
  sourceRef1: string      // source reference for value1
  sourceRef2: string      // source reference for value2
}

interface AnalysisComparison {
  comparisonIndex: number // 1-6
  title: string           // e.g., "Projection vs Business Plan - Income Shortfalls"
  category: 'income' | 'cost'
  operator: 'lt' | 'gt'   // lt = value1 < value2, gt = value1 > value2
  finType1: string        // actual Financial_Type name for value1
  finType2: string        // actual Financial_Type name for value2
  items: AnalysisItem[]
}

interface AnalysisResult {
  comparisons: AnalysisComparison[]
  timestamp: number
  project: string
}

// In-memory cache: project -> analysis result (with 30-minute TTL)
const analysisCache = new Map<string, AnalysisResult>()
const ANALYSIS_CACHE_TTL = 30 * 60 * 1000 // 30 minutes

function isAnalyzeQuery(question: string): boolean {
  const lowerQ = question.toLowerCase().trim()
  return lowerQ === 'analyze' || lowerQ === 'analyse' || 
         lowerQ.startsWith('analyze ') || lowerQ.startsWith('analyse ')
}

function isDetailQuery(question: string): boolean {
  const lowerQ = question.toLowerCase().trim()
  return /^detail\s+\d+(\.\d+)?$/i.test(lowerQ)
}

function parseDetailQuery(question: string): { x: number; y?: number } | null {
  const lowerQ = question.toLowerCase().trim()
  const match = lowerQ.match(/^detail\s+(\d+)(?:\.(\d+))?$/)
  if (!match) return null
  const x = parseInt(match[1])
  const y = match[2] ? parseInt(match[2]) : undefined
  return { x, y }
}

// Resolve a Financial_Type keyword to actual Financial_Type value in the data
// Uses explicit mappings first, then falls back to fuzzy matching
function resolveFinancialType(data: FinancialRow[], project: string, keyword: string): string | null {
  const projectData = data.filter(d => d._project === project && d.Sheet_Name === 'Financial Status')
  const availableTypes = Array.from(new Set(projectData.map(d => d.Financial_Type).filter(Boolean)))
  
  const keywordLower = keyword.toLowerCase()
  
  // === Explicit keyword-to-Financial_Type mappings ===
  // These take highest priority to avoid ambiguous matches
  const EXPLICIT_FINANCIAL_TYPE_MAP: Record<string, string[]> = {
    'business plan':       ['Business Plan'],
    'bp':                  ['Business Plan'],
    'budget':              ['Business Plan'],
    'revision':            ['Revision as at'],
    'revision as at':      ['Revision as at'],
    'budget revision':     ['Revision as at'],
    'rev':                 ['Revision as at'],
    '1st working budget':  ['1st Working Budget'],
    'first working budget':['1st Working Budget'],
    'working budget':      ['1st Working Budget'],
    'projection':          ['Projection as at'],
    'projected':           ['Projection as at'],
    'projection as at':    ['Projection as at'],
    'tender':              ['Budget Tender'],
    'budget tender':       ['Budget Tender'],
    'audit report':        ['Audit Report (WIP)'],
    'wip':                 ['Audit Report (WIP)'],
    'audit report (wip)':  ['Audit Report (WIP)'],
    'committed':           ['Committed Value / Cost as at'],
    'committed value':     ['Committed Value / Cost as at'],
    'committed cost':      ['Committed Value / Cost as at'],
    'accrual':             ['Accrual'],
    'accrued':             ['Accrual'],
    'cash flow':           ['Cash Flow Actual received & paid as at'],
    'cashflow':            ['Cash Flow Actual received & paid as at'],
    'cf':                  ['Cash Flow Actual received & paid as at'],
    'general':             ['General'],
    'adjustment':          ['Adjustment Cost/ variation', 'Adjustment Cost / Variation k=I-J'],
    'variation':           ['Adjustment Cost/ variation', 'Adjustment Cost / Variation k=I-J'],
    'balance':             ['Balance'],
    'balance to':          ['Balance to'],
  }
  
  // Check explicit map first
  const explicitCandidates = EXPLICIT_FINANCIAL_TYPE_MAP[keywordLower]
  if (explicitCandidates) {
    for (const candidate of explicitCandidates) {
      // Find an available type that matches (case-insensitive)
      const match = availableTypes.find(ft => ft.toLowerCase() === candidate.toLowerCase())
      if (match) return match
      // Also try contains match for slight naming variations in data
      const containsMatch = availableTypes.find(ft => ft.toLowerCase().includes(candidate.toLowerCase()))
      if (containsMatch) return containsMatch
    }
  }
  
  // Fallback: Try exact match against available types
  let match = availableTypes.find(ft => ft.toLowerCase() === keywordLower)
  if (match) return match
  
  // Fallback: Try contains match
  match = availableTypes.find(ft => ft.toLowerCase().includes(keywordLower))
  if (match) return match
  
  // Fallback: Try reverse contains
  match = availableTypes.find(ft => keywordLower.includes(ft.toLowerCase()))
  if (match) return match
  
  return null
}

// Get all 2nd tier items under a parent (e.g., parentCode="1" → 1.1, 1.2, etc.)
function getSecondTierItems(data: FinancialRow[], project: string, parentCode: string): Array<{ itemCode: string; itemName: string }> {
  const projectData = data.filter(d => 
    d._project === project && 
    d.Sheet_Name === 'Financial Status'
  )
  
  const prefix = parentCode + '.'
  const items = new Map<string, string>()
  
  for (const row of projectData) {
    if (row.Item_Code.startsWith(prefix)) {
      // Check it's exactly 2nd tier (e.g., "1.1" not "1.1.1")
      const afterPrefix = row.Item_Code.slice(prefix.length)
      if (!afterPrefix.includes('.') && afterPrefix.length > 0) {
        if (!items.has(row.Item_Code)) {
          items.set(row.Item_Code, row.Data_Type || row.Item_Code)
        }
      }
    }
  }
  
  // Sort numerically
  return Array.from(items.entries())
    .sort((a, b) => {
      const partsA = a[0].split('.').map(Number)
      const partsB = b[0].split('.').map(Number)
      for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
        const diff = (partsA[i] || 0) - (partsB[i] || 0)
        if (diff !== 0) return diff
      }
      return 0
    })
    .map(([code, name]) => ({ itemCode: code, itemName: name }))
}

// Get all 3rd tier items under a 2nd tier parent (e.g., parentCode="2.1" → 2.1.1, 2.1.2, etc.)
function getThirdTierItems(data: FinancialRow[], project: string, parentCode: string): Array<{ itemCode: string; itemName: string }> {
  const projectData = data.filter(d => 
    d._project === project && 
    d.Sheet_Name === 'Financial Status'
  )
  
  const prefix = parentCode + '.'
  const items = new Map<string, string>()
  
  for (const row of projectData) {
    if (row.Item_Code.startsWith(prefix)) {
      // Check it's exactly 3rd tier (e.g., "2.1.1" not "2.1.1.1")
      const afterPrefix = row.Item_Code.slice(prefix.length)
      if (!afterPrefix.includes('.') && afterPrefix.length > 0) {
        if (!items.has(row.Item_Code)) {
          items.set(row.Item_Code, row.Data_Type || row.Item_Code)
        }
      }
    }
  }
  
  return Array.from(items.entries())
    .sort((a, b) => {
      const partsA = a[0].split('.').map(Number)
      const partsB = b[0].split('.').map(Number)
      for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
        const diff = (partsA[i] || 0) - (partsB[i] || 0)
        if (diff !== 0) return diff
      }
      return 0
    })
    .map(([code, name]) => ({ itemCode: code, itemName: name }))
}

// Get a value for a specific item code and financial type from Financial Status sheet
function getFinancialStatusValue(data: FinancialRow[], project: string, itemCode: string, financialType: string): number {
  const rows = data.filter(d => 
    d._project === project && 
    d.Sheet_Name === 'Financial Status' && 
    d.Item_Code === itemCode && 
    d.Financial_Type === financialType
  )
  return rows.reduce((sum, d) => sum + toNumber(d.Value), 0)
}

// Get rows for a specific item code and financial type from Financial Status sheet
function getFinancialStatusRows(data: FinancialRow[], project: string, itemCode: string, financialType: string): FinancialRow[] {
  return data.filter(d => 
    d._project === project && 
    d.Sheet_Name === 'Financial Status' && 
    d.Item_Code === itemCode && 
    d.Financial_Type === financialType
  )
}

// Run a comparison between two financial types for a set of items
function runComparison(
  data: FinancialRow[], 
  project: string, 
  items: Array<{ itemCode: string; itemName: string }>,
  finType1: string, 
  finType2: string, 
  operator: 'lt' | 'gt',
  label1: string,
  label2: string
): AnalysisItem[] {
  const results: AnalysisItem[] = []
  let subIndex = 0
  
  for (const item of items) {
    const rows1 = getFinancialStatusRows(data, project, item.itemCode, finType1)
    const rows2 = getFinancialStatusRows(data, project, item.itemCode, finType2)
    const val1 = rows1.reduce((sum, d) => sum + toNumber(d.Value), 0)
    const val2 = rows2.reduce((sum, d) => sum + toNumber(d.Value), 0)
    
    // Skip if both are zero or either is missing
    if (val1 === 0 && val2 === 0) continue
    
    const meetsCondition = operator === 'lt' ? val1 < val2 : val1 > val2
    
    if (meetsCondition) {
      subIndex++
      const diff = Math.abs(val1 - val2)
      const pct = val2 !== 0 ? (diff / Math.abs(val2)) * 100 : 0
      
      const sourceRef1 = rows1.length > 0 ? formatSourceRef(rows1[0]) : ''
      const sourceRef2 = rows2.length > 0 ? formatSourceRef(rows2[0]) : ''
      
      results.push({
        subIndex,
        itemCode: item.itemCode,
        itemName: item.itemName,
        value1: val1,
        value2: val2,
        label1,
        label2,
        difference: diff,
        percentage: pct,
        sourceRef1,
        sourceRef2
      })
    }
  }
  
  return results
}

// Handle "Analyze" query
function handleAnalyzeQuery(data: FinancialRow[], project: string): FuzzyResult {
  const projectData = data.filter(d => d._project === project && d.Sheet_Name === 'Financial Status')
  
  if (projectData.length === 0) {
    return { text: '❌ No Financial Status data found for this project.', candidates: [] }
  }
  
  // Discover actual Financial_Type names from data
  const availableTypes = Array.from(new Set(projectData.map(d => d.Financial_Type).filter(Boolean)))
  
  // Try to resolve each needed Financial_Type
  // IMPORTANT: "Business Plan" maps to the actual "Business Plan" type, NOT "1st Working Budget"
  const projectionType = resolveFinancialType(data, project, 'projection')
  const businessPlanType = resolveFinancialType(data, project, 'business plan')
  const wipType = resolveFinancialType(data, project, 'wip')
  const committedType = resolveFinancialType(data, project, 'committed')
  // "Latest Budget" (was "Budget Revision") — resolves via "revision" or "latest budget"
  const budgetRevisionType = resolveFinancialType(data, project, 'revision') || resolveFinancialType(data, project, 'latest budget')
  
  // Get 2nd tier items
  const incomeItems = getSecondTierItems(data, project, '1')  // 1.1, 1.2, etc.
  const costItems = getSecondTierItems(data, project, '2')    // 2.1, 2.2, etc.
  
  const comparisons: AnalysisComparison[] = []
  let compIndex = 0
  
  // === INCOME COMPARISONS (1.x) ===
  
  // Comparison 1: Projection vs Business Plan - Income Shortfalls (Projected < Business Plan)
  if (projectionType && businessPlanType) {
    compIndex++
    const items = runComparison(data, project, incomeItems, projectionType, businessPlanType, 'lt', 'Projected', 'Business Plan')
    comparisons.push({
      comparisonIndex: compIndex,
      title: 'Projection vs Business Plan - Income Shortfalls',
      category: 'income',
      operator: 'lt',
      finType1: projectionType,
      finType2: businessPlanType,
      items
    })
  }
  
  // Comparison 2: Projection vs Audit Report (WIP) - Income Shortfalls (Projected < WIP)
  if (projectionType && wipType) {
    compIndex++
    const items = runComparison(data, project, incomeItems, projectionType, wipType, 'lt', 'Projected', 'WIP')
    comparisons.push({
      comparisonIndex: compIndex,
      title: 'Projection vs Audit Report (WIP) - Income Shortfalls',
      category: 'income',
      operator: 'lt',
      finType1: projectionType,
      finType2: wipType,
      items
    })
  }
  
  // === COST COMPARISONS (2.x) ===
  
  // Comparison 3: Projection vs Business Plan - Cost Overruns (Projected > Business Plan)
  if (projectionType && businessPlanType) {
    compIndex++
    const items = runComparison(data, project, costItems, projectionType, businessPlanType, 'gt', 'Projected', 'Business Plan')
    comparisons.push({
      comparisonIndex: compIndex,
      title: 'Projection vs Business Plan - Cost Overruns',
      category: 'cost',
      operator: 'gt',
      finType1: projectionType,
      finType2: businessPlanType,
      items
    })
  }
  
  // Comparison 4: Projection vs Audit Report (WIP) - Cost Overruns (Projected > WIP)
  if (projectionType && wipType) {
    compIndex++
    const items = runComparison(data, project, costItems, projectionType, wipType, 'gt', 'Projected', 'WIP')
    comparisons.push({
      comparisonIndex: compIndex,
      title: 'Projection vs Audit Report (WIP) - Cost Overruns',
      category: 'cost',
      operator: 'gt',
      finType1: projectionType,
      finType2: wipType,
      items
    })
  }
  
  // Comparison 5: Committed vs Projection - Committed Exceeds Projection
  if (committedType && projectionType) {
    compIndex++
    const items = runComparison(data, project, costItems, committedType, projectionType, 'gt', 'Committed', 'Projected')
    comparisons.push({
      comparisonIndex: compIndex,
      title: 'Committed vs Projection - Committed Exceeds Projection',
      category: 'cost',
      operator: 'gt',
      finType1: committedType,
      finType2: projectionType,
      items
    })
  }
  
  // Comparison 6: Projection vs Latest Budget - Exceeds Latest Budget
  if (budgetRevisionType && projectionType) {
    compIndex++
    const items = runComparison(data, project, costItems, projectionType, budgetRevisionType, 'gt', 'Projected', 'Latest Budget')
    comparisons.push({
      comparisonIndex: compIndex,
      title: 'Projection vs Latest Budget - Exceeds Latest Budget',
      category: 'cost',
      operator: 'gt',
      finType1: projectionType,
      finType2: budgetRevisionType,
      items
    })
  }
  
  // Store in cache
  const analysisResult: AnalysisResult = {
    comparisons,
    timestamp: Date.now(),
    project
  }
  analysisCache.set(project, analysisResult)
  
  // Build formatted output
  let response = `## Financial Analysis\n\n`
  
  // Show which Financial Types were detected
  response += `**Data Source:** Financial Status (cumulative)\n`
  response += `**Financial Types Detected:**\n`
  if (projectionType) response += `• Projection: "${projectionType}"\n`
  if (businessPlanType) response += `• Business Plan: "${businessPlanType}"\n`
  if (wipType) response += `• Audit Report (WIP): "${wipType}"\n`
  if (committedType) response += `• Committed: "${committedType}"\n`
  if (budgetRevisionType) response += `• Latest Budget: "${budgetRevisionType}"\n`
  
  // Show warnings for missing types
  const missingTypes: string[] = []
  if (!projectionType) missingTypes.push('Projection')
  if (!businessPlanType) missingTypes.push('Business Plan')
  if (!wipType) missingTypes.push('Audit Report (WIP)')
  if (!committedType) missingTypes.push('Committed')
  if (!budgetRevisionType) missingTypes.push('Latest Budget')
  
  if (missingTypes.length > 0) {
    response += `\n⚠️ **Not found:** ${missingTypes.join(', ')}\n`
    response += `Available types: ${availableTypes.join(', ')}\n`
  }
  
  response += `\n`
  
  // Income section
  const incomeComparisons = comparisons.filter(c => c.category === 'income')
  if (incomeComparisons.length > 0) {
    response += `### Income Analysis (Item 1.x)\n\n`
    for (const comp of incomeComparisons) {
      response += `**${comp.comparisonIndex}. ${comp.title}**\n`
      if (comp.items.length === 0) {
        response += `   ✅ No shortfalls found.\n`
      } else {
        for (const item of comp.items) {
          const arrow = comp.operator === 'lt' ? '↓' : '↑'
          const sign = comp.operator === 'lt' ? '-' : '+'
          const ref1 = item.sourceRef1 ? ` ${item.sourceRef1}` : ''
          const ref2 = item.sourceRef2 ? ` ${item.sourceRef2}` : ''
          response += `   ${comp.comparisonIndex}.${item.subIndex} ${item.itemName}: ${item.label1} ${formatCurrency(item.value1)}${ref1} < ${item.label2} ${formatCurrency(item.value2)}${ref2} (${arrow}${formatCurrency(item.difference)}, ${sign}${item.percentage.toFixed(1)}%)\n`
        }
      }
      response += `\n`
    }
  }
  
  // Cost section
  const costComparisons = comparisons.filter(c => c.category === 'cost')
  if (costComparisons.length > 0) {
    response += `### Cost Analysis (Item 2.x)\n\n`
    for (const comp of costComparisons) {
      response += `**${comp.comparisonIndex}. ${comp.title}**\n`
      if (comp.items.length === 0) {
        response += `   ✅ No issues found.\n`
      } else {
        for (const item of comp.items) {
          const arrow = '↑'
          const sign = '+'
          const ref1 = item.sourceRef1 ? ` ${item.sourceRef1}` : ''
          const ref2 = item.sourceRef2 ? ` ${item.sourceRef2}` : ''
          response += `   ${comp.comparisonIndex}.${item.subIndex} ${item.itemName}: ${item.label1} ${formatCurrency(item.value1)}${ref1} > ${item.label2} ${formatCurrency(item.value2)}${ref2} (${arrow}${formatCurrency(item.difference)}, ${sign}${item.percentage.toFixed(1)}%)\n`
        }
      }
      response += `\n`
    }
  }
  
  // Summary
  const totalIssues = comparisons.reduce((sum, c) => sum + c.items.length, 0)
  response += `---\n`
  response += `**Summary:** ${totalIssues} issue(s) found across ${comparisons.length} comparisons.\n`
  response += `💡 Type **"Detail X"** to drill down (e.g., "Detail 3" for Cost Overruns).\n`
  response += `💡 Type **"Detail X.Y"** for specific item details (e.g., "Detail 3.1").\n`
  
  return { text: response, candidates: [] }
}

// Handle "Detail X" or "Detail X.Y" query
function handleDetailQuery(data: FinancialRow[], project: string, question: string): FuzzyResult | null {
  const parsed = parseDetailQuery(question)
  if (!parsed) return null
  
  // Check cache
  const cached = analysisCache.get(project)
  if (!cached || (Date.now() - cached.timestamp > ANALYSIS_CACHE_TTL)) {
    return { 
      text: '❌ No analysis results found. Please run **"Analyze"** first to generate the analysis.', 
      candidates: [] 
    }
  }
  
  // Find the comparison
  const comparison = cached.comparisons.find(c => c.comparisonIndex === parsed.x)
  if (!comparison) {
    const availableIndices = cached.comparisons.map(c => c.comparisonIndex).join(', ')
    return { 
      text: `❌ Comparison #${parsed.x} not found. Available comparisons: ${availableIndices}`, 
      candidates: [] 
    }
  }
  
  if (parsed.y !== undefined) {
    // Detail X.Y - Show 3rd tier items for a specific 2nd tier item
    const analysisItem = comparison.items.find(item => item.subIndex === parsed.y)
    if (!analysisItem) {
      const availableItems = comparison.items.map(i => `${parsed.x}.${i.subIndex}`).join(', ')
      return { 
        text: `❌ Item ${parsed.x}.${parsed.y} not found in comparison #${parsed.x}. Available: ${availableItems}`, 
        candidates: [] 
      }
    }
    
    // Get 3rd tier items under this 2nd tier item
    const thirdTierItems = getThirdTierItems(data, project, analysisItem.itemCode)
    
    let response = `## Detail ${parsed.x}.${parsed.y}: ${analysisItem.itemName} - ${comparison.title}\n\n`
    response += `**Parent:** ${analysisItem.itemCode} - ${analysisItem.itemName}\n\n`
    
    // Build table
    response += `| 3rd Tier Item | ${comparison.items[0]?.label1 || 'Value 1'} | ${comparison.items[0]?.label2 || 'Value 2'} | Difference |\n`
    response += `|---------------|-----------|---------------|------------|\n`
    
    let totalDiff = 0
    let foundItems = 0
    
    for (const tier3 of thirdTierItems) {
      const rows1 = getFinancialStatusRows(data, project, tier3.itemCode, comparison.finType1)
      const rows2 = getFinancialStatusRows(data, project, tier3.itemCode, comparison.finType2)
      const val1 = rows1.reduce((sum, d) => sum + toNumber(d.Value), 0)
      const val2 = rows2.reduce((sum, d) => sum + toNumber(d.Value), 0)
      
      if (val1 === 0 && val2 === 0) continue
      
      const meetsCondition = comparison.operator === 'lt' ? val1 < val2 : val1 > val2
      if (!meetsCondition) continue
      
      foundItems++
      const diff = Math.abs(val1 - val2)
      const pct = val2 !== 0 ? (diff / Math.abs(val2)) * 100 : 0
      const arrow = comparison.operator === 'lt' ? '↓' : '↑'
      const sign = comparison.operator === 'lt' ? '-' : '+'
      totalDiff += diff
      
      const ref1 = rows1.length > 0 ? ` ${formatSourceRef(rows1[0])}` : ''
      const ref2 = rows2.length > 0 ? ` ${formatSourceRef(rows2[0])}` : ''
      response += `| ${tier3.itemCode} ${tier3.itemName} | ${formatCurrency(val1)}${ref1} | ${formatCurrency(val2)}${ref2} | ${arrow}${formatCurrency(diff)} (${sign}${pct.toFixed(1)}%) |\n`
    }
    
    if (foundItems === 0) {
      response += `| (no matching 3rd tier items) | - | - | - |\n`
    }
    
    const totalArrow = comparison.operator === 'lt' ? '↓' : '↑'
    response += `\n**Total ${comparison.operator === 'lt' ? 'Shortfall' : 'Overrun'}:** ${totalArrow}${formatCurrency(totalDiff)}\n`
    
    return { text: response, candidates: [] }
    
  } else {
    // Detail X - Show all 2nd tier items with their 3rd tier breakdown
    let response = `## Detail ${parsed.x}: ${comparison.title}\n\n`
    
    if (comparison.items.length === 0) {
      response += `✅ No issues found in this comparison.\n`
      return { text: response, candidates: [] }
    }
    
    for (const analysisItem of comparison.items) {
      response += `### ${parsed.x}.${analysisItem.subIndex} ${analysisItem.itemName} (${analysisItem.itemCode})\n`
      
      // Get 3rd tier items
      const thirdTierItems = getThirdTierItems(data, project, analysisItem.itemCode)
      
      let foundThirdTier = false
      for (const tier3 of thirdTierItems) {
        const rows1 = getFinancialStatusRows(data, project, tier3.itemCode, comparison.finType1)
        const rows2 = getFinancialStatusRows(data, project, tier3.itemCode, comparison.finType2)
        const val1 = rows1.reduce((sum, d) => sum + toNumber(d.Value), 0)
        const val2 = rows2.reduce((sum, d) => sum + toNumber(d.Value), 0)
        
        if (val1 === 0 && val2 === 0) continue
        
        const meetsCondition = comparison.operator === 'lt' ? val1 < val2 : val1 > val2
        if (!meetsCondition) continue
        
        foundThirdTier = true
        const diff = Math.abs(val1 - val2)
        const pct = val2 !== 0 ? (diff / Math.abs(val2)) * 100 : 0
        const arrow = comparison.operator === 'lt' ? '↓' : '↑'
        const sign = comparison.operator === 'lt' ? '-' : '+'
        const symbol = comparison.operator === 'lt' ? '<' : '>'
        
        const ref1 = rows1.length > 0 ? ` ${formatSourceRef(rows1[0])}` : ''
        const ref2 = rows2.length > 0 ? ` ${formatSourceRef(rows2[0])}` : ''
        response += `   - ${tier3.itemCode} ${tier3.itemName}: ${analysisItem.label1} ${formatCurrency(val1)}${ref1} ${symbol} ${analysisItem.label2} ${formatCurrency(val2)}${ref2} (${arrow}${formatCurrency(diff)}, ${sign}${pct.toFixed(1)}%)\n`
      }
      
      if (!foundThirdTier) {
        response += `   - (no 3rd tier breakdown available)\n`
      }
      
      response += `\n`
    }
    
    response += `💡 Type **"Detail ${parsed.x}.Y"** for a table view of a specific item.\n`
    
    return { text: response, candidates: [] }
  }
}

// Main query handler with new logic
function answerQuestion(data: FinancialRow[], project: string, question: string, defaultMonth: string): FuzzyResult {
  const expandedQuestion = expandAcronyms(question).toLowerCase()
  // Get significant words from the question (after acronym expansion)
  // IMPORTANT: Keep ALL words including short ones like "np" which may be acronyms
  const questionWords = expandedQuestion.split(/\s+/).filter(w => w.length > 0)
  const projectData = data.filter(d => d._project === project)

  if (projectData.length === 0) {
    return { text: 'No data found for this project.', candidates: [] }
  }

  // Step 0: Check if this is a List query — highest priority
  const listResult = handleListQuery(data, project, question)
  if (listResult) return listResult

  // Step 0a: Check if this is a Shortcuts/Help query
  const lowerQ = question.toLowerCase().trim()
  if (lowerQ === 'shortcuts' || lowerQ === 'help' || lowerQ === 'commands') {
    return {
      text: `📋 **Quick Reference**\n\n**10 Commands:**\n• **analyze** — Run financial analysis (6 comparisons)\n• **compare X vs Y** — Compare two Financial Types\n• **trend [metric] [N]** — Show values over N months\n• **list** — Show data items (list, list more, list 2.2)\n• **total [item] [type]** — Sum sub-items under a parent\n• **detail X** — Drill down into results (after any query)\n• **risk** — Risk items across WIP/Committed/CF\n• **cash flow** — Last 12 months GP summary\n• **type** — List all Financial Types & Sheets\n• **shortcuts** — This help\n\n**Financial Types:** bp, budget/bt/revision/rev, 1wb, tender, projection, wip, committed, cf/cashflow, accrual\n\n**Data Types:** gp, np, prelim, materials, plant, subcon, labour, rebar, income, cost, overhead\n\n💡 For full details, see the **Guide Menu** above!`,
      candidates: []
    }
  }

  // Step 0b: Check if this is a Type query
  if (lowerQ === 'type' || lowerQ === 'types' || lowerQ === 'financial types') {
    // Import from shortcuts.ts
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
    
    return { text: lines, candidates: [] }
  }

  // Step 0c: Check if this is a Cash Flow query (shortcut for cash flow trend)
  if (lowerQ === 'cash flow' || lowerQ === 'cashflow') {
    const result = handleTrendQuery(data, project, 'cash flow gp 12', defaultMonth)
    return result || { text: 'No cash flow data found.', candidates: [] }
  }

  // Step 0d: Check if this is a Risk query
  if (lowerQ === 'risk' || lowerQ === 'risks') {
    // Handle risk query - show risk items
    return handleRiskQuery(data, project, defaultMonth)
  }

  // Step 0e: Check if this is "more" after a list query
  const listMoreResult = handleListMore(data, project, question)
  if (listMoreResult) return listMoreResult

  // Step 0b: Check if this is an Analyze query
  if (isAnalyzeQuery(question)) {
    return handleAnalyzeQuery(data, project)
  }

  // Step 0a: Check Detail/More for context-aware handlers FIRST
  // Priority: Trend context → Compare context → Analyze context
  // This ensures "detail N" after a Trend drills into Trend sub-items,
  // not the Analyze handler which would return "No analysis results found"
  const isDetailOrMore = lowerQ === 'detail' || lowerQ === 'more' || /^detail\s+\d+(\.\d+)?$/i.test(lowerQ)

  if (isDetailOrMore) {
    // Try Trend detail first (if Trend context exists)
    const detailTrendResult = handleDetailTrend(data, project, question)
    if (detailTrendResult) return detailTrendResult

    // Try Compare detail second (if Compare context exists)
    const detailCompareResult = handleDetailCompare(data, project, question, defaultMonth)
    if (detailCompareResult) return detailCompareResult

    // Try Analyze detail last (fallback)
    if (isDetailQuery(question)) {
      const detailResult = handleDetailQuery(data, project, question)
      if (detailResult) return detailResult
    }

    // No context found for any handler
    return {
      text: '❌ No previous query found to drill down into.\n\nPlease run a query first:\n• **Trend:** e.g., "trend cashflow cost"\n• **Compare:** e.g., "compare cashflow subbie 9 2025 vs 12 2025"\n• **Analyze:** e.g., "Analyze"\n\nThen type **detail** to see sub-items.',
      candidates: []
    }
  }

  // Step 0b: Check if this is a Total query — handle with dedicated logic
  const totalResult = handleTotalQuery(data, project, question, defaultMonth)
  if (totalResult) return totalResult

  // Step 0c: Check if this is a Trend query — handle with dedicated logic
  const trendResult = handleTrendQuery(data, project, question, defaultMonth)
  if (trendResult) return trendResult

  // Step 0b: Check if this is a comparison query — handle it with dedicated logic
  const comparisonResult = handleComparisonQuery(data, project, question, defaultMonth)
  if (comparisonResult) return comparisonResult

  // Step 1: Parse date → month, year
  const parsedDate = parseDate(expandedQuestion, defaultMonth)

  // Step 2: Check Sheet_Name
  // IF user didn't specify any date (only using defaults): default to "Financial Status"
  // IF user specified a date: check if user mentioned a specific sheet
  let targetSheet: string | undefined
  const sheets = getUniqueValues(data, project, 'Sheet_Name')

  // Detect if user actually specified a date (not just using defaults)
  const userSpecifiedYear = parsedDate.year && parsedDate.year !== String(new Date().getFullYear())
  const userSpecifiedMonth = parsedDate.month && parsedDate.month !== defaultMonth
  const hasUserDate = userSpecifiedYear || userSpecifiedMonth

  if (!hasUserDate) {
    // No date specified by user → Default to Financial Status, skip sheet detection
    targetSheet = 'Financial Status'
  } else {
    // Date specified by user → Check if user explicitly mentioned a sheet
    // First try: check if user explicitly mentioned a sheet
    for (const sheet of sheets) {
      const sheetLower = sheet.toLowerCase()
      // Check if sheet name appears in question (with or without "sheet")
      if (expandedQuestion.includes(sheetLower.replace(/\s+/g, '')) ||
          expandedQuestion.includes(sheetLower.split(' ')[0])) {
        targetSheet = sheet
        break
      }
    }

    // Second: check for common sheet name keywords even without "sheet" prefix
    if (!targetSheet) {
      const sheetKeywords: Record<string, string> = {
        'cashflow': 'Cash Flow',
        'cash flow': 'Cash Flow',
        'projection': 'Projection',
        'committed': 'Committed Cost',
        'accrual': 'Accrual',
        'financial status': 'Financial Status',
        'financial': 'Financial Status'
      }
      for (const [keyword, sheetName] of Object.entries(sheetKeywords)) {
        // Check if keyword is in expanded question (as standalone word/phrase)
        const keywordRegex = new RegExp(`\\b${keyword.replace(/\s+/g, '\\s+')}\\b`, 'i')
        if (keywordRegex.test(expandedQuestion)) {
          // Verify this sheet actually exists in the data (handle whitespace/blank issues)
          const found = sheets.find(s => s && s.trim() && s.trim().toLowerCase() === sheetName.toLowerCase())
          if (found) {
            targetSheet = found
            break
          }
        }
      }
    }
  }

  // Step 3: Get unique Financial_Type and Data_Type from data
  const financialTypes = getUniqueValues(data, project, 'Financial_Type')
  const dataTypes = getUniqueValues(data, project, 'Data_Type')
  
  // Step 4: Extract Financial_Type from question (find closest match)
  // IMPORTANT: "projected" should map to Financial_Type like "Projection as at"
  // We should NOT skip Financial_Type just because it contains a Sheet_Name
  // Filter out stopwords when matching to avoid false positives
  let targetFinType: string | undefined
  let targetDataType: string | undefined
  
  // First, try to match PRIMARY Financial Type keywords (projection, revision, budget, etc.)
  // These get highest priority
  for (const qWord of questionWords) {
    if (STOPWORDS.has(qWord)) continue  // Skip stopwords
    if (!isFinancialTypeKeyword(qWord)) continue  // Skip non-primary keywords
    
    for (const ft of financialTypes) {
      const ftLower = ft.toLowerCase()
      if (ftLower.includes(qWord)) {
        targetFinType = ft
        break
      }
    }
    if (targetFinType) break
  }
  
  // If no primary keyword match, try general matching (excluding stopwords)
  if (!targetFinType) {
    for (const ft of financialTypes) {
      const ftLower = ft.toLowerCase()
      // Check if any SIGNIFICANT question word matches any Financial_Type word
      // IMPORTANT: Keep short words like "np" which may be acronyms, but exclude stopwords
      const ftWords = ftLower.split(/\s+/).filter(w => w.length > 0 && !STOPWORDS.has(w))
      for (const qWord of questionWords) {
        if (STOPWORDS.has(qWord)) continue  // Skip stopwords
        for (const ftWord of ftWords) {
          // Exact word match OR word contains substring with 50%+ threshold
          if (qWord === ftWord) {
            targetFinType = ft
            break
          }
          if (ftWord.includes(qWord) && qWord.length >= ftWord.length * 0.5) {
            targetFinType = ft
            break
          }
        }
        if (targetFinType) break
      }
      if (targetFinType) break
    }
  }
  
  // If no match found, use fuzzy matching (excluding stopwords)
  if (!targetFinType) {
    for (const word of questionWords) {
      if (STOPWORDS.has(word)) continue  // Skip stopwords
      const match = findClosestMatch(word, financialTypes)
      if (match) {
        targetFinType = match
        break
      }
    }
  }

  // Step 5: Extract Data_Type from question (find closest match)
  // IMPORTANT: "gp" / "np" should map to Data_Type like "Gross Profit" / "Net Profit"

  // Special mapping for common acronyms (must come first!)
  const acronymMap: Record<string, string[]> = {
    'np': ['net profit', 'acc. net profit'],
    'gp': ['gross profit', 'acc. gross profit'],
    'wip': ['work in progress'],
    'cf': ['cash flow']
  }

  // Check if question contains any known acronyms
  for (const [acronym, expansions] of Object.entries(acronymMap)) {
    if (questionWords.includes(acronym)) {
      // Try to find a matching Data_Type in the data
      for (const expansion of expansions) {
        const match = dataTypes.find(dt => dt.toLowerCase().includes(expansion))
        if (match) {
          targetDataType = match
          break
        }
      }
      if (targetDataType) break
    }
  }

  // If no acronym match found, continue with regular matching
  let bestDataTypeMatchCount = 0

  // Helper to check if a word looks like an item code (e.g., "2.1", "1.2.3")
  const isItemCodePattern = (word: string) => /^\d+(\.\d+)+$/.test(word)

  if (!targetDataType) {
    for (const dt of dataTypes) {
      const dtLower = dt.toLowerCase()
      const dtWords = dtLower.split(/\s+/).filter(w => w.length > 0)

      // Count how many question words match this Data_Type
      let matchCount = 0
      const matchedWords: string[] = []
      for (const qWord of questionWords) {
        // Skip words that look like item codes (e.g., "2.1", "1.2.3")
        if (isItemCodePattern(qWord)) continue
        // Skip words that are Financial_Type keywords (e.g., "projected", "budget")
        // This prevents "projected" from matching "Project Code" in Data_Type
        if (isFinancialTypeKeyword(qWord)) continue
        
        for (const dtWord of dtWords) {
          if (qWord === dtWord) {
            matchCount++
            matchedWords.push(qWord)
            break
          }
        }
      }

      // Partial matches for longer words (4+ chars)
      for (const qWord of questionWords) {
        if (matchedWords.includes(qWord)) continue
        if (qWord.length <= 3) continue
        // Skip words that look like item codes
        if (isItemCodePattern(qWord)) continue
        // Skip words that are Financial_Type keywords
        if (isFinancialTypeKeyword(qWord)) continue

        for (const dtWord of dtWords) {
          const qLen = qWord.length
          const dLen = dtWord.length

          const longer = qLen >= dLen ? qWord : dtWord
          const shorter = qLen >= dLen ? dtWord : qWord

          if (longer.includes(shorter) && shorter.length >= longer.length * 0.5) {
            matchCount++
            matchedWords.push(qWord)
            break
          }
        }
      }

      if (matchCount > bestDataTypeMatchCount) {
        bestDataTypeMatchCount = matchCount
        targetDataType = dt
      }
    }
  }

  // If no match found, use fuzzy matching with all significant words
  if (!targetDataType) {
    for (const word of questionWords) {
      // Skip words that look like item codes (e.g., "2.1", "1.2.3")
      if (isItemCodePattern(word)) continue
      // Skip words that are Financial_Type keywords
      if (isFinancialTypeKeyword(word)) continue
      
      const match = findClosestMatch(word, dataTypes)
      if (match) {
        targetDataType = match
        break
      }
    }
  }

  // Step 6: Extract Item_Code from question
  // Patterns: "item code 2.1", "item_code 2.1", "item 2.1", standalone "2.1"
  let targetItemCode: string | null = null
  
  // Pattern 1: "item code X.X" or "item_code X.X" or "item X.X"
  const itemCodePattern = /item[_\s]*code[_\s]*(\d+(?:\.\d+)*)/i
  const itemCodeMatch = expandedQuestion.match(itemCodePattern)
  if (itemCodeMatch) {
    targetItemCode = itemCodeMatch[1]
  } else {
    // Pattern 2: "item X.X" (without "code")
    const itemPattern = /item[_\s]+(\d+(?:\.\d+)*)/i
    const itemMatch = expandedQuestion.match(itemPattern)
    if (itemMatch) {
      targetItemCode = itemMatch[1]
    } else {
      // Pattern 3: Standalone number pattern like "2.1" or "1.2.3" (but not dates like "2025")
      // Only match if it's clearly an item code (has a decimal point and is short)
      const standalonePattern = /(?:^|\s)(\d+\.\d+(?:\.\d+)?)(?:\s|$)/
      const standaloneMatch = expandedQuestion.match(standalonePattern)
      if (standaloneMatch && standaloneMatch[1].length <= 10) {
        targetItemCode = standaloneMatch[1]
      }
    }
  }

  // If no explicit item code found, try PARENT_ITEM_MAP to get Item_Code from metric keywords
  // This ensures "projected cost" resolves to Item 2 (Less : Cost), not a child like 2.1.1
  if (!targetItemCode) {
    const sortedParentItems = Object.entries(PARENT_ITEM_MAP).sort((a, b) => b[0].length - a[0].length)
    for (const [keyword, info] of sortedParentItems) {
      const pattern = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}\\b`, 'i')
      if (pattern.test(expandedQuestion)) {
        targetItemCode = info.code
        break
      }
    }
  }

  // Track which sheet was actually applied (for display)
  let appliedSheet = targetSheet

  // Build filter conditions
  let filtered = projectData

  // Apply Sheet_Name filter
  if (targetSheet) {
    filtered = filtered.filter(d => d.Sheet_Name === targetSheet)
    appliedSheet = targetSheet
  }

  // Apply month filter (if specified) - BUT NOT for Financial Status
  // Financial Status is cumulative/report-level data, not monthly
  // Only apply month filter for sheet-specific queries (Cash Flow, Projection, etc.)
  if (parsedDate.month && targetSheet !== 'Financial Status') {
    filtered = filtered.filter(d => d.Month === parsedDate.month)
  }

  // Apply year filter (if specified)
  if (parsedDate.year) {
    filtered = filtered.filter(d => d.Year === parsedDate.year)
  }

  // Apply Financial_Type filter (if found)
  if (targetFinType) {
    filtered = filtered.filter(d => d.Financial_Type === targetFinType)
  }

  // Apply Data_Type filter (if found)
  if (targetDataType) {
    filtered = filtered.filter(d => d.Data_Type === targetDataType)
  }

  // Apply Item_Code filter (if found)
  if (targetItemCode) {
    filtered = filtered.filter(d => d.Item_Code === targetItemCode)
  }

  // If no exact matches, relax filters progressively
  if (filtered.length === 0) {
    // Try without Financial_Type
    filtered = projectData
    if (targetSheet) filtered = filtered.filter(d => d.Sheet_Name === targetSheet)
    if (parsedDate.month) filtered = filtered.filter(d => d.Month === parsedDate.month)
    if (parsedDate.year) filtered = filtered.filter(d => d.Year === parsedDate.year)
    if (targetDataType) filtered = filtered.filter(d => d.Data_Type === targetDataType)
    if (targetItemCode) filtered = filtered.filter(d => d.Item_Code === targetItemCode)
    appliedSheet = targetSheet || 'Financial Status'
  }

  if (filtered.length === 0) {
    // Try without Data_Type
    filtered = projectData
    if (targetSheet) filtered = filtered.filter(d => d.Sheet_Name === targetSheet)
    if (parsedDate.month) filtered = filtered.filter(d => d.Month === parsedDate.month)
    if (parsedDate.year) filtered = filtered.filter(d => d.Year === parsedDate.year)
    if (targetItemCode) filtered = filtered.filter(d => d.Item_Code === targetItemCode)
    appliedSheet = targetSheet || 'Financial Status'
  }

  if (filtered.length === 0) {
    // PHASE 2: Generate helpful suggestions based on available data
    const availableMonths = Array.from(new Set(projectData.map(d => d.Month))).sort()
    const availableDataTypes = Array.from(new Set(projectData.map(d => d.Data_Type).filter(Boolean)))
    const availableFinTypes = Array.from(new Set(projectData.map(d => d.Financial_Type).filter(Boolean)))
    
    let suggestions = `No data found matching your query.\n\nFilters attempted:`
    if (appliedSheet) suggestions += `\n- Sheet: ${appliedSheet}`
    // Don't show month filter for Financial Status (it's not applicable)
    if (parsedDate.month && targetSheet !== 'Financial Status') suggestions += `\n- Month: ${parsedDate.month}`
    if (parsedDate.year) suggestions += `\n- Year: ${parsedDate.year}`
    if (targetFinType) suggestions += `\n- Financial Type: ${targetFinType}`
    if (targetDataType) suggestions += `\n- Data Type: ${targetDataType}`
    
    // Add helpful suggestions
    suggestions += `\n\n💡 Suggestions:`
    if (availableMonths.length > 0) {
      suggestions += `\n• Available months: ${availableMonths.slice(0, 6).join(', ')}${availableMonths.length > 6 ? '...' : ''}`
    }
    if (availableDataTypes.length > 0) {
      suggestions += `\n• Try: "${availableDataTypes[0]}" (most common)`
    }
    suggestions += `\n• Try: "gross profit", "projection", "budget", "cash flow"`
    suggestions += `\n• Or try: "last month", "this month"`
    
    return { text: suggestions, candidates: [] }
  }

  // Helper to convert Value to number safely
  const toNumber = (val: number | string): number => {
    if (typeof val === 'number') return val
    return parseFloat(val) || 0
  }

  // Format results
  const total = filtered.reduce((sum, d) => sum + toNumber(d.Value), 0)

  // Get unique Item_Codes for display
  const itemGroups = new Map<string, FinancialRow[]>()
  filtered.forEach(d => {
    const key = d.Item_Code || 'Unknown'
    if (!itemGroups.has(key)) itemGroups.set(key, [])
    itemGroups.get(key)!.push(d)
  })

  let response = `## Query Results\n\n`
  response += `**Filters:**\n`
  // Show which sheet was used
  if (appliedSheet) response += `• Sheet: ${appliedSheet}\n`
  // Show Financial Type filter
  if (targetFinType) response += `• Financial Type: ${targetFinType}\n`
  // Show month - only show actual month if user specified it
  response += `• Month: ${hasUserDate && parsedDate.month ? parsedDate.month : 'All'}\n`
  // Show year - only show actual year if user specified it
  response += `• Year: ${hasUserDate && parsedDate.year ? parsedDate.year : 'All'}\n`
  response += `• Data Type: ${targetDataType || 'All'}\n`
  response += `• Item Code: ${targetItemCode || 'All'}\n`
  // Add Row number for the top match
  if (allCandidates.length > 0 && allCandidates[0].rowLabel) {
    response += `• Row ${allCandidates[0].rowLabel}\n`
  }
  response += `\n`

  // Build source ref for the total
  const totalSourceRef = filtered.length === 1 
    ? ` ${formatSourceRef(filtered[0])}` 
    : filtered.length > 1 
      ? ` [sum of ${filtered.length} rows]`
      : ''
  response += `**Total: ${formatCurrency(total)}${totalSourceRef}** ('000)\n\n`

  // Only show "By Item Code" breakdown if no specific item code was filtered
  if (!targetItemCode) {
    response += `**By Item Code:**\n`
    itemGroups.forEach((rows, itemCode) => {
      const itemTotal = rows.reduce((sum, d) => sum + toNumber(d.Value), 0)
    const itemSourceRef = rows.length === 1 
      ? ` ${formatSourceRef(rows[0])}` 
      : rows.length > 1 
        ? ` ${formatSourceRef(rows[0])}`
        : ''
    response += `• Item ${itemCode}: ${formatCurrency(itemTotal)}${itemSourceRef}\n`
  })
  } // End of if (!targetItemCode)

  // Create candidates for clickable selection
  // ALWAYS score ALL project data records and show top 5 best matches
  // Include keyword matching across ALL fields for comprehensive scoring
  
  // Filter out stopwords from question words for scoring (but keep for display)
  const significantQuestionWords = questionWords.filter(w => !STOPWORDS.has(w))
  
  const allCandidates = projectData.map((d) => {
    let matchScore = 0
    const matchedKeywords: string[] = []

    // Build combined text from all searchable fields
    const combinedText = `${d.Sheet_Name} ${d.Financial_Type} ${d.Data_Type} ${d.Item_Code} ${d.Month} ${d.Year}`.toLowerCase()

    // Check each SIGNIFICANT question word against ALL fields
    // STOPWORDS are EXCLUDED from scoring to prevent false matches
    for (const qWord of significantQuestionWords) {
      // Financial_Type match - 10x weight for PRIMARY keywords
      if (d.Financial_Type.toLowerCase().includes(qWord)) {
        if (isFinancialTypeKeyword(qWord)) {
          // PRIMARY Financial Type keyword (projection, revision, budget, etc.) - 10x weight
          matchScore += 50
        } else {
          // Non-primary word in Financial_Type - normal weight
          matchScore += 5
        }
        matchedKeywords.push(qWord)
      }

      // Data_Type match (important!)
      if (d.Data_Type.toLowerCase().includes(qWord)) {
        matchScore += 8
        if (!matchedKeywords.includes(qWord)) matchedKeywords.push(qWord)
      }

      // Item_Code match - EXACT match gets much higher score than substring
      if (d.Item_Code.toLowerCase() === qWord) {
        matchScore += 50  // EXACT match - high priority (e.g., "2.1" matches "2.1")
        if (!matchedKeywords.includes(qWord)) matchedKeywords.push(qWord)
      } else if (d.Item_Code.toLowerCase().includes(qWord)) {
        matchScore += 3   // Substring match - low priority (e.g., "2.1" matches "2.1.1")
        if (!matchedKeywords.includes(qWord)) matchedKeywords.push(qWord)
      }

      // Sheet_Name match
      if (d.Sheet_Name.toLowerCase().includes(qWord)) {
        matchScore += 2
        if (!matchedKeywords.includes(qWord)) matchedKeywords.push(qWord)
      }
    }

    // Explicit Financial_Type match (high priority) - 10x weight boost
    if (targetFinType && d.Financial_Type === targetFinType) {
      matchScore += 100  // Increased from 40 to 100 for explicit match
    }
    else if (targetFinType && d.Financial_Type.toLowerCase().includes(targetFinType.toLowerCase())) {
      matchScore += 80   // Increased from 30 to 80 for partial match
      if (!matchedKeywords.includes(targetFinType)) matchedKeywords.push(targetFinType)
    }

    // Explicit Data_Type match (high priority)
    if (targetDataType && d.Data_Type === targetDataType) matchScore += 35
    else if (targetDataType && d.Data_Type.toLowerCase().includes(targetDataType.toLowerCase())) {
      matchScore += 25
      if (!matchedKeywords.includes(targetDataType)) matchedKeywords.push(targetDataType)
    }

    // Month match
    if (parsedDate.month && d.Month === parsedDate.month) matchScore += 20

    // Year match
    if (parsedDate.year && d.Year === parsedDate.year) matchScore += 15

    // Bonus for common item codes
    if (d.Item_Code === '3' || d.Item_Code === '1' || d.Item_Code === '2') matchScore += 5

    // Bonus for Financial Status (default sheet)
    if (d.Sheet_Name === 'Financial Status') matchScore += 2

    return {
      id: 0, // Will be reassigned
      value: d.Value,
      score: matchScore,
      sheet: d.Sheet_Name,
      financialType: d.Financial_Type,
      dataType: d.Data_Type,
      itemCode: d.Item_Code,
      month: d.Month,
      year: d.Year,
      matchedKeywords: Array.from(new Set(matchedKeywords)),
      rowLabel: d._rowIndex ? String.fromCharCode(64 + (d._rowIndex % 26) || 26) + (Math.floor(d._rowIndex / 26) > 0 ? String(Math.floor(d._rowIndex / 26)) : "") : undefined
    }
  }).sort((a, b) => b.score - a.score).slice(0, 5)

  // Reassign IDs after sorting
  const candidates = allCandidates.map((c, i) => ({ ...c, id: i + 1 }))

  if (candidates.length > 0) {
    response += `\n**Available Records (click to select):**\n`
    candidates.forEach((c) => {
      const matches = c.matchedKeywords.length > 0 ? ` [Matched: ${c.matchedKeywords.join(', ')}]` : ''
      const rowLabel = c.rowLabel ? ` • Row ${c.rowLabel}` : ''
      response += `[${c.id}] ${c.month}/${c.year}/${c.sheet}/${c.financialType}/${c.dataType}/${c.itemCode}: ${formatCurrency(toNumber(c.value))} [Score: ${c.score}]${rowLabel}${matches}
`
    })
  }

  return { text: response, candidates }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { action, year, month, project, projectFile, question } = body

    switch (action) {
      case 'getStructure': {
        const result = await getFolderStructure()
        if (result.error) {
          return NextResponse.json({
            folders: result.folders,
            projects: result.projects,
            error: result.error
          })
        }
        return NextResponse.json({
          folders: result.folders,
          projects: result.projects
        })
      }

      case 'loadProject': {
        const data = await loadProjectData(projectFile, year, month)
        const metrics = getProjectMetrics(data, project)

        // Debug info
        const debug = {
          source: `Google Drive: Ai Chatbot Knowledge Base/${year}/${month}/${projectFile}`,
          totalRows: data.length,
          // Show raw values from CSV
          sampleRows: data.slice(0, 3).map(d => ({
            Sheet: d.Sheet_Name,
            FinType: d.Financial_Type,
            Item: d.Item_Code,
            Data: d.Data_Type,
            Value: d.Value
          })),
          uniqueSheets: Array.from(new Set(data.map(d => d.Sheet_Name))),
          uniqueFinancialTypes: Array.from(new Set(data.map(d => d.Financial_Type))),
          uniqueItemCodes: Array.from(new Set(data.map(d => d.Item_Code))),
          uniqueDataTypes: Array.from(new Set(data.map(d => d.Data_Type))),
          gpRowsCount: data.filter(d =>
            d.Item_Code === '3' &&
            d.Data_Type?.toLowerCase().includes('gross profit')
          ).length
        }

        return NextResponse.json({ data, metrics, debug })
      }

      case 'query': {
        const data = await loadProjectData(projectFile, year, month)
        const result = answerQuestion(data, project, question, month)
        return NextResponse.json({ response: result.text, candidates: result.candidates })
      }

      case 'metrics': {
        const data = await loadProjectData(projectFile, year, month)
        const metrics = getProjectMetrics(data, project)
        return NextResponse.json({ metrics })
      }

      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }
  } catch (error) {
    console.error('API error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
